//! Authentication end-to-end tests: TOTP, recovery codes, the 2FA policy gate, passkeys via a
//! software authenticator, OIDC against an in-process mock IdP, SAML with signed assertions
//! (and replay / tamper rejection), LOCAL_LOGIN=0 with break-glass accounts, LDAP config.

use axum::extract::{Form, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use remote_console::app::{build_router, AppState};
use remote_console::auth::totp;
use remote_console::config::{Config, TwoFactorPolicy};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use webauthn_authenticator_rs::softpasskey::SoftPasskey;
use webauthn_authenticator_rs::WebauthnAuthenticator;
use webauthn_rs::prelude::{
    CreationChallengeResponse, PublicKeyCredential, RegisterPublicKeyCredential,
    RequestChallengeResponse, Url,
};

const ADMIN_EMAIL: &str = "admin@example.com";
const ADMIN_PASS: &str = "correct-horse-battery";

struct TestApp {
    base: String,
    state: AppState,
    db_url: String,
    _dir: tempfile::TempDir,
}

async fn spawn_with(mutate: impl FnOnce(&mut Config)) -> TestApp {
    let dir = tempfile::tempdir().expect("tempdir");
    let db_url = format!(
        "sqlite://{}?mode=rwc",
        dir.path().join("console.db").display()
    );
    let mut config = Config::for_tests(db_url.clone());
    mutate(&mut config);
    let (base, state) = serve(config).await.expect("state");
    TestApp {
        base,
        state,
        db_url,
        _dir: dir,
    }
}

async fn serve(config: Config) -> anyhow::Result<(String, AppState)> {
    let state = AppState::init(config).await?;
    let app = build_router(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let addr = listener.local_addr()?;
    tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .expect("serve");
    });
    Ok((format!("http://{addr}"), state))
}

