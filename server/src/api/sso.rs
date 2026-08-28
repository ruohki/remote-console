//! OIDC, SAML and LDAP sign-in plus their admin configuration endpoints.
//!
//! Browser redirect flows (OIDC callback, SAML ACS) end in a redirect: to `return_to` with a
//! session cookie, to the login page with a pending second-factor challenge, or to the login
//! page with `?error=` when the identity provider response was rejected.

use super::auth::{complete_login, pending_response, start_challenge};
use crate::app::AppState;
use crate::auth::{self, ldap, oidc, saml, sso, AdminUser};
use crate::db::{self, models::AuthMethod};
use crate::error::{ApiError, ApiResult};
use axum::extract::{ConnectInfo, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Redirect, Response};
use axum::{Form, Json};
use axum_extra::extract::CookieJar;
use serde::Deserialize;
use serde_json::json;
use std::net::SocketAddr;

// ── shared completion ─────────────────────────────────────────────────────────

/// Where a finished SSO login goes: a session, or a second-factor challenge first.
enum Outcome {
    Session(CookieJar, super::auth::UserEnvelope),
    Challenge(CookieJar, db::models::UserRow, String),
}

async fn finish_sso(
    state: &AppState,
    jar: CookieJar,
    login: sso::SsoLogin,
    method: AuthMethod,
    ip: &str,
    return_to: &str,
) -> ApiResult<Outcome> {
    let user = login.user;
    if user.two_factor_enabled() && !login.mfa_satisfied {
        let id = start_challenge(state, &user, method, ip, Some(return_to.to_string())).await?;
        let jar = jar.add(auth::preauth_cookie(state.config.is_https(), id.clone()));
        return Ok(Outcome::Challenge(jar, user, id));
    }
    let (jar, envelope) = complete_login(
        state,
        jar,
        &user,
        method,
        ip,
        json!({
            "provisioned": login.provisioned,
            "linked": login.linked,
            "idp_mfa": login.mfa_satisfied,
        }),
    )
    .await?;
    Ok(Outcome::Session(jar, envelope))
}

/// Browser flows: turn the outcome into a redirect.
fn redirect_outcome(outcome: Outcome, return_to: &str) -> Response {
    match outcome {
        Outcome::Session(jar, _) => (jar, Redirect::to(return_to)).into_response(),
        Outcome::Challenge(jar, user, id) => {
            let methods = super::auth::second_factor_methods(&user).join(",");
            let target = format!(
                "/login?pending=two_factor&challenge_id={}&methods={}&return={}",
                urlenc(&id),
                urlenc(&methods),
                urlenc(return_to)
            );
            (jar, Redirect::to(&target)).into_response()
        }
    }
}

/// Browser flows: a rejected response becomes `/login?error=…`.
fn redirect_error(state: &AppState, provider: &str, err: ApiError) -> Response {
    tracing::warn!(
        provider,
        code = err.code,
        "SSO sign-in rejected: {}",
        err.message
    );
    let jar = CookieJar::new().add(auth::clear_preauth_cookie(state.config.is_https()));
    let target = format!(
        "/login?error={}&provider={}&message={}",
        urlenc(err.code),
        urlenc(provider),
        urlenc(&err.message)
    );
    (jar, Redirect::to(&target)).into_response()
}

