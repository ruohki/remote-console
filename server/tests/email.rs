//! Outgoing email: SMTP settings (sealed password), the test endpoint, password reset for
//! local accounts and email codes as a second factor. A recording mailer replaces SMTP so
//! nothing touches the network.

use remote_console::app::{build_router, AppState};
use remote_console::auth::Limits;
use remote_console::config::Config;
use remote_console::db::{self, models::AuthMethod};
use remote_console::mail::RecordingMailer;
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

const ADMIN_EMAIL: &str = "admin@example.com";
const ADMIN_PASS: &str = "correct-horse-battery";

struct TestApp {
    base: String,
    state: AppState,
    mailer: Arc<RecordingMailer>,
    _dir: tempfile::TempDir,
}

async fn spawn_with(mutate: impl FnOnce(&mut Config), limits: Option<Limits>) -> TestApp {
    let dir = tempfile::tempdir().expect("tempdir");
    let db_url = format!(
        "sqlite://{}?mode=rwc",
        dir.path().join("console.db").display()
    );
    let mut config = Config::for_tests(db_url);
    mutate(&mut config);
    let mut state = AppState::init(config).await.expect("state");
    let mailer = Arc::new(RecordingMailer::default());
    state.mailer = mailer.clone();
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
        state,
        mailer,
        _dir: dir,
    }
}

async fn spawn() -> TestApp {
    spawn_with(|_| {}, None).await
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .cookie_store(true)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("client")
}

async fn body_json(r: reqwest::Response) -> Value {
    let status = r.status();
    let text = r.text().await.unwrap_or_default();
    serde_json::from_str(&text).unwrap_or_else(|_| panic!("non-JSON {status} body: {text}"))
}

async fn setup_admin(app: &TestApp, c: &reqwest::Client) -> Value {
    let r = c
        .post(format!("{}/api/setup", app.base))
        .json(&json!({ "email": ADMIN_EMAIL, "name": "Admin", "password": ADMIN_PASS }))
        .send()
        .await
        .expect("setup");
    assert_eq!(r.status(), 201, "{}", r.text().await.unwrap_or_default());
    r.json().await.expect("json")
}

async fn login(
    app: &TestApp,
    c: &reqwest::Client,
    email: &str,
    password: &str,
) -> reqwest::Response {
    c.post(format!("{}/api/auth/login", app.base))
        .json(&json!({ "email": email, "password": password }))
        .send()
        .await
        .expect("login")
}

async fn me(app: &TestApp, c: &reqwest::Client) -> reqwest::Response {
    c.get(format!("{}/api/auth/me", app.base))
        .send()
        .await
        .expect("me")
}

async fn providers(app: &TestApp) -> Value {
    body_json(
        client()
            .get(format!("{}/api/auth/providers", app.base))
            .send()
            .await
            .unwrap(),
    )
    .await
}

async fn audit_actions(app: &TestApp, c: &reqwest::Client) -> Vec<Value> {
    body_json(
        c.get(format!("{}/api/audit?limit=200", app.base))
            .send()
            .await
            .unwrap(),
    )
    .await
    .as_array()
    .cloned()
    .unwrap()
}

fn smtp_input(enabled: bool) -> Value {
    json!({
        "enabled": enabled,
        "host": "smtp.invalid",
        "port": 587,
        "security": "starttls",
        "username": "console",
        "password": "hunter2-relay-secret",
        "from_address": "console@example.com",
        "from_name": "",
        "reply_to": ""
    })
}

async fn configure_smtp(app: &TestApp, admin: &reqwest::Client) -> Value {
    let r = admin
        .put(format!("{}/api/email/config", app.base))
        .json(&smtp_input(true))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200, "{}", r.text().await.unwrap_or_default());
    body_json(r).await
}

fn set_cookies(r: &reqwest::Response) -> Vec<String> {
    r.headers()
        .get_all("set-cookie")
        .iter()
        .map(|v| v.to_str().unwrap().to_string())
        .collect()
}

