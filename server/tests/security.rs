//! Security hardening: headers, CSRF/origin policy, lockout, session policy, WebSocket
//! limits, rate limits, encrypted signing key.

use futures_util::{SinkExt, StreamExt};
use remote_console::app::{build_router, AppState};
use remote_console::auth::{BackoffLimiter, Limits, RateLimiter};
use remote_console::config::Config;
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::Message;

struct TestApp {
    base: String,
    ws_base: String,
    state: AppState,
    dir: tempfile::TempDir,
}

fn test_config(dir: &tempfile::TempDir) -> Config {
    let db_path = dir.path().join("console.db");
    Config::for_tests(format!("sqlite://{}?mode=rwc", db_path.display()))
}

async fn spawn_with(config: Config, dir: tempfile::TempDir, limits: Option<Limits>) -> TestApp {
    let mut state = AppState::init(config).await.expect("state");
    if let Some(l) = limits {
        state.limits = Arc::new(l);
    }
    let app = build_router(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .expect("serve");
    });
    TestApp {
        base: format!("http://{addr}"),
        ws_base: format!("ws://{addr}"),
        state,
        dir,
    }
}

async fn spawn_app() -> TestApp {
    let dir = tempfile::tempdir().expect("tempdir");
    let config = test_config(&dir);
    spawn_with(config, dir, None).await
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .cookie_store(true)
        .build()
        .expect("client")
}

const ADMIN_EMAIL: &str = "admin@example.com";
const ADMIN_PASSWORD: &str = "correct-horse-battery";

async fn setup_admin(app: &TestApp, c: &reqwest::Client) -> reqwest::Response {
    c.post(format!("{}/api/setup", app.base))
        .json(&json!({ "email": ADMIN_EMAIL, "name": "Admin", "password": ADMIN_PASSWORD }))
        .send()
        .await
        .expect("setup")
}

async fn login(app: &TestApp, c: &reqwest::Client, password: &str) -> reqwest::Response {
    c.post(format!("{}/api/auth/login", app.base))
        .json(&json!({ "email": ADMIN_EMAIL, "password": password }))
        .send()
        .await
        .expect("login")
}

#[tokio::test]
async fn security_headers_are_present() {
    let app = spawn_app().await;
    let c = client();
    for path in ["/", "/api/info", "/devices", "/api/nope"] {
        let r = c.get(format!("{}{path}", app.base)).send().await.unwrap();
        let h = r.headers();
        assert_eq!(h.get("x-frame-options").unwrap(), "DENY", "{path}");
        assert_eq!(
            h.get("x-content-type-options").unwrap(),
            "nosniff",
            "{path}"
        );
        assert_eq!(
            h.get("referrer-policy").unwrap(),
            "strict-origin-when-cross-origin",
            "{path}"
        );
        let csp = h.get("content-security-policy").unwrap().to_str().unwrap();
        assert!(csp.contains("default-src 'self'"), "{path}: {csp}");
        assert!(csp.contains("frame-ancestors 'none'"), "{path}");
        assert!(
            !csp.contains("script-src 'self' 'unsafe-inline'"),
            "{path}: no inline scripts"
        );
        assert!(h
            .get("permissions-policy")
            .unwrap()
            .to_str()
            .unwrap()
            .contains("camera=()"));
        assert!(
            h.get("strict-transport-security").is_none(),
            "no HSTS on a plain-http public URL"
        );
    }
}

#[tokio::test]
async fn hsts_only_with_https_public_url() {
    let dir = tempfile::tempdir().unwrap();
    let mut config = test_config(&dir);
    config.public_url = "https://console.example.com".into();
    let app = spawn_with(config, dir, None).await;
    let r = client()
        .get(format!("{}/api/info", app.base))
        .send()
        .await
        .unwrap();
    assert_eq!(
        r.headers().get("strict-transport-security").unwrap(),
        "max-age=31536000; includeSubDomains"
    );
}

#[tokio::test]
async fn insecure_public_url_is_refused_unless_overridden() {
    let dir = tempfile::tempdir().unwrap();
    let mut config = test_config(&dir);
    config.public_url = "http://console.example.com".into();
    assert!(config.validate_for_serve().is_err());
    config.allow_insecure_public_url = true;
    assert!(config.validate_for_serve().is_ok());
    config.public_url = "http://10.0.0.5:8080".into();
    config.allow_insecure_public_url = false;
    assert!(
        config.validate_for_serve().is_ok(),
        "private LAN http is allowed"
    );
}