fn urlenc(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

fn client_ip(state: &AppState, headers: &HeaderMap, peer: SocketAddr) -> String {
    state.client_ip(headers, Some(&ConnectInfo(peer)))
}

fn audit_config(provider: &str, cfg: &serde_json::Value) -> serde_json::Value {
    let mut v = cfg.clone();
    if let Some(obj) = v.as_object_mut() {
        obj.remove("client_secret");
        obj.remove("client_secret_enc");
        obj.remove("bind_password");
        obj.remove("bind_password_enc");
        obj.remove("idp_metadata_xml");
        obj.insert("provider".into(), json!(provider));
    }
    v
}

#[derive(Deserialize)]
pub struct StartQuery {
    #[serde(default, rename = "return")]
    pub return_to: Option<String>,
}

#[derive(Deserialize)]
pub struct MappingTestBody {
    #[serde(default)]
    pub groups: Vec<String>,
}

fn mapping_report(policy: &sso::ProviderPolicy, groups: &[String]) -> serde_json::Value {
    let outcome = sso::evaluate(&policy.mappings, groups);
    let effective_role = outcome.role.or(match policy.default_role {
        sso::DefaultRole::Operator => Some(db::models::Role::Operator),
        sso::DefaultRole::Admin => Some(db::models::Role::Admin),
        sso::DefaultRole::None => None,
    });
    json!({
        "role": outcome.role,
        "effective_role": effective_role,
        "rejected": effective_role.is_none(),
        "grants": outcome.grants.iter().map(|(g, p)| json!({ "group_id": g, "permission": p })).collect::<Vec<_>>(),
        "matched": outcome.matched,
        "sync_mode": policy.sync_mode,
    })
}

// ── OIDC ──────────────────────────────────────────────────────────────────────

pub async fn oidc_start(
    State(state): State<AppState>,
    jar: CookieJar,
    Query(q): Query<StartQuery>,
) -> ApiResult<Response> {
    let cfg = oidc::load(&state.db).await?;
    if !cfg.enabled {
        return Err(ApiError::not_found("OIDC provider"));
    }
    let return_to = sso::safe_return(q.return_to.as_deref());
    let (state_id, url) = oidc::start(&state, &cfg, return_to).await?;
    let jar = jar.add(auth::preauth_cookie(state.config.is_https(), state_id));
    Ok((jar, Redirect::to(&url)).into_response())
}

#[derive(Deserialize)]
pub struct OidcCallbackQuery {
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub error_description: Option<String>,
}

pub async fn oidc_callback(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    jar: CookieJar,
    Query(q): Query<OidcCallbackQuery>,
) -> Response {
    match oidc_callback_inner(&state, &headers, peer, jar, q).await {
        Ok(r) => r,
        Err(e) => redirect_error(&state, "oidc", e),
    }
}

async fn oidc_callback_inner(
    state: &AppState,
    headers: &HeaderMap,
    peer: SocketAddr,
    jar: CookieJar,
    q: OidcCallbackQuery,
) -> ApiResult<Response> {
    let cfg = oidc::load(&state.db).await?;
    if !cfg.enabled {
        return Err(ApiError::not_found("OIDC provider"));
    }
    if let Some(err) = q.error {
        return Err(oidc::provider_error(format!(
            "{err}: {}",
            q.error_description.unwrap_or_default()
        )));
    }
    let (code, state_id) = match (q.code, q.state) {
        (Some(c), Some(s)) => (c, s),
        _ => return Err(ApiError::validation("missing code or state")),
    };
    if jar.get(auth::PREAUTH_COOKIE).map(|c| c.value()) != Some(state_id.as_str()) {
        return Err(oidc::provider_error(
            "the sign-in attempt does not belong to this browser session; start again",
        ));
    }
    let (identity, return_to) = oidc::finish(state, &cfg, &state_id, &code).await?;
    let policy = oidc::effective_policy(&cfg);
    let login = sso::login(state, &identity, &policy).await?;
    let ip = client_ip(state, headers, peer);
    let outcome = finish_sso(state, jar, login, AuthMethod::Oidc, &ip, &return_to).await?;
    Ok(redirect_outcome(outcome, &return_to))
}

pub async fn oidc_config_get(
    State(state): State<AppState>,
    _admin: AdminUser,
) -> ApiResult<Json<oidc::OidcConfigPublic>> {
    let cfg = oidc::load(&state.db).await?;
    Ok(Json(cfg.public(&state.config)))
}

pub async fn oidc_config_put(
    State(state): State<AppState>,
    admin: AdminUser,
    Json(input): Json<oidc::OidcConfigInput>,
) -> ApiResult<Json<oidc::OidcConfigPublic>> {
    let existing = oidc::load(&state.db).await?;
    let cfg = oidc::merge_input(&existing, input, &state.config)?;
    oidc::store(&state.db, &cfg).await?;
    let public = cfg.public(&state.config);
    db::audit::record(
        &state.db,
        Some(admin.actor()),
        "auth.config",
        None,
        audit_config("oidc", &serde_json::to_value(&public)?),
    )
    .await?;
    Ok(Json(public))
}

/// Discovery against the stored (or supplied) issuer; reports the endpoints.
pub async fn oidc_test(
    State(state): State<AppState>,
    _admin: AdminUser,
    body: Option<Json<oidc::OidcConfigInput>>,
) -> ApiResult<Json<serde_json::Value>> {
    let existing = oidc::load(&state.db).await?;
    let cfg = match body {
        Some(Json(input)) => oidc::merge_input(&existing, input, &state.config)?,
        None => existing,
    };
    if cfg.issuer.is_empty() {
        return Err(ApiError::validation("issuer is not configured"));
    }
    let doc = state
        .auth
        .oidc
        .discover(&cfg.issuer)
        .await
        .map_err(|e| oidc::provider_error(format!("discovery failed: {e:#}")))?;
    let jwks = state
        .auth
        .oidc
        .jwks(&doc.jwks_uri, true)
        .await
        .map_err(|e| oidc::provider_error(format!("JWKS fetch failed: {e:#}")))?;
    Ok(Json(json!({
        "ok": true,
        "issuer": doc.issuer,
        "authorization_endpoint": doc.authorization_endpoint,
        "token_endpoint": doc.token_endpoint,
        "userinfo_endpoint": doc.userinfo_endpoint,
        "jwks_uri": doc.jwks_uri,
        "jwks_keys": jwks.keys.len(),
        "redirect_uri": oidc::redirect_uri(&state.config),
        "client_secret_set": cfg.client_secret_enc.is_some(),
    })))
}

pub async fn oidc_test_mapping(
    State(state): State<AppState>,
    _admin: AdminUser,
    Json(body): Json<MappingTestBody>,
) -> ApiResult<Json<serde_json::Value>> {
    let cfg = oidc::load(&state.db).await?;
    Ok(Json(mapping_report(
        &oidc::effective_policy(&cfg),
        &body.groups,
    )))
}

// ── SAML ──────────────────────────────────────────────────────────────────────

pub async fn saml_metadata(State(state): State<AppState>) -> ApiResult<Response> {
    let cfg = saml::load(&state.db).await?;
    let cert = if cfg.sign_requests {
        Some(saml::sp_keys(&state).await?.cert_pem)
    } else {
        None
    };
    let xml = saml::sp_metadata_xml(&state.config, &cfg, cert.as_deref());
    Ok((
        [(header::CONTENT_TYPE, "application/samlmetadata+xml")],
        xml,
    )
        .into_response())
}

pub async fn saml_start(
    State(state): State<AppState>,
    jar: CookieJar,
    Query(q): Query<StartQuery>,
) -> ApiResult<Response> {
    let cfg = saml::load(&state.db).await?;
    if !cfg.enabled {
        return Err(ApiError::not_found("SAML provider"));
    }
    let return_to = sso::safe_return(q.return_to.as_deref());
    let (state_id, url) = saml::start(&state, &cfg, return_to).await?;
    let jar = jar.add(auth::preauth_cookie(state.config.is_https(), state_id));
    Ok((jar, Redirect::to(&url)).into_response())
}

#[derive(Deserialize)]
pub struct AcsForm {
    #[serde(rename = "SAMLResponse")]
    pub saml_response: String,
    #[serde(default, rename = "RelayState")]
    pub relay_state: Option<String>,
}

pub async fn saml_acs(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    jar: CookieJar,
    Form(form): Form<AcsForm>,
) -> Response {
    match saml_acs_inner(&state, &headers, peer, jar, form).await {
        Ok(r) => r,
        Err(e) => redirect_error(&state, "saml", e),
    }
}

async fn saml_acs_inner(
    state: &AppState,
    headers: &HeaderMap,
    peer: SocketAddr,
    jar: CookieJar,
    form: AcsForm,
) -> ApiResult<Response> {
    let cfg = saml::load(&state.db).await?;
    if !cfg.enabled {
        return Err(ApiError::not_found("SAML provider"));
    }
    let relay = form
        .relay_state
        .as_deref()
        .filter(|r| r.starts_with("ast_"));
    let result = saml::consume(state, &cfg, &form.saml_response, relay).await?;
    let policy = cfg.effective_policy();
    let login = sso::login(state, &result.identity, &policy).await?;
    let ip = client_ip(state, headers, peer);
    let outcome = finish_sso(state, jar, login, AuthMethod::Saml, &ip, &result.return_to).await?;
    Ok(redirect_outcome(outcome, &result.return_to))
}

pub async fn saml_config_get(
    State(state): State<AppState>,
    _admin: AdminUser,
) -> ApiResult<Json<saml::SamlConfigPublic>> {
    let cfg = saml::load(&state.db).await?;
    Ok(Json(saml::public_view(&state, &cfg).await?))
}

fn validate_saml(cfg: &mut saml::SamlConfig) -> ApiResult<()> {
    let name = cfg.display_name.trim();
    if name.is_empty() || name.len() > 60 {
        return Err(ApiError::validation("display_name must be 1–60 characters"));
    }
    cfg.display_name = name.to_string();
    if let Some(xml) = cfg.idp_metadata_xml.as_deref() {
        if xml.trim().is_empty() {
            cfg.idp_metadata_xml = None;
        } else {
            saml::parse_idp_metadata(xml)
                .map_err(|e| ApiError::validation(format!("IdP metadata: {e:#}")))?;
        }
    }
    if cfg.enabled && cfg.idp_metadata_xml.is_none() {
        return Err(ApiError::validation(
            "IdP metadata (XML or URL) is required to enable SAML",
        ));
    }
    Ok(())
}

pub async fn saml_config_put(
    State(state): State<AppState>,
    admin: AdminUser,
    Json(mut cfg): Json<saml::SamlConfig>,
) -> ApiResult<Json<saml::SamlConfigPublic>> {
    if let Some(url) = cfg
        .idp_metadata_url
        .as_deref()
        .map(str::trim)
        .filter(|u| !u.is_empty())
    {
        let xml = saml::fetch_metadata(url)
            .await
            .map_err(|e| ApiError::validation(format!("fetching IdP metadata: {e:#}")))?;
        cfg.idp_metadata_xml = Some(xml);
    }
    validate_saml(&mut cfg)?;
    if cfg.enabled || cfg.sign_requests {
        saml::sp_keys(&state).await?;
    }
    saml::store(&state.db, &cfg).await?;
    let view = saml::public_view(&state, &cfg).await?;
    db::audit::record(
        &state.db,
        Some(admin.actor()),
        "auth.config",
        None,
        audit_config("saml", &serde_json::to_value(&cfg)?),
    )
    .await?;
    Ok(Json(view))
}

/// Parse the stored (or supplied) IdP metadata and make sure SP keys exist.
pub async fn saml_test(
    State(state): State<AppState>,
    _admin: AdminUser,
    body: Option<Json<saml::SamlConfig>>,
) -> ApiResult<Json<serde_json::Value>> {
    let mut cfg = match body {
        Some(Json(c)) => c,
        None => saml::load(&state.db).await?,
    };
    if let Some(url) = cfg
        .idp_metadata_url
        .as_deref()
        .map(str::trim)
        .filter(|u| !u.is_empty())
    {
        cfg.idp_metadata_xml = Some(
            saml::fetch_metadata(url)
                .await
                .map_err(|e| ApiError::validation(format!("fetching IdP metadata: {e:#}")))?,
        );
    }
    let xml = cfg
        .idp_metadata_xml
        .as_deref()
        .ok_or_else(|| ApiError::validation("IdP metadata is not configured"))?;
    let meta = saml::parse_idp_metadata(xml)
        .map_err(|e| ApiError::validation(format!("IdP metadata: {e:#}")))?;
    let keys = saml::sp_keys(&state).await?;
    Ok(Json(json!({
        "ok": true,
        "idp": { "entity_id": meta.entity_id, "sso_url": meta.sso_redirect_url, "certificates": meta.certificates_der.len() },
        "sp_entity_id": cfg.sp_entity_id(&state.config),
        "acs_url": saml::acs_url(&state.config),
        "sp_certificate_pem": keys.cert_pem,
    })))
}

pub async fn saml_test_mapping(
    State(state): State<AppState>,
    _admin: AdminUser,
    Json(body): Json<MappingTestBody>,
) -> ApiResult<Json<serde_json::Value>> {
    let cfg = saml::load(&state.db).await?;
    Ok(Json(mapping_report(&cfg.effective_policy(), &body.groups)))
}

// ── LDAP ──────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct LdapLoginBody {
    pub username: String,
    pub password: String,
}

