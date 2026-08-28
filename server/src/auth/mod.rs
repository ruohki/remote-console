//! Passwords, cookie sessions, role extractors, second factor policy, rate limiting and the
//! CSRF guard.

pub mod access;
pub mod ldap;
pub mod oidc;
pub mod passkeys;
pub mod saml;
pub mod sso;
pub mod totp;

use crate::app::AppState;
use crate::db::models::UserRow;
use crate::error::ApiError;
use argon2::password_hash::{phc::PasswordHash, PasswordHasher, PasswordVerifier};
use argon2::Argon2;
use axum::extract::{ConnectInfo, FromRequestParts, Request, State};
use axum::http::{header, request::Parts, HeaderMap, Method, StatusCode};
use axum::middleware::Next;
use axum::response::Response;
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::time::{Duration, Instant};

pub const SESSION_COOKIE: &str = "console_session";
/// Pre-authentication cookie set between a successful password check and the second factor
/// (also carries WebAuthn / SSO ceremony ids). Five minutes.
pub const PREAUTH_COOKIE: &str = "console_preauth";
pub const PREAUTH_TTL_MINUTES: i64 = 5;
pub const MIN_PASSWORD_LEN: usize = 10;

/// Routes a user in the `two_factor_required` state may still call (enrolment + sign-out).
const TWO_FACTOR_ALLOWLIST: &[&str] = &[
    "/api/auth/me",
    "/api/auth/logout",
    "/api/auth/2fa/setup",
    "/api/auth/2fa/enable",
    "/api/auth/passkeys/register/start",
    "/api/auth/passkeys/register/finish",
    "/api/auth/passkeys",
    "/api/auth/providers",
    "/api/branding",
    "/api/info",
];

/// Whether the second-factor policy blocks this user from `path` right now.
pub fn two_factor_blocks(config: &crate::config::Config, user: &UserRow, path: &str) -> bool {
    config.require_2fa.applies_to(user.is_admin())
        && !user.two_factor_enabled()
        && !TWO_FACTOR_ALLOWLIST.contains(&path)
}

pub fn two_factor_required_error() -> ApiError {
    ApiError::new(
        StatusCode::FORBIDDEN,
        "two_factor_required",
        "a second factor must be set up before using the console",
    )
}

// ── shared auth context ───────────────────────────────────────────────────────

/// Long-lived authentication helpers created at startup.
pub struct AuthContext {
    pub webauthn: webauthn_rs::Webauthn,
    pub oidc: oidc::OidcCache,
}

impl AuthContext {
    pub async fn new(config: &crate::config::Config, db: &crate::db::Db) -> anyhow::Result<Self> {
        let branding = crate::db::settings::branding(db).await?;
        Ok(Self {
            webauthn: passkeys::build(config, &branding.product_name)?,
            oidc: oidc::OidcCache::default(),
        })
    }
}

// ── passwords ─────────────────────────────────────────────────────────────────

/// argon2id hash in PHC string format.
pub fn hash_password(password: &str) -> anyhow::Result<String> {
    let hash = Argon2::default()
        .hash_password(password.as_bytes())
        .map_err(|e| anyhow::anyhow!("hashing password: {e}"))?;
    Ok(hash.to_string())
}

/// Constant-time verification; `false` for malformed hashes.
pub fn verify_password(password: &str, phc: &str) -> bool {
    match PasswordHash::new(phc) {
        Ok(parsed) => Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok(),
        Err(_) => false,
    }
}

/// Run the (CPU heavy) verification off the async runtime.
pub async fn verify_password_async(password: String, phc: String) -> bool {
    tokio::task::spawn_blocking(move || verify_password(&password, &phc))
        .await
        .unwrap_or(false)
}

pub fn validate_password(password: &str) -> Result<(), ApiError> {
    if password.chars().count() < MIN_PASSWORD_LEN {
        return Err(ApiError::validation(format!(
            "password must be at least {MIN_PASSWORD_LEN} characters"
        )));
    }
    if password.chars().count() > 256 {
        return Err(ApiError::validation("password is too long"));
    }
    Ok(())
}

pub fn validate_email(email: &str) -> Result<(), ApiError> {
    let e = email.trim();
    if e.len() < 3 || e.len() > 254 || !e.contains('@') || e.contains(char::is_whitespace) {
        return Err(ApiError::validation("invalid email address"));
    }
    Ok(())
}

// ── cookies ───────────────────────────────────────────────────────────────────