#[tokio::test]
async fn cookie_policy_and_session_rotation() {
    let app = spawn_app().await;
    let c = client();
    let r = setup_admin(&app, &c).await;
    assert_eq!(r.status(), 201);
    let set_cookie = r
        .headers()
        .get("set-cookie")
        .unwrap()
        .to_str()
        .unwrap()
        .to_string();
    assert!(set_cookie.contains("console_session="));
    assert!(set_cookie.contains("HttpOnly"), "{set_cookie}");
    assert!(set_cookie.contains("SameSite=Lax"), "{set_cookie}");
    assert!(
        !set_cookie.contains("Secure"),
        "plain http test config: {set_cookie}"
    );
    let first_sid = set_cookie
        .split(';')
        .next()
        .unwrap()
        .trim_start_matches("console_session=")
        .to_string();

    // Logging in again rotates the session: the first id is invalidated.
    let r = login(&app, &c, ADMIN_PASSWORD).await;
    assert_eq!(r.status(), 200);
    let second = r.headers().get("set-cookie").unwrap().to_str().unwrap();
    assert!(!second.contains(&first_sid), "new session id on login");
    let stale = reqwest::Client::new();
    let r = stale
        .get(format!("{}/api/auth/me", app.base))
        .header("cookie", format!("console_session={first_sid}"))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 401, "old session must be dead after re-login");

    // Logout invalidates server-side.
    let r = c
        .post(format!("{}/api/auth/logout", app.base))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 204);
    let r = c
        .get(format!("{}/api/auth/me", app.base))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 401);
}

#[tokio::test]
async fn idle_sessions_expire() {
    let app = spawn_app().await;
    let c = client();
    let r = setup_admin(&app, &c).await;
    let sid = r
        .headers()
        .get("set-cookie")
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .trim_start_matches("console_session=")
        .to_string();
    let r = c
        .get(format!("{}/api/auth/me", app.base))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    // Pretend the session was last used 13 hours ago (absolute TTL is 168 h).
    remote_console::db::users::touch_login_session(
        &app.state.db,
        &sid,
        chrono::Utc::now() - chrono::Duration::hours(13),
    )
    .await
    .unwrap();
    let r = c
        .get(format!("{}/api/auth/me", app.base))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 401, "idle session rejected");
}