pub async fn ldap_login(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(body): Json<LdapLoginBody>,
) -> ApiResult<Response> {
    let cfg = ldap::load(&state.db).await?;
    if !cfg.enabled {
        return Err(ApiError::not_found("LDAP provider"));
    }
    let ip = client_ip(&state, &headers, peer);
    let account = format!("ldap:{}", body.username.trim().to_lowercase());
    super::auth::check_login_limits(&state, &ip, &account)?;
    let result = ldap::authenticate(&state.config, &cfg, &body.username, &body.password)
        .await
        .map_err(|e| {
            tracing::warn!("LDAP sign-in error: {e:#}");
            ApiError::new(
                StatusCode::BAD_GATEWAY,
                "sso_provider_error",
                "the directory could not be reached or rejected the service account",
            )
        })?;
    let identity = match result {
        ldap::LdapLogin::Ok(identity) => identity,
        ldap::LdapLogin::BadCredentials => {
            super::auth::record_login_failure(&state, &ip, &account);
            db::audit::record_lossy(
                &state.db,
                None,
                "login_failed",
                None,
                json!({ "username": body.username.trim(), "ip": ip, "method": "ldap" }),
            )
            .await;
            return Err(ApiError::new(
                StatusCode::UNAUTHORIZED,
                "invalid_credentials",
                "invalid username or password",
            ));
        }
    };
    super::auth::clear_login_failures(&state, &ip, &account);
    let login = sso::login(&state, &identity, &cfg.effective_policy()).await?;
    match finish_sso(&state, jar, login, AuthMethod::Ldap, &ip, "/devices").await? {
        Outcome::Session(jar, envelope) => Ok((jar, Json(envelope)).into_response()),
        Outcome::Challenge(jar, user, id) => Ok(pending_response(&state, jar, &user, id)),
    }
}

