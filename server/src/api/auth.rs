//! First-run setup, login (password + second factor), TOTP enrolment, passkeys, current user
//! and the public provider list. SSO providers live in [`super::sso`].

use crate::app::AppState;
use crate::auth::{self, passkeys, totp, AnyAuthUser, AuthUser};
use crate::db::{
    self,
    audit::Actor,
    models::{AuthMethod, Role, UserRow},
    settings,
};
use crate::error::{ApiError, ApiResult};
use crate::mail::{self, templates, Recipient};
use axum::extract::{ConnectInfo, Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use axum_extra::extract::CookieJar;
use chrono::{Duration, Utc};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::net::SocketAddr;
use subtle::ConstantTimeEq;
use webauthn_rs::prelude::*;

const CHALLENGE_KIND: &str = "2fa";
const TOTP_SETUP_KIND: &str = "totp_setup";
const PASSKEY_REG_KIND: &str = "passkey_reg";
const PASSKEY_LOGIN_KIND: &str = "passkey_login";
const PASSWORD_RESET_KIND: &str = "password_reset";
const EMAIL_SETUP_KIND: &str = "email_2fa_setup";
const MAX_CHALLENGE_ATTEMPTS: u32 = 5;
const PASSWORD_RESET_TTL_MINUTES: i64 = 30;
const EMAIL_CODE_TTL_MINUTES: i64 = 10;
const EMAIL_SETUP_MAX_ATTEMPTS: u32 = 5;
const EMAIL_CODE_MAX_SENDS: u32 = 3;

#[derive(Serialize)]
pub struct SetupStatus {
    pub needs_setup: bool,
}

pub async fn setup_status(State(state): State<AppState>) -> ApiResult<Json<SetupStatus>> {
    let count = db::users::count(&state.db).await?;
    Ok(Json(SetupStatus {
        needs_setup: count == 0,
    }))
}

#[derive(Deserialize)]
pub struct SetupBody {
    pub email: String,
    pub name: String,
    pub password: String,
}

#[derive(Serialize)]
pub struct UserEnvelope {
    pub user: db::models::UserPublic,
    /// The second-factor policy applies and nothing is enrolled yet.
    pub two_factor_required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_method: Option<AuthMethod>,
}

impl UserEnvelope {
    pub fn new(state: &AppState, user: &UserRow, auth_method: Option<AuthMethod>) -> Self {
        Self {
            user: user.public(),
            two_factor_required: state.config.require_2fa.applies_to(user.is_admin())
                && !user.two_factor_enabled(),
            auth_method,
        }
    }
}

pub async fn setup(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(body): Json<SetupBody>,
) -> ApiResult<impl IntoResponse> {
    if db::users::count(&state.db).await? > 0 {
        return Err(ApiError::conflict(
            "already_setup",
            "an account already exists",
        ));
    }
    auth::validate_email(&body.email)?;
    auth::validate_password(&body.password)?;
    if body.name.trim().is_empty() {
        return Err(ApiError::validation("name is required"));
    }
    let hash = auth::hash_password(&body.password)?;
    let user = db::users::create(&state.db, &body.email, &body.name, &hash, Role::Admin).await?;
    // Without local login the first administrator must be able to get in somehow.
    if !state.config.local_login {
        db::users::set_break_glass(&state.db, &user.id, true).await?;
    }
    let user = db::users::by_id(&state.db, &user.id)
        .await?
        .ok_or_else(|| ApiError::not_found("user"))?;
    db::users::set_last_login(&state.db, &user.id).await?;
    db::audit::record(
        &state.db,
        Some(Actor {
            id: &user.id,
            name: &user.name,
        }),
        "user.create",
        Some(&user.id),
        json!({ "email": user.email, "role": "admin", "setup": true, "break_glass": user.break_glass }),
    )
    .await?;
    let sid = db::users::create_login_session(&state.db, &user.id, state.config.session_ttl_hours)
        .await?;
    let jar = jar.add(auth::session_cookie(
        state.config.is_https(),
        sid,
        state.config.session_ttl_hours,
    ));
    let envelope = UserEnvelope::new(&state, &user, Some(AuthMethod::Password));
    Ok((StatusCode::CREATED, jar, Json(envelope)))
}

// ── shared login plumbing ─────────────────────────────────────────────────────

/// A first factor succeeded; the second one is still outstanding.
#[derive(Debug, Serialize, Deserialize)]
pub struct TwoFactorChallenge {
    pub user_id: String,
    pub attempts: u32,
    pub ip: String,
    /// The first factor, recorded as the session's auth method afterwards.
    pub method: AuthMethod,
    #[serde(default)]
    pub return_to: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub passkey_auth: Option<PasskeyAuthentication>,
    /// SHA-256 of the emailed sign-in code, while one is outstanding.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email_code_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email_code_expires: Option<String>,
    #[serde(default)]
    pub email_sends: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email_last_sent: Option<String>,
}

/// Second-factor methods the user can complete a challenge with. Email codes are only
/// offered while outgoing mail is configured.
pub fn second_factor_methods(user: &UserRow, mail_configured: bool) -> Vec<&'static str> {
    let mut m = Vec::new();
    if user.totp_enabled {
        m.push("totp");
    }
    if user.passkeys > 0 {
        m.push("passkey");
    }
    if user.email_2fa_enabled && mail_configured {
        m.push("email");
    }
    m
}

/// Persist a pending second-factor challenge; returns its id. `503 second_factor_unavailable`
/// when the user's only factor is email codes and SMTP is not configured (an admin has to
/// fix the mail settings or reset the user's second factor).
pub async fn start_challenge(
    state: &AppState,
    user: &UserRow,
    method: AuthMethod,
    ip: &str,
    return_to: Option<String>,
) -> ApiResult<String> {
    let mail_ok = mail::is_configured(&state.db).await;
    if second_factor_methods(user, mail_ok).is_empty() {
        tracing::error!(
            user = %user.email,
            "second factor required but no method is usable (email codes enrolled, SMTP not configured)"
        );
        db::audit::record_lossy(
            &state.db,
            Some(Actor {
                id: &user.id,
                name: &user.name,
            }),
            "login_failed",
            None,
            json!({ "email": user.email, "ip": ip, "reason": "second_factor_unavailable" }),
        )
        .await;
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "second_factor_unavailable",
            "your second factor is email codes, but the console cannot send email right now; contact your administrator",
        ));
    }
    let challenge = TwoFactorChallenge {
        user_id: user.id.clone(),
        attempts: 0,
        ip: ip.to_string(),
        method,
        return_to,
        passkey_auth: None,
        email_code_hash: None,
        email_code_expires: None,
        email_sends: 0,
        email_last_sent: None,
    };
    Ok(db::auth::put_state(
        &state.db,
        CHALLENGE_KIND,
        Some(&user.id),
        &challenge,
        Duration::minutes(auth::PREAUTH_TTL_MINUTES),
    )
    .await?)
}