/// `SameSite=Lax` (not `Strict`) on purpose: top-level navigations to deep links from other
/// sites (a device link in a chat) must still carry the cookie. Cross-site *requests* are
/// blocked by [`csrf_guard`] (JSON content type + `Origin` check), so Lax loses nothing here.
pub fn session_cookie(secure: bool, session_id: String, ttl_hours: i64) -> Cookie<'static> {
    Cookie::build((SESSION_COOKIE, session_id))
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        .secure(secure)
        .max_age(time::Duration::hours(ttl_hours))
        .build()
}

pub fn preauth_cookie(secure: bool, state_id: String) -> Cookie<'static> {
    Cookie::build((PREAUTH_COOKIE, state_id))
        .path("/api/auth")
        .http_only(true)
        .same_site(SameSite::Lax)
        .secure(secure)
        .max_age(time::Duration::minutes(PREAUTH_TTL_MINUTES))
        .build()
}

pub fn clear_preauth_cookie(secure: bool) -> Cookie<'static> {
    Cookie::build((PREAUTH_COOKIE, ""))
        .path("/api/auth")
        .http_only(true)
        .same_site(SameSite::Lax)
        .secure(secure)
        .max_age(time::Duration::ZERO)
        .build()
}

pub fn clear_session_cookie(secure: bool) -> Cookie<'static> {
    Cookie::build((SESSION_COOKIE, ""))
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        .secure(secure)
        .max_age(time::Duration::ZERO)
        .build()
}

pub fn session_id_from_headers(headers: &HeaderMap) -> Option<String> {
    CookieJar::from_headers(headers)
        .get(SESSION_COOKIE)
        .map(|c| c.value().to_string())
        .filter(|v| !v.is_empty() && v.len() <= 128)
}

/// Resolve the current user from the request cookies.
pub async fn user_from_headers(state: &AppState, headers: &HeaderMap) -> Option<UserRow> {
    let sid = session_id_from_headers(headers)?;
    match crate::db::users::user_by_login_session(&state.db, &sid).await {
        Ok(user) => user,
        Err(err) => {
            tracing::error!("session lookup failed: {err}");
            None
        }
    }
}

// ── extractors ────────────────────────────────────────────────────────────────

/// Any logged-in, enabled user.
#[derive(Debug, Clone)]
pub struct AuthUser(pub UserRow);

/// A logged-in administrator.
#[derive(Debug, Clone)]
pub struct AdminUser(pub UserRow);

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let user = user_from_headers(state, &parts.headers)
            .await
            .ok_or_else(ApiError::unauthorized)?;
        if two_factor_blocks(&state.config, &user, parts.uri.path()) {
            return Err(two_factor_required_error());
        }
        Ok(AuthUser(user))
    }
}

/// A logged-in user that may still be in the `two_factor_required` state (enrolment routes).
#[derive(Debug, Clone)]
pub struct AnyAuthUser(pub UserRow);

impl FromRequestParts<AppState> for AnyAuthUser {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        user_from_headers(state, &parts.headers)
            .await
            .map(AnyAuthUser)
            .ok_or_else(ApiError::unauthorized)
    }
}

impl FromRequestParts<AppState> for AdminUser {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let AuthUser(user) = AuthUser::from_request_parts(parts, state).await?;
        if user.is_admin() {
            Ok(AdminUser(user))
        } else {
            Err(ApiError::forbidden())
        }
    }
}

impl AuthUser {
    pub fn actor(&self) -> crate::db::audit::Actor<'_> {
        crate::db::audit::Actor {
            id: &self.0.id,
            name: &self.0.name,
        }
    }
}

impl AdminUser {
    pub fn actor(&self) -> crate::db::audit::Actor<'_> {
        crate::db::audit::Actor {
            id: &self.0.id,
            name: &self.0.name,
        }
    }
}

// ── client IP ─────────────────────────────────────────────────────────────────

/// Client address for rate limiting and audit. Forwarding headers are only honoured when
/// `trust_proxy` is set (a reverse proxy in front of the console); otherwise anyone could
/// spoof `X-Forwarded-For` to dodge limits or forge audit entries.
pub fn client_ip(
    headers: &HeaderMap,
    peer: Option<&ConnectInfo<SocketAddr>>,
    trust_proxy: bool,
) -> String {
    if trust_proxy {
        if let Some(xff) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
            if let Some(first) = xff
                .split(',')
                .next()
                .map(str::trim)
                .filter(|s| !s.is_empty() && s.len() <= 64)
            {
                return first.to_string();
            }
        }
        if let Some(real) = headers.get("x-real-ip").and_then(|v| v.to_str().ok()) {
            let real = real.trim();
            if !real.is_empty() && real.len() <= 64 {
                return real.to_string();
            }
        }
    }
    peer.map(|c| c.0.ip().to_string())
        .unwrap_or_else(|| "unknown".into())
}