pub async fn ldap_config_get(
    State(state): State<AppState>,
    _admin: AdminUser,
) -> ApiResult<Json<ldap::LdapConfigPublic>> {
    let cfg = ldap::load(&state.db).await?;
    Ok(Json(ldap::public_view(&cfg)))
}

pub async fn ldap_config_put(
    State(state): State<AppState>,
    admin: AdminUser,
    Json(input): Json<ldap::LdapConfigInput>,
) -> ApiResult<Json<ldap::LdapConfigPublic>> {
    let existing = ldap::load(&state.db).await?;
    let cfg = ldap::merge_input(&state.config, &existing, input)?;
    ldap::store(&state.db, &cfg).await?;
    let view = ldap::public_view(&cfg);
    db::audit::record(
        &state.db,
        Some(admin.actor()),
        "auth.config",
        None,
        audit_config("ldap", &serde_json::to_value(&view)?),
    )
    .await?;
    Ok(Json(view))
}

pub async fn ldap_test(
    State(state): State<AppState>,
    _admin: AdminUser,
    body: Option<Json<ldap::LdapConfigInput>>,
) -> ApiResult<Json<serde_json::Value>> {
    let existing = ldap::load(&state.db).await?;
    let cfg = match body {
        Some(Json(input)) => ldap::merge_input(&state.config, &existing, input)?,
        None => existing,
    };
    if cfg.url.is_empty() {
        return Err(ApiError::validation("url is not configured"));
    }
    let detail = ldap::test_connection(&state.config, &cfg)
        .await
        .map_err(|e| {
            ApiError::new(
                StatusCode::BAD_GATEWAY,
                "sso_provider_error",
                format!("{e:#}"),
            )
        })?;
    Ok(Json(json!({ "ok": true, "detail": detail })))
}

pub async fn ldap_test_mapping(
    State(state): State<AppState>,
    _admin: AdminUser,
    Json(body): Json<MappingTestBody>,
) -> ApiResult<Json<serde_json::Value>> {
    let cfg = ldap::load(&state.db).await?;
    Ok(Json(mapping_report(&cfg.effective_policy(), &body.groups)))
}