/// The six-digit code is the first word of the subject ("123456 is your … code").
fn code_from_subject(subject: &str) -> String {
    let code = subject.split_whitespace().next().unwrap_or_default();
    assert_eq!(code.len(), 6, "{subject}");
    assert!(code.chars().all(|c| c.is_ascii_digit()), "{subject}");
    code.to_string()
}

/// Enrol email codes for the current session; returns the recovery codes when issued.
async fn enrol_email(app: &TestApp, c: &reqwest::Client) -> Option<Vec<String>> {
    let r = c
        .post(format!("{}/api/auth/2fa/email/start", app.base))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200, "{}", r.text().await.unwrap_or_default());
    assert_eq!(body_json(r).await["sent_to"], "a***@example.com");
    let mail = app.mailer.last().expect("verification mail");
    assert_eq!(mail.to[0].address, ADMIN_EMAIL);
    assert!(
        mail.subject.ends_with("verification code"),
        "{}",
        mail.subject
    );
    let code = code_from_subject(&mail.subject);
    assert!(mail.text.contains(&code) && mail.html.contains(&code));
    let r = c
        .post(format!("{}/api/auth/2fa/email/enable", app.base))
        .json(&json!({ "code": code }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200, "{}", r.text().await.unwrap_or_default());
    let body = body_json(r).await;
    if body["recovery_codes"].is_null() {
        None
    } else {
        Some(serde_json::from_value(body["recovery_codes"].clone()).unwrap())
    }
}

// ── configuration ─────────────────────────────────────────────────────────────

#[tokio::test]
async fn email_config_roundtrip_hides_password_and_seals_it() {
    let app = spawn_with(|c| c.master_key = Some([5u8; 32]), None).await;
    let admin = client();
    setup_admin(&app, &admin).await;

    assert_eq!(
        client()
            .get(format!("{}/api/email/config", app.base))
            .send()
            .await
            .unwrap()
            .status(),
        401,
        "admin only"
    );
    let initial = body_json(
        admin
            .get(format!("{}/api/email/config", app.base))
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(initial["enabled"], false);
    assert_eq!(initial["port"], 587);
    assert_eq!(initial["security"], "starttls");
    assert_eq!(initial["password_set"], false);

    let stored = configure_smtp(&app, &admin).await;
    assert_eq!(stored["password_set"], true);
    assert_eq!(stored["host"], "smtp.invalid");
    assert!(stored.get("password").is_none(), "{stored}");
    assert!(stored.get("password_enc").is_none(), "{stored}");
    let fetched = body_json(
        admin
            .get(format!("{}/api/email/config", app.base))
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(fetched["password_set"], true);
    assert!(fetched.get("password").is_none());

    // Sealed at rest, never in plain text.
    let raw = db::settings::get(&app.state.db, "smtp_config")
        .await
        .unwrap()
        .expect("stored");
    assert!(raw.contains("enc:v1:"), "{raw}");
    assert!(!raw.contains("hunter2-relay-secret"), "{raw}");

    // Saving again without a password keeps the stored one.
    let mut again = smtp_input(true);
    again["password"] = Value::Null;
    again["from_name"] = json!("IT Desk");
    let r = admin
        .put(format!("{}/api/email/config", app.base))
        .json(&again)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let body = body_json(r).await;
    assert_eq!(body["password_set"], true);
    assert_eq!(body["from_name"], "IT Desk");

    // Validation.
    let mut bad = smtp_input(true);
    bad["host"] = json!("");
    let r = admin
        .put(format!("{}/api/email/config", app.base))
        .json(&bad)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 422);
    let mut bad = smtp_input(true);
    bad["reply_to"] = json!("not-an-address");
    let r = admin
        .put(format!("{}/api/email/config", app.base))
        .json(&bad)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 422);
    let mut bad = smtp_input(true);
    bad["security"] = json!("ssl3");
    let r = admin
        .put(format!("{}/api/email/config", app.base))
        .json(&bad)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status().as_u16(), 422, "unknown security value");

    // Audit rows never carry the password.
    let entries = audit_actions(&app, &admin).await;
    let cfg_rows: Vec<&Value> = entries
        .iter()
        .filter(|e| e["action"] == "email.config")
        .collect();
    assert!(!cfg_rows.is_empty(), "email.config audited");
    for row in cfg_rows {
        let details = row["details"].to_string();
        assert!(!details.contains("hunter2"), "{details}");
        assert!(row["details"].get("password").is_none(), "{details}");
        assert_eq!(row["details"]["host"], "smtp.invalid");
    }
}