/// `202 { pending: "two_factor", methods, challenge_id }` plus the pre-auth cookie.
pub async fn pending_response(
    state: &AppState,
    jar: CookieJar,
    user: &UserRow,
    challenge_id: String,
) -> Response {
    let mail_ok = mail::is_configured(&state.db).await;
    let jar = jar.add(auth::preauth_cookie(
        state.config.is_https(),
        challenge_id.clone(),
    ));
    (
        StatusCode::ACCEPTED,
        jar,
        Json(json!({
            "pending": "two_factor",
            "methods": second_factor_methods(user, mail_ok),
            "challenge_id": challenge_id,
        })),
    )
        .into_response()
}

/// Rotate the session, record the login and return the cookie jar + envelope.
pub async fn complete_login(
    state: &AppState,
    jar: CookieJar,
    user: &UserRow,
    method: AuthMethod,
    ip: &str,
    details: serde_json::Value,
) -> ApiResult<(CookieJar, UserEnvelope)> {
    if let Some(old) = jar.get(auth::SESSION_COOKIE).map(|c| c.value().to_string()) {
        let _ = db::users::delete_login_session(&state.db, &old).await;
    }
    db::users::set_last_login(&state.db, &user.id).await?;
    let mut audit = details;
    if let Some(obj) = audit.as_object_mut() {
        obj.insert("ip".into(), json!(ip));
        obj.insert("method".into(), json!(method));
    }
    db::audit::record_lossy(
        &state.db,
        Some(Actor {
            id: &user.id,
            name: &user.name,
        }),
        "login",
        None,
        audit,
    )
    .await;
    let sid = db::users::create_login_session_with(
        &state.db,
        &user.id,
        state.config.session_ttl_hours,
        method,
    )
    .await?;
    let had_preauth = jar.get(auth::PREAUTH_COOKIE).is_some();
    let mut jar = jar.add(auth::session_cookie(
        state.config.is_https(),
        sid,
        state.config.session_ttl_hours,
    ));
    if had_preauth {
        jar = jar.add(auth::clear_preauth_cookie(state.config.is_https()));
    }
    let user = db::users::by_id(&state.db, &user.id)
        .await?
        .ok_or_else(|| ApiError::not_found("user"))?;
    let envelope = UserEnvelope::new(state, &user, Some(method));
    Ok((jar, envelope))
}

/// Login rate limits: `429` with `Retry-After` when the IP or the account is locked out.
pub fn check_login_limits(state: &AppState, ip: &str, account: &str) -> ApiResult<()> {
    if let Some(wait) = state.limits.login_account.blocked_for(account) {
        return Err(ApiError::rate_limited(
            "too many failed login attempts for this account, try again later",
            wait.as_secs() + 1,
        ));
    }
    if let Some(wait) = state.limiter.blocked_for(ip) {
        return Err(ApiError::rate_limited(
            "too many failed login attempts, try again later",
            wait.as_secs() + 1,
        ));
    }
    Ok(())
}

pub fn record_login_failure(state: &AppState, ip: &str, account: &str) {
    state.limiter.record_failure(ip);
    state.limits.login_account.record_failure(account);
}

pub fn clear_login_failures(state: &AppState, ip: &str, account: &str) {
    state.limiter.clear(ip);
    state.limits.login_account.clear(account);
}

fn invalid_credentials() -> ApiError {
    ApiError::new(
        StatusCode::UNAUTHORIZED,
        "invalid_credentials",
        "invalid email or password",
    )
}

// ── password login ────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct LoginBody {
    pub email: String,
    pub password: String,
}

pub async fn login(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(body): Json<LoginBody>,
) -> ApiResult<Response> {
    let ip = state.client_ip(&headers, Some(&ConnectInfo(peer)));
    let account = body.email.trim().to_lowercase();
    check_login_limits(&state, &ip, &account)?;

    let user = db::users::by_email(&state.db, &body.email).await?;
    // Always run the hash to keep timing uniform for unknown emails; bound concurrency so
    // a flood of logins cannot exhaust the CPU with argon2.
    let _slot = state.limits.verify_slots.acquire().await;
    let (ok, user) = match user {
        Some(u) => {
            let ok =
                auth::verify_password_async(body.password.clone(), u.password_hash.clone()).await;
            (ok && !u.disabled, Some(u))
        }
        None => {
            let _ =
                auth::verify_password_async(body.password.clone(), dummy_hash().to_string()).await;
            (false, None)
        }
    };
    drop(_slot);

    // With LOCAL_LOGIN=0 only break-glass accounts may use a password. The check comes after
    // the (constant-time) verification so the response timing does not leak which is which.
    if !state.config.local_login && !user.as_ref().is_some_and(|u| u.break_glass) {
        db::audit::record_lossy(
            &state.db,
            None,
            "login_failed",
            None,
            json!({ "email": account, "ip": ip, "reason": "local_login_disabled" }),
        )
        .await;
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "local_login_disabled",
            "password sign-in is disabled; use your organisation's identity provider",
        ));
    }

    if !ok {
        record_login_failure(&state, &ip, &account);
        db::audit::record_lossy(
            &state.db,
            None,
            "login_failed",
            None,
            json!({ "email": account, "ip": ip }),
        )
        .await;
        return Err(invalid_credentials());
    }

    let user = user.ok_or_else(ApiError::unauthorized)?;
    clear_login_failures(&state, &ip, &account);
    if user.two_factor_enabled() {
        let id = start_challenge(&state, &user, AuthMethod::Password, &ip, None).await?;
        return Ok(pending_response(&state, jar, &user, id).await);
    }
    let (jar, envelope) =
        complete_login(&state, jar, &user, AuthMethod::Password, &ip, json!({})).await?;
    Ok((jar, Json(envelope)).into_response())
}

// ── password reset (local accounts only) ──────────────────────────────────────

fn reset_state_id(token: &str) -> String {
    format!("pwr_{}", crate::ids::sha256_hex(token.trim()))
}

#[derive(Serialize, Deserialize)]
struct PasswordResetState {
    email: String,
}

/// Whether a password reset may be sent: enabled local account with a real password.
fn reset_eligible(state: &AppState, user: &UserRow) -> bool {
    state.config.local_login
        && !user.disabled
        && user.auth_methods().contains(&AuthMethod::Password)
}

#[derive(Deserialize)]
pub struct ForgotBody {
    pub email: String,
}