async fn spawn() -> TestApp {
    spawn_with(|_| {}).await
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .cookie_store(true)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("client")
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

async fn body_json(r: reqwest::Response) -> Value {
    let status = r.status();
    let text = r.text().await.unwrap_or_default();
    serde_json::from_str(&text).unwrap_or_else(|_| panic!("non-JSON {status} body: {text}"))
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

/// Enrol TOTP for the current session; returns (secret, recovery codes).
async fn enrol_totp(app: &TestApp, c: &reqwest::Client) -> (String, Vec<String>) {
    let r = c
        .post(format!("{}/api/auth/2fa/setup", app.base))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let setup = body_json(r).await;
    let secret = setup["secret"].as_str().unwrap().to_string();
    assert!(setup["otpauth_url"]
        .as_str()
        .unwrap()
        .starts_with("otpauth://totp/"));
    assert!(setup["qr_svg"].as_str().unwrap().contains("<svg"));

    let wrong = c
        .post(format!("{}/api/auth/2fa/enable", app.base))
        .json(&json!({ "code": "000000" }))
        .send()
        .await
        .unwrap();
    assert!(
        wrong.status() == 401 || totp::code_at(&secret, now_unix()).unwrap() == "000000",
        "wrong code rejected"
    );

    let code = totp::code_at(&secret, now_unix()).unwrap();
    let r = c
        .post(format!("{}/api/auth/2fa/enable", app.base))
        .json(&json!({ "code": code }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let codes: Vec<String> =
        serde_json::from_value(body_json(r).await["recovery_codes"].clone()).unwrap();
    assert_eq!(codes.len(), 10);
    (secret, codes)
}

// ── password + TOTP ───────────────────────────────────────────────────────────

#[tokio::test]
async fn totp_login_recovery_codes_and_lockout() {
    let app = spawn().await;
    let c = client();
    setup_admin(&app, &c).await;
    let (secret, codes) = enrol_totp(&app, &c).await;

    let m = body_json(me(&app, &c).await).await;
    assert_eq!(m["user"]["two_factor_enabled"], true);
    assert_eq!(m["two_factor_required"], false);

    // Fresh browser: password → 202 pending → TOTP → session.
    let c2 = client();
    let r = login(&app, &c2, ADMIN_EMAIL, ADMIN_PASS).await;
    assert_eq!(r.status(), 202);
    let set_cookie = r
        .headers()
        .get_all("set-cookie")
        .iter()
        .map(|v| v.to_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert!(
        set_cookie.iter().any(|v| v.starts_with("console_preauth=")),
        "{set_cookie:?}"
    );
    assert!(
        !set_cookie.iter().any(|v| v.starts_with("console_session=")),
        "no session yet"
    );
    let pending = body_json(r).await;
    assert_eq!(pending["pending"], "two_factor");
    assert_eq!(pending["methods"], json!(["totp"]));
    let challenge_id = pending["challenge_id"].as_str().unwrap().to_string();

    // Nothing else works while pending.
    assert_eq!(me(&app, &c2).await.status(), 401);

    let bad = c2
        .post(format!("{}/api/auth/2fa/verify", app.base))
        .json(&json!({ "challenge_id": challenge_id, "code": "123456" }))
        .send()
        .await
        .unwrap();
    assert_eq!(bad.status(), 401);
    assert_eq!(body_json(bad).await["error"]["code"], "invalid_code");

    let code = totp::code_at(&secret, now_unix()).unwrap();
    let ok = c2
        .post(format!("{}/api/auth/2fa/verify", app.base))
        .json(&json!({ "challenge_id": challenge_id, "code": code }))
        .send()
        .await
        .unwrap();
    assert_eq!(ok.status(), 200);
    let cookies: Vec<String> = ok
        .headers()
        .get_all("set-cookie")
        .iter()
        .map(|v| v.to_str().unwrap().to_string())
        .collect();
    assert!(
        cookies.iter().any(|v| v.starts_with("console_session=")),
        "{cookies:?}"
    );
    let body = body_json(ok).await;
    assert_eq!(body["user"]["email"], ADMIN_EMAIL);
    assert_eq!(body["auth_method"], "password");
    let m = body_json(me(&app, &c2).await).await;
    assert_eq!(m["auth_method"], "password");
    assert_eq!(m["user"]["last_login_method"], "password");

    // Challenge is single-use.
    let replay = c2
        .post(format!("{}/api/auth/2fa/verify", app.base))
        .json(&json!({ "challenge_id": challenge_id, "code": code }))
        .send()
        .await
        .unwrap();
    assert_eq!(replay.status(), 401);

    // Recovery code works once.
    let c3 = client();
    let r = login(&app, &c3, ADMIN_EMAIL, ADMIN_PASS).await;
    let challenge_id = body_json(r).await["challenge_id"]
        .as_str()
        .unwrap()
        .to_string();
    let rc = c3
        .post(format!("{}/api/auth/2fa/verify", app.base))
        .json(&json!({ "challenge_id": challenge_id, "code": codes[0].to_uppercase() }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        rc.status(),
        200,
        "recovery code accepted (case-insensitive)"
    );
    let c4 = client();
    let r = login(&app, &c4, ADMIN_EMAIL, ADMIN_PASS).await;
    let challenge_id = body_json(r).await["challenge_id"]
        .as_str()
        .unwrap()
        .to_string();
    let reused = c4
        .post(format!("{}/api/auth/2fa/verify", app.base))
        .json(&json!({ "challenge_id": challenge_id, "code": codes[0] }))
        .send()
        .await
        .unwrap();
    assert_eq!(reused.status(), 401, "a recovery code cannot be reused");

    // Five wrong codes (the reused recovery code was the first) void the challenge with
    // 429 + Retry-After.
    let mut statuses = Vec::new();
    for _ in 0..4 {
        let r = c4
            .post(format!("{}/api/auth/2fa/verify", app.base))
            .json(&json!({ "challenge_id": challenge_id, "code": "000000" }))
            .send()
            .await
            .unwrap();
        let status = r.status().as_u16();
        if status == 429 {
            assert!(r.headers().get("retry-after").is_some());
        }
        statuses.push(status);
    }
    assert_eq!(statuses, vec![401, 401, 401, 429], "{statuses:?}");
    let again = c4
        .post(format!("{}/api/auth/2fa/verify", app.base))
        .json(&json!({ "challenge_id": challenge_id, "code": totp::code_at(&secret, now_unix()).unwrap() }))
        .send()
        .await
        .unwrap();
    assert_eq!(again.status(), 401, "voided challenge");

    // Audit trail.
    let audit = body_json(
        c.get(format!("{}/api/audit", app.base))
            .send()
            .await
            .unwrap(),
    )
    .await;
    let actions: Vec<&str> = audit
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|e| e["action"].as_str())
        .collect();
    assert!(actions.contains(&"2fa.enable"), "{actions:?}");
    assert!(actions.contains(&"login"), "{actions:?}");
    assert!(actions.contains(&"2fa.recovery"), "{actions:?}");

    // Regenerate + disable (policy off in tests).
    let regen = c
        .post(format!("{}/api/auth/2fa/recovery-codes", app.base))
        .json(&json!({ "code": totp::code_at(&secret, now_unix()).unwrap() }))
        .send()
        .await
        .unwrap();
    assert_eq!(regen.status(), 200);
    let disable = c
        .post(format!("{}/api/auth/2fa/disable", app.base))
        .json(&json!({ "code": totp::code_at(&secret, now_unix()).unwrap() }))
        .send()
        .await
        .unwrap();
    assert_eq!(disable.status(), 204);
    let m = body_json(me(&app, &c).await).await;
    assert_eq!(m["user"]["two_factor_enabled"], false);
    let r = login(&app, &client(), ADMIN_EMAIL, ADMIN_PASS).await;
    assert_eq!(r.status(), 200, "no second factor after disabling");
}

#[tokio::test]
async fn password_lockout_sends_retry_after() {
    let app = spawn().await;
    let c = client();
    setup_admin(&app, &c).await;
    let mut last = None;
    for _ in 0..6 {
        last = Some(login(&app, &client(), ADMIN_EMAIL, "wrong-password-1").await);
    }
    let last = last.unwrap();
    assert_eq!(last.status(), 429);
    let retry: u64 = last.headers()["retry-after"]
        .to_str()
        .unwrap()
        .parse()
        .unwrap();
    assert!((1..=61).contains(&retry), "{retry}");
    assert_eq!(body_json(last).await["error"]["code"], "rate_limited");
}

// ── policy gate ───────────────────────────────────────────────────────────────

#[tokio::test]
async fn two_factor_policy_gates_admins_until_enrolled() {
    let app = spawn_with(|c| c.require_2fa = TwoFactorPolicy::Admins).await;
    let c = client();
    let setup = setup_admin(&app, &c).await;
    assert_eq!(setup["two_factor_required"], true);

    let r = c
        .get(format!("{}/api/devices", app.base))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 403);
    assert_eq!(body_json(r).await["error"]["code"], "two_factor_required");
    let m = body_json(me(&app, &c).await).await;
    assert_eq!(m["two_factor_required"], true);
    let providers = body_json(
        c.get(format!("{}/api/auth/providers", app.base))
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(providers["require_2fa"], "admins");
    assert_eq!(providers["local_login"], true);
    assert_eq!(providers["passkeys"], true);

    let (secret, _) = enrol_totp(&app, &c).await;
    let r = c
        .get(format!("{}/api/devices", app.base))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200, "enrolled → gate lifted");
    let m = body_json(me(&app, &c).await).await;
    assert_eq!(m["two_factor_required"], false);

    // The policy forbids removing the only second factor.
    let disable = c
        .post(format!("{}/api/auth/2fa/disable", app.base))
        .json(&json!({ "code": totp::code_at(&secret, now_unix()).unwrap() }))
        .send()
        .await
        .unwrap();
    assert_eq!(disable.status(), 409);
    assert_eq!(
        body_json(disable).await["error"]["code"],
        "policy_requires_2fa"
    );

    // Operators are not affected under `admins`.
    let r = c
        .post(format!("{}/api/users", app.base))
        .json(&json!({ "email": "op@example.com", "name": "Op", "password": "operator-pass-123", "role": "operator" }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 201);
    let op_id = body_json(r).await["id"].as_str().unwrap().to_string();
    let op = client();
    assert_eq!(
        login(&app, &op, "op@example.com", "operator-pass-123")
            .await
            .status(),
        200
    );
    assert_eq!(
        op.get(format!("{}/api/devices", app.base))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );

    // Admin reset clears the admin's factors and sessions; re-enrolment is required again.
    let admin_id = setup["user"]["id"].as_str().unwrap().to_string();
    let r = c
        .post(format!("{}/api/users/{admin_id}/2fa/reset", app.base))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 204);
    assert_eq!(me(&app, &c).await.status(), 401, "sessions dropped");
    let c2 = client();
    assert_eq!(
        login(&app, &c2, ADMIN_EMAIL, ADMIN_PASS).await.status(),
        200,
        "no second factor left"
    );
    assert_eq!(
        c2.get(format!("{}/api/devices", app.base))
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    let _ = op_id;
}

// ── passkeys ──────────────────────────────────────────────────────────────────

fn rp_origin() -> Url {
    Url::parse("http://localhost:8080").unwrap()
}

#[tokio::test]
async fn passkey_registration_login_and_second_factor() {
    let app = spawn().await;
    let c = client();
    let setup = setup_admin(&app, &c).await;
    let admin_id = setup["user"]["id"].as_str().unwrap().to_string();
    let mut authenticator = WebauthnAuthenticator::new(SoftPasskey::new(true));

    // Register.
    let r = c
        .post(format!("{}/api/auth/passkeys/register/start", app.base))
        .json(&json!({ "name": "YubiKey 5C" }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let ccr: CreationChallengeResponse = r.json().await.unwrap();
    let cred: RegisterPublicKeyCredential = authenticator
        .do_registration(rp_origin(), ccr)
        .expect("soft registration");
    let cred_id = cred.id.clone();
    let r = c
        .post(format!("{}/api/auth/passkeys/register/finish", app.base))
        .json(&cred)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 201, "{}", r.text().await.unwrap_or_default());
    let pk = body_json(r).await;
    assert_eq!(pk["name"], "YubiKey 5C");
    // The software authenticator is U2F-style: it needs allowCredentials to find its key, so
    // the discoverable (empty) list is filled in on the client side as a real browser would
    // do from its own credential store.
    let discoverable = |mut options: Value| -> RequestChallengeResponse {
        options["publicKey"]["allowCredentials"] = json!([{ "type": "public-key", "id": cred_id }]);
        serde_json::from_value(options).unwrap()
    };
    let pk_id = pk["id"].as_str().unwrap().to_string();
    let m = body_json(me(&app, &c).await).await;
    assert_eq!(m["user"]["passkeys"], 1);
    assert_eq!(m["user"]["two_factor_enabled"], true);

    // Same credential cannot be registered twice.
    let r = c
        .post(format!("{}/api/auth/passkeys/register/start", app.base))
        .json(&json!({ "name": "dup" }))
        .send()
        .await
        .unwrap();
    let ccr: CreationChallengeResponse = r.json().await.unwrap();
    assert!(
        !ccr.public_key
            .exclude_credentials
            .clone()
            .unwrap_or_default()
            .is_empty(),
        "existing key is excluded"
    );

    // Rename (own) and admin listing.
    let r = c
        .patch(format!("{}/api/auth/passkeys/{pk_id}", app.base))
        .json(&json!({ "name": "Work key" }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(body_json(r).await["name"], "Work key");
    let list = body_json(
        c.get(format!("{}/api/users/{admin_id}/passkeys", app.base))
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(list.as_array().unwrap().len(), 1);

    // Usernameless login with the passkey.
    let c2 = client();
    let r = c2
        .post(format!("{}/api/auth/passkeys/login/start", app.base))
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let options = body_json(r).await;
    let rcr = discoverable(options.clone());
    let assertion: PublicKeyCredential = authenticator
        .do_authentication(rp_origin(), rcr)
        .expect("soft assertion");
    let r = c2
        .post(format!("{}/api/auth/passkeys/login/finish", app.base))
        .json(&json!({ "challenge_id": options["challenge_id"], "credential": assertion }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200, "{}", r.text().await.unwrap_or_default());
    let body = body_json(r).await;
    assert_eq!(body["auth_method"], "passkey");
    assert_eq!(body["user"]["email"], ADMIN_EMAIL);
    let m = body_json(me(&app, &c2).await).await;
    assert_eq!(m["auth_method"], "passkey");
    let list = body_json(
        c2.get(format!("{}/api/auth/passkeys", app.base))
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert!(list[0]["last_used_at"].is_string(), "{list}");

    // Password login now asks for the passkey as second factor.
    let c3 = client();
    let r = login(&app, &c3, ADMIN_EMAIL, ADMIN_PASS).await;
    assert_eq!(r.status(), 202);
    let pending = body_json(r).await;
    assert_eq!(pending["methods"], json!(["passkey"]));
    let challenge_id = pending["challenge_id"].as_str().unwrap().to_string();
    let r = c3
        .post(format!("{}/api/auth/2fa/passkey/start", app.base))
        .json(&json!({ "challenge_id": challenge_id }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let rcr: RequestChallengeResponse = r.json().await.unwrap();
    assert!(
        !rcr.public_key.allow_credentials.is_empty(),
        "second factor lists the user's keys"
    );
    let assertion = authenticator.do_authentication(rp_origin(), rcr).unwrap();
    let r = c3
        .post(format!("{}/api/auth/2fa/passkey/finish", app.base))
        .json(&json!({ "challenge_id": challenge_id, "credential": assertion }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200, "{}", r.text().await.unwrap_or_default());
    assert_eq!(body_json(r).await["auth_method"], "password");
    assert_eq!(me(&app, &c3).await.status(), 200);

    // A stale (already used) assertion is rejected.
    let c4 = client();
    let r = c4
        .post(format!("{}/api/auth/passkeys/login/start", app.base))
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    let options = body_json(r).await;
    let rcr = discoverable(options.clone());
    let assertion = authenticator.do_authentication(rp_origin(), rcr).unwrap();
    let first = c4
        .post(format!("{}/api/auth/passkeys/login/finish", app.base))
        .json(&assertion)
        .send()
        .await
        .unwrap();
    assert_eq!(first.status(), 200, "bare credential body accepted");
    let second = c4
        .post(format!("{}/api/auth/passkeys/login/finish", app.base))
        .json(&assertion)
        .send()
        .await
        .unwrap();
    assert_eq!(second.status(), 401, "challenge consumed");

    // Remove (policy off) and audit.
    let r = c
        .delete(format!("{}/api/auth/passkeys/{pk_id}", app.base))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 204);
    let audit = body_json(
        c.get(format!("{}/api/audit", app.base))
            .send()
            .await
            .unwrap(),
    )
    .await;
    let actions: Vec<&str> = audit
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|e| e["action"].as_str())
        .collect();
    assert!(actions.contains(&"passkey.register"), "{actions:?}");
    assert!(actions.contains(&"passkey.remove"), "{actions:?}");
}

#[tokio::test]
async fn passkey_cannot_be_removed_when_policy_needs_it() {
    let app = spawn_with(|c| c.require_2fa = TwoFactorPolicy::All).await;
    let c = client();
    setup_admin(&app, &c).await;
    let mut authenticator = WebauthnAuthenticator::new(SoftPasskey::new(true));
    let r = c
        .post(format!("{}/api/auth/passkeys/register/start", app.base))
        .json(&json!({ "name": "only key" }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200, "enrolment allowed while gated");
    let ccr: CreationChallengeResponse = r.json().await.unwrap();
    let cred = authenticator.do_registration(rp_origin(), ccr).unwrap();
    let r = c
        .post(format!("{}/api/auth/passkeys/register/finish", app.base))
        .json(&cred)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 201);
    let pk_id = body_json(r).await["id"].as_str().unwrap().to_string();
    assert_eq!(
        c.get(format!("{}/api/devices", app.base))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    let r = c
        .delete(format!("{}/api/auth/passkeys/{pk_id}", app.base))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 409);
    assert_eq!(body_json(r).await["error"]["code"], "policy_requires_2fa");
}

// ── mock OIDC identity provider ───────────────────────────────────────────────

struct MockIdp {
    base: String,
    state: Arc<Mutex<MockIdpState>>,
}

#[derive(Default)]
struct MockIdpState {
    nonce: Option<String>,
    code_challenge: Option<String>,
    /// Extra claims for the next ID token (groups, email_verified, amr…).
    claims: Value,
    token_requests: Vec<HashMap<String, String>>,
}

#[derive(Clone)]
struct MockCtx {
    issuer: String,
    key_pem: String,
    jwk: Value,
    state: Arc<Mutex<MockIdpState>>,
}

fn b64url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

async fn spawn_mock_idp() -> MockIdp {
    use rsa::pkcs8::{EncodePrivateKey, LineEnding};
    use rsa::traits::PublicKeyParts;
    let key = rsa::RsaPrivateKey::new(&mut rand_core::OsRng, 2048).unwrap();
    let key_pem = key.to_pkcs8_pem(LineEnding::LF).unwrap().to_string();
    let public = key.to_public_key();
    let jwk = json!({
        "kty": "RSA", "kid": "k1", "use": "sig", "alg": "RS256",
        "n": b64url(&public.n().to_bytes_be()),
        "e": b64url(&public.e().to_bytes_be()),
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let state = Arc::new(Mutex::new(MockIdpState::default()));
    let ctx = MockCtx {
        issuer: base.clone(),
        key_pem: key_pem.clone(),
        jwk: jwk.clone(),
        state: state.clone(),
    };
    let app = Router::new()
        .route("/.well-known/openid-configuration", get(mock_discovery))
        .route("/jwks", get(mock_jwks))
        .route("/token", post(mock_token))
        .route("/userinfo", get(mock_userinfo))
        .with_state(ctx);
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    MockIdp { base, state }
}

async fn mock_discovery(State(ctx): State<MockCtx>) -> Json<Value> {
    Json(json!({
        "issuer": ctx.issuer,
        "authorization_endpoint": format!("{}/authorize", ctx.issuer),
        "token_endpoint": format!("{}/token", ctx.issuer),
        "jwks_uri": format!("{}/jwks", ctx.issuer),
        "userinfo_endpoint": format!("{}/userinfo", ctx.issuer),
        "response_types_supported": ["code"],
        "id_token_signing_alg_values_supported": ["RS256"],
        "code_challenge_methods_supported": ["S256"],
    }))
}

async fn mock_jwks(State(ctx): State<MockCtx>) -> Json<Value> {
    Json(json!({ "keys": [ctx.jwk] }))
}

fn mock_id_token(ctx: &MockCtx, nonce: Option<&str>, extra: &Value) -> String {
    let now = now_unix();
    let mut claims = json!({
        "iss": ctx.issuer,
        "sub": "idp-user-1",
        "aud": "console-client",
        "exp": now + 300,
        "iat": now,
        "nonce": nonce,
        "email": "alice@corp.example",
        "email_verified": true,
        "name": "Alice Example",
    });
    if let (Some(base), Some(add)) = (claims.as_object_mut(), extra.as_object()) {
        for (k, v) in add {
            base.insert(k.clone(), v.clone());
        }
    }
    let header = jsonwebtoken::Header {
        kid: Some("k1".into()),
        ..jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256)
    };
    let key = jsonwebtoken::EncodingKey::from_rsa_pem(ctx.key_pem.as_bytes()).unwrap();
    jsonwebtoken::encode(&header, &claims, &key).unwrap()
}

async fn mock_token(
    State(ctx): State<MockCtx>,
    Form(form): Form<HashMap<String, String>>,
) -> (axum::http::StatusCode, Json<Value>) {
    let (nonce, challenge, extra) = {
        let mut s = ctx.state.lock().unwrap();
        s.token_requests.push(form.clone());
        (s.nonce.clone(), s.code_challenge.clone(), s.claims.clone())
    };
    let verifier = form.get("code_verifier").cloned().unwrap_or_default();
    let expected = {
        use sha2::Digest;
        b64url(&sha2::Sha256::digest(verifier.as_bytes()))
    };
    if form.get("grant_type").map(String::as_str) != Some("authorization_code")
        || form.get("code").map(String::as_str) != Some("good-code")
        || Some(expected) != challenge
        || form.get("client_id").map(String::as_str) != Some("console-client")
        || form.get("client_secret").map(String::as_str) != Some("s3cret")
    {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            Json(
                json!({ "error": "invalid_grant", "error_description": "mock rejected the exchange" }),
            ),
        );
    }
    let id_token = mock_id_token(&ctx, nonce.as_deref(), &extra);
    (
        axum::http::StatusCode::OK,
        Json(json!({ "access_token": "at-1", "token_type": "Bearer", "id_token": id_token })),
    )
}

async fn mock_userinfo(State(ctx): State<MockCtx>) -> Json<Value> {
    let extra = ctx.state.lock().unwrap().claims.clone();
    let mut v = json!({ "sub": "idp-user-1", "email": "alice@corp.example" });
    if let Some(g) = extra.get("userinfo_groups") {
        v["groups"] = g.clone();
    }
    Json(v)
}

/// Follow the console's redirect to the mock IdP, then call the callback as the IdP would.
async fn oidc_login(app: &TestApp, idp: &MockIdp, c: &reqwest::Client) -> reqwest::Response {
    let r = c
        .get(format!("{}/api/auth/oidc/start?return=/devices", app.base))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 303, "{}", r.text().await.unwrap_or_default());
    let location = r.headers()["location"].to_str().unwrap().to_string();
    let url = Url::parse(&location).unwrap();
    assert!(
        location.starts_with(&format!("{}/authorize?", idp.base)),
        "{location}"
    );
    let q: HashMap<String, String> = url.query_pairs().into_owned().collect();
    assert_eq!(q["response_type"], "code");
    assert_eq!(q["client_id"], "console-client");
    assert_eq!(q["code_challenge_method"], "S256");
    assert_eq!(
        q["redirect_uri"],
        "http://localhost:8080/api/auth/oidc/callback"
    );
    {
        let mut s = idp.state.lock().unwrap();
        s.nonce = Some(q["nonce"].clone());
        s.code_challenge = Some(q["code_challenge"].clone());
    }
    c.get(format!(
        "{}/api/auth/oidc/callback?code=good-code&state={}",
        app.base, q["state"]
    ))
    .send()
    .await
    .unwrap()
}

#[tokio::test]
async fn oidc_round_trip_with_mock_idp() {
    let app = spawn().await;
    let idp = spawn_mock_idp().await;
    let admin = client();
    setup_admin(&app, &admin).await;

    // Device group to map onto.
    let r = admin
        .post(format!("{}/api/groups", app.base))
        .json(&json!({ "name": "Lab", "description": "" }))
        .send()
        .await
        .unwrap();
    let group_id = body_json(r).await["id"].as_str().unwrap().to_string();

    // Not configured yet → 404.
    assert_eq!(
        client()
            .get(format!("{}/api/auth/oidc/start", app.base))
            .send()
            .await
            .unwrap()
            .status(),
        404
    );

    let cfg = json!({
        "enabled": true,
        "display_name": "Corp SSO",
        "issuer": idp.base,
        "client_id": "console-client",
        "client_secret": "s3cret",
        "scopes": "openid email profile groups",
        "groups_claim": "groups",
        "auto_provision": true,
        "default_role": "operator",
        "trust_idp_mfa": true,
        "allowed_domains": ["corp.example"],
        "sync_mode": "authoritative",
        "mappings": [
            { "idp_group": "console-admins", "role": "admin" },
            { "idp_group": "it-*", "groups": [{ "group_id": group_id, "permission": "connect" }] }
        ]
    });
    let r = admin
        .put(format!("{}/api/auth/oidc/config", app.base))
        .json(&cfg)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200, "{}", r.text().await.unwrap_or_default());
    let stored = body_json(r).await;
    assert_eq!(stored["client_secret_set"], true);
    assert!(
        stored.get("client_secret").is_none(),
        "secret is write-only"
    );
    assert_eq!(
        stored["redirect_uri"],
        "http://localhost:8080/api/auth/oidc/callback"
    );

    let test = body_json(
        admin
            .post(format!("{}/api/auth/oidc/test", app.base))
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(test["ok"], true, "{test}");
    assert_eq!(test["jwks_keys"], 1);
    let providers = body_json(
        client()
            .get(format!("{}/api/auth/providers", app.base))
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(providers["oidc"]["display_name"], "Corp SSO");

    let mapping = body_json(
        admin
            .post(format!("{}/api/auth/oidc/test-mapping", app.base))
            .json(&json!({ "groups": ["it-support", "other"] }))
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(mapping["effective_role"], "operator");
    assert_eq!(mapping["grants"][0]["group_id"], group_id);
    assert_eq!(mapping["matched"], json!(["it-*"]));

    // 1. Provision an operator with a mapped grant (MFA claimed via amr).
    idp.state.lock().unwrap().claims = json!({ "groups": ["it-support"], "amr": ["mfa", "pwd"] });
    let c = client();
    let r = oidc_login(&app, &idp, &c).await;
    assert_eq!(r.status(), 303, "{}", r.text().await.unwrap_or_default());
    assert_eq!(r.headers()["location"], "/devices");
    let m = body_json(me(&app, &c).await).await;
    assert_eq!(m["user"]["email"], "alice@corp.example");
    assert_eq!(m["user"]["role"], "operator");
    assert_eq!(m["auth_method"], "oidc");
    assert_eq!(m["user"]["auth_methods"], json!(["oidc"]));
    let uid = m["user"]["id"].as_str().unwrap().to_string();
    let grants = body_json(
        admin
            .get(format!("{}/api/users/{uid}/grants", app.base))
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(grants.as_array().unwrap().len(), 1, "{grants}");
    assert_eq!(grants[0]["permission"], "connect");
    let token_form = idp
        .state
        .lock()
        .unwrap()
        .token_requests
        .last()
        .cloned()
        .unwrap();
    assert!(
        token_form.contains_key("code_verifier"),
        "PKCE verifier sent"
    );

    // Provisioned users have no usable password.
    assert_eq!(
        login(&app, &client(), "alice@corp.example", "anything-at-all")
            .await
            .status(),
        401
    );

    // 2. Second login with the admin group and without the IT group: authoritative sync
    //    promotes and removes the stale SSO grant.
    idp.state.lock().unwrap().claims = json!({ "groups": ["console-admins"], "amr": ["mfa"] });
    let c2 = client();
    assert_eq!(oidc_login(&app, &idp, &c2).await.status(), 303);
    let m = body_json(me(&app, &c2).await).await;
    assert_eq!(m["user"]["role"], "admin");
    let grants = body_json(
        admin
            .get(format!("{}/api/users/{uid}/grants", app.base))
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(
        grants.as_array().unwrap().len(),
        0,
        "stale SSO grant removed: {grants}"
    );

    // 3. Groups only in userinfo are still read.
    idp.state.lock().unwrap().claims = json!({ "userinfo_groups": ["it-ops"], "amr": ["mfa"] });
    let c3 = client();
    assert_eq!(oidc_login(&app, &idp, &c3).await.status(), 303);
    let grants = body_json(
        admin
            .get(format!("{}/api/users/{uid}/grants", app.base))
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(grants.as_array().unwrap().len(), 1, "{grants}");

    // 4. Unverified email is refused → login page with an error.
    idp.state.lock().unwrap().claims = json!({ "email_verified": false });
    let r = oidc_login(&app, &idp, &client()).await;
    assert_eq!(r.status(), 303);
    let loc = r.headers()["location"].to_str().unwrap().to_string();
    assert!(loc.starts_with("/login?error=sso_denied"), "{loc}");

    // 5. Wrong nonce (token minted for another request) is rejected.
    let c5 = client();
    let r = c5
        .get(format!("{}/api/auth/oidc/start", app.base))
        .send()
        .await
        .unwrap();
    let url = Url::parse(r.headers()["location"].to_str().unwrap()).unwrap();
    let q: HashMap<String, String> = url.query_pairs().into_owned().collect();
    {
        let mut s = idp.state.lock().unwrap();
        s.nonce = Some("stale-nonce".into());
        s.code_challenge = Some(q["code_challenge"].clone());
        s.claims = json!({});
    }
    let r = c5
        .get(format!(
            "{}/api/auth/oidc/callback?code=good-code&state={}",
            app.base, q["state"]
        ))
        .send()
        .await
        .unwrap();
    let loc = r.headers()["location"].to_str().unwrap().to_string();
    assert!(loc.starts_with("/login?error="), "{loc}");
    assert_eq!(me(&app, &c5).await.status(), 401);

    // 6. Callback from a browser that did not start the flow (missing cookie).
    let r = client()
        .get(format!(
            "{}/api/auth/oidc/callback?code=good-code&state=ast_x",
            app.base
        ))
        .send()
        .await
        .unwrap();
    assert!(r.headers()["location"]
        .to_str()
        .unwrap()
        .starts_with("/login?error="));

    // 7. A user with TOTP is asked for it when the IdP did not claim MFA.
    let (_secret, _) = enrol_totp(&app, &c2).await;
    idp.state.lock().unwrap().claims = json!({ "groups": ["console-admins"] });
    let c7 = client();
    let r = oidc_login(&app, &idp, &c7).await;
    assert_eq!(r.status(), 303);
    let loc = r.headers()["location"].to_str().unwrap().to_string();
    assert!(
        loc.starts_with("/login?pending=two_factor&challenge_id="),
        "{loc}"
    );
    assert_eq!(me(&app, &c7).await.status(), 401);
    let challenge_id = Url::parse(&format!("http://x{loc}"))
        .unwrap()
        .query_pairs()
        .find(|(k, _)| k == "challenge_id")
        .map(|(_, v)| v.to_string())
        .unwrap();
    let r = c7
        .post(format!("{}/api/auth/2fa/verify", app.base))
        .json(&json!({ "challenge_id": challenge_id, "code": totp::code_at(&_secret, now_unix()).unwrap() }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let body = body_json(r).await;
    assert_eq!(body["auth_method"], "oidc");
    assert_eq!(body["return_to"], "/devices");

    // Audit: provisioning + mapping + config.
    let audit = body_json(
        admin
            .get(format!("{}/api/audit", app.base))
            .send()
            .await
            .unwrap(),
    )
    .await;
    let actions: Vec<&str> = audit
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|e| e["action"].as_str())
        .collect();
    for a in ["sso.provision", "sso.mapping", "auth.config", "login"] {
        assert!(actions.contains(&a), "{a} missing in {actions:?}");
    }
}

// ── SAML ──────────────────────────────────────────────────────────────────────

struct MockSamlIdp {
    entity_id: String,
    key_pem: String,
    cert_pem: String,
    metadata: String,
}

fn mock_saml_idp() -> MockSamlIdp {
    let keys = remote_console::auth::saml::generate_sp_keys("idp.test").unwrap();
    let cert_b64: String = keys
        .cert_pem
        .lines()
        .filter(|l| !l.starts_with("-----"))
        .collect();
    let entity_id = "https://idp.test/saml".to_string();
    let metadata = format!(
        r#"<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="{entity_id}">
  <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>{cert_b64}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.test/sso"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>"#
    );
    MockSamlIdp {
        entity_id,
        key_pem: keys.key_pem,
        cert_pem: keys.cert_pem,
        metadata,
    }
}

struct AssertionSpec<'a> {
    in_response_to: Option<&'a str>,
    audience: &'a str,
    email: &'a str,
    groups: &'a [&'a str],
    authn_context: &'a str,
    expired: bool,
}

fn iso(t: chrono::DateTime<chrono::Utc>) -> String {
    t.format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

/// A signed `samlp:Response` (base64) as an IdP would POST it.
fn signed_response(idp: &MockSamlIdp, spec: &AssertionSpec<'_>) -> (String, String) {
    use xml_sec::c14n::{C14nAlgorithm, C14nMode};
    use xml_sec::xmldsig::{
        DigestAlgorithm, ReferenceBuilder, RsaSigningKey, SignContext, SignatureAlgorithm,
        SignatureBuilder, Transform, X509CertificateKeyInfoWriter,
    };
    use xml_sec::IdAttributeRegistration;

    let now = chrono::Utc::now();
    let (not_before, not_after) = if spec.expired {
        (
            now - chrono::Duration::hours(2),
            now - chrono::Duration::hours(1),
        )
    } else {
        (
            now - chrono::Duration::minutes(1),
            now + chrono::Duration::minutes(5),
        )
    };
    let assertion_id = format!("_a{}", remote_console::ids::base62(24));
    let irt = spec
        .in_response_to
        .map(|r| format!(" InResponseTo=\"{r}\""))
        .unwrap_or_default();
    let groups: String = spec
        .groups
        .iter()
        .map(|g| format!("<saml:AttributeValue>{g}</saml:AttributeValue>"))
        .collect();
    let assertion = format!(
        r#"<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="{assertion_id}" Version="2.0" IssueInstant="{issue}"><saml:Issuer>{issuer}</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">{email}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData{irt} Recipient="http://localhost:8080/api/auth/saml/acs" NotOnOrAfter="{not_after}"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="{not_before}" NotOnOrAfter="{not_after}"><saml:AudienceRestriction><saml:Audience>{audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="{issue}"><saml:AuthnContext><saml:AuthnContextClassRef>{ctx}</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement><saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>{email}</saml:AttributeValue></saml:Attribute><saml:Attribute Name="displayName"><saml:AttributeValue>Sam L. User</saml:AttributeValue></saml:Attribute><saml:Attribute Name="groups">{groups}</saml:Attribute></saml:AttributeStatement></saml:Assertion>"#,
        issue = iso(now),
        issuer = idp.entity_id,
        email = spec.email,
        not_after = iso(not_after),
        not_before = iso(not_before),
        audience = spec.audience,
        ctx = spec.authn_context,
    );
    let key = RsaSigningKey::from_pkcs8_pem(&idp.key_pem).unwrap();
    let writer = X509CertificateKeyInfoWriter::from_pem(&idp.cert_pem).unwrap();
    let ids = [IdAttributeRegistration::global("ID")];
    let exc = C14nAlgorithm::new(C14nMode::Exclusive1_0, false);
    let builder = SignatureBuilder::new(exc.clone(), SignatureAlgorithm::RsaSha256)
        .add_reference(
            ReferenceBuilder::new(DigestAlgorithm::Sha256)
                .uri(format!("#{assertion_id}"))
                .transform(Transform::Enveloped)
                .transform(Transform::C14n(exc)),
        )
        .key_info(true);
    let signed_assertion = SignContext::new(&key)
        .key_info_writer(&writer)
        .id_attributes(&ids)
        .sign_with_builder(&assertion, &builder)
        .expect("sign assertion");
    let signed_assertion = signed_assertion
        .trim_start_matches("<?xml version=\"1.0\" encoding=\"UTF-8\"?>")
        .trim()
        .to_string();
    let response_id = format!("_r{}", remote_console::ids::base62(24));
    let response = format!(
        r#"<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="{response_id}" Version="2.0" IssueInstant="{issue}" Destination="http://localhost:8080/api/auth/saml/acs"{irt}><saml:Issuer>{issuer}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>{signed_assertion}</samlp:Response>"#,
        issue = iso(now),
        issuer = idp.entity_id,
    );
    (
        base64::engine::general_purpose::STANDARD.encode(response.as_bytes()),
        assertion_id,
    )
}

/// Parse the request id out of a redirect-binding AuthnRequest URL; returns (request id, relay state).
fn parse_authn_request(location: &str) -> (String, String) {
    use std::io::Read;
    let url = Url::parse(location).unwrap();
    let q: HashMap<String, String> = url.query_pairs().into_owned().collect();
    let deflated = base64::engine::general_purpose::STANDARD
        .decode(&q["SAMLRequest"])
        .unwrap();
    let mut xml = String::new();
    flate2::read::DeflateDecoder::new(&deflated[..])
        .read_to_string(&mut xml)
        .unwrap();
    let doc = roxmltree::Document::parse(&xml).unwrap();
    let root = doc.root_element();
    assert_eq!(root.tag_name().name(), "AuthnRequest");
    assert_eq!(root.attribute("Destination"), Some("https://idp.test/sso"));
    (
        root.attribute("ID").unwrap().to_string(),
        q["RelayState"].clone(),
    )
}

async fn post_acs(
    app: &TestApp,
    c: &reqwest::Client,
    response_b64: &str,
    relay: Option<&str>,
) -> reqwest::Response {
    let mut form = vec![("SAMLResponse", response_b64.to_string())];
    if let Some(r) = relay {
        form.push(("RelayState", r.to_string()));
    }
    c.post(format!("{}/api/auth/saml/acs", app.base))
        .header("Origin", "https://idp.test")
        .form(&form)
        .send()
        .await
        .unwrap()
}

fn location(r: &reqwest::Response) -> String {
    r.headers()
        .get("location")
        .map(|v| v.to_str().unwrap().to_string())
        .unwrap_or_default()
}

#[tokio::test]
async fn saml_signed_assertion_round_trip_and_replay() {
    let app = spawn().await;
    let idp = mock_saml_idp();
    let admin = client();
    setup_admin(&app, &admin).await;

    let cfg = json!({
        "enabled": true,
        "display_name": "Corp SAML",
        "idp_metadata_xml": idp.metadata,
        "sign_requests": true,
        "allow_idp_initiated": false,
        "auto_provision": true,
        "default_role": "operator",
        "admin_group": "Console Admins",
        "trust_idp_mfa": true,
        "sync_mode": "additive",
        "mappings": []
    });
    let r = admin
        .put(format!("{}/api/auth/saml/config", app.base))
        .json(&cfg)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200, "{}", r.text().await.unwrap_or_default());
    let stored = body_json(r).await;
    assert_eq!(stored["idp"]["entity_id"], idp.entity_id);
    assert_eq!(
        stored["sp_entity_id_effective"],
        "http://localhost:8080/saml"
    );
    assert!(stored["sp_certificate_pem"]
        .as_str()
        .unwrap()
        .contains("BEGIN CERTIFICATE"));

    let test = body_json(
        admin
            .post(format!("{}/api/auth/saml/test", app.base))
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(test["ok"], true, "{test}");

    // SP metadata is public and carries the signing certificate.
    let r = client()
        .get(format!("{}/api/auth/saml/metadata", app.base))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    assert!(r.headers()["content-type"]
        .to_str()
        .unwrap()
        .contains("samlmetadata"));
    let md = r.text().await.unwrap();
    assert!(md.contains("AuthnRequestsSigned=\"true\""), "{md}");
    assert!(md.contains("X509Certificate"), "{md}");
    assert!(md.contains("/api/auth/saml/acs"));

    // SP-initiated: start → signed redirect binding.
    let c = client();
    let r = c
        .get(format!(
            "{}/api/auth/saml/start?return=/devices/abc",
            app.base
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 303, "{}", r.text().await.unwrap_or_default());
    let loc = location(&r);
    assert!(
        loc.contains("SigAlg=") && loc.contains("Signature="),
        "{loc}"
    );
    let (request_id, relay) = parse_authn_request(&loc);

    let (resp, _) = signed_response(
        &idp,
        &AssertionSpec {
            in_response_to: Some(&request_id),
            audience: "http://localhost:8080/saml",
            email: "sam@corp.example",
            groups: &["Console Admins"],
            authn_context: "urn:oasis:names:tc:SAML:2.0:ac:classes:MultiFactor",
            expired: false,
        },
    );
    let r = post_acs(&app, &c, &resp, Some(&relay)).await;
    assert_eq!(r.status(), 303, "{}", r.text().await.unwrap_or_default());
    assert_eq!(location(&r), "/devices/abc");
    let m = body_json(me(&app, &c).await).await;
    assert_eq!(m["user"]["email"], "sam@corp.example");
    assert_eq!(m["user"]["name"], "Sam L. User");
    assert_eq!(m["user"]["role"], "admin", "admin_group mapped");
    assert_eq!(m["auth_method"], "saml");

    // Replaying the same response: the request state is gone → rejected.
    let r = post_acs(&app, &client(), &resp, Some(&relay)).await;
    assert!(
        location(&r).starts_with("/login?error=saml_invalid"),
        "{}",
        location(&r)
    );

    // Unsolicited responses are refused until IdP-initiated login is enabled.
    let (unsolicited, _) = signed_response(
        &idp,
        &AssertionSpec {
            in_response_to: None,
            audience: "http://localhost:8080/saml",
            email: "sam@corp.example",
            groups: &[],
            authn_context: "urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport",
            expired: false,
        },
    );
    let r = post_acs(&app, &client(), &unsolicited, None).await;
    assert!(
        location(&r).starts_with("/login?error=saml_invalid"),
        "{}",
        location(&r)
    );

    let mut cfg2 = cfg.clone();
    cfg2["allow_idp_initiated"] = json!(true);
    let r = admin
        .put(format!("{}/api/auth/saml/config", app.base))
        .json(&cfg2)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let c2 = client();
    let r = post_acs(&app, &c2, &unsolicited, None).await;
    assert_eq!(location(&r), "/devices", "IdP-initiated accepted");
    assert_eq!(me(&app, &c2).await.status(), 200);
    // …exactly once.
    let r = post_acs(&app, &client(), &unsolicited, None).await;
    let loc = location(&r);
    assert!(
        loc.starts_with("/login?error=saml_invalid") && loc.contains("replayed"),
        "{loc}"
    );

    // Tampered attribute → signature check fails.
    let tampered = String::from_utf8(
        base64::engine::general_purpose::STANDARD
            .decode(&unsolicited)
            .unwrap(),
    )
    .unwrap()
    .replace("sam@corp.example", "eve@corp.example");
    let tampered = base64::engine::general_purpose::STANDARD.encode(tampered);
    let r = post_acs(&app, &client(), &tampered, None).await;
    assert!(location(&r).contains("signature"), "{}", location(&r));

    // Wrong audience and expired conditions are rejected even with a valid signature.
    let (wrong_aud, _) = signed_response(
        &idp,
        &AssertionSpec {
            in_response_to: None,
            audience: "https://someone-else.example/saml",
            email: "sam@corp.example",
            groups: &[],
            authn_context: "x",
            expired: false,
        },
    );
    assert!(location(&post_acs(&app, &client(), &wrong_aud, None).await).contains("audience"));
    let (expired, _) = signed_response(
        &idp,
        &AssertionSpec {
            in_response_to: None,
            audience: "http://localhost:8080/saml",
            email: "sam@corp.example",
            groups: &[],
            authn_context: "x",
            expired: true,
        },
    );
    assert!(location(&post_acs(&app, &client(), &expired, None).await).contains("expired"));

    // Signed by a different key (another IdP) → rejected.
    let other = mock_saml_idp();
    let other = MockSamlIdp {
        entity_id: idp.entity_id.clone(),
        ..other
    };
    let (foreign, _) = signed_response(
        &other,
        &AssertionSpec {
            in_response_to: None,
            audience: "http://localhost:8080/saml",
            email: "sam@corp.example",
            groups: &[],
            authn_context: "x",
            expired: false,
        },
    );
    assert!(location(&post_acs(&app, &client(), &foreign, None).await).contains("signature"));

    // Mapping test endpoint sees the admin group.
    let mapping = body_json(
        admin
            .post(format!("{}/api/auth/saml/test-mapping", app.base))
            .json(&json!({ "groups": ["Console Admins"] }))
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(mapping["effective_role"], "admin");

    // A user with TOTP and an assertion without MFA context is asked for the code.
    enrol_totp(&app, &c).await;
    let (no_mfa, _) = signed_response(
        &idp,
        &AssertionSpec {
            in_response_to: None,
            audience: "http://localhost:8080/saml",
            email: "sam@corp.example",
            groups: &[],
            authn_context: "urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport",
            expired: false,
        },
    );
    let r = post_acs(&app, &client(), &no_mfa, None).await;
    assert!(
        location(&r).starts_with("/login?pending=two_factor"),
        "{}",
        location(&r)
    );
    let (mfa, _) = signed_response(
        &idp,
        &AssertionSpec {
            in_response_to: None,
            audience: "http://localhost:8080/saml",
            email: "sam@corp.example",
            groups: &[],
            authn_context: "urn:oasis:names:tc:SAML:2.0:ac:classes:MultiFactor",
            expired: false,
        },
    );
    let c3 = client();
    let r = post_acs(&app, &c3, &mfa, None).await;
    assert_eq!(
        location(&r),
        "/devices",
        "trusted IdP MFA skips the console's TOTP"
    );
    assert_eq!(me(&app, &c3).await.status(), 200);
}

#[tokio::test]
async fn saml_config_validation() {
    let app = spawn().await;
    let admin = client();
    setup_admin(&app, &admin).await;
    let r = admin
        .put(format!("{}/api/auth/saml/config", app.base))
        .json(&json!({ "enabled": true, "display_name": "x" }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 422, "metadata required to enable");
    let r = admin
        .put(format!("{}/api/auth/saml/config", app.base))
        .json(&json!({ "enabled": false, "display_name": "x", "idp_metadata_xml": "<broken" }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 422);
    assert_eq!(
        client()
            .get(format!("{}/api/auth/saml/start", app.base))
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
    assert_eq!(
        client()
            .get(format!("{}/api/auth/saml/config", app.base))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
}

// ── LOCAL_LOGIN=0 and break-glass ─────────────────────────────────────────────

#[tokio::test]
async fn local_login_disabled_keeps_break_glass_admins() {
    let app = spawn().await;
    let admin = client();
    let setup = setup_admin(&app, &admin).await;
    let admin_id = setup["user"]["id"].as_str().unwrap().to_string();
    assert_eq!(setup["user"]["break_glass"], false);
    let r = admin
        .post(format!("{}/api/users", app.base))
        .json(&json!({ "email": "op@example.com", "name": "Op", "password": "operator-pass-123", "role": "operator" }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 201);

    // Starting with LOCAL_LOGIN=0 and no break-glass admin is refused.
    let mut cfg = Config::for_tests(app.db_url.clone());
    cfg.local_login = false;
    let err = AppState::init(cfg).await.err().expect("refused");
    assert!(format!("{err:#}").contains("break_glass"), "{err:#}");

    let r = admin
        .patch(format!("{}/api/users/{admin_id}", app.base))
        .json(&json!({ "break_glass": true }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(body_json(r).await["break_glass"], true);

    let mut cfg = Config::for_tests(app.db_url.clone());
    cfg.local_login = false;
    let (base2, _state2) = serve(cfg).await.expect("starts with a break-glass admin");
    let app2 = TestApp {
        base: base2,
        state: app.state.clone(),
        db_url: app.db_url.clone(),
        _dir: tempfile::tempdir().unwrap(),
    };
    let providers = body_json(
        client()
            .get(format!("{}/api/auth/providers", app2.base))
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(providers["local_login"], false);

    let r = login(&app2, &client(), "op@example.com", "operator-pass-123").await;
    assert_eq!(r.status(), 403);
    assert_eq!(body_json(r).await["error"]["code"], "local_login_disabled");
    let r = login(&app2, &client(), "nobody@example.com", "operator-pass-123").await;
    assert_eq!(r.status(), 403, "unknown accounts get the same answer");
    let bg = client();
    let r = login(&app2, &bg, ADMIN_EMAIL, ADMIN_PASS).await;
    assert_eq!(r.status(), 200, "break-glass admin still signs in");
    let r = login(&app2, &client(), ADMIN_EMAIL, "wrong-password-xx").await;
    assert_eq!(r.status(), 401);

    // The last break-glass admin cannot lose the flag while local login is off.
    let r = bg
        .patch(format!("{}/api/users/{admin_id}", app2.base))
        .json(&json!({ "break_glass": false }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 409);
    assert_eq!(body_json(r).await["error"]["code"], "last_break_glass");
}

#[tokio::test]
async fn setup_with_local_login_off_flags_first_admin() {
    let app = spawn_with(|c| c.local_login = false).await;
    let c = client();
    let setup = setup_admin(&app, &c).await;
    assert_eq!(setup["user"]["break_glass"], true);
    assert_eq!(
        login(&app, &client(), ADMIN_EMAIL, ADMIN_PASS)
            .await
            .status(),
        200
    );
}

// ── LDAP (no directory available: config + error paths) ───────────────────────

#[tokio::test]
async fn ldap_config_and_unreachable_directory() {
    let app = spawn().await;
    let admin = client();
    setup_admin(&app, &admin).await;
    assert_eq!(
        client()
            .post(format!("{}/api/auth/ldap/login", app.base))
            .json(&json!({ "username": "u", "password": "p" }))
            .send()
            .await
            .unwrap()
            .status(),
        404,
        "disabled provider"
    );
    let cfg = json!({
        "enabled": true,
        "display_name": "Corp Directory",
        "url": "ldap://127.0.0.1:1",
        "bind_dn": "cn=svc,dc=corp,dc=example",
        "bind_password": "svc-secret",
        "base_dn": "dc=corp,dc=example",
        "attribute_map": { "email": "mail", "name": "displayName", "groups": "memberOf" },
        "admin_group": "Remote Admins",
        "auto_provision": true,
        "default_role": "operator"
    });
    let r = admin
        .put(format!("{}/api/auth/ldap/config", app.base))
        .json(&cfg)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200, "{}", r.text().await.unwrap_or_default());
    let stored = body_json(r).await;
    assert_eq!(stored["bind_password_set"], true);
    assert!(stored.get("bind_password").is_none() && stored.get("bind_password_enc").is_none());
    let providers = body_json(
        client()
            .get(format!("{}/api/auth/providers", app.base))
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(providers["ldap"]["display_name"], "Corp Directory");

    let r = admin
        .post(format!("{}/api/auth/ldap/test", app.base))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 502);
    let r = client()
        .post(format!("{}/api/auth/ldap/login", app.base))
        .json(&json!({ "username": "alice", "password": "pw" }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 502);
    assert_eq!(body_json(r).await["error"]["code"], "sso_provider_error");

    let mapping = body_json(
        admin
            .post(format!("{}/api/auth/ldap/test-mapping", app.base))
            .json(&json!({ "groups": ["Remote Admins"] }))
            .send()
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(mapping["effective_role"], "admin");

    let r = admin
        .put(format!("{}/api/auth/ldap/config", app.base))
        .json(&json!({ "enabled": true, "display_name": "x", "url": "http://nope", "base_dn": "dc=x" }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 422);
}