/// Whether the request arrived over TLS from the client's point of view.
pub fn request_is_https(headers: &HeaderMap, trust_proxy: bool, public_https: bool) -> bool {
    if trust_proxy {
        if let Some(proto) = headers
            .get("x-forwarded-proto")
            .and_then(|v| v.to_str().ok())
        {
            return proto
                .split(',')
                .next()
                .map(str::trim)
                .is_some_and(|p| p.eq_ignore_ascii_case("https"));
        }
    }
    public_https
}

// ── rate limiting ─────────────────────────────────────────────────────────────

/// Fixed-window counter per key: at most `max` events within `window`.
pub struct RateLimiter {
    max: u32,
    window: Duration,
    entries: Mutex<HashMap<String, (u32, Instant)>>,
}

impl RateLimiter {
    pub fn new(max: u32, window: Duration) -> Self {
        Self {
            max,
            window,
            entries: Mutex::new(HashMap::new()),
        }
    }

    /// Whether `key` has exhausted its budget (does not count).
    pub fn is_blocked(&self, key: &str) -> bool {
        self.blocked_for(key).is_some()
    }

    /// Remaining time of the current window when `key` is blocked.
    pub fn blocked_for(&self, key: &str) -> Option<Duration> {
        let mut map = self.entries.lock();
        match map.get(key) {
            Some((count, since)) if since.elapsed() < self.window => {
                (*count >= self.max).then(|| self.window.saturating_sub(since.elapsed()))
            }
            Some(_) => {
                map.remove(key);
                None
            }
            None => None,
        }
    }

    /// Count one event; returns `false` when the budget is exhausted (the event is rejected).
    pub fn check(&self, key: &str) -> bool {
        let mut map = self.entries.lock();
        let entry = map.entry(key.to_string()).or_insert((0, Instant::now()));
        if entry.1.elapsed() >= self.window {
            *entry = (0, Instant::now());
        }
        entry.0 += 1;
        let ok = entry.0 <= self.max;
        if map.len() > 20_000 {
            let window = self.window;
            map.retain(|_, (_, since)| since.elapsed() < window);
        }
        ok
    }

    pub fn record_failure(&self, key: &str) {
        let _ = self.check(key);
    }

    pub fn clear(&self, key: &str) {
        self.entries.lock().remove(key);
    }
}

/// Per-IP login failure limiter (kept as its own type for the existing state field).
pub struct LoginLimiter(RateLimiter);

impl Default for LoginLimiter {
    fn default() -> Self {
        Self::new(10, Duration::from_secs(15 * 60))
    }
}

impl LoginLimiter {
    pub fn new(max_failures: u32, window: Duration) -> Self {
        Self(RateLimiter::new(max_failures, window))
    }
    pub fn is_blocked(&self, ip: &str) -> bool {
        self.0.is_blocked(ip)
    }
    pub fn blocked_for(&self, ip: &str) -> Option<Duration> {
        self.0.blocked_for(ip)
    }
    pub fn record_failure(&self, ip: &str) {
        self.0.record_failure(ip)
    }
    pub fn clear(&self, ip: &str) {
        self.0.clear(ip)
    }
}

/// Exponential backoff per key: after `threshold` consecutive failures the key is blocked
/// for `base`, doubling with every further failure up to `max`. Success clears it.
pub struct BackoffLimiter {
    threshold: u32,
    base: Duration,
    max: Duration,
    entries: Mutex<HashMap<String, (u32, Option<Instant>)>>,
}

impl BackoffLimiter {
    pub fn new(threshold: u32, base: Duration, max: Duration) -> Self {
        Self {
            threshold,
            base,
            max,
            entries: Mutex::new(HashMap::new()),
        }
    }

    /// Remaining block time for `key`, if blocked.
    pub fn blocked_for(&self, key: &str) -> Option<Duration> {
        let map = self.entries.lock();
        let (_, until) = map.get(key)?;
        let until = (*until)?;
        let now = Instant::now();
        (until > now).then(|| until - now)
    }

    pub fn is_blocked(&self, key: &str) -> bool {
        self.blocked_for(key).is_some()
    }

    pub fn record_failure(&self, key: &str) {
        let mut map = self.entries.lock();
        let entry = map.entry(key.to_string()).or_insert((0, None));
        entry.0 = entry.0.saturating_add(1);
        if entry.0 >= self.threshold {
            let exp = (entry.0 - self.threshold).min(16);
            let delay = self.base.saturating_mul(1u32 << exp).min(self.max);
            entry.1 = Some(Instant::now() + delay);
        }
        if map.len() > 20_000 {
            map.retain(|_, (_, until)| until.is_some_and(|u| u > Instant::now()));
        }
    }