/// Always `202 {}` — the response never reveals whether the account exists. Mail is only
/// sent for enabled local (password) accounts while SMTP is configured.
pub async fn password_forgot(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<ForgotBody>,
) -> ApiResult<(StatusCode, Json<serde_json::Value>)> {
    let ip = state.client_ip(&headers, Some(&ConnectInfo(peer)));
    let account = body.email.trim().to_lowercase();
    if !state.limits.reset_ip.check(&ip) {
        let wait = state
            .limits
            .reset_ip
            .blocked_for(&ip)
            .map(|d| d.as_secs() + 1)
            .unwrap_or(900);
        return Err(ApiError::rate_limited(
            "too many password reset requests, try again later",
            wait,
        ));
    }
    if !state.limits.reset_account.check(&account) {
        let wait = state
            .limits
            .reset_account
            .blocked_for(&account)
            .map(|d| d.as_secs() + 1)
            .unwrap_or(900);
        return Err(ApiError::rate_limited(
            "too many password reset requests for this account, try again later",
            wait,
        ));
    }

    let user = db::users::by_email(&state.db, &account)
        .await?
        .filter(|u| reset_eligible(&state, u));
    let mail_ok = mail::is_configured(&state.db).await;
    if !mail_ok {
        tracing::warn!(
            email = %account,
            "password reset requested but outgoing email is not configured"
        );
    }
    let mut sent = false;
    if let (Some(user), true) = (&user, mail_ok) {
        let token = crate::ids::secret();
        db::auth::delete_states_for_user_kind(&state.db, &user.id, PASSWORD_RESET_KIND).await?;
        db::auth::put_state_with_id(
            &state.db,
            &reset_state_id(&token),
            PASSWORD_RESET_KIND,
            Some(&user.id),
            &PasswordResetState {
                email: user.email.clone(),
            },
            Duration::minutes(PASSWORD_RESET_TTL_MINUTES),
        )
        .await?;
        let link = format!(
            "{}/reset-password?token={}",
            state.config.public_url.trim_end_matches('/'),
            token
        );
        let branding = settings::branding(&state.db).await?;
        let message = templates::password_reset(
            &branding,
            &state.config.public_url,
            &link,
            PASSWORD_RESET_TTL_MINUTES,
        )
        .to(Recipient::new(&user.email, Some(user.name.clone())));
        match state.mailer.send(message).await {
            Ok(()) => sent = true,
            Err(err) => tracing::warn!(email = %account, "password reset email failed: {err:#}"),
        }
    }
    db::audit::record_lossy(
        &state.db,
        None,
        "password_reset.request",
        None,
        json!({ "email": account, "ip": ip, "sent": sent }),
    )
    .await;
    Ok((StatusCode::ACCEPTED, Json(json!({}))))
}

#[derive(Deserialize)]
pub struct ResetBody {
    pub token: String,
    pub password: String,
}

fn invalid_reset_token() -> ApiError {
    ApiError::new(
        StatusCode::BAD_REQUEST,
        "invalid_token",
        "this password reset link is invalid or has expired; request a new one",
    )
}

/// Consume a reset token: set the password, sign out everywhere, notify the user.
pub async fn password_reset(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<ResetBody>,
) -> ApiResult<Json<serde_json::Value>> {
    let ip = state.client_ip(&headers, Some(&ConnectInfo(peer)));
    if body.token.trim().is_empty() || body.token.len() > 128 {
        return Err(invalid_reset_token());
    }
    let id = reset_state_id(&body.token);
    let row = db::auth::get_state(&state.db, &id, PASSWORD_RESET_KIND)
        .await?
        .ok_or_else(invalid_reset_token)?;
    let user = match row.user_id.as_deref() {
        Some(uid) => db::users::by_id(&state.db, uid).await?,
        None => None,
    }
    .filter(|u| reset_eligible(&state, u))
    .ok_or_else(invalid_reset_token)?;
    auth::validate_password(&body.password)?;
    let hash = auth::hash_password(&body.password)?;
    db::users::update(
        &state.db,
        &user.id,
        db::users::UserUpdate {
            name: None,
            role: None,
            password_hash: Some(&hash),
            disabled: None,
        },
    )
    .await?;
    db::users::delete_login_sessions_for_user(&state.db, &user.id).await?;
    db::auth::delete_state(&state.db, &id).await?;
    clear_login_failures(&state, &ip, &user.email.to_lowercase());
    db::audit::record(
        &state.db,
        Some(Actor {
            id: &user.id,
            name: &user.name,
        }),
        "password_reset.complete",
        Some(&user.id),
        json!({ "email": user.email, "ip": ip }),
    )
    .await?;
    // Best effort: the reset succeeded even if the notice cannot be delivered.
    if let Ok(branding) = settings::branding(&state.db).await {
        let when = Utc::now().format("%Y-%m-%d %H:%M UTC").to_string();
        let message = templates::password_changed(&branding, &state.config.public_url, &when)
            .to(Recipient::new(&user.email, Some(user.name.clone())));
        if let Err(err) = state.mailer.send(message).await {
            tracing::warn!(email = %user.email, "password changed notice failed: {err:#}");
        }
    }
    Ok(Json(json!({})))
}

/// A valid argon2id hash of a random string, used to equalize timing for unknown users.
fn dummy_hash() -> &'static str {
    static DUMMY: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    DUMMY.get_or_init(|| {
        auth::hash_password(&crate::ids::secret())
            .unwrap_or_else(|_| String::from("$argon2id$invalid"))
    })
}

pub async fn logout(State(state): State<AppState>, jar: CookieJar) -> ApiResult<impl IntoResponse> {
    if let Some(sid) = jar.get(auth::SESSION_COOKIE).map(|c| c.value().to_string()) {
        db::users::delete_login_session(&state.db, &sid).await?;
    }
    let had_preauth = jar.get(auth::PREAUTH_COOKIE).is_some();
    let mut jar = jar.add(auth::clear_session_cookie(state.config.is_https()));
    if had_preauth {
        jar = jar.add(auth::clear_preauth_cookie(state.config.is_https()));
    }
    Ok((StatusCode::NO_CONTENT, jar))
}

pub async fn me(
    State(state): State<AppState>,
    AnyAuthUser(user): AnyAuthUser,
    jar: CookieJar,
) -> ApiResult<Json<UserEnvelope>> {
    let method = match jar.get(auth::SESSION_COOKIE) {
        Some(c) => db::users::session_auth_method(&state.db, c.value()).await?,
        None => None,
    };
    Ok(Json(UserEnvelope::new(&state, &user, method)))
}

// ── second-factor challenge ───────────────────────────────────────────────────

/// Load a pending challenge; the id must match the pre-auth cookie.
async fn load_challenge(
    state: &AppState,
    jar: &CookieJar,
    challenge_id: &str,
) -> ApiResult<(TwoFactorChallenge, UserRow)> {
    let cookie = jar.get(auth::PREAUTH_COOKIE).map(|c| c.value().to_string());
    if cookie.as_deref() != Some(challenge_id) {
        return Err(challenge_expired());
    }
    let row = db::auth::get_state(&state.db, challenge_id, CHALLENGE_KIND)
        .await?
        .ok_or_else(challenge_expired)?;
    let challenge: TwoFactorChallenge =
        db::auth::decode_state(&row).ok_or_else(challenge_expired)?;
    let user = db::users::by_id(&state.db, &challenge.user_id)
        .await?
        .filter(|u| !u.disabled)
        .ok_or_else(challenge_expired)?;
    Ok((challenge, user))
}

