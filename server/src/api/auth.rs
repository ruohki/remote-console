//! First-run setup, login, logout, current user.

use crate::app::AppState;
use crate::auth::{self, AuthUser};
use crate::db::{self, audit::Actor, models::Role};
use crate::error::{ApiError, ApiResult};
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use axum_extra::extract::CookieJar;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::net::SocketAddr;

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
    db::users::set_last_login(&state.db, &user.id).await?;
    db::audit::record(
        &state.db,
        Some(Actor {
            id: &user.id,
            name: &user.name,
        }),
        "user.create",
        Some(&user.id),
        json!({ "email": user.email, "role": "admin", "setup": true }),
    )
    .await?;
    let sid = db::users::create_login_session(&state.db, &user.id, state.config.session_ttl_hours)
        .await?;
    let jar = jar.add(auth::session_cookie(
        state.config.is_https(),
        sid,
        state.config.session_ttl_hours,
    ));
    Ok((
        StatusCode::CREATED,
        jar,
        Json(UserEnvelope {
            user: user.public(),
        }),
    ))
}

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
) -> ApiResult<impl IntoResponse> {
    let ip = state.client_ip(&headers, Some(&ConnectInfo(peer)));
    let account = body.email.trim().to_lowercase();
    if state.limiter.is_blocked(&ip) || state.limits.login_account.is_blocked(&account) {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "too many failed login attempts, try again later",
        ));
    }

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

    if !ok {
        state.limiter.record_failure(&ip);
        state.limits.login_account.record_failure(&account);
        db::audit::record_lossy(
            &state.db,
            None,
            "login_failed",
            None,
            json!({ "email": body.email.trim().to_lowercase(), "ip": ip }),
        )
        .await;
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "invalid_credentials",
            "invalid email or password",
        ));
    }

    let user = user.ok_or_else(ApiError::unauthorized)?;
    state.limiter.clear(&ip);
    state.limits.login_account.clear(&account);
    // Session rotation: a cookie presented at login (fixation attempt or stale session) is
    // invalidated; the new session always gets a fresh id.
    if let Some(old) = jar.get(auth::SESSION_COOKIE).map(|c| c.value().to_string()) {
        let _ = db::users::delete_login_session(&state.db, &old).await;
    }
    db::users::set_last_login(&state.db, &user.id).await?;
    db::audit::record_lossy(
        &state.db,
        Some(Actor {
            id: &user.id,
            name: &user.name,
        }),
        "login",
        None,
        json!({ "ip": ip }),
    )
    .await;
    let sid = db::users::create_login_session(&state.db, &user.id, state.config.session_ttl_hours)
        .await?;
    let jar = jar.add(auth::session_cookie(
        state.config.is_https(),
        sid,
        state.config.session_ttl_hours,
    ));
    Ok((
        jar,
        Json(UserEnvelope {
            user: user.public(),
        }),
    ))
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
    let jar = jar.add(auth::clear_session_cookie(state.config.is_https()));
    Ok((StatusCode::NO_CONTENT, jar))
}

pub async fn me(AuthUser(user): AuthUser) -> Json<UserEnvelope> {
    Json(UserEnvelope {
        user: user.public(),
    })
}