    pub fn clear(&self, key: &str) {
        self.entries.lock().remove(key);
    }
}

/// All request limiters, keyed by client IP / account / token.
pub struct Limits {
    /// Failed logins per IP.
    pub login_ip: LoginLimiter,
    /// Failed logins per account (email), exponential backoff.
    pub login_account: BackoffLimiter,
    /// Enrollment attempts per IP.
    pub enroll_ip: RateLimiter,
    /// Enrollment attempts per token hash.
    pub enroll_token: RateLimiter,
    /// Agent downloads (bakes) per IP.
    pub download_ip: RateLimiter,
    /// Failed agent WebSocket hellos per IP.
    pub agent_hello_ip: BackoffLimiter,
    /// Bound on concurrent argon2 verifications (agent hellos + logins).
    pub verify_slots: tokio::sync::Semaphore,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            login_ip: LoginLimiter::default(),
            login_account: BackoffLimiter::new(
                5,
                Duration::from_secs(60),
                Duration::from_secs(60 * 60),
            ),
            enroll_ip: RateLimiter::new(10, Duration::from_secs(60)),
            enroll_token: RateLimiter::new(10, Duration::from_secs(60)),
            download_ip: RateLimiter::new(10, Duration::from_secs(60)),
            agent_hello_ip: BackoffLimiter::new(
                10,
                Duration::from_secs(60),
                Duration::from_secs(15 * 60),
            ),
            verify_slots: tokio::sync::Semaphore::new(4),
        }
    }
}

/// Parse an IP string (used for tests / logging).
pub fn parse_ip(s: &str) -> Option<IpAddr> {
    s.parse().ok()
}

// ── CSRF guard ────────────────────────────────────────────────────────────────

/// Cross-site request protection for the cookie-authenticated surface:
///
/// * mutating `/api` requests must be JSON (a non-JSON `Content-Type`, or a body without
///   one, is rejected with 415 — forms cannot produce that);
/// * when the browser sends an `Origin` header on a mutating `/api` request or on the UI
///   WebSocket upgrade, it must match the console's own origin (public URL or the request
///   `Host`). Requests without `Origin` (agents, curl) are unaffected — they carry no cookie.
pub async fn csrf_guard(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let path = req.uri().path();
    let mutating = matches!(
        *req.method(),
        Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    );
    // The SAML assertion consumer service receives a cross-site HTML form POST from the
    // identity provider by design; it is protected by the assertion signature instead.
    let saml_acs = path == "/api/auth/saml/acs";
    let api_mutation = mutating && path.starts_with("/api/") && !saml_acs;
    let ui_ws = path == protocol::UI_WS_PATH;

    if api_mutation {
        let content_type = req
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_ascii_lowercase());
        let has_body = req
            .headers()
            .get(header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .map(|n| n > 0)
            .unwrap_or_else(|| req.headers().contains_key(header::TRANSFER_ENCODING));
        let ok = match content_type {
            Some(ct) => ct.starts_with("application/json"),
            None => !has_body,
        };
        if !ok {
            return ApiError::new(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "unsupported_media_type",
                "requests must use Content-Type: application/json",
            )
            .into_response_pub();
        }
    }

    if api_mutation || ui_ws {
        if let Some(origin) = req
            .headers()
            .get(header::ORIGIN)
            .and_then(|v| v.to_str().ok())
        {
            if !origin_allowed(origin, req.headers(), &state.config.public_origin()) {
                tracing::warn!(%origin, %path, "cross-origin request rejected");
                return ApiError::new(
                    StatusCode::FORBIDDEN,
                    "cross_origin",
                    "cross-origin requests are not allowed",
                )
                .into_response_pub();
            }
        }
    }

    next.run(req).await
}

/// `Origin` must match the public origin or the request's own `Host` (any scheme).
fn origin_allowed(origin: &str, headers: &HeaderMap, public_origin: &str) -> bool {
    if origin.eq_ignore_ascii_case("null") {
        return false;
    }
    if !public_origin.is_empty() && origin.eq_ignore_ascii_case(public_origin) {
        return true;
    }
    let origin_host = url::Url::parse(origin)
        .ok()
        .and_then(|u| {
            u.host_str().map(|h| match u.port() {
                Some(p) => format!("{h}:{p}"),
                None => h.to_string(),
            })
        })
        .unwrap_or_default();
    if origin_host.is_empty() {
        return false;
    }
    let host = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .trim();
    // Compare host[:port] with default ports normalised away.
    normalise_host(&origin_host) == normalise_host(host)
}