fn challenge_expired() -> ApiError {
    ApiError::new(
        StatusCode::UNAUTHORIZED,
        "challenge_expired",
        "the sign-in attempt expired; enter your password again",
    )
}

/// Count a failed second-factor attempt; voids the challenge after the limit.
async fn challenge_failed(
    state: &AppState,
    challenge_id: &str,
    mut challenge: TwoFactorChallenge,
    user: &UserRow,
) -> ApiError {
    challenge.attempts += 1;
    db::audit::record_lossy(
        &state.db,
        Some(Actor {
            id: &user.id,
            name: &user.name,
        }),
        "login_failed",
        None,
        json!({ "email": user.email, "ip": challenge.ip, "stage": "second_factor" }),
    )
    .await;
    if challenge.attempts >= MAX_CHALLENGE_ATTEMPTS {
        let _ = db::auth::delete_state(&state.db, challenge_id).await;
        record_login_failure(state, &challenge.ip, &user.email.to_lowercase());
        return ApiError::rate_limited(
            "too many incorrect codes; sign in again",
            state
                .limits
                .login_account
                .blocked_for(&user.email.to_lowercase())
                .map(|d| d.as_secs() + 1)
                .unwrap_or(30),
        );
    }
    if let Err(e) = db::auth::update_state(&state.db, challenge_id, &challenge).await {
        return ApiError::from(e);
    }
    ApiError::new(StatusCode::UNAUTHORIZED, "invalid_code", "incorrect code")
}

/// Finish a challenge: session for the first-factor method, plus a `return_to` for SSO flows.
async fn finish_challenge(
    state: &AppState,
    jar: CookieJar,
    challenge_id: &str,
    challenge: &TwoFactorChallenge,
    user: &UserRow,
    second_factor: &str,
) -> ApiResult<Response> {
    db::auth::delete_state(&state.db, challenge_id).await?;
    clear_login_failures(state, &challenge.ip, &user.email.to_lowercase());
    let (jar, mut envelope) = complete_login(
        state,
        jar,
        user,
        challenge.method,
        &challenge.ip,
        json!({ "second_factor": second_factor }),
    )
    .await?;
    envelope.auth_method = Some(challenge.method);
    let mut body = serde_json::to_value(&envelope)?;
    if let (Some(obj), Some(r)) = (body.as_object_mut(), challenge.return_to.as_deref()) {
        obj.insert("return_to".into(), json!(r));
    }
    Ok((jar, Json(body)).into_response())
}

#[derive(Deserialize)]
pub struct VerifyBody {
    pub challenge_id: String,
    pub code: String,
    /// `"totp"` (default) or `"email"`; without it an emailed code is assumed when one is
    /// outstanding and the user has no authenticator app.
    #[serde(default)]
    pub method: Option<String>,
}

/// Whether an outstanding emailed code matches (constant-time) and has not expired.
fn email_code_matches(challenge: &TwoFactorChallenge, code: &str) -> bool {
    let (Some(hash), Some(expires)) = (&challenge.email_code_hash, &challenge.email_code_expires)
    else {
        return false;
    };
    let unexpired = db::parse_ts(expires).is_some_and(|t| t > Utc::now());
    let given = crate::ids::sha256_hex(code);
    unexpired && bool::from(given.as_bytes().ct_eq(hash.as_bytes()))
}

/// TOTP, recovery code or emailed code for a pending challenge.
pub async fn two_factor_verify(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(body): Json<VerifyBody>,
) -> ApiResult<Response> {
    let (mut challenge, user) = load_challenge(&state, &jar, &body.challenge_id).await?;
    let code = body.code.trim().to_string();
    let use_email = match body.method.as_deref() {
        Some("email") => true,
        Some(_) => false,
        None => {
            challenge.email_code_hash.is_some()
                && !user.totp_enabled
                && !totp::looks_like_recovery_code(&code)
        }
    };
    if use_email {
        if !user.email_2fa_enabled {
            return Err(ApiError::validation("email codes are not enabled"));
        }
        if email_code_matches(&challenge, &code) {
            // Single use: the code is gone even before the challenge is deleted.
            challenge.email_code_hash = None;
            challenge.email_code_expires = None;
            return finish_challenge(&state, jar, &body.challenge_id, &challenge, &user, "email")
                .await;
        }
        return Err(challenge_failed(&state, &body.challenge_id, challenge, &user).await);
    }
    let _slot = state.limits.verify_slots.acquire().await;
    let used = if totp::looks_like_recovery_code(&code) {
        match consume_recovery_code(&state, &user, &code).await? {
            true => Some("recovery"),
            false => None,
        }
    } else if user.totp_enabled {
        let secret = totp_secret(&state, &user)?;
        totp::verify(&secret, &code).then_some("totp")
    } else {
        None
    };
    drop(_slot);
    match used {
        Some(second_factor) => {
            if second_factor == "recovery" {
                db::audit::record_lossy(
                    &state.db,
                    Some(Actor {
                        id: &user.id,
                        name: &user.name,
                    }),
                    "2fa.recovery",
                    Some(&user.id),
                    json!({ "used": true, "remaining": db::auth::unused_recovery_codes(&state.db, &user.id).await.map(|v| v.len()).unwrap_or(0) }),
                )
                .await;
            }
            finish_challenge(
                &state,
                jar,
                &body.challenge_id,
                &challenge,
                &user,
                second_factor,
            )
            .await
        }
        None => Err(challenge_failed(&state, &body.challenge_id, challenge, &user).await),
    }
}

fn totp_secret(state: &AppState, user: &UserRow) -> ApiResult<String> {
    let enc = user
        .totp_secret_enc
        .as_deref()
        .ok_or_else(|| ApiError::validation("authenticator app is not set up"))?;
    Ok(settings::open(&state.config, enc)?)
}

/// Match a recovery code against the unused hashes and burn it.
async fn consume_recovery_code(state: &AppState, user: &UserRow, code: &str) -> ApiResult<bool> {
    let normalised = totp::normalise_recovery_code(code);
    let rows = db::auth::unused_recovery_codes(&state.db, &user.id).await?;
    let hit = tokio::task::spawn_blocking(move || {
        rows.into_iter()
            .find(|r| auth::verify_password(&normalised, &r.code_hash))
            .map(|r| r.id)
    })
    .await
    .map_err(|e| ApiError::internal(format!("recovery code check: {e}")))?;
    match hit {
        Some(id) => {
            db::auth::mark_recovery_code_used(&state.db, id).await?;
            Ok(true)
        }
        None => Ok(false),
    }
}

/// Verify a TOTP code for an already signed-in user (enable/disable/regenerate).
fn require_totp(state: &AppState, user: &UserRow, code: &str) -> ApiResult<()> {
    let secret = totp_secret(state, user)?;
    if totp::verify(&secret, code) {
        Ok(())
    } else {
        Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "invalid_code",
            "incorrect code",
        ))
    }
}