#[tokio::test]
async fn test_email_endpoint_records_a_branded_message() {
    let app = spawn().await;
    let admin = client();
    setup_admin(&app, &admin).await;

    // Nothing configured yet → validation error, nothing sent.
    let r = admin
        .post(format!("{}/api/email/test", app.base))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 422);
    assert!(app.mailer.messages().is_empty());

    configure_smtp(&app, &admin).await;
    let r = admin
        .post(format!("{}/api/email/test", app.base))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200, "{}", r.text().await.unwrap_or_default());
    let body = body_json(r).await;
    assert_eq!(body["ok"], true);
    assert_eq!(body["detail"], format!("Sent to {ADMIN_EMAIL}"));
    let mail = app.mailer.last().expect("recorded");
    assert_eq!(mail.to.len(), 1);
    assert_eq!(mail.to[0].address, ADMIN_EMAIL);
    assert!(mail.subject.contains("Remote Console"), "{}", mail.subject);
    assert!(mail.html.contains("#3b82f6"), "accent in html");
    assert!(mail.text.contains(ADMIN_EMAIL), "sender named in body");
    assert!(mail.inline_logo_png.is_none());

    // Unsaved values + explicit recipient work without touching the stored config.
    let r = admin
        .post(format!("{}/api/email/test", app.base))
        .json(&json!({ "config": smtp_input(false), "to": "ops@example.com" }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200, "{}", r.text().await.unwrap_or_default());
    assert_eq!(app.mailer.last().unwrap().to[0].address, "ops@example.com");
    let cfg = body_json(
        admin
            .get(format!("{}/api/email/config", app.base))
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(cfg["enabled"], true, "test did not persist the draft");
    let r = admin
        .post(format!("{}/api/email/test", app.base))
        .json(&json!({ "to": "nope" }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 422);
}

// ── password reset ────────────────────────────────────────────────────────────

fn token_from_mail(text: &str) -> String {
    let start =
        text.find("reset-password?token=").expect("link in mail") + "reset-password?token=".len();
    text[start..]
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric())
        .collect()
}

#[tokio::test]
async fn password_reset_flow_for_local_account() {
    let app = spawn().await;
    let admin = client();
    let setup = setup_admin(&app, &admin).await;
    let admin_id = setup["user"]["id"].as_str().unwrap().to_string();
    let anon = client();
    let forgot = |email: &str| {
        anon.post(format!("{}/api/auth/password/forgot", app.base))
            .json(&json!({ "email": email }))
            .send()
    };

    // SMTP not configured: still 202, nothing sent.
    let r = forgot(ADMIN_EMAIL).await.unwrap();
    assert_eq!(r.status(), 202);
    assert!(app.mailer.messages().is_empty());

    configure_smtp(&app, &admin).await;
    let r = forgot(&ADMIN_EMAIL.to_uppercase()).await.unwrap();
    assert_eq!(r.status(), 202);
    let mail = app.mailer.last().expect("reset mail");
    assert_eq!(mail.to[0].address, ADMIN_EMAIL);
    assert_eq!(mail.to[0].name.as_deref(), Some("Admin"));
    assert_eq!(mail.subject, "Reset your Remote Console password");
    let token = token_from_mail(&mail.text);
    assert_eq!(token.len(), 43, "{token}");
    assert!(
        mail.html.contains(&format!(
            "http://localhost:8080/reset-password?token={token}"
        )),
        "absolute link in html"
    );
    assert!(mail.text.contains("30 minutes"));

    // A second request invalidates the first token.
    let r = forgot(ADMIN_EMAIL).await.unwrap();
    assert_eq!(r.status(), 202);
    let stale = token;
    let token = token_from_mail(&app.mailer.last().unwrap().text);
    assert_ne!(stale, token);
    let r = anon
        .post(format!("{}/api/auth/password/reset", app.base))
        .json(&json!({ "token": stale, "password": "brand-new-password-1" }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 400);
    assert_eq!(body_json(r).await["error"]["code"], "invalid_token");

    // Weak password is refused and the token survives.
    let r = anon
        .post(format!("{}/api/auth/password/reset", app.base))
        .json(&json!({ "token": token, "password": "short" }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 422);

    let sent_before = app.mailer.messages().len();
    let r = anon
        .post(format!("{}/api/auth/password/reset", app.base))
        .json(&json!({ "token": token, "password": "brand-new-password-1" }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200, "{}", r.text().await.unwrap_or_default());
    assert_eq!(
        me(&app, &admin).await.status(),
        401,
        "old sessions are dead"
    );
    assert_eq!(
        login(&app, &client(), ADMIN_EMAIL, ADMIN_PASS)
            .await
            .status(),
        401,
        "old password rejected"
    );
    let fresh = client();
    assert_eq!(
        login(&app, &fresh, ADMIN_EMAIL, "brand-new-password-1")
            .await
            .status(),
        200
    );
    let notice = app.mailer.last().unwrap();
    assert_eq!(app.mailer.messages().len(), sent_before + 1);
    assert_eq!(notice.subject, "Your Remote Console password was changed");
    assert!(notice.text.contains("contact your administrator"));

    // Tokens are single use.
    let r = anon
        .post(format!("{}/api/auth/password/reset", app.base))
        .json(&json!({ "token": token, "password": "another-password-22" }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 400);
    assert_eq!(body_json(r).await["error"]["code"], "invalid_token");
    let r = anon
        .post(format!("{}/api/auth/password/reset", app.base))
        .json(&json!({ "token": "garbage", "password": "another-password-22" }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 400);

    // Unknown accounts get the same answer and no mail.
    let count = app.mailer.messages().len();
    let r = forgot("nobody@example.com").await.unwrap();
    assert_eq!(r.status(), 202);
    assert_eq!(app.mailer.messages().len(), count);

    // SSO-only accounts (no "password" auth method) are never mailed.
    let r = fresh
        .post(format!("{}/api/users", app.base))
        .json(&json!({ "email": "sso@example.com", "name": "Sso", "password": "provisioned-pw-1", "role": "operator" }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 201);
    let sso_id = body_json(r).await["id"].as_str().unwrap().to_string();
    db::users::set_auth_methods(&app.state.db, &sso_id, &[AuthMethod::Oidc])
        .await
        .unwrap();
    let r = forgot("sso@example.com").await.unwrap();
    assert_eq!(r.status(), 202);
    assert_eq!(
        app.mailer.messages().len(),
        count,
        "no mail for SSO accounts"
    );

    // Audit trail.
    let entries = audit_actions(&app, &fresh).await;
    let requests: Vec<&Value> = entries
        .iter()
        .filter(|e| e["action"] == "password_reset.request")
        .collect();
    assert!(requests.len() >= 4, "{requests:?}");
    assert!(requests.iter().any(|e| e["details"]["email"] == ADMIN_EMAIL
        && e["details"]["sent"] == true
        && e["details"]["ip"] == "127.0.0.1"
        && e.get("user_id").is_none()));
    assert!(requests
        .iter()
        .any(|e| e["details"]["email"] == "sso@example.com" && e["details"]["sent"] == false));
    let complete = entries
        .iter()
        .find(|e| e["action"] == "password_reset.complete")
        .expect("completion audited");
    assert_eq!(complete["user_id"], admin_id);
    assert_eq!(complete["target"], admin_id);
}

#[tokio::test]
async fn password_reset_is_rate_limited_per_ip() {
    let limits = Limits {
        reset_ip: remote_console::auth::RateLimiter::new(2, Duration::from_secs(60)),
        ..Limits::default()
    };
    let app = spawn_with(|_| {}, Some(limits)).await;
    let admin = client();
    setup_admin(&app, &admin).await;
    configure_smtp(&app, &admin).await;
    let anon = client();
    let mut statuses = vec![];
    for i in 0..3 {
        let r = anon
            .post(format!("{}/api/auth/password/forgot", app.base))
            .json(&json!({ "email": format!("user{i}@example.com") }))
            .send()
            .await
            .unwrap();
        if r.status() == 429 {
            assert!(r.headers().get("retry-after").is_some());
        }
        statuses.push(r.status().as_u16());
    }
    assert_eq!(statuses, vec![202, 202, 429]);
}

// ── email codes as a second factor ────────────────────────────────────────────

#[tokio::test]
async fn email_code_second_factor_enrol_login_disable() {
    let app = spawn().await;
    let c = client();
    setup_admin(&app, &c).await;

    // Without SMTP the enrolment cannot start.
    let r = c
        .post(format!("{}/api/auth/2fa/email/start", app.base))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 409);
    assert_eq!(body_json(r).await["error"]["code"], "email_not_configured");
    configure_smtp(&app, &c).await;

    // Enable before start → 422; wrong code → 401; right code → recovery codes.
    let r = c
        .post(format!("{}/api/auth/2fa/email/enable", app.base))
        .json(&json!({ "code": "123456" }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 422);
    let r = c
        .post(format!("{}/api/auth/2fa/email/start", app.base))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let code = code_from_subject(&app.mailer.last().unwrap().subject);
    let wrong = if code == "000000" { "111111" } else { "000000" };
    let r = c
        .post(format!("{}/api/auth/2fa/email/enable", app.base))
        .json(&json!({ "code": wrong }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 401);
    assert_eq!(body_json(r).await["error"]["code"], "invalid_code");
    let r = c
        .post(format!("{}/api/auth/2fa/email/enable", app.base))
        .json(&json!({ "code": format!(" {code} ") }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200, "{}", r.text().await.unwrap_or_default());
    let codes: Vec<String> =
        serde_json::from_value(body_json(r).await["recovery_codes"].clone()).unwrap();
    assert_eq!(codes.len(), 10);
    let m = body_json(me(&app, &c).await).await;
    assert_eq!(m["user"]["email_2fa_enabled"], true);
    assert_eq!(m["user"]["two_factor_enabled"], true);

    // Re-enrolling does not replace existing recovery codes.
    assert!(enrol_email(&app, &c).await.is_none());

    // Login asks for the email code.
    let c2 = client();
    let r = login(&app, &c2, ADMIN_EMAIL, ADMIN_PASS).await;
    assert_eq!(r.status(), 202);
    let pending = body_json(r).await;
    assert_eq!(pending["methods"], json!(["email"]));
    let challenge_id = pending["challenge_id"].as_str().unwrap().to_string();

    // Verifying before a code was sent fails like a wrong code.
    let r = c2
        .post(format!("{}/api/auth/2fa/verify", app.base))
        .json(&json!({ "challenge_id": challenge_id, "code": "123456", "method": "email" }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 401);

    // Sending needs the pre-auth cookie of the same browser.
    let r = client()
        .post(format!("{}/api/auth/2fa/email/send", app.base))
        .json(&json!({ "challenge_id": challenge_id }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 401);
    let r = c2
        .post(format!("{}/api/auth/2fa/email/send", app.base))
        .json(&json!({ "challenge_id": challenge_id }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200, "{}", r.text().await.unwrap_or_default());
    let sent = body_json(r).await;
    assert_eq!(sent["sent_to"], "a***@example.com");
    assert_eq!(sent["expires_in_s"], 600);
    let mail = app.mailer.last().unwrap();
    assert!(mail.subject.ends_with("sign-in code"), "{}", mail.subject);
    let code = code_from_subject(&mail.subject);
    let wrong = if code == "000000" { "111111" } else { "000000" };
    let r = c2
        .post(format!("{}/api/auth/2fa/verify", app.base))
        .json(&json!({ "challenge_id": challenge_id, "code": wrong, "method": "email" }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 401);
    let r = c2
        .post(format!("{}/api/auth/2fa/verify", app.base))
        .json(&json!({ "challenge_id": challenge_id, "code": code, "method": "email" }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200, "{}", r.text().await.unwrap_or_default());
    let cookies = set_cookies(&r);
    assert!(
        cookies.iter().any(|v| v.starts_with("console_session=")),
        "{cookies:?}"
    );
    let body = body_json(r).await;
    assert_eq!(body["user"]["email"], ADMIN_EMAIL);
    assert_eq!(body["auth_method"], "password");
    assert_eq!(me(&app, &c2).await.status(), 200);
    // Challenge consumed.
    let r = c2
        .post(format!("{}/api/auth/2fa/verify", app.base))
        .json(&json!({ "challenge_id": challenge_id, "code": code, "method": "email" }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 401);

    // Without `method` the emailed code is assumed when there is no authenticator app,
    // and recovery codes still work.
    let c3 = client();
    let pending = body_json(login(&app, &c3, ADMIN_EMAIL, ADMIN_PASS).await).await;
    let challenge_id = pending["challenge_id"].as_str().unwrap().to_string();
    let r = c3
        .post(format!("{}/api/auth/2fa/email/send", app.base))
        .json(&json!({ "challenge_id": challenge_id }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let code = code_from_subject(&app.mailer.last().unwrap().subject);
    let r = c3
        .post(format!("{}/api/auth/2fa/verify", app.base))
        .json(&json!({ "challenge_id": challenge_id, "code": code }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200, "implicit email method");
    let c4 = client();
    let pending = body_json(login(&app, &c4, ADMIN_EMAIL, ADMIN_PASS).await).await;
    let r = c4
        .post(format!("{}/api/auth/2fa/verify", app.base))
        .json(&json!({ "challenge_id": pending["challenge_id"], "code": codes[0] }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200, "recovery code accepted");

    // Disable → next login is direct.
    let r = c
        .post(format!("{}/api/auth/2fa/email/disable", app.base))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 204);
    let m = body_json(me(&app, &c).await).await;
    assert_eq!(m["user"]["email_2fa_enabled"], false);
    assert_eq!(m["user"]["two_factor_enabled"], false);
    assert_eq!(
        login(&app, &client(), ADMIN_EMAIL, ADMIN_PASS)
            .await
            .status(),
        200
    );
    let r = c
        .post(format!("{}/api/auth/2fa/email/disable", app.base))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 422, "already off");

    let entries = audit_actions(&app, &c).await;
    let actions: Vec<&str> = entries
        .iter()
        .filter_map(|e| e["action"].as_str())
        .collect();
    for a in ["2fa.enable", "2fa.email_sent", "2fa.disable", "login"] {
        assert!(actions.contains(&a), "{a} missing in {actions:?}");
    }
    assert!(entries
        .iter()
        .any(|e| e["action"] == "login" && e["details"]["second_factor"] == "email"));
    assert!(entries
        .iter()
        .any(|e| e["action"] == "2fa.enable" && e["details"]["method"] == "email"));
}

#[tokio::test]
async fn email_code_send_is_limited_per_challenge() {
    let limits = Limits {
        email_code_spacing: Duration::ZERO,
        ..Limits::default()
    };
    let app = spawn_with(|_| {}, Some(limits)).await;
    let c = client();
    setup_admin(&app, &c).await;
    configure_smtp(&app, &c).await;
    enrol_email(&app, &c).await.expect("recovery codes");

    let c2 = client();
    let pending = body_json(login(&app, &c2, ADMIN_EMAIL, ADMIN_PASS).await).await;
    let challenge_id = pending["challenge_id"].as_str().unwrap().to_string();
    let mut statuses = vec![];
    for _ in 0..4 {
        let r = c2
            .post(format!("{}/api/auth/2fa/email/send", app.base))
            .json(&json!({ "challenge_id": challenge_id }))
            .send()
            .await
            .unwrap();
        if r.status() == 429 {
            assert!(r.headers().get("retry-after").is_some());
        }
        statuses.push(r.status().as_u16());
    }
    assert_eq!(statuses, vec![200, 200, 200, 429]);
    // Only the latest code is valid.
    let mails = app.mailer.messages();
    let latest = code_from_subject(&mails[mails.len() - 1].subject);
    let earlier = code_from_subject(&mails[mails.len() - 3].subject);
    if earlier != latest {
        let r = c2
            .post(format!("{}/api/auth/2fa/verify", app.base))
            .json(&json!({ "challenge_id": challenge_id, "code": earlier, "method": "email" }))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 401, "superseded code rejected");
    }
    let r = c2
        .post(format!("{}/api/auth/2fa/verify", app.base))
        .json(&json!({ "challenge_id": challenge_id, "code": latest, "method": "email" }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);

    // With the default spacing a second code right away is refused.
    let app2 = spawn().await;
    let c = client();
    setup_admin(&app2, &c).await;
    configure_smtp(&app2, &c).await;
    enrol_email(&app2, &c).await;
    let c2 = client();
    let pending = body_json(login(&app2, &c2, ADMIN_EMAIL, ADMIN_PASS).await).await;
    let challenge_id = pending["challenge_id"].as_str().unwrap().to_string();
    let first = c2
        .post(format!("{}/api/auth/2fa/email/send", app2.base))
        .json(&json!({ "challenge_id": challenge_id }))
        .send()
        .await
        .unwrap();
    assert_eq!(first.status(), 200);
    let second = c2
        .post(format!("{}/api/auth/2fa/email/send", app2.base))
        .json(&json!({ "challenge_id": challenge_id }))
        .send()
        .await
        .unwrap();
    assert_eq!(second.status(), 429, "30 s spacing");
    let retry: u64 = second.headers()["retry-after"]
        .to_str()
        .unwrap()
        .parse()
        .unwrap();
    assert!((1..=31).contains(&retry), "{retry}");
}

#[tokio::test]
async fn login_is_refused_when_email_is_the_only_factor_and_smtp_is_off() {
    let app = spawn().await;
    let c = client();
    setup_admin(&app, &c).await;
    configure_smtp(&app, &c).await;
    enrol_email(&app, &c).await;
    let r = c
        .put(format!("{}/api/email/config", app.base))
        .json(&smtp_input(false))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let r = login(&app, &client(), ADMIN_EMAIL, ADMIN_PASS).await;
    assert_eq!(r.status(), 503);
    assert_eq!(
        body_json(r).await["error"]["code"],
        "second_factor_unavailable"
    );
    // The admin reset clears the email factor and unblocks the account.
    let m = body_json(me(&app, &c).await).await;
    let id = m["user"]["id"].as_str().unwrap().to_string();
    let r = c
        .post(format!("{}/api/users/{id}/2fa/reset", app.base))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 204);
    let c2 = client();
    let r = login(&app, &c2, ADMIN_EMAIL, ADMIN_PASS).await;
    assert_eq!(r.status(), 200);
    assert_eq!(
        body_json(me(&app, &c2).await).await["user"]["email_2fa_enabled"],
        false
    );
}

#[tokio::test]
async fn providers_advertise_password_reset_and_email_2fa_only_when_configured() {
    let app = spawn().await;
    let admin = client();
    setup_admin(&app, &admin).await;
    let p = providers(&app).await;
    assert_eq!(p["password_reset"], false);
    assert_eq!(p["email_2fa"], false);

    configure_smtp(&app, &admin).await;
    let p = providers(&app).await;
    assert_eq!(p["password_reset"], true);
    assert_eq!(p["email_2fa"], true);

    let r = admin
        .put(format!("{}/api/email/config", app.base))
        .json(&smtp_input(false))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let p = providers(&app).await;
    assert_eq!(p["password_reset"], false);
    assert_eq!(p["email_2fa"], false);

    // Without local login there is nothing to reset, but email codes still work.
    let app = spawn_with(|c| c.local_login = false, None).await;
    let admin = client();
    setup_admin(&app, &admin).await;
    configure_smtp(&app, &admin).await;
    let p = providers(&app).await;
    assert_eq!(p["local_login"], false);
    assert_eq!(p["password_reset"], false);
    assert_eq!(p["email_2fa"], true);
    let r = client()
        .post(format!("{}/api/auth/password/forgot", app.base))
        .json(&json!({ "email": ADMIN_EMAIL }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 202);
    assert!(
        app.mailer.messages().is_empty(),
        "no reset mail without local login"
    );
}