fn normalise_host(h: &str) -> String {
    let h = h.to_ascii_lowercase();
    h.trim_end_matches(":443")
        .trim_end_matches(":80")
        .to_string()
}

impl ApiError {
    fn into_response_pub(self) -> Response {
        axum::response::IntoResponse::into_response(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_hash_roundtrip() {
        let h = hash_password("correct horse battery").unwrap();
        assert!(h.starts_with("$argon2id$"));
        assert!(verify_password("correct horse battery", &h));
        assert!(!verify_password("wrong", &h));
        assert!(!verify_password("x", "not-a-hash"));
    }

    #[test]
    fn limiter_blocks_after_threshold() {
        let l = LoginLimiter::new(3, Duration::from_secs(60));
        assert!(!l.is_blocked("1.2.3.4"));
        for _ in 0..3 {
            l.record_failure("1.2.3.4");
        }
        assert!(l.is_blocked("1.2.3.4"));
        assert!(!l.is_blocked("5.6.7.8"));
        l.clear("1.2.3.4");
        assert!(!l.is_blocked("1.2.3.4"));
    }

    #[test]
    fn limiter_window_expires() {
        let l = LoginLimiter::new(1, Duration::from_millis(1));
        l.record_failure("a");
        std::thread::sleep(Duration::from_millis(5));
        assert!(!l.is_blocked("a"));
    }

    #[test]
    fn rate_limiter_counts_and_rejects() {
        let l = RateLimiter::new(2, Duration::from_secs(60));
        assert!(l.check("k"));
        assert!(l.check("k"));
        assert!(!l.check("k"), "third event in the window is rejected");
        assert!(l.is_blocked("k"));
        assert!(l.check("other"));
    }

    #[test]
    fn backoff_doubles_and_clears() {
        let l = BackoffLimiter::new(2, Duration::from_millis(100), Duration::from_millis(350));
        l.record_failure("acct");
        assert!(!l.is_blocked("acct"), "below threshold");
        l.record_failure("acct");
        let first = l.blocked_for("acct").expect("blocked at threshold");
        assert!(first <= Duration::from_millis(100));
        l.record_failure("acct");
        let second = l.blocked_for("acct").expect("still blocked");
        assert!(second > first, "delay doubles");
        for _ in 0..5 {
            l.record_failure("acct");
        }
        assert!(
            l.blocked_for("acct").unwrap() <= Duration::from_millis(350),
            "capped"
        );
        l.clear("acct");
        assert!(!l.is_blocked("acct"));
    }

    #[test]
    fn client_ip_only_trusts_forwarding_when_told() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", "203.0.113.9, 10.0.0.1".parse().unwrap());
        let peer = ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 5)));
        assert_eq!(client_ip(&headers, Some(&peer), true), "203.0.113.9");
        assert_eq!(
            client_ip(&headers, Some(&peer), false),
            "127.0.0.1",
            "spoofed header ignored without TRUST_PROXY"
        );
        assert_eq!(client_ip(&HeaderMap::new(), Some(&peer), true), "127.0.0.1");
        assert!(parse_ip("203.0.113.9").is_some());
        let mut h = HeaderMap::new();
        h.insert("x-forwarded-proto", "https".parse().unwrap());
        assert!(request_is_https(&h, true, false));
        assert!(!request_is_https(&h, false, false));
    }

    #[test]
    fn cookie_attributes() {
        let c = session_cookie(true, "abc".into(), 1);
        assert_eq!(c.name(), SESSION_COOKIE);
        assert_eq!(c.secure(), Some(true));
        assert_eq!(c.http_only(), Some(true));
        assert_eq!(c.same_site(), Some(SameSite::Lax));
    }

    #[test]
    fn origin_policy() {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, "console.example.com".parse().unwrap());
        assert!(origin_allowed(
            "https://console.example.com",
            &headers,
            "https://console.example.com"
        ));
        assert!(origin_allowed(
            "https://console.example.com:443",
            &headers,
            ""
        ));
        assert!(!origin_allowed(
            "https://evil.example",
            &headers,
            "https://console.example.com"
        ));
        assert!(!origin_allowed(
            "null",
            &headers,
            "https://console.example.com"
        ));
        let mut local = HeaderMap::new();
        local.insert(header::HOST, "localhost:8080".parse().unwrap());
        assert!(origin_allowed(
            "http://localhost:8080",
            &local,
            "http://localhost:8080"
        ));
        assert!(!origin_allowed(
            "http://localhost:9999",
            &local,
            "http://localhost:8080"
        ));
    }
}