async fn issue_recovery_codes(state: &AppState, user_id: &str) -> ApiResult<Vec<String>> {
    let codes = totp::generate_recovery_codes();
    let to_hash = codes.clone();
    let hashes = tokio::task::spawn_blocking(move || {
        to_hash
            .iter()
            .map(|c| auth::hash_password(&totp::normalise_recovery_code(c)))
            .collect::<anyhow::Result<Vec<String>>>()
    })
    .await
    .map_err(|e| ApiError::internal(format!("hashing recovery codes: {e}")))??;
    db::auth::replace_recovery_codes(&state.db, user_id, &hashes).await?;
    Ok(codes)
}

// ── TOTP enrolment ────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
struct TotpSetup {
    secret_enc: String,
}

fn totp_setup_id(user_id: &str) -> String {
    format!("{TOTP_SETUP_KIND}:{user_id}")
}

/// Start enrolment: a fresh secret, the otpauth URL and a QR code.
pub async fn two_factor_setup(
    State(state): State<AppState>,
    AnyAuthUser(user): AnyAuthUser,
) -> ApiResult<Json<serde_json::Value>> {
    let secret = totp::generate_secret();
    let issuer = settings::branding(&state.db).await?.product_name;
    let url = totp::otpauth_url(&secret, &issuer, &user.email)?;
    let qr = totp::qr_svg(&url)?;
    db::auth::put_state_with_id(
        &state.db,
        &totp_setup_id(&user.id),
        TOTP_SETUP_KIND,
        Some(&user.id),
        &TotpSetup {
            secret_enc: settings::seal(&state.config, &secret),
        },
        Duration::minutes(15),
    )
    .await?;
    Ok(Json(
        json!({ "secret": secret, "otpauth_url": url, "qr_svg": qr }),
    ))
}

#[derive(Deserialize)]
pub struct CodeBody {
    pub code: String,
}

/// Confirm the code from the app; returns the recovery codes (shown once).
pub async fn two_factor_enable(
    State(state): State<AppState>,
    AnyAuthUser(user): AnyAuthUser,
    Json(body): Json<CodeBody>,
) -> ApiResult<Json<serde_json::Value>> {
    let id = totp_setup_id(&user.id);
    let row = db::auth::get_state(&state.db, &id, TOTP_SETUP_KIND)
        .await?
        .ok_or_else(|| {
            ApiError::validation("start the setup first (it expires after 15 minutes)")
        })?;
    let setup: TotpSetup =
        db::auth::decode_state(&row).ok_or_else(|| ApiError::validation("corrupt setup state"))?;
    let secret = settings::open(&state.config, &setup.secret_enc)?;
    if !totp::verify(&secret, &body.code) {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "invalid_code",
            "incorrect code — check the time on your device",
        ));
    }
    db::users::set_totp(&state.db, &user.id, Some(&setup.secret_enc), true).await?;
    db::auth::delete_state(&state.db, &id).await?;
    let codes = issue_recovery_codes(&state, &user.id).await?;
    db::audit::record(
        &state.db,
        Some(Actor {
            id: &user.id,
            name: &user.name,
        }),
        "2fa.enable",
        Some(&user.id),
        json!({ "method": "totp" }),
    )
    .await?;
    Ok(Json(json!({ "recovery_codes": codes })))
}

pub async fn two_factor_recovery_codes(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Json(body): Json<CodeBody>,
) -> ApiResult<Json<serde_json::Value>> {
    require_totp(&state, &user, &body.code)?;
    let codes = issue_recovery_codes(&state, &user.id).await?;
    db::audit::record(
        &state.db,
        Some(Actor {
            id: &user.id,
            name: &user.name,
        }),
        "2fa.recovery",
        Some(&user.id),
        json!({ "regenerated": true }),
    )
    .await?;
    Ok(Json(json!({ "recovery_codes": codes })))
}

pub async fn two_factor_disable(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Json(body): Json<CodeBody>,
) -> ApiResult<StatusCode> {
    if !user.totp_enabled {
        return Err(ApiError::validation("authenticator app is not enabled"));
    }
    require_totp(&state, &user, &body.code)?;
    if state.config.require_2fa.applies_to(user.is_admin()) && user.passkeys == 0 {
        return Err(ApiError::conflict(
            "policy_requires_2fa",
            "the second-factor policy applies to your account; add a passkey before disabling the authenticator app",
        ));
    }
    db::users::set_totp(&state.db, &user.id, None, false).await?;
    db::auth::delete_recovery_codes(&state.db, &user.id).await?;
    db::audit::record(
        &state.db,
        Some(Actor {
            id: &user.id,
            name: &user.name,
        }),
        "2fa.disable",
        Some(&user.id),
        json!({ "method": "totp" }),
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

// ── email codes as a second factor ────────────────────────────────────────────

fn email_setup_id(user_id: &str) -> String {
    format!("email_setup:{user_id}")
}

#[derive(Serialize, Deserialize)]
struct EmailSetup {
    code_hash: String,
    attempts: u32,
}

/// Six random decimal digits, zero-padded.
fn generate_email_code() -> String {
    format!("{:06}", rand::random_range(0..1_000_000u32))
}

fn email_not_configured() -> ApiError {
    ApiError::conflict(
        "email_not_configured",
        "outgoing email is not configured; an administrator has to set up SMTP first",
    )
}

fn smtp_failed(err: anyhow::Error) -> ApiError {
    tracing::warn!("sending email failed: {err:#}");
    ApiError::new(
        StatusCode::BAD_GATEWAY,
        "smtp_failed",
        "the email could not be sent; try again later or contact your administrator",
    )
}

/// Start enrolment: email a verification code to the account's address.
pub async fn two_factor_email_start(
    State(state): State<AppState>,
    AnyAuthUser(user): AnyAuthUser,
) -> ApiResult<Json<serde_json::Value>> {
    if !mail::is_configured(&state.db).await {
        return Err(email_not_configured());
    }
    if !state.limits.email_2fa_setup.check(&user.id) {
        let wait = state
            .limits
            .email_2fa_setup
            .blocked_for(&user.id)
            .map(|d| d.as_secs() + 1)
            .unwrap_or(600);
        return Err(ApiError::rate_limited(
            "too many verification codes requested; wait before trying again",
            wait,
        ));
    }
    let code = generate_email_code();
    db::auth::put_state_with_id(
        &state.db,
        &email_setup_id(&user.id),
        EMAIL_SETUP_KIND,
        Some(&user.id),
        &EmailSetup {
            code_hash: crate::ids::sha256_hex(&code),
            attempts: 0,
        },
        Duration::minutes(EMAIL_CODE_TTL_MINUTES),
    )
    .await?;
    let branding = settings::branding(&state.db).await?;
    let message = templates::two_factor_code(
        &branding,
        &code,
        EMAIL_CODE_TTL_MINUTES,
        templates::CodePurpose::Enrol,
    )
    .to(Recipient::new(&user.email, Some(user.name.clone())));
    state.mailer.send(message).await.map_err(smtp_failed)?;
    Ok(Json(json!({ "sent_to": mail::mask_email(&user.email) })))
}

/// Confirm the emailed code; turns email codes on and hands out recovery codes when the
/// user has none yet.
pub async fn two_factor_email_enable(
    State(state): State<AppState>,
    AnyAuthUser(user): AnyAuthUser,
    Json(body): Json<CodeBody>,
) -> ApiResult<Json<serde_json::Value>> {
    let id = email_setup_id(&user.id);
    let row = db::auth::get_state(&state.db, &id, EMAIL_SETUP_KIND)
        .await?
        .ok_or_else(|| {
            ApiError::validation("request a verification code first (it expires after 10 minutes)")
        })?;
    let mut setup: EmailSetup =
        db::auth::decode_state(&row).ok_or_else(|| ApiError::validation("corrupt setup state"))?;
    let given = crate::ids::sha256_hex(body.code.trim());
    if !bool::from(given.as_bytes().ct_eq(setup.code_hash.as_bytes())) {
        setup.attempts += 1;
        if setup.attempts >= EMAIL_SETUP_MAX_ATTEMPTS {
            db::auth::delete_state(&state.db, &id).await?;
            return Err(ApiError::rate_limited(
                "too many incorrect codes; request a new one",
                60,
            ));
        }
        db::auth::update_state(&state.db, &id, &setup).await?;
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "invalid_code",
            "incorrect code",
        ));
    }
    db::users::set_email_2fa(&state.db, &user.id, true).await?;
    db::auth::delete_state(&state.db, &id).await?;
    let recovery_codes = if db::auth::unused_recovery_codes(&state.db, &user.id)
        .await?
        .is_empty()
    {
        Some(issue_recovery_codes(&state, &user.id).await?)
    } else {
        None
    };
    db::audit::record(
        &state.db,
        Some(Actor {
            id: &user.id,
            name: &user.name,
        }),
        "2fa.enable",
        Some(&user.id),
        json!({ "method": "email" }),
    )
    .await?;
    Ok(Json(json!({ "recovery_codes": recovery_codes })))
}

