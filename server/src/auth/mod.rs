//! Passwords, cookie sessions, role extractors, login rate limiting and the JSON guard.

use crate::app::AppState;
use crate::db::models::UserRow;
use crate::error::ApiError;
use argon2::password_hash::{phc::PasswordHash, PasswordHasher, PasswordVerifier};
use argon2::Argon2;
use axum::extract::{ConnectInfo, FromRequestParts, Request};
use axum::http::{header, request::Parts, HeaderMap, Method, StatusCode};
use axum::middleware::Next;
use axum::response::Response;
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::time::{Duration, Instant};

pub const SESSION_COOKIE: &str = "console_session";
pub const MIN_PASSWORD_LEN: usize = 10;

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
    Ok(())
}

pub fn validate_email(email: &str) -> Result<(), ApiError> {
    let e = email.trim();
    if e.len() < 3 || !e.contains('@') || e.contains(char::is_whitespace) {
        return Err(ApiError::validation("invalid email address"));
    }
    Ok(())
}

// ── cookies ───────────────────────────────────────────────────────────────────

pub fn session_cookie(secure: bool, session_id: String, ttl_hours: i64) -> Cookie<'static> {
    Cookie::build((SESSION_COOKIE, session_id))
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        .secure(secure)
        .max_age(time::Duration::hours(ttl_hours))
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
        .filter(|v| !v.is_empty())
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
        user_from_headers(state, &parts.headers)
            .await
            .map(AuthUser)
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

/// Best-effort client address: first `X-Forwarded-For` entry, else the socket peer.
pub fn client_ip(headers: &HeaderMap, peer: Option<&ConnectInfo<SocketAddr>>) -> String {
    if let Some(xff) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
        if let Some(first) = xff
            .split(',')
            .next()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            return first.to_string();
        }
    }
    if let Some(real) = headers.get("x-real-ip").and_then(|v| v.to_str().ok()) {
        if !real.trim().is_empty() {
            return real.trim().to_string();
        }
    }
    peer.map(|c| c.0.ip().to_string())
        .unwrap_or_else(|| "unknown".into())
}

// ── login rate limiting ───────────────────────────────────────────────────────

/// Fixed-window failure counter per IP: after `max_failures` within `window` the IP is blocked.
pub struct LoginLimiter {
    max_failures: u32,
    window: Duration,
    entries: Mutex<HashMap<String, (u32, Instant)>>,
}

impl Default for LoginLimiter {
    fn default() -> Self {
        Self::new(10, Duration::from_secs(15 * 60))
    }
}

impl LoginLimiter {
    pub fn new(max_failures: u32, window: Duration) -> Self {
        Self {
            max_failures,
            window,
            entries: Mutex::new(HashMap::new()),
        }
    }

    pub fn is_blocked(&self, ip: &str) -> bool {
        let mut map = self.entries.lock();
        match map.get(ip) {
            Some((count, since)) if since.elapsed() < self.window => *count >= self.max_failures,
            Some(_) => {
                map.remove(ip);
                false
            }
            None => false,
        }
    }

    pub fn record_failure(&self, ip: &str) {
        let mut map = self.entries.lock();
        let entry = map.entry(ip.to_string()).or_insert((0, Instant::now()));
        if entry.1.elapsed() >= self.window {
            *entry = (0, Instant::now());
        }
        entry.0 += 1;
        if map.len() > 10_000 {
            let window = self.window;
            map.retain(|_, (_, since)| since.elapsed() < window);
        }
    }

    pub fn clear(&self, ip: &str) {
        self.entries.lock().remove(ip);
    }
}

/// Parse an IP string (used for tests / logging).
pub fn parse_ip(s: &str) -> Option<IpAddr> {
    s.parse().ok()
}

// ── JSON guard (CSRF) ─────────────────────────────────────────────────────────

/// Mutating `/api` requests must be JSON: a non-JSON `Content-Type`, or a body without one,
/// is rejected with 415. Together with `SameSite=Lax` this blocks cross-site form posts.
pub async fn json_guard(req: Request, next: Next) -> Response {
    let mutating = matches!(
        *req.method(),
        Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    );
    if mutating && req.uri().path().starts_with("/api/") {
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
    next.run(req).await
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
    fn client_ip_prefers_forwarded() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", "203.0.113.9, 10.0.0.1".parse().unwrap());
        let peer = ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 5)));
        assert_eq!(client_ip(&headers, Some(&peer)), "203.0.113.9");
        assert_eq!(client_ip(&HeaderMap::new(), Some(&peer)), "127.0.0.1");
        assert!(parse_ip("203.0.113.9").is_some());
    }

    #[test]
    fn cookie_attributes() {
        let c = session_cookie(true, "abc".into(), 1);
        assert_eq!(c.name(), SESSION_COOKIE);
        assert_eq!(c.secure(), Some(true));
        assert_eq!(c.http_only(), Some(true));
        assert_eq!(c.same_site(), Some(SameSite::Lax));
    }
}