#[tokio::test]
async fn login_lockout_per_account_with_backoff() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_config(&dir);
    let limits = Limits {
        login_account: BackoffLimiter::new(
            5,
            Duration::from_millis(300),
            Duration::from_millis(600),
        ),
        ..Limits::default()
    };
    let app = spawn_with(config, dir, Some(limits)).await;
    let c = client();
    assert_eq!(setup_admin(&app, &c).await.status(), 201);
    let anon = reqwest::Client::new();
    for _ in 0..5 {
        let r = login(&app, &anon, "wrong-password-xx").await;
        assert_eq!(r.status(), 401);
    }
    // Sixth attempt is refused even with the right password.
    let r = login(&app, &anon, ADMIN_PASSWORD).await;
    assert_eq!(r.status(), 429);
    let body: Value = r.json().await.unwrap();
    assert_eq!(body["error"]["code"], "rate_limited");
    // Failed logins are audited with the IP.
    let audit: Vec<Value> = c
        .get(format!("{}/api/audit?limit=50", app.base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let failed = audit
        .iter()
        .filter(|a| a["action"] == "login_failed")
        .count();
    assert!(failed >= 5, "login_failed audited: {failed}");
    assert!(audit
        .iter()
        .any(|a| a["action"] == "login_failed" && a["details"]["ip"] == "127.0.0.1"));
    // After the backoff the account works again.
    tokio::time::sleep(Duration::from_millis(400)).await;
    let r = login(&app, &anon, ADMIN_PASSWORD).await;
    assert_eq!(r.status(), 200, "login succeeds after backoff");
}

#[tokio::test]
async fn cross_origin_mutations_are_rejected() {
    let app = spawn_app().await;
    let c = client();
    assert_eq!(setup_admin(&app, &c).await.status(), 201);
    let r = c
        .post(format!("{}/api/enroll-tokens", app.base))
        .header("origin", "https://evil.example")
        .json(&json!({ "label": "x", "default_mode": "unattended", "default_tags": [] }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 403);
    let body: Value = r.json().await.unwrap();
    assert_eq!(body["error"]["code"], "cross_origin");
    // Same-origin (matching Host) passes; the public URL origin passes too.
    let host = app.base.trim_start_matches("http://").to_string();
    let r = c
        .post(format!("{}/api/enroll-tokens", app.base))
        .header("origin", format!("http://{host}"))
        .json(&json!({ "label": "x", "default_mode": "unattended", "default_tags": [] }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 201);
    let r = c
        .post(format!("{}/api/enroll-tokens", app.base))
        .header("origin", "http://localhost:8080")
        .json(&json!({ "label": "y", "default_mode": "unattended", "default_tags": [] }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 201);
    // The UI WebSocket upgrade with a foreign Origin is refused.
    let mut req = format!("{}/ws/ui", app.ws_base)
        .into_client_request()
        .unwrap();
    req.headers_mut()
        .insert("origin", "https://evil.example".parse().unwrap());
    let err = tokio_tungstenite::connect_async(req).await.err();
    assert!(err.is_some(), "foreign-origin ws upgrade rejected");
}

#[tokio::test]
async fn oversized_ws_text_frame_closes_socket() {
    let app = spawn_app().await;
    let c = client();
    let r = setup_admin(&app, &c).await;
    let cookie = r
        .headers()
        .get("set-cookie")
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string();
    let mut req = format!("{}/ws/ui", app.ws_base)
        .into_client_request()
        .unwrap();
    req.headers_mut().insert("cookie", cookie.parse().unwrap());
    let (mut ws, _) = tokio_tungstenite::connect_async(req).await.expect("ws");
    // A frame above the 256 KiB limit must not be processed: the server drops the socket.
    let huge = format!(
        "{{\"type\":\"ping\",\"nonce\":1,\"pad\":\"{}\"}}",
        "x".repeat(300 * 1024)
    );
    let _ = ws.send(Message::Text(huge.into())).await;
    let mut closed = false;
    for _ in 0..10 {
        match tokio::time::timeout(Duration::from_secs(2), ws.next()).await {
            Ok(Some(Ok(Message::Close(_)))) | Ok(None) | Ok(Some(Err(_))) | Err(_) => {
                closed = true;
                break;
            }
            Ok(Some(Ok(_))) => continue,
        }
    }
    assert!(closed, "socket closed after an oversized frame");
    // Binary frames are rejected as well.
    let mut req = format!("{}/ws/ui", app.ws_base)
        .into_client_request()
        .unwrap();
    req.headers_mut().insert("cookie", cookie.parse().unwrap());
    let (mut ws, _) = tokio_tungstenite::connect_async(req).await.expect("ws");
    let _ = ws.send(Message::Binary(vec![1, 2, 3].into())).await;
    let ended = matches!(
        tokio::time::timeout(Duration::from_secs(3), ws.next()).await,
        Ok(Some(Ok(Message::Close(_)))) | Ok(None) | Ok(Some(Err(_)))
    );
    assert!(ended, "binary frame closes the ui socket");
}

#[tokio::test]
async fn enrollment_and_download_rate_limits() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_config(&dir);
    let limits = Limits {
        enroll_ip: RateLimiter::new(3, Duration::from_secs(60)),
        download_ip: RateLimiter::new(2, Duration::from_secs(60)),
        ..Limits::default()
    };
    let app = spawn_with(config, dir, Some(limits)).await;
    let anon = reqwest::Client::new();
    let body = json!({
        "token": "definitely-not-a-token",
        "hostname": "h",
        "os": "macos",
        "arch": "aarch64",
        "agent_version": "0.0.0"
    });
    let mut statuses = vec![];
    for _ in 0..4 {
        let r = anon
            .post(format!("{}/api/enroll", app.base))
            .json(&body)
            .send()
            .await
            .unwrap();
        statuses.push(r.status().as_u16());
    }
    assert_eq!(
        statuses,
        vec![401, 401, 401, 429],
        "fourth enrollment attempt is rate limited"
    );

    let mut statuses = vec![];
    for _ in 0..3 {
        let r = anon
            .get(format!(
                "{}/api/agent/download/macos-universal?token=nope",
                app.base
            ))
            .send()
            .await
            .unwrap();
        statuses.push(r.status().as_u16());
    }
    assert_eq!(
        statuses,
        vec![401, 401, 429],
        "token downloads are rate limited per IP"
    );
}

#[tokio::test]
async fn agent_hello_failures_back_off_per_ip() {
    let dir = tempfile::tempdir().unwrap();
    let config = test_config(&dir);
    let limits = Limits {
        agent_hello_ip: BackoffLimiter::new(2, Duration::from_secs(60), Duration::from_secs(60)),
        ..Limits::default()
    };
    let app = spawn_with(config, dir, Some(limits)).await;
    let hello = json!({
        "type": "hello",
        "protocol_version": protocol::PROTOCOL_VERSION,
        "device_id": "dev_doesnotexist",
        "device_secret": "x",
        "agent_version": "0",
        "hostname": "h",
        "os": "macos",
        "arch": "aarch64",
        "mode": "unattended",
        "capabilities": { "codecs": [], "displays": [], "input": false, "clipboard": false }
    });
    let mut codes = vec![];
    for _ in 0..3 {
        let (mut ws, _) = tokio_tungstenite::connect_async(format!("{}/ws/agent", app.ws_base))
            .await
            .expect("ws");
        // The third connection is refused before we even send hello; sending anyway is fine.
        let _ = ws.send(Message::Text(hello.to_string().into())).await;
        let mut code = 0u16;
        for _ in 0..5 {
            match tokio::time::timeout(Duration::from_secs(3), ws.next()).await {
                Ok(Some(Ok(Message::Close(Some(f))))) => {
                    code = f.code.into();
                    break;
                }
                Ok(None) | Ok(Some(Err(_))) | Err(_) => break,
                _ => continue,
            }
        }
        codes.push(code);
    }
    assert_eq!(codes[0], 4409, "unknown device");
    assert_eq!(codes[1], 4409);
    assert_eq!(
        codes[2], 4429,
        "third attempt from the same IP is rate limited"
    );
}

#[tokio::test]
async fn signing_key_is_encrypted_with_master_key_and_wrong_key_is_refused() {
    use base64::Engine;
    let dir = tempfile::tempdir().unwrap();
    let mut config = test_config(&dir);
    // First run without a master key: plaintext key.
    let state = AppState::init(config.clone()).await.expect("plain init");
    let plain = remote_console::db::settings::get(&state.db, "bakery_signing_key")
        .await
        .unwrap()
        .unwrap();
    assert!(!plain.starts_with("enc:"));
    let pk_before = remote_console::db::settings::signing_key(&state.db, &config)
        .await
        .unwrap()
        .verifying_key();
    drop(state);

    // Second run with a master key: migrated to ciphertext, same key material.
    config.master_key = Some([3u8; 32]);
    let state = AppState::init(config.clone())
        .await
        .expect("encrypted init");
    let stored = remote_console::db::settings::get(&state.db, "bakery_signing_key")
        .await
        .unwrap()
        .unwrap();
    assert!(stored.starts_with("enc:v1:"), "encrypted at rest: {stored}");
    let pk_after = remote_console::db::settings::signing_key(&state.db, &config)
        .await
        .unwrap()
        .verifying_key();
    assert_eq!(pk_before, pk_after, "same signing key after encryption");
    let app = spawn_with(config.clone(), dir, None).await;
    let info: Value = client()
        .get(format!("{}/api/info", app.base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        info["console_public_key"],
        base64::engine::general_purpose::STANDARD.encode(pk_after.as_bytes())
    );
    assert!(info.get("console_tls_spki_sha256").is_none());
    drop(state);

    // Wrong master key: refuse to start. Missing master key: refuse to start.
    let mut wrong = config.clone();
    wrong.master_key = Some([4u8; 32]);
    assert!(
        AppState::init(wrong).await.is_err(),
        "wrong master key refused"
    );
    let mut missing = config.clone();
    missing.master_key = None;
    assert!(
        AppState::init(missing).await.is_err(),
        "encrypted key without master key refused"
    );
    let _keep = &app.dir;
}

#[tokio::test]
async fn spki_pin_is_published_when_configured() {
    let dir = tempfile::tempdir().unwrap();
    let mut config = test_config(&dir);
    config.tls_spki_sha256 = Some("EuFBOcAHR2Gqg51n83Ruzsr23mFMSpIN463ylxbk3HE=".into());
    let app = spawn_with(config, dir, None).await;
    let info: Value = client()
        .get(format!("{}/api/info", app.base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        info["console_tls_spki_sha256"],
        "EuFBOcAHR2Gqg51n83Ruzsr23mFMSpIN463ylxbk3HE="
    );
}

#[tokio::test]
async fn forwarded_headers_are_ignored_without_trust_proxy() {
    let app = spawn_app().await;
    let c = client();
    assert_eq!(setup_admin(&app, &c).await.status(), 201);
    // A spoofed X-Forwarded-For must not change the audited IP.
    let r = c
        .post(format!("{}/api/auth/login", app.base))
        .header("x-forwarded-for", "203.0.113.77")
        .json(&json!({ "email": ADMIN_EMAIL, "password": "nope-nope-nope" }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 401);
    let audit: Vec<Value> = c
        .get(format!("{}/api/audit?limit=20", app.base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let failed = audit
        .iter()
        .find(|a| a["action"] == "login_failed")
        .expect("audited");
    assert_eq!(failed["details"]["ip"], "127.0.0.1");
}