pub async fn two_factor_email_disable(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
) -> ApiResult<StatusCode> {
    if !user.email_2fa_enabled {
        return Err(ApiError::validation("email codes are not enabled"));
    }
    let last_factor = !user.totp_enabled && user.passkeys == 0;
    if state.config.require_2fa.applies_to(user.is_admin()) && last_factor {
        return Err(ApiError::conflict(
            "policy_requires_2fa",
            "the second-factor policy applies to your account; add an authenticator app or a passkey before disabling email codes",
        ));
    }
    db::users::set_email_2fa(&state.db, &user.id, false).await?;
    if last_factor {
        db::auth::delete_recovery_codes(&state.db, &user.id).await?;
    }
    db::audit::record(
        &state.db,
        Some(Actor {
            id: &user.id,
            name: &user.name,
        }),
        "2fa.disable",
        Some(&user.id),
        json!({ "method": "email" }),
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Email a sign-in code for a pending challenge (at most three per challenge, spaced out).
pub async fn two_factor_email_send(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(body): Json<ChallengeBody>,
) -> ApiResult<Json<serde_json::Value>> {
    let ip = state.client_ip(&headers, Some(&ConnectInfo(peer)));
    let (mut challenge, user) = load_challenge(&state, &jar, &body.challenge_id).await?;
    if !user.email_2fa_enabled {
        return Err(ApiError::validation(
            "email codes are not enabled for this account",
        ));
    }
    if !mail::is_configured(&state.db).await {
        return Err(email_not_configured());
    }
    if challenge.email_sends >= EMAIL_CODE_MAX_SENDS {
        return Err(ApiError::rate_limited(
            "no more codes can be sent for this sign-in; enter the last code or sign in again",
            auth::PREAUTH_TTL_MINUTES as u64 * 60,
        ));
    }
    let now = Utc::now();
    let spacing = state.limits.email_code_spacing;
    if let Some(last) = challenge.email_last_sent.as_deref().and_then(db::parse_ts) {
        let since = (now - last).to_std().unwrap_or_default();
        if since < spacing {
            let wait = spacing.saturating_sub(since).as_secs() + 1;
            return Err(ApiError::rate_limited(
                "a code was just sent; wait a moment before requesting another",
                wait,
            ));
        }
    }
    let code = generate_email_code();
    challenge.email_code_hash = Some(crate::ids::sha256_hex(&code));
    challenge.email_code_expires = Some(db::format_ts(
        now + Duration::minutes(EMAIL_CODE_TTL_MINUTES),
    ));
    challenge.email_sends += 1;
    challenge.email_last_sent = Some(db::format_ts(now));
    db::auth::update_state(&state.db, &body.challenge_id, &challenge).await?;
    let branding = settings::branding(&state.db).await?;
    let message = templates::two_factor_code(
        &branding,
        &code,
        EMAIL_CODE_TTL_MINUTES,
        templates::CodePurpose::Login,
    )
    .to(Recipient::new(&user.email, Some(user.name.clone())));
    state.mailer.send(message).await.map_err(smtp_failed)?;
    db::audit::record_lossy(
        &state.db,
        Some(Actor {
            id: &user.id,
            name: &user.name,
        }),
        "2fa.email_sent",
        Some(&user.id),
        json!({ "ip": ip, "sends": challenge.email_sends }),
    )
    .await;
    Ok(Json(json!({
        "sent_to": mail::mask_email(&user.email),
        "expires_in_s": EMAIL_CODE_TTL_MINUTES * 60,
    })))
}

// ── passkeys ──────────────────────────────────────────────────────────────────

/// Bodies may be the bare WebAuthn credential or `{ challenge_id?, credential }`.
fn credential_from<T: DeserializeOwned>(
    value: serde_json::Value,
) -> ApiResult<(Option<String>, T)> {
    if let Some(obj) = value.as_object() {
        if let Some(cred) = obj.get("credential") {
            let challenge_id = obj
                .get("challenge_id")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let cred: T = serde_json::from_value(cred.clone())
                .map_err(|e| ApiError::validation(format!("invalid credential: {e}")))?;
            return Ok((challenge_id, cred));
        }
    }
    let cred: T = serde_json::from_value(value)
        .map_err(|e| ApiError::validation(format!("invalid credential: {e}")))?;
    Ok((None, cred))
}

fn passkey_reg_id(user_id: &str) -> String {
    format!("{PASSKEY_REG_KIND}:{user_id}")
}

#[derive(Serialize, Deserialize)]
struct PasskeyRegState {
    name: String,
    reg: PasskeyRegistration,
}

#[derive(Deserialize)]
pub struct RegisterStartBody {
    #[serde(default)]
    pub name: Option<String>,
}

fn validate_passkey_name(name: Option<&str>) -> ApiResult<String> {
    let name = name.unwrap_or("Passkey").trim();
    if name.is_empty() || name.chars().count() > 60 {
        return Err(ApiError::validation("name must be 1–60 characters"));
    }
    Ok(name.to_string())
}

pub async fn passkey_register_start(
    State(state): State<AppState>,
    AnyAuthUser(user): AnyAuthUser,
    Json(body): Json<RegisterStartBody>,
) -> ApiResult<Json<CreationChallengeResponse>> {
    let name = validate_passkey_name(body.name.as_deref())?;
    let existing = db::auth::passkeys_for_user(&state.db, &user.id).await?;
    let exclude: Vec<CredentialID> = existing
        .iter()
        .filter_map(|p| passkeys::parse_passkey(&p.passkey_json).ok())
        .map(|p| p.cred_id().clone())
        .collect();
    let (ccr, reg) = state
        .auth
        .webauthn()?
        .start_passkey_registration(
            passkeys::user_handle(&user.id),
            &user.email,
            &user.name,
            (!exclude.is_empty()).then_some(exclude),
        )
        .map_err(|e| ApiError::internal(format!("webauthn: {e}")))?;
    db::auth::put_state_with_id(
        &state.db,
        &passkey_reg_id(&user.id),
        PASSKEY_REG_KIND,
        Some(&user.id),
        &PasskeyRegState { name, reg },
        Duration::minutes(auth::PREAUTH_TTL_MINUTES),
    )
    .await?;
    Ok(Json(ccr))
}

pub async fn passkey_register_finish(
    State(state): State<AppState>,
    AnyAuthUser(user): AnyAuthUser,
    Json(body): Json<serde_json::Value>,
) -> ApiResult<(StatusCode, Json<db::auth::PasskeyPublic>)> {
    let (_, cred): (_, RegisterPublicKeyCredential) = credential_from(body)?;
    let id = passkey_reg_id(&user.id);
    let row = db::auth::get_state(&state.db, &id, PASSKEY_REG_KIND)
        .await?
        .ok_or_else(|| ApiError::validation("start the registration first"))?;
    let reg: PasskeyRegState = db::auth::decode_state(&row)
        .ok_or_else(|| ApiError::validation("corrupt registration state"))?;
    let passkey = state
        .auth
        .webauthn()?
        .finish_passkey_registration(&cred, &reg.reg)
        .map_err(|e| {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                "webauthn_failed",
                format!("passkey registration failed: {e}"),
            )
        })?;
    db::auth::delete_state(&state.db, &id).await?;
    let flags = passkeys::credential_flags(&passkey);
    let transports: Vec<String> = cred
        .response
        .transports
        .as_ref()
        .map(|t| t.iter().map(|x| format!("{x:?}").to_lowercase()).collect())
        .unwrap_or_default();
    let credential_id = passkeys::credential_id_string(passkey.cred_id());
    if db::auth::passkey_by_credential(&state.db, &credential_id)
        .await?
        .is_some()
    {
        return Err(ApiError::conflict(
            "passkey_exists",
            "this passkey is already registered",
        ));
    }
    let row = db::auth::insert_passkey(
        &state.db,
        db::auth::NewPasskey {
            user_id: &user.id,
            name: &reg.name,
            credential_id: &credential_id,
            passkey_json: &passkeys::passkey_json(&passkey)?,
            counter: flags.counter,
            backup_eligible: flags.backup_eligible,
            backup_state: flags.backup_state,
            transports: &transports,
        },
    )
    .await?;
    db::audit::record(
        &state.db,
        Some(Actor {
            id: &user.id,
            name: &user.name,
        }),
        "passkey.register",
        Some(&user.id),
        json!({ "passkey": row.id, "name": row.name, "backup_eligible": row.backup_eligible }),
    )
    .await?;
    Ok((StatusCode::CREATED, Json(row.public())))
}

pub async fn passkeys_list(
    State(state): State<AppState>,
    AnyAuthUser(user): AnyAuthUser,
) -> ApiResult<Json<Vec<db::auth::PasskeyPublic>>> {
    let rows = db::auth::passkeys_for_user(&state.db, &user.id).await?;
    Ok(Json(rows.iter().map(|r| r.public()).collect()))
}

#[derive(Deserialize)]
pub struct RenameBody {
    pub name: String,
}

/// Rename a passkey (own; admins may rename any).
pub async fn passkey_rename(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<String>,
    Json(body): Json<RenameBody>,
) -> ApiResult<Json<db::auth::PasskeyPublic>> {
    let row = db::auth::passkey_by_id(&state.db, &id)
        .await?
        .filter(|p| p.user_id == user.id || user.is_admin())
        .ok_or_else(|| ApiError::not_found("passkey"))?;
    let name = validate_passkey_name(Some(&body.name))?;
    db::auth::rename_passkey(&state.db, &row.id, &name).await?;
    let row = db::auth::passkey_by_id(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("passkey"))?;
    Ok(Json(row.public()))
}

pub async fn passkey_delete(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let row = db::auth::passkey_by_id(&state.db, &id)
        .await?
        .filter(|p| p.user_id == user.id || user.is_admin())
        .ok_or_else(|| ApiError::not_found("passkey"))?;
    let owner = if row.user_id == user.id {
        user.clone()
    } else {
        db::users::by_id(&state.db, &row.user_id)
            .await?
            .ok_or_else(|| ApiError::not_found("user"))?
    };
    if state.config.require_2fa.applies_to(owner.is_admin())
        && !owner.totp_enabled
        && owner.passkeys <= 1
    {
        return Err(ApiError::conflict(
            "policy_requires_2fa",
            "this is the only second factor and the policy requires one; add another first",
        ));
    }
    db::auth::delete_passkey(&state.db, &row.id).await?;
    db::audit::record(
        &state.db,
        Some(Actor {
            id: &user.id,
            name: &user.name,
        }),
        "passkey.remove",
        Some(&row.user_id),
        json!({ "passkey": row.id, "name": row.name }),
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

// ── passkey login (usernameless) ──────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
struct PasskeyLoginState {
    auth: DiscoverableAuthentication,
    ip: String,
}

pub async fn passkey_login_start(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    jar: CookieJar,
) -> ApiResult<Response> {
    let ip = state.client_ip(&headers, Some(&ConnectInfo(peer)));
    if let Some(wait) = state.limiter.blocked_for(&ip) {
        return Err(ApiError::rate_limited(
            "too many failed sign-in attempts, try again later",
            wait.as_secs() + 1,
        ));
    }
    let (rcr, auth_state) = state
        .auth
        .webauthn()?
        .start_discoverable_authentication()
        .map_err(|e| ApiError::internal(format!("webauthn: {e}")))?;
    let id = db::auth::put_state(
        &state.db,
        PASSKEY_LOGIN_KIND,
        None,
        &PasskeyLoginState {
            auth: auth_state,
            ip,
        },
        Duration::minutes(auth::PREAUTH_TTL_MINUTES),
    )
    .await?;
    let jar = jar.add(auth::preauth_cookie(state.config.is_https(), id.clone()));
    let mut body = serde_json::to_value(&rcr)?;
    if let Some(obj) = body.as_object_mut() {
        obj.insert("challenge_id".into(), json!(id));
    }
    Ok((jar, Json(body)).into_response())
}

pub async fn passkey_login_finish(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(body): Json<serde_json::Value>,
) -> ApiResult<Response> {
    let (challenge_id, cred): (Option<String>, PublicKeyCredential) = credential_from(body)?;
    let challenge_id = challenge_id
        .or_else(|| jar.get(auth::PREAUTH_COOKIE).map(|c| c.value().to_string()))
        .ok_or_else(challenge_expired)?;
    let row = db::auth::get_state(&state.db, &challenge_id, PASSKEY_LOGIN_KIND)
        .await?
        .ok_or_else(challenge_expired)?;
    let login: PasskeyLoginState = db::auth::decode_state(&row).ok_or_else(challenge_expired)?;
    db::auth::delete_state(&state.db, &challenge_id).await?;

    // The credential id identifies the key; the user handle (when the authenticator sends
    // one) must agree with the key's owner.
    let credential_id =
        passkeys::credential_id_string(&CredentialID::from(cred.get_credential_id().to_vec()));
    let (stored, user) = match db::auth::passkey_by_credential(&state.db, &credential_id).await? {
        Some(p) => {
            let u = db::users::by_id(&state.db, &p.user_id).await?;
            (Some(p), u)
        }
        None => (None, None),
    };
    let (Some(stored), Some(user)) = (stored, user) else {
        state.limiter.record_failure(&login.ip);
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "unknown_passkey",
            "this passkey is not registered",
        ));
    };
    if let Ok((handle, _)) = state
        .auth
        .webauthn()?
        .identify_discoverable_authentication(&cred)
    {
        if handle != passkeys::user_handle(&user.id) {
            state.limiter.record_failure(&login.ip);
            return Err(ApiError::new(
                StatusCode::UNAUTHORIZED,
                "unknown_passkey",
                "this passkey does not belong to the reported user",
            ));
        }
    }
    if user.disabled {
        return Err(invalid_credentials());
    }
    let mut passkey = passkeys::parse_passkey(&stored.passkey_json)?;
    let keys = [DiscoverableKey::from(&passkey)];
    let result = state
        .auth
        .webauthn()?
        .finish_discoverable_authentication(&cred, login.auth, &keys)
        .map_err(|e| {
            state.limiter.record_failure(&login.ip);
            ApiError::new(
                StatusCode::UNAUTHORIZED,
                "webauthn_failed",
                format!("passkey sign-in failed: {e}"),
            )
        })?;
    record_passkey_use(&state, &stored, &mut passkey, &result).await?;
    state.limiter.clear(&login.ip);
    let (jar, envelope) = complete_login(
        &state,
        jar,
        &user,
        AuthMethod::Passkey,
        &login.ip,
        json!({ "passkey": stored.id, "user_verified": result.user_verified() }),
    )
    .await?;
    Ok((jar, Json(envelope)).into_response())
}

/// Persist counter / backup-state changes after a successful assertion.
async fn record_passkey_use(
    state: &AppState,
    stored: &db::auth::PasskeyRow,
    passkey: &mut Passkey,
    result: &AuthenticationResult,
) -> ApiResult<()> {
    passkey.update_credential(result);
    db::auth::update_passkey_after_use(
        &state.db,
        &stored.id,
        &passkeys::passkey_json(passkey)?,
        result.counter() as i64,
        result.backup_state(),
    )
    .await?;
    Ok(())
}

// ── passkey as second factor ──────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct ChallengeBody {
    pub challenge_id: String,
}

pub async fn two_factor_passkey_start(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(body): Json<ChallengeBody>,
) -> ApiResult<Json<RequestChallengeResponse>> {
    let (mut challenge, user) = load_challenge(&state, &jar, &body.challenge_id).await?;
    let rows = db::auth::passkeys_for_user(&state.db, &user.id).await?;
    let keys: Vec<Passkey> = rows
        .iter()
        .filter_map(|r| passkeys::parse_passkey(&r.passkey_json).ok())
        .collect();
    if keys.is_empty() {
        return Err(ApiError::validation("no passkeys registered"));
    }
    let (rcr, auth_state) = state
        .auth
        .webauthn()?
        .start_passkey_authentication(&keys)
        .map_err(|e| ApiError::internal(format!("webauthn: {e}")))?;
    challenge.passkey_auth = Some(auth_state);
    db::auth::update_state(&state.db, &body.challenge_id, &challenge).await?;
    Ok(Json(rcr))
}

pub async fn two_factor_passkey_finish(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(body): Json<serde_json::Value>,
) -> ApiResult<Response> {
    let (challenge_id, cred): (Option<String>, PublicKeyCredential) = credential_from(body)?;
    let challenge_id = challenge_id
        .or_else(|| jar.get(auth::PREAUTH_COOKIE).map(|c| c.value().to_string()))
        .ok_or_else(challenge_expired)?;
    let (mut challenge, user) = load_challenge(&state, &jar, &challenge_id).await?;
    let Some(auth_state) = challenge.passkey_auth.take() else {
        return Err(ApiError::validation("start the passkey step first"));
    };
    let result = match state
        .auth
        .webauthn()?
        .finish_passkey_authentication(&cred, &auth_state)
    {
        Ok(r) => r,
        Err(e) => {
            tracing::debug!("second-factor passkey rejected: {e}");
            return Err(challenge_failed(&state, &challenge_id, challenge, &user).await);
        }
    };
    let credential_id = passkeys::credential_id_string(result.cred_id());
    let stored = db::auth::passkey_by_credential(&state.db, &credential_id)
        .await?
        .filter(|p| p.user_id == user.id)
        .ok_or_else(|| ApiError::not_found("passkey"))?;
    let mut passkey = passkeys::parse_passkey(&stored.passkey_json)?;
    record_passkey_use(&state, &stored, &mut passkey, &result).await?;
    finish_challenge(&state, jar, &challenge_id, &challenge, &user, "passkey").await
}

// ── providers ─────────────────────────────────────────────────────────────────

/// Public: which sign-in methods the login page should offer.
pub async fn providers(State(state): State<AppState>) -> ApiResult<Json<serde_json::Value>> {
    let oidc = crate::auth::oidc::load(&state.db).await?;
    let saml = crate::auth::saml::load(&state.db).await?;
    let ldap = crate::auth::ldap::load(&state.db).await?;
    let mail_ok = mail::is_configured(&state.db).await;
    let mut out = json!({
        "local_login": state.config.local_login,
        "passkeys": state.auth.webauthn.is_some(),
        "require_2fa": state.config.require_2fa.as_str(),
        "password_reset": state.config.local_login && mail_ok,
        "email_2fa": mail_ok,
    });
    if oidc.enabled {
        out["oidc"] = json!({ "display_name": oidc.display_name });
    }
    if saml.enabled {
        out["saml"] = json!({ "display_name": saml.display_name });
    }
    if ldap.enabled {
        out["ldap"] = json!({ "display_name": ldap.display_name });
    }
    Ok(Json(out))
}
