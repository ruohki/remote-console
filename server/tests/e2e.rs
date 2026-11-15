//! End-to-end tests: real HTTP server on a random port, real WebSockets, temp SQLite.

use futures_util::{SinkExt, StreamExt};
use protocol::agent::{AgentCapabilities, AgentToConsole, ConsoleToAgent};
use protocol::common::*;
use protocol::config::{EnrollRequest, EnrollResponse, LocalOverrides};
use protocol::ui::{ConsoleToUi, UiToConsole};
use remote_console::app::{build_router, AppState};
use remote_console::config::Config;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::time::Duration;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

struct TestApp {
    base: String,
    ws_base: String,
    state: AppState,
    _dir: tempfile::TempDir,
}

async fn spawn_app() -> TestApp {
    let dir = tempfile::tempdir().expect("tempdir");
    let db_path = dir.path().join("console.db");
    let config = Config::for_tests(format!("sqlite://{}?mode=rwc", db_path.display()));
    let state = AppState::init(config).await.expect("state");
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
        _dir: dir,
    }
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .cookie_store(true)
        .build()
        .expect("client")
}

async fn setup_admin(app: &TestApp, c: &reqwest::Client) -> String {
    let r = c
        .post(format!("{}/api/setup", app.base))
        .json(&json!({ "email": "admin@example.com", "name": "Admin", "password": "correct-horse-battery" }))
        .send()
        .await
        .expect("setup");
    assert_eq!(r.status(), 201, "{}", r.text().await.unwrap_or_default());
    let cookie = r
        .headers()
        .get("set-cookie")
        .expect("set-cookie")
        .to_str()
        .expect("str")
        .split(';')
        .next()
        .expect("pair")
        .to_string();
    assert!(cookie.starts_with("console_session="));
    cookie
}

async fn create_token(app: &TestApp, c: &reqwest::Client, mode: &str) -> Value {
    let r = c
        .post(format!("{}/api/enroll-tokens", app.base))
        .json(&json!({ "label": "test", "default_mode": mode, "default_tags": ["lab"], "max_uses": 5 }))
        .send()
        .await
        .expect("token");
    assert_eq!(r.status(), 201);
    r.json().await.expect("json")
}

async fn enroll(app: &TestApp, token: &str) -> EnrollResponse {
    let r = reqwest::Client::new()
        .post(format!("{}/api/enroll", app.base))
        .json(&EnrollRequest {
            token: token.to_string(),
            hostname: "test-host".into(),
            os: Os::Macos,
            arch: Arch::Aarch64,
            agent_version: "0.1.0".into(),
            display_name: None,
            machine_id: None,
        })
        .send()
        .await
        .expect("enroll");
    assert_eq!(r.status(), 201, "{}", r.text().await.unwrap_or_default());
    r.json().await.expect("json")
}

async fn connect_ws(url: &str, cookie: Option<&str>) -> Ws {
    let mut req = url.into_client_request().expect("request");
    if let Some(cookie) = cookie {
        req.headers_mut()
            .insert("Cookie", cookie.parse().expect("cookie header"));
    }
    let (ws, _) = tokio_tungstenite::connect_async(req)
        .await
        .expect("ws connect");
    ws
}

async fn send<T: serde::Serialize>(ws: &mut Ws, msg: &T) {
    ws.send(Message::Text(
        serde_json::to_string(msg).expect("ser").into(),
    ))
    .await
    .expect("send");
}

/// Next JSON text frame, ignoring pings/pongs. Panics on close/timeout.
async fn recv<T: DeserializeOwned>(ws: &mut Ws) -> T {
    let frame = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match ws.next().await {
                Some(Ok(Message::Text(t))) => return Ok(t.to_string()),
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
                Some(Ok(Message::Close(f))) => return Err(format!("closed: {f:?}")),
                other => return Err(format!("unexpected: {other:?}")),
            }
        }
    })
    .await
    .expect("timeout waiting for ws message")
    .expect("ws message");
    serde_json::from_str(&frame).unwrap_or_else(|e| panic!("bad message {frame}: {e}"))
}

/// Keep receiving until `pred` matches (skips unrelated broadcasts).
async fn recv_until<T: DeserializeOwned>(ws: &mut Ws, mut pred: impl FnMut(&T) -> bool) -> T {
    for _ in 0..20 {
        let m: T = recv(ws).await;
        if pred(&m) {
            return m;
        }
    }
    panic!("expected message not received");
}

async fn expect_close(ws: &mut Ws) -> u16 {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match ws.next().await {
                Some(Ok(Message::Close(Some(f)))) => return u16::from(f.code),
                Some(Ok(Message::Close(None))) => return 1005,
                Some(Ok(_)) => continue,
                _ => return 1006,
            }
        }
    })
    .await
    .expect("timeout waiting for close")
}

fn default_capabilities() -> AgentCapabilities {
    AgentCapabilities {
        codecs: vec![VideoCodec::H265, VideoCodec::H264],
        displays: vec![DisplayInfo {
            index: 0,
            name: "Main".into(),
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
            scale: 1.0,
            primary: true,
        }],
        input: true,
        clipboard: true,
        privacy_screen: PrivacyScreenSupport::Unsupported,
    }
}

async fn agent_hello(app: &TestApp, enrolled: &EnrollResponse, secret: &str) -> Ws {
    agent_hello_with(app, enrolled, secret, default_capabilities()).await
}

async fn agent_hello_with(
    app: &TestApp,
    enrolled: &EnrollResponse,
    secret: &str,
    capabilities: AgentCapabilities,
) -> Ws {
    let mut ws = connect_ws(&format!("{}/ws/agent", app.ws_base), None).await;
    send(
        &mut ws,
        &AgentToConsole::Hello {
            protocol_version: protocol::PROTOCOL_VERSION,
            device_id: enrolled.device_id.clone(),
            device_secret: secret.to_string(),
            agent_version: "0.1.0".into(),
            hostname: "test-host".into(),
            os: Os::Macos,
            arch: Arch::Aarch64,
            mode: DeviceMode::Unattended,
            capabilities,
            logged_in_user: Some("alice".into()),
            local_overrides: LocalOverrides::default(),
            machine_id: None,
            desktop: None,
        },
    )
    .await;
    ws
}

// ── tests ─────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn setup_login_and_me() {
    let app = spawn_app().await;
    let c = client();

    let r: Value = c
        .get(format!("{}/api/setup", app.base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(r["needs_setup"], true);
    let r = c
        .get(format!("{}/api/auth/me", app.base))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 401);

    setup_admin(&app, &c).await;
    let r: Value = c
        .get(format!("{}/api/setup", app.base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(r["needs_setup"], false);

    // second setup is refused
    let r = c
        .post(format!("{}/api/setup", app.base))
        .json(
            &json!({ "email": "x@example.com", "name": "X", "password": "correct-horse-battery" }),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 409);

    let me: Value = c
        .get(format!("{}/api/auth/me", app.base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(me["user"]["role"], "admin");
    assert_eq!(me["user"]["email"], "admin@example.com");

    // logout, wrong password, correct password
    assert_eq!(
        c.post(format!("{}/api/auth/logout", app.base))
            .send()
            .await
            .unwrap()
            .status(),
        204
    );
    assert_eq!(
        c.get(format!("{}/api/auth/me", app.base))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    let r = c
        .post(format!("{}/api/auth/login", app.base))
        .json(&json!({ "email": "admin@example.com", "password": "nope-nope-nope" }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 401);
    let body: Value = r.json().await.unwrap();
    assert_eq!(body["error"]["code"], "invalid_credentials");
    let r = c
        .post(format!("{}/api/auth/login", app.base))
        .json(&json!({ "email": "Admin@Example.com", "password": "correct-horse-battery" }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(
        c.get(format!("{}/api/auth/me", app.base))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );

    // info is public
    let info: Value = reqwest::get(format!("{}/api/info", app.base))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(info["protocol_version"], protocol::PROTOCOL_VERSION);
    assert_eq!(info["turn_enabled"], false);
}

#[tokio::test]
async fn json_guard_rejects_forms() {
    let app = spawn_app().await;
    let r = reqwest::Client::new()
        .post(format!("{}/api/setup", app.base))
        .header("content-type", "application/x-www-form-urlencoded")
        .body("email=a@b.c&name=A&password=correct-horse-battery")
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 415);
}

#[tokio::test]
async fn users_crud_and_last_admin_protection() {
    let app = spawn_app().await;
    let c = client();
    setup_admin(&app, &c).await;

    let r = c
        .post(format!("{}/api/users", app.base))
        .json(&json!({ "email": "op@example.com", "name": "Op", "password": "operator-pass-1", "role": "operator" }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 201);
    let op: Value = r.json().await.unwrap();
    let users: Vec<Value> = c
        .get(format!("{}/api/users", app.base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(users.len(), 2);

    let me: Value = c
        .get(format!("{}/api/auth/me", app.base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let admin_id = me["user"]["id"].as_str().unwrap();
    let r = c
        .patch(format!("{}/api/users/{admin_id}", app.base))
        .json(&json!({ "role": "operator" }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 409);
    let r = c
        .delete(format!("{}/api/users/{admin_id}", app.base))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 409);

    // operator cannot manage users
    let opc = client();
    let r = opc
        .post(format!("{}/api/auth/login", app.base))
        .json(&json!({ "email": "op@example.com", "password": "operator-pass-1" }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(
        opc.get(format!("{}/api/users", app.base))
            .send()
            .await
            .unwrap()
            .status(),
        403
    );

    let r = c
        .delete(format!(
            "{}/api/users/{}",
            app.base,
            op["id"].as_str().unwrap()
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 204);
    assert_eq!(
        opc.get(format!("{}/api/auth/me", app.base))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
}

#[tokio::test]
async fn enroll_and_install_scripts() {
    let app = spawn_app().await;
    let c = client();
    setup_admin(&app, &c).await;
    let tok = create_token(&app, &c, "help_me").await;
    let token = tok["token"].as_str().unwrap().to_string();
    assert_eq!(tok["token_prefix"], token[..8]);
    assert!(tok["install"]["macos"]
        .as_str()
        .unwrap()
        .contains(&format!("install.sh?token={token}")));
    assert!(tok["install"]["windows"]
        .as_str()
        .unwrap()
        .contains("install.ps1"));

    // scripts
    let sh = reqwest::get(format!("{}/install.sh?token={token}", app.base))
        .await
        .unwrap();
    assert_eq!(sh.status(), 200);
    assert!(sh.headers()["content-type"]
        .to_str()
        .unwrap()
        .contains("shellscript"));
    let sh = sh.text().await.unwrap();
    assert!(sh.contains(&format!("TOKEN=\"{token}\"")));
    assert!(sh.contains("remote-agent enroll") || sh.contains("enroll --server"));
    let bad = reqwest::get(format!("{}/install.sh?token=nope", app.base))
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(bad.contains("exit 1") && bad.contains("unknown enrollment token"));
    let none = reqwest::get(format!("{}/install.ps1", app.base))
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(none.contains("exit 1"));
    let ps = reqwest::get(format!("{}/install.ps1?token={token}", app.base))
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(ps.contains(&format!("$Token        = '{token}'")));

    // enroll
    let enrolled = enroll(&app, &token).await;
    assert!(enrolled.device_id.starts_with("dev_"));
    assert_eq!(enrolled.device_secret.len(), 43);
    assert_eq!(enrolled.config.mode, DeviceMode::HelpMe);
    assert_eq!(enrolled.server_url, "http://localhost:8080");

    let devices: Vec<Value> = c
        .get(format!("{}/api/devices", app.base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(devices.len(), 1);
    assert_eq!(devices[0]["id"], enrolled.device_id);
    assert_eq!(devices[0]["online"], false);
    assert_eq!(devices[0]["tags"][0], "lab");
    assert_eq!(devices[0]["mode"], "help_me");

    let detail: Value = c
        .get(format!("{}/api/devices/{}", app.base, enrolled.device_id))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(detail["enrolled_with"], "test");
    assert_eq!(detail["config"]["mode"], "help_me");

    // token accounting + revoke
    let tokens: Vec<Value> = c
        .get(format!("{}/api/enroll-tokens", app.base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(tokens[0]["uses"], 1);
    assert!(tokens[0].get("token").is_none());
    let r = c
        .delete(format!(
            "{}/api/enroll-tokens/{}",
            app.base,
            tok["id"].as_str().unwrap()
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 204);
    let r = reqwest::Client::new()
        .post(format!("{}/api/enroll", app.base))
        .json(&json!({ "token": token, "hostname": "h", "os": "windows", "arch": "x86_64", "agent_version": "0.1.0" }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 401);
}

#[tokio::test]
async fn agent_bad_secret_is_rejected() {
    let app = spawn_app().await;
    let c = client();
    setup_admin(&app, &c).await;
    let tok = create_token(&app, &c, "unattended").await;
    let enrolled = enroll(&app, tok["token"].as_str().unwrap()).await;

    let mut ws = agent_hello(&app, &enrolled, "wrong-secret").await;
    assert_eq!(expect_close(&mut ws).await, 4401);

    let mut ws = connect_ws(&format!("{}/ws/agent", app.ws_base), None).await;
    send(&mut ws, &json!({ "type": "heartbeat", "uptime_s": 1 })).await;
    assert_eq!(expect_close(&mut ws).await, 4400);

    let mut ws = connect_ws(&format!("{}/ws/agent", app.ws_base), None).await;
    send(
        &mut ws,
        &json!({
            "type": "hello", "protocol_version": 999, "device_id": enrolled.device_id,
            "device_secret": enrolled.device_secret, "agent_version": "0", "hostname": "h",
            "os": "macos", "arch": "aarch64", "mode": "unattended",
            "capabilities": { "codecs": [], "displays": [], "input": false, "clipboard": false }
        }),
    )
    .await;
    assert_eq!(expect_close(&mut ws).await, 4426);

    let mut ws = connect_ws(&format!("{}/ws/agent", app.ws_base), None).await;
    send(
        &mut ws,
        &json!({
            "type": "hello", "protocol_version": protocol::PROTOCOL_VERSION, "device_id": "dev_missing",
            "device_secret": "x", "agent_version": "0", "hostname": "h",
            "os": "macos", "arch": "aarch64", "mode": "unattended",
            "capabilities": { "codecs": [], "displays": [], "input": false, "clipboard": false }
        }),
    )
    .await;
    assert_eq!(expect_close(&mut ws).await, 4409);
}

#[tokio::test]
async fn full_session_flow() {
    let app = spawn_app().await;
    let c = client();
    let cookie = setup_admin(&app, &c).await;
    let tok = create_token(&app, &c, "unattended").await;
    let enrolled = enroll(&app, tok["token"].as_str().unwrap()).await;

    // agent connects
    let mut agent = agent_hello(&app, &enrolled, &enrolled.device_secret).await;
    let ack: ConsoleToAgent = recv(&mut agent).await;
    match ack {
        ConsoleToAgent::HelloAck {
            config,
            protocol_version,
            ..
        } => {
            assert_eq!(protocol_version, protocol::PROTOCOL_VERSION);
            assert_eq!(config.mode, DeviceMode::Unattended);
        }
        other => panic!("expected hello_ack, got {other:?}"),
    }

    // ui subscribes and sees the device online
    let mut ui = connect_ws(&format!("{}/ws/ui", app.ws_base), Some(&cookie)).await;
    send(&mut ui, &UiToConsole::Subscribe).await;
    let snap: ConsoleToUi = recv(&mut ui).await;
    match snap {
        ConsoleToUi::Snapshot { devices, sessions } => {
            assert_eq!(devices.len(), 1);
            assert!(devices[0].online);
            assert_eq!(devices[0].logged_in_user.as_deref(), Some("alice"));
            assert_eq!(devices[0].codecs, vec![VideoCodec::H265, VideoCodec::H264]);
            assert!(sessions.is_empty());
        }
        other => panic!("expected snapshot, got {other:?}"),
    }

    // ping/pong
    send(&mut ui, &UiToConsole::Ping { nonce: 7 }).await;
    let pong: ConsoleToUi = recv_until(&mut ui, |m| matches!(m, ConsoleToUi::Pong { .. })).await;
    assert!(matches!(pong, ConsoleToUi::Pong { nonce: 7 }));

    // offer
    send(
        &mut ui,
        &UiToConsole::SessionOffer {
            device_id: enrolled.device_id.clone(),
            offer: SessionDescription {
                kind: "offer".into(),
                sdp: "v=0 offer".into(),
            },
            shadow_of: None,
        },
    )
    .await;
    let created: ConsoleToUi =
        recv_until(&mut ui, |m| matches!(m, ConsoleToUi::SessionCreated { .. })).await;
    let session_id = match created {
        ConsoleToUi::SessionCreated {
            session_id,
            device_id,
            ice_servers,
        } => {
            assert_eq!(device_id, enrolled.device_id);
            assert!(!ice_servers.is_empty());
            session_id
        }
        _ => unreachable!(),
    };
    assert!(session_id.starts_with("ses_"));

    let req: ConsoleToAgent = recv_until(&mut agent, |m| {
        matches!(m, ConsoleToAgent::SessionRequest { .. })
    })
    .await;
    match req {
        ConsoleToAgent::SessionRequest {
            session_id: sid,
            operator,
            offer,
            ice_servers,
            ..
        } => {
            assert_eq!(sid, session_id);
            assert_eq!(operator.name, "Admin");
            assert_eq!(offer.sdp, "v=0 offer");
            assert!(!ice_servers.is_empty());
        }
        _ => unreachable!(),
    }

    // device is busy now
    send(
        &mut ui,
        &UiToConsole::SessionOffer {
            device_id: enrolled.device_id.clone(),
            offer: SessionDescription {
                kind: "offer".into(),
                sdp: "x".into(),
            },
            shadow_of: None,
        },
    )
    .await;
    let busy: ConsoleToUi = recv_until(&mut ui, |m| matches!(m, ConsoleToUi::Error { .. })).await;
    assert!(matches!(busy, ConsoleToUi::Error { code, .. } if code == "device_busy"));

    // answer + ice both ways
    send(
        &mut agent,
        &AgentToConsole::SessionAnswer {
            session_id: session_id.clone(),
            answer: SessionDescription {
                kind: "answer".into(),
                sdp: "v=0 answer".into(),
            },
            codec: VideoCodec::H265,
        },
    )
    .await;
    let answer: ConsoleToUi =
        recv_until(&mut ui, |m| matches!(m, ConsoleToUi::SessionAnswer { .. })).await;
    match answer {
        ConsoleToUi::SessionAnswer { answer, codec, .. } => {
            assert_eq!(answer.sdp, "v=0 answer");
            assert_eq!(codec, VideoCodec::H265);
        }
        _ => unreachable!(),
    }
    let cand = IceCandidate {
        candidate: "candidate:1".into(),
        sdp_mid: Some("0".into()),
        sdp_mline_index: Some(0),
        username_fragment: None,
    };
    send(
        &mut ui,
        &UiToConsole::IceCandidate {
            session_id: session_id.clone(),
            candidate: cand.clone(),
        },
    )
    .await;
    let got: ConsoleToAgent = recv_until(&mut agent, |m| {
        matches!(m, ConsoleToAgent::IceCandidate { .. })
    })
    .await;
    assert!(matches!(got, ConsoleToAgent::IceCandidate { candidate, .. } if candidate == cand));
    send(
        &mut agent,
        &AgentToConsole::IceCandidate {
            session_id: session_id.clone(),
            candidate: cand.clone(),
        },
    )
    .await;
    let got: ConsoleToUi =
        recv_until(&mut ui, |m| matches!(m, ConsoleToUi::IceCandidate { .. })).await;
    assert!(matches!(got, ConsoleToUi::IceCandidate { candidate, .. } if candidate == cand));

    // connected
    send(
        &mut agent,
        &AgentToConsole::SessionState {
            session_id: session_id.clone(),
            state: SessionState::Connected,
            reason: None,
        },
    )
    .await;
    let upd: ConsoleToUi = recv_until(
        &mut ui,
        |m| matches!(m, ConsoleToUi::SessionUpdate { session } if session.state == SessionState::Connected),
    )
    .await;
    assert!(
        matches!(upd, ConsoleToUi::SessionUpdate { session } if session.connected_at.is_some() && session.codec == Some(VideoCodec::H265))
    );

    let active: Vec<Value> = c
        .get(format!("{}/api/sessions?active=1", app.base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(active.len(), 1);
    assert_eq!(active[0]["state"], "connected");
    let dev: Value = c
        .get(format!("{}/api/devices/{}", app.base, enrolled.device_id))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(dev["active_session_id"], session_id);

    // end from the UI
    send(
        &mut ui,
        &UiToConsole::SessionEnd {
            session_id: session_id.clone(),
        },
    )
    .await;
    let end: ConsoleToAgent = recv_until(&mut agent, |m| {
        matches!(m, ConsoleToAgent::SessionEnd { .. })
    })
    .await;
    assert!(matches!(
        end,
        ConsoleToAgent::SessionEnd {
            reason: EndReason::OperatorClosed,
            ..
        }
    ));
    let _: ConsoleToUi = recv_until(
        &mut ui,
        |m| matches!(m, ConsoleToUi::SessionUpdate { session } if session.state == SessionState::Ended),
    )
    .await;

    let all: Vec<Value> = c
        .get(format!("{}/api/sessions", app.base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(all[0]["state"], "ended");
    assert_eq!(all[0]["end_reason"], "operator_closed");
    let by_device: Vec<Value> = c
        .get(format!(
            "{}/api/devices/{}/sessions",
            app.base, enrolled.device_id
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(by_device.len(), 1);

    // audit trail
    let audit: Vec<Value> = c
        .get(format!("{}/api/audit", app.base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let actions: Vec<&str> = audit
        .iter()
        .map(|a| a["action"].as_str().unwrap())
        .collect();
    assert!(actions.contains(&"session.start"));
    assert!(actions.contains(&"session.end"));
    assert!(actions.contains(&"enroll"));

    // config push reaches the agent
    let r = c
        .patch(format!(
            "{}/api/devices/{}/config",
            app.base, enrolled.device_id
        ))
        .json(&json!({ "mode": "help_me", "max_fps": 30 }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let upd: ConsoleToAgent = recv_until(&mut agent, |m| {
        matches!(m, ConsoleToAgent::ConfigUpdate { .. })
    })
    .await;
    assert!(
        matches!(upd, ConsoleToAgent::ConfigUpdate { config } if config.mode == DeviceMode::HelpMe && config.max_fps == 30)
    );
    let dev: Value = c
        .get(format!("{}/api/devices/{}", app.base, enrolled.device_id))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(dev["mode"], "help_me");

    // agent disconnect → ui sees offline
    agent.close(None).await.unwrap();
    let off: ConsoleToUi = recv_until(
        &mut ui,
        |m| matches!(m, ConsoleToUi::DeviceUpdate { device } if !device.online),
    )
    .await;
    assert!(matches!(off, ConsoleToUi::DeviceUpdate { .. }));
}

#[tokio::test]
async fn help_me_denied_and_offline_errors() {
    let app = spawn_app().await;
    let c = client();
    let cookie = setup_admin(&app, &c).await;
    let tok = create_token(&app, &c, "help_me").await;
    let enrolled = enroll(&app, tok["token"].as_str().unwrap()).await;

    let mut ui = connect_ws(&format!("{}/ws/ui", app.ws_base), Some(&cookie)).await;
    send(&mut ui, &UiToConsole::Subscribe).await;
    let _: ConsoleToUi = recv(&mut ui).await;

    // offline
    send(
        &mut ui,
        &UiToConsole::SessionOffer {
            device_id: enrolled.device_id.clone(),
            offer: SessionDescription {
                kind: "offer".into(),
                sdp: "x".into(),
            },
            shadow_of: None,
        },
    )
    .await;
    let err: ConsoleToUi = recv_until(&mut ui, |m| matches!(m, ConsoleToUi::Error { .. })).await;
    assert!(matches!(err, ConsoleToUi::Error { code, .. } if code == "device_offline"));

    // unknown device
    send(
        &mut ui,
        &UiToConsole::SessionOffer {
            device_id: "dev_nope".into(),
            offer: SessionDescription {
                kind: "offer".into(),
                sdp: "x".into(),
            },
            shadow_of: None,
        },
    )
    .await;
    let err: ConsoleToUi = recv_until(&mut ui, |m| matches!(m, ConsoleToUi::Error { .. })).await;
    assert!(matches!(err, ConsoleToUi::Error { code, .. } if code == "not_found"));

    // help-me denial
    let mut agent = agent_hello(&app, &enrolled, &enrolled.device_secret).await;
    let _: ConsoleToAgent = recv(&mut agent).await;
    send(
        &mut ui,
        &UiToConsole::SessionOffer {
            device_id: enrolled.device_id.clone(),
            offer: SessionDescription {
                kind: "offer".into(),
                sdp: "x".into(),
            },
            shadow_of: None,
        },
    )
    .await;
    let created: ConsoleToUi =
        recv_until(&mut ui, |m| matches!(m, ConsoleToUi::SessionCreated { .. })).await;
    let ConsoleToUi::SessionCreated { session_id, .. } = created else {
        unreachable!()
    };
    let _: ConsoleToUi = recv_until(
        &mut ui,
        |m| matches!(m, ConsoleToUi::SessionUpdate { session } if session.state == SessionState::AwaitingApproval),
    )
    .await;
    let _: ConsoleToAgent = recv_until(&mut agent, |m| {
        matches!(m, ConsoleToAgent::SessionRequest { .. })
    })
    .await;
    send(
        &mut agent,
        &AgentToConsole::ApprovalResult {
            session_id: session_id.clone(),
            approved: false,
        },
    )
    .await;
    let err: ConsoleToUi = recv_until(&mut ui, |m| matches!(m, ConsoleToUi::Error { .. })).await;
    assert!(
        matches!(err, ConsoleToUi::Error { code, session_id: Some(s), .. } if code == "denied" && s == session_id)
    );
    let end: ConsoleToAgent = recv_until(&mut agent, |m| {
        matches!(m, ConsoleToAgent::SessionEnd { .. })
    })
    .await;
    assert!(matches!(
        end,
        ConsoleToAgent::SessionEnd {
            reason: EndReason::Denied,
            ..
        }
    ));
    let sessions: Vec<Value> = c
        .get(format!("{}/api/sessions", app.base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(sessions[0]["end_reason"], "denied");

    // REST end of an active session by admin
    send(
        &mut ui,
        &UiToConsole::SessionOffer {
            device_id: enrolled.device_id.clone(),
            offer: SessionDescription {
                kind: "offer".into(),
                sdp: "x".into(),
            },
            shadow_of: None,
        },
    )
    .await;
    let created: ConsoleToUi =
        recv_until(&mut ui, |m| matches!(m, ConsoleToUi::SessionCreated { .. })).await;
    let ConsoleToUi::SessionCreated { session_id, .. } = created else {
        unreachable!()
    };
    let r = c
        .post(format!("{}/api/sessions/{session_id}/end", app.base))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 204);
    let end: ConsoleToAgent = recv_until(&mut agent, |m| {
        matches!(m, ConsoleToAgent::SessionEnd { .. })
    })
    .await;
    assert!(matches!(
        end,
        ConsoleToAgent::SessionEnd {
            reason: EndReason::OperatorClosed,
            ..
        }
    ));
    let r = c
        .post(format!("{}/api/sessions/{session_id}/end", app.base))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 409);
}

#[tokio::test]
async fn second_agent_connection_replaces_first() {
    let app = spawn_app().await;
    let c = client();
    setup_admin(&app, &c).await;
    let tok = create_token(&app, &c, "unattended").await;
    let enrolled = enroll(&app, tok["token"].as_str().unwrap()).await;

    let mut first = agent_hello(&app, &enrolled, &enrolled.device_secret).await;
    let _: ConsoleToAgent = recv(&mut first).await;
    let mut second = agent_hello(&app, &enrolled, &enrolled.device_secret).await;
    let _: ConsoleToAgent = recv(&mut second).await;

    let bye: ConsoleToAgent =
        recv_until(&mut first, |m| matches!(m, ConsoleToAgent::Goodbye { .. })).await;
    assert!(matches!(bye, ConsoleToAgent::Goodbye { .. }));
    assert_eq!(expect_close(&mut first).await, 1000);

    // device still online via the second connection
    let devices: Vec<Value> = c
        .get(format!("{}/api/devices", app.base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(devices[0]["online"], true);

    // delete device → the (protocol 2) second connection is retired and closed
    let r = c
        .delete(format!("{}/api/devices/{}", app.base, enrolled.device_id))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 204);
    let bye: ConsoleToAgent =
        recv_until(&mut second, |m| matches!(m, ConsoleToAgent::Retire { .. })).await;
    assert_eq!(
        bye,
        ConsoleToAgent::Retire {
            reason: "device deleted".into()
        }
    );
    assert_eq!(expect_close(&mut second).await, 1000);
    let devices: Vec<Value> = c
        .get(format!("{}/api/devices", app.base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(devices.is_empty());
}

#[tokio::test]
async fn ui_socket_requires_login_and_spa_fallback_works() {
    let app = spawn_app().await;
    let req = format!("{}/ws/ui", app.ws_base)
        .into_client_request()
        .unwrap();
    let err = tokio_tungstenite::connect_async(req)
        .await
        .expect_err("should be rejected");
    assert!(err.to_string().contains("401"), "{err}");

    let r = reqwest::get(format!("{}/some/client/route", app.base))
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    assert!(r.headers()["content-type"]
        .to_str()
        .unwrap()
        .contains("text/html"));
    let r = reqwest::get(format!("{}/api/does-not-exist", app.base))
        .await
        .unwrap();
    assert_eq!(r.status(), 404);
}

#[tokio::test]
async fn session_events_are_stored_pushed_and_audited() {
    use protocol::agent::SessionEvent;
    use protocol::channel::ChatParty;
    use protocol::files::{TransferDirection, TransferKind};

    let app = spawn_app().await;
    let c = client();
    let cookie = setup_admin(&app, &c).await;
    let tok = create_token(&app, &c, "unattended").await;
    let enrolled = enroll(&app, tok["token"].as_str().unwrap()).await;
    let other = enroll(&app, tok["token"].as_str().unwrap()).await;

    let mut agent = agent_hello(&app, &enrolled, &enrolled.device_secret).await;
    let _ack: ConsoleToAgent = recv(&mut agent).await;
    let mut foreign = agent_hello(&app, &other, &other.device_secret).await;
    let _ack: ConsoleToAgent = recv(&mut foreign).await;

    let mut ui = connect_ws(&format!("{}/ws/ui", app.ws_base), Some(&cookie)).await;
    send(&mut ui, &UiToConsole::Subscribe).await;
    let _snap: ConsoleToUi = recv(&mut ui).await;

    send(
        &mut ui,
        &UiToConsole::SessionOffer {
            device_id: enrolled.device_id.clone(),
            offer: SessionDescription {
                kind: "offer".into(),
                sdp: "v=0 offer".into(),
            },
            shadow_of: None,
        },
    )
    .await;
    let created: ConsoleToUi =
        recv_until(&mut ui, |m| matches!(m, ConsoleToUi::SessionCreated { .. })).await;
    let session_id = match created {
        ConsoleToUi::SessionCreated { session_id, .. } => session_id,
        _ => unreachable!(),
    };
    let _req: ConsoleToAgent = recv_until(&mut agent, |m| {
        matches!(m, ConsoleToAgent::SessionRequest { .. })
    })
    .await;

    // chat + completed transfer from the owning agent
    let chat = SessionEvent::Chat {
        from: ChatParty::Device,
        text: "hello operator".into(),
    };
    send(
        &mut agent,
        &AgentToConsole::SessionEvent {
            session_id: session_id.clone(),
            event: chat.clone(),
            ts_ms: 1,
        },
    )
    .await;
    let pushed: ConsoleToUi =
        recv_until(&mut ui, |m| matches!(m, ConsoleToUi::SessionEvent { .. })).await;
    match pushed {
        ConsoleToUi::SessionEvent {
            session_id: sid,
            event,
            ts,
        } => {
            assert_eq!(sid, session_id);
            assert_eq!(event, chat);
            assert!(!ts.is_empty());
        }
        _ => unreachable!(),
    }
    let transfer = SessionEvent::TransferCompleted {
        token: "tok1".into(),
        name: "report.pdf".into(),
        size: 1234,
        direction: TransferDirection::ToDevice,
        path: Some("/Users/alice/Downloads/RemoteAgent/report.pdf".into()),
    };
    send(
        &mut agent,
        &AgentToConsole::SessionEvent {
            session_id: session_id.clone(),
            event: transfer.clone(),
            ts_ms: 2,
        },
    )
    .await;
    let _pushed: ConsoleToUi =
        recv_until(&mut ui, |m| matches!(m, ConsoleToUi::SessionEvent { .. })).await;

    // an event for this session from another device is rejected (no push, no row)
    send(
        &mut foreign,
        &AgentToConsole::SessionEvent {
            session_id: session_id.clone(),
            event: SessionEvent::TransferStarted {
                token: "x".into(),
                name: "evil".into(),
                size: 1,
                kind: TransferKind::File,
                direction: TransferDirection::ToDevice,
                offset: 0,
            },
            ts_ms: 3,
        },
    )
    .await;
    // …and one for an unknown session is rejected too
    send(
        &mut agent,
        &AgentToConsole::SessionEvent {
            session_id: "ses_doesnotexist".into(),
            event: chat.clone(),
            ts_ms: 4,
        },
    )
    .await;
    // a ping/pong round trip on the ui socket proves the rejected events produced nothing before it
    send(&mut ui, &UiToConsole::Ping { nonce: 42 }).await;
    let next: ConsoleToUi = recv(&mut ui).await;
    assert!(
        matches!(next, ConsoleToUi::Pong { nonce: 42 }),
        "unexpected {next:?}"
    );

    // endpoint: oldest first, only the two accepted events
    let r = c
        .get(format!("{}/api/sessions/{session_id}/events", app.base))
        .send()
        .await
        .expect("events");
    assert_eq!(r.status(), 200);
    let events: Vec<Value> = r.json().await.expect("json");
    assert_eq!(events.len(), 2, "{events:?}");
    assert_eq!(events[0]["event"]["type"], "chat");
    assert_eq!(events[0]["event"]["text"], "hello operator");
    assert_eq!(events[1]["event"]["type"], "transfer_completed");
    assert_eq!(events[1]["event"]["name"], "report.pdf");
    assert!(events[0]["id"].as_i64().unwrap() < events[1]["id"].as_i64().unwrap());
    assert_eq!(events[0]["session_id"], session_id);
    // `after` pagination
    let after = events[0]["id"].as_i64().unwrap();
    let page: Vec<Value> = c
        .get(format!(
            "{}/api/sessions/{session_id}/events?after={after}",
            app.base
        ))
        .send()
        .await
        .expect("page")
        .json()
        .await
        .expect("json");
    assert_eq!(page.len(), 1);
    assert_eq!(page[0]["event"]["type"], "transfer_completed");
    // unknown session → 404
    let r = c
        .get(format!("{}/api/sessions/ses_nope/events", app.base))
        .send()
        .await
        .expect("404");
    assert_eq!(r.status(), 404);

    // audit row for the transfer
    let audit: Vec<Value> = c
        .get(format!("{}/api/audit?limit=50", app.base))
        .send()
        .await
        .expect("audit")
        .json()
        .await
        .expect("json");
    let transfer_row = audit
        .iter()
        .find(|a| a["action"] == "session.transfer")
        .expect("session.transfer audit entry");
    assert_eq!(transfer_row["target"], session_id);
    assert_eq!(transfer_row["details"]["name"], "report.pdf");
    assert_eq!(transfer_row["details"]["result"], "completed");
    assert_eq!(transfer_row["user_name"], "Admin");

    // events are still accepted shortly after the session ended (late transfer results)
    send(
        &mut ui,
        &UiToConsole::SessionEnd {
            session_id: session_id.clone(),
        },
    )
    .await;
    let _ended: ConsoleToUi = recv_until(&mut ui, |m| {
        matches!(m, ConsoleToUi::SessionUpdate { session } if session.state == SessionState::Ended)
    })
    .await;
    send(
        &mut agent,
        &AgentToConsole::SessionEvent {
            session_id: session_id.clone(),
            event: SessionEvent::TransferFailed {
                token: "tok2".into(),
                name: "late.bin".into(),
                reason: "connection lost".into(),
            },
            ts_ms: 5,
        },
    )
    .await;
    let late: ConsoleToUi =
        recv_until(&mut ui, |m| matches!(m, ConsoleToUi::SessionEvent { .. })).await;
    assert!(matches!(
        late,
        ConsoleToUi::SessionEvent {
            event: SessionEvent::TransferFailed { .. },
            ..
        }
    ));
    let events: Vec<Value> = c
        .get(format!("{}/api/sessions/{session_id}/events", app.base))
        .send()
        .await
        .expect("events")
        .json()
        .await
        .expect("json");
    assert_eq!(events.len(), 3);
}

#[tokio::test]
async fn device_config_patch_roundtrips_new_fields() {
    let app = spawn_app().await;
    let c = client();
    let _cookie = setup_admin(&app, &c).await;
    let tok = create_token(&app, &c, "unattended").await;
    let enrolled = enroll(&app, tok["token"].as_str().unwrap()).await;

    // defaults from a fresh enrollment
    let detail: Value = c
        .get(format!("{}/api/devices/{}", app.base, enrolled.device_id))
        .send()
        .await
        .expect("detail")
        .json()
        .await
        .expect("json");
    assert_eq!(detail["config"]["allow_file_transfer"], true);
    assert_eq!(detail["config"]["allow_audio"], true);
    assert!(detail["config"].get("transfer_dir").is_none());

    let r = c
        .patch(format!("{}/api/devices/{}/config", app.base, enrolled.device_id))
        .json(&json!({ "allow_file_transfer": false, "transfer_dir": "/srv/drop", "allow_audio": false, "max_fps": 30 }))
        .send()
        .await
        .expect("patch");
    assert_eq!(r.status(), 200, "{}", r.text().await.unwrap_or_default());
    let detail: Value = c
        .get(format!("{}/api/devices/{}", app.base, enrolled.device_id))
        .send()
        .await
        .expect("detail")
        .json()
        .await
        .expect("json");
    assert_eq!(detail["config"]["allow_file_transfer"], false);
    assert_eq!(detail["config"]["allow_audio"], false);
    assert_eq!(detail["config"]["transfer_dir"], "/srv/drop");
    assert_eq!(detail["config"]["max_fps"], 30);

    // empty string clears the directory override; other fields untouched
    let r = c
        .patch(format!(
            "{}/api/devices/{}/config",
            app.base, enrolled.device_id
        ))
        .json(&json!({ "transfer_dir": "  " }))
        .send()
        .await
        .expect("patch");
    assert_eq!(r.status(), 200);
    let detail: Value = r.json().await.expect("json");
    assert!(detail["config"].get("transfer_dir").is_none());
    assert_eq!(detail["config"]["allow_file_transfer"], false);
    assert_eq!(detail["config"]["max_fps"], 30);
}

// ── groups & RBAC ─────────────────────────────────────────────────────────────

async fn login(app: &TestApp, email: &str, password: &str) -> (reqwest::Client, String) {
    let c = client();
    let r = c
        .post(format!("{}/api/auth/login", app.base))
        .json(&json!({ "email": email, "password": password }))
        .send()
        .await
        .expect("login");
    assert_eq!(r.status(), 200);
    let cookie = r
        .headers()
        .get("set-cookie")
        .expect("set-cookie")
        .to_str()
        .expect("str")
        .split(';')
        .next()
        .expect("pair")
        .to_string();
    (c, cookie)
}

async fn create_group(app: &TestApp, c: &reqwest::Client, name: &str) -> String {
    let r = c
        .post(format!("{}/api/groups", app.base))
        .json(&json!({ "name": name, "description": format!("{name} devices") }))
        .send()
        .await
        .expect("group");
    assert_eq!(r.status(), 201, "{}", r.text().await.unwrap_or_default());
    let v: Value = r.json().await.expect("json");
    v["id"].as_str().expect("id").to_string()
}

async fn put_json(c: &reqwest::Client, url: &str, body: Value) -> reqwest::Response {
    c.put(url).json(&body).send().await.expect("put")
}

#[tokio::test]
async fn groups_and_rbac_enforcement() {
    let app = spawn_app().await;
    let admin = client();
    let admin_cookie = setup_admin(&app, &admin).await;

    // operator account
    let r = admin
        .post(format!("{}/api/users", app.base))
        .json(&json!({ "email": "op@example.com", "name": "Olive", "password": "operator-pass-123", "role": "operator" }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 201);
    let op_id = r.json::<Value>().await.unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let (op, op_cookie) = login(&app, "op@example.com", "operator-pass-123").await;

    // groups (+ duplicate name conflict)
    let ga = create_group(&app, &admin, "Alpha").await;
    let gb = create_group(&app, &admin, "Beta").await;
    let gc = create_group(&app, &admin, "Gamma").await;
    let dup = admin
        .post(format!("{}/api/groups", app.base))
        .json(&json!({ "name": "alpha" }))
        .send()
        .await
        .unwrap();
    assert_eq!(dup.status(), 409);
    // operators cannot create groups
    let r = op
        .post(format!("{}/api/groups", app.base))
        .json(&json!({ "name": "Nope" }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 403);

    // three devices, one per group
    let tok = create_token(&app, &admin, "unattended").await;
    let da = enroll(&app, tok["token"].as_str().unwrap()).await;
    let db_ = enroll(&app, tok["token"].as_str().unwrap()).await;
    let dc = enroll(&app, tok["token"].as_str().unwrap()).await;
    for (g, d) in [(&ga, &da), (&gb, &db_), (&gc, &dc)] {
        let r = put_json(
            &admin,
            &format!("{}/api/groups/{g}/devices", app.base),
            json!({ "device_ids": [d.device_id] }),
        )
        .await;
        assert_eq!(r.status(), 204, "{}", r.text().await.unwrap_or_default());
    }
    let bad = put_json(
        &admin,
        &format!("{}/api/groups/{ga}/devices", app.base),
        json!({ "device_ids": ["dev_doesnotexist"] }),
    )
    .await;
    assert_eq!(bad.status(), 422);

    // operator sees nothing yet
    let none: Vec<Value> = op
        .get(format!("{}/api/devices", app.base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(none.is_empty());

    // operator UI socket connected *before* grants exist → must receive live updates later
    let mut op_ui = connect_ws(&format!("{}/ws/ui", app.ws_base), Some(&op_cookie)).await;
    send(&mut op_ui, &UiToConsole::Subscribe).await;
    let snap: ConsoleToUi = recv(&mut op_ui).await;
    assert!(matches!(snap, ConsoleToUi::Snapshot { ref devices, .. } if devices.is_empty()));

    // grants: view on Alpha, connect on Beta (+ unknown user rejected)
    let r = put_json(
        &admin,
        &format!("{}/api/groups/{ga}/grants", app.base),
        json!({ "grants": [{ "user_id": op_id, "permission": "view" }] }),
    )
    .await;
    assert_eq!(r.status(), 200);
    let bad = put_json(
        &admin,
        &format!("{}/api/groups/{gb}/grants", app.base),
        json!({ "grants": [{ "user_id": "nobody", "permission": "connect" }] }),
    )
    .await;
    assert_eq!(bad.status(), 422);
    let r = put_json(
        &admin,
        &format!("{}/api/groups/{gb}/grants", app.base),
        json!({ "grants": [{ "user_id": op_id, "permission": "connect" }] }),
    )
    .await;
    assert_eq!(r.status(), 200);
    let grants: Vec<Value> = r.json().await.unwrap();
    assert_eq!(grants[0]["user_name"], "Olive");
    assert_eq!(grants[0]["permission"], "connect");

    // the live socket learned about both devices with the right permissions
    let upd_a: ConsoleToUi = recv_until(
        &mut op_ui,
        |m| matches!(m, ConsoleToUi::DeviceUpdate { device } if device.id == da.device_id),
    )
    .await;
    assert!(
        matches!(upd_a, ConsoleToUi::DeviceUpdate { device } if device.permission == protocol::ui::DevicePermission::View)
    );
    let upd_b: ConsoleToUi = recv_until(
        &mut op_ui,
        |m| matches!(m, ConsoleToUi::DeviceUpdate { device } if device.id == db_.device_id),
    )
    .await;
    assert!(
        matches!(upd_b, ConsoleToUi::DeviceUpdate { device } if device.permission == protocol::ui::DevicePermission::Connect)
    );

    // REST listing filtered + permissions + groups
    let mut list: Vec<Value> = op
        .get(format!("{}/api/devices", app.base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    list.sort_by_key(|d| d["id"].as_str().unwrap().to_string());
    assert_eq!(list.len(), 2);
    for d in &list {
        if d["id"] == da.device_id {
            assert_eq!(d["permission"], "view");
            assert_eq!(d["groups"][0]["name"], "Alpha");
        } else {
            assert_eq!(d["id"], db_.device_id);
            assert_eq!(d["permission"], "connect");
        }
    }
    // admin sees everything as manage
    let all: Vec<Value> = admin
        .get(format!("{}/api/devices", app.base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(all.len(), 3);
    assert!(all.iter().all(|d| d["permission"] == "manage"));

    // direct access: C invisible (404), A view-only (PATCH 403), B connect (PATCH 200)
    let r = op
        .get(format!("{}/api/devices/{}", app.base, dc.device_id))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 404);
    let r = op
        .get(format!(
            "{}/api/devices/{}/sessions",
            app.base, dc.device_id
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 404);
    let r = op
        .patch(format!("{}/api/devices/{}", app.base, da.device_id))
        .json(&json!({ "name": "renamed" }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 403);
    let r = op
        .patch(format!("{}/api/devices/{}", app.base, db_.device_id))
        .json(&json!({ "name": "Beta box" }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(r.json::<Value>().await.unwrap()["permission"], "connect");
    // config stays admin-only even with connect
    let r = op
        .patch(format!("{}/api/devices/{}/config", app.base, db_.device_id))
        .json(&json!({ "max_fps": 30 }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 403);

    // groups visible to the operator: Alpha + Beta; Gamma's devices → 404
    let groups: Vec<Value> = op
        .get(format!("{}/api/groups", app.base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let names: Vec<&str> = groups.iter().map(|g| g["name"].as_str().unwrap()).collect();
    assert_eq!(names, vec!["Alpha", "Beta"]);
    assert_eq!(groups[0]["device_count"], 1);
    let r = op
        .get(format!("{}/api/groups/{gc}/devices", app.base))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 404);
    let in_b: Vec<Value> = op
        .get(format!("{}/api/groups/{gb}/devices", app.base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(in_b.len(), 1);
    assert_eq!(in_b[0]["name"], "Beta box");

    // user grants overview (admin)
    let ug: Vec<Value> = admin
        .get(format!("{}/api/users/{op_id}/grants", app.base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(ug.len(), 2);
    assert_eq!(ug[0]["group_name"], "Alpha");
    assert_eq!(ug[0]["permission"], "view");

    // sessions: connect A → forbidden, connect B → created
    let mut agent_a = agent_hello(&app, &da, &da.device_secret).await;
    let _: ConsoleToAgent = recv(&mut agent_a).await;
    let mut agent_b = agent_hello(&app, &db_, &db_.device_secret).await;
    let _: ConsoleToAgent = recv(&mut agent_b).await;
    let offer = SessionDescription {
        kind: "offer".into(),
        sdp: "v=0 offer".into(),
    };
    send(
        &mut op_ui,
        &UiToConsole::SessionOffer {
            device_id: da.device_id.clone(),
            offer: offer.clone(),
            shadow_of: None,
        },
    )
    .await;
    let err: ConsoleToUi = recv_until(&mut op_ui, |m| matches!(m, ConsoleToUi::Error { .. })).await;
    assert!(matches!(err, ConsoleToUi::Error { code, .. } if code == "forbidden"));
    // shadowing is not implemented yet
    send(
        &mut op_ui,
        &UiToConsole::SessionOffer {
            device_id: db_.device_id.clone(),
            offer: offer.clone(),
            shadow_of: Some("ses_x".into()),
        },
    )
    .await;
    let err: ConsoleToUi = recv_until(&mut op_ui, |m| matches!(m, ConsoleToUi::Error { .. })).await;
    assert!(matches!(err, ConsoleToUi::Error { code, .. } if code == "not_implemented"));
    send(
        &mut op_ui,
        &UiToConsole::SessionOffer {
            device_id: db_.device_id.clone(),
            offer,
            shadow_of: None,
        },
    )
    .await;
    let created: ConsoleToUi = recv_until(&mut op_ui, |m| {
        matches!(m, ConsoleToUi::SessionCreated { .. })
    })
    .await;
    let session_id = match created {
        ConsoleToUi::SessionCreated { session_id, .. } => session_id,
        _ => unreachable!(),
    };
    let req: ConsoleToAgent = recv_until(&mut agent_b, |m| {
        matches!(m, ConsoleToAgent::SessionRequest { .. })
    })
    .await;
    // `connect` alone never unlocks the privacy screen
    assert!(matches!(
        req,
        ConsoleToAgent::SessionRequest {
            role: SessionRole::Operator,
            shadow_of: None,
            privacy_screen_allowed: false,
            ..
        }
    ));

    // session listing is filtered: operator sees the B session; an admin-only device's
    // sessions are hidden. Events of a session on an invisible device → 404.
    let sessions: Vec<Value> = op
        .get(format!("{}/api/sessions", app.base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0]["id"], session_id);
    let r = op
        .get(format!(
            "{}/api/sessions?device_id={}",
            app.base, dc.device_id
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 404);

    // grant on Gamma appears live, revoking it removes the device live
    let r = put_json(
        &admin,
        &format!("{}/api/groups/{gc}/grants", app.base),
        json!({ "grants": [{ "user_id": op_id, "permission": "connect" }] }),
    )
    .await;
    assert_eq!(r.status(), 200);
    let upd_c: ConsoleToUi = recv_until(
        &mut op_ui,
        |m| matches!(m, ConsoleToUi::DeviceUpdate { device } if device.id == dc.device_id),
    )
    .await;
    assert!(
        matches!(upd_c, ConsoleToUi::DeviceUpdate { device } if device.permission == protocol::ui::DevicePermission::Connect)
    );
    let r = put_json(
        &admin,
        &format!("{}/api/groups/{gc}/grants", app.base),
        json!({ "grants": [] }),
    )
    .await;
    assert_eq!(r.status(), 200);
    let removed: ConsoleToUi = recv_until(
        &mut op_ui,
        |m| matches!(m, ConsoleToUi::DeviceRemoved { device_id } if *device_id == dc.device_id),
    )
    .await;
    assert!(matches!(removed, ConsoleToUi::DeviceRemoved { .. }));

    // token with a default group enrolls straight into Alpha (visible to the operator)
    let r = admin
        .post(format!("{}/api/enroll-tokens", app.base))
        .json(&json!({ "label": "alpha-token", "default_mode": "unattended", "default_tags": [], "default_group_id": ga }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 201);
    let tok2: Value = r.json().await.unwrap();
    assert_eq!(tok2["default_group"]["name"], "Alpha");
    let bad = admin
        .post(format!("{}/api/enroll-tokens", app.base))
        .json(&json!({ "label": "x", "default_group_id": "grp_missing" }))
        .send()
        .await
        .unwrap();
    assert_eq!(bad.status(), 422);
    let dd = enroll(&app, tok2["token"].as_str().unwrap()).await;
    let detail: Value = admin
        .get(format!("{}/api/devices/{}", app.base, dd.device_id))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(detail["groups"][0]["id"], ga);
    let upd_d: ConsoleToUi = recv_until(
        &mut op_ui,
        |m| matches!(m, ConsoleToUi::DeviceUpdate { device } if device.id == dd.device_id),
    )
    .await;
    assert!(
        matches!(upd_d, ConsoleToUi::DeviceUpdate { device } if device.permission == protocol::ui::DevicePermission::View)
    );
    let listed: Vec<Value> = admin
        .get(format!("{}/api/enroll-tokens", app.base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(listed
        .iter()
        .any(|t| t["label"] == "alpha-token" && t["default_group"]["id"] == ga));

    // PUT /api/devices/:id/groups replaces membership; group delete leaves devices intact
    let r = put_json(
        &admin,
        &format!("{}/api/devices/{}/groups", app.base, dc.device_id),
        json!({ "group_ids": [ga, gc] }),
    )
    .await;
    assert_eq!(r.status(), 200);
    let det: Value = r.json().await.unwrap();
    assert_eq!(det["groups"].as_array().unwrap().len(), 2);
    let r = admin
        .delete(format!("{}/api/groups/{gc}", app.base))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 204);
    let det: Value = admin
        .get(format!("{}/api/devices/{}", app.base, dc.device_id))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(det["groups"].as_array().unwrap().len(), 1);
    assert_eq!(det["groups"][0]["id"], ga);
    // now in Alpha → the operator sees it (view)
    let r = op
        .get(format!("{}/api/devices/{}", app.base, dc.device_id))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(r.json::<Value>().await.unwrap()["permission"], "view");

    // audit trail
    let audit: Vec<Value> = admin
        .get(format!("{}/api/audit?limit=200", app.base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    for action in [
        "group.create",
        "group.members",
        "group.grants",
        "group.delete",
        "device.groups",
    ] {
        assert!(
            audit.iter().any(|a| a["action"] == action),
            "missing audit action {action}"
        );
    }
    drop(admin_cookie);
}

// ── branding & agent bakery ─────────────────────────────────────────────────────────

/// Spawn an app whose config points `AGENT_BINARY_DIR` at a temp dir seeded with a fake
/// macOS base binary, so baking has something to append to without any network.
async fn spawn_app_with_binaries() -> (TestApp, Vec<u8>) {
    let dir = tempfile::tempdir().expect("tempdir");
    let db_path = dir.path().join("console.db");
    let bin_dir = dir.path().join("bins");
    std::fs::create_dir_all(&bin_dir).unwrap();
    let base = b"\x7fELF fake-remote-agent base binary".to_vec();
    // Deliberately the legacy name: an AGENT_BINARY_DIR filled in before the -base rename
    // must keep working.
    std::fs::write(bin_dir.join("remote-agent-macos-universal"), &base).unwrap();

    let mut config = Config::for_tests(format!("sqlite://{}?mode=rwc", db_path.display()));
    config.agent_binary_dir = Some(bin_dir);
    let state = AppState::init(config).await.expect("state");
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
    (
        TestApp {
            base: format!("http://{addr}"),
            ws_base: format!("ws://{addr}"),
            state,
            _dir: dir,
        },
        base,
    )
}

#[tokio::test]
async fn branding_and_agent_bakery() {
    use base64::Engine;
    use protocol::bakery::{read_trailer, verify_payload};

    let (app, base) = spawn_app_with_binaries().await;
    let admin = client();
    let cookie = setup_admin(&app, &admin).await;

    // default branding is public
    let b: Value = admin
        .get(format!("{}/api/branding", app.base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(b["product_name"], "Remote Console");

    // update branding (admin)
    let r = admin
        .put(format!("{}/api/branding", app.base))
        .json(&json!({ "product_name": "Acme Remote", "accent": "#12ab34", "support_text": "call us", "organization": "Acme" }))
        .send().await.unwrap();
    assert_eq!(r.status(), 200);
    // public read reflects it
    let pub_b: Value = reqwest::Client::new()
        .get(format!("{}/api/branding", app.base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(pub_b["product_name"], "Acme Remote");
    assert_eq!(pub_b["accent"], "#12ab34");

    // info exposes the public key
    let info: Value = reqwest::Client::new()
        .get(format!("{}/api/info", app.base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let pk_b64 = info["console_public_key"].as_str().unwrap().to_string();
    assert!(!pk_b64.is_empty());
    assert_eq!(info["branding_product_name"], "Acme Remote");

    // downloads listing (admin) shows the local macOS binary available
    let downloads: Vec<Value> = admin
        .get(format!("{}/api/agent/downloads", app.base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let mac = downloads
        .iter()
        .find(|d| d["platform"] == "macos-universal")
        .unwrap();
    assert_eq!(mac["available"], true);
    assert_eq!(mac["source"], "local");

    // bake with a valid token (admin cookie path)
    let token = create_token(&app, &admin, "unattended").await;
    let token_str = token["token"].as_str().unwrap().to_string();
    let resp = admin
        .get(format!(
            "{}/api/agent/download/macos-universal?token={token_str}&quick=1",
            app.base
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let cd = resp
        .headers()
        .get("content-disposition")
        .unwrap()
        .to_str()
        .unwrap()
        .to_string();
    assert!(cd.contains("Acme-Remote.zip"), "disposition: {cd}");
    assert_eq!(
        resp.headers().get("content-type").unwrap(),
        "application/zip"
    );
    assert_eq!(resp.headers().get("x-agent-signed").unwrap(), "0");
    let baked = resp.bytes().await.unwrap().to_vec();

    // the zip holds a complete .app bundle: plist, unmodified binary (0755), signed sidecar
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(baked.clone())).unwrap();
    let names: Vec<String> = archive.file_names().map(String::from).collect();
    assert!(
        names.contains(&"Acme Remote.app/Contents/Info.plist".to_string()),
        "names: {names:?}"
    );
    let plist = read_zip_entry(&mut archive, "Acme Remote.app/Contents/Info.plist");
    assert!(String::from_utf8_lossy(&plist).contains("<string>Acme Remote</string>"));
    {
        let exe = archive
            .by_name("Acme Remote.app/Contents/MacOS/remote-agent")
            .unwrap();
        assert_eq!(exe.unix_mode().map(|m| m & 0o777), Some(0o755));
    }
    let exe_bytes = read_zip_entry(&mut archive, "Acme Remote.app/Contents/MacOS/remote-agent");
    assert_eq!(exe_bytes, base, "base bytes preserved inside the bundle");
    let sidecar = read_zip_entry(
        &mut archive,
        "Acme Remote.app/Contents/Resources/baked.json",
    );
    let payload: protocol::bakery::BakedPayload = serde_json::from_slice(&sidecar).unwrap();
    let key = verify_payload(&payload).expect("signature valid");
    assert_eq!(
        base64::engine::general_purpose::STANDARD.encode(key.as_bytes()),
        pk_b64
    );
    assert_eq!(payload.config.server_url, "http://localhost:8080");
    assert_eq!(
        payload.config.enroll_token.as_deref(),
        Some(token_str.as_str())
    );
    assert!(payload.config.quick_support);
    assert_eq!(payload.config.branding.product_name, "Acme Remote");

    // Windows downloads keep the executable trailer format
    std::fs::write(
        app.state
            .config
            .agent_binary_dir
            .as_ref()
            .unwrap()
            .join("remote-agent-windows-x86_64.exe"),
        b"MZ fake windows base",
    )
    .unwrap();
    let win = admin
        .get(format!(
            "{}/api/agent/download/windows-x86_64?token={token_str}",
            app.base
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(win.status(), 200);
    let cd = win
        .headers()
        .get("content-disposition")
        .unwrap()
        .to_str()
        .unwrap()
        .to_string();
    assert!(
        cd.contains("Acme-Remote-windows-x86_64.exe"),
        "disposition: {cd}"
    );
    let exe = win.bytes().await.unwrap().to_vec();
    assert!(exe.starts_with(b"MZ fake windows base"));
    let trailer = read_trailer(&exe)
        .unwrap()
        .expect("windows trailer present");
    verify_payload(&trailer).expect("windows trailer valid");
    std::fs::remove_file(
        app.state
            .config
            .agent_binary_dir
            .as_ref()
            .unwrap()
            .join("remote-agent-windows-x86_64.exe"),
    )
    .unwrap();

    // token-only download (no cookie) works too
    let anon = reqwest::Client::new();
    let r = anon
        .get(format!(
            "{}/api/agent/download/macos-universal?token={token_str}",
            app.base
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);

    // no auth at all → 401
    let r = anon
        .get(format!("{}/api/agent/download/macos-universal", app.base))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 401);

    // unknown platform → 404
    let r = admin
        .get(format!("{}/api/agent/download/linux-x86_64", app.base))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 404);

    // windows arch with no base binary → 404 (helpful, not 500)
    let r = admin
        .get(format!(
            "{}/api/agent/download/windows-x86_64?token={token_str}",
            app.base
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 404);

    // a used-up token still downloads (installer re-runs on enrolled machines); enrolling
    // with it is what fails
    let one_use = create_token_max1(&app, &admin).await;
    let _ = enroll(&app, &one_use).await; // consumes the single use
    let r = anon
        .get(format!(
            "{}/api/agent/download/macos-universal?token={one_use}",
            app.base
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let r = anon
        .post(format!("{}/api/enroll", app.base))
        .json(&json!({ "token": one_use, "hostname": "h", "os": "macos", "arch": "aarch64", "agent_version": "0.1.0" }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 410);
    // a revoked token does not
    let id = token["id"].as_str().unwrap();
    let r = admin
        .delete(format!("{}/api/enroll-tokens/{id}", app.base))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 204);
    let r = anon
        .get(format!(
            "{}/api/agent/download/macos-universal?token={token_str}",
            app.base
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 401);

    // branding.update + agent.bake audited
    let audit: Vec<Value> = admin
        .get(format!("{}/api/audit?limit=200", app.base))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    for action in ["branding.update", "agent.bake"] {
        assert!(
            audit.iter().any(|a| a["action"] == action),
            "missing audit {action}"
        );
    }

    // install.sh renders the console download URL when a base binary is available — also
    // for a used-up token (re-runs), but not for a revoked one
    let revoked = anon
        .get(format!("{}/install.sh?token={token_str}", app.base))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(revoked.contains("exit 1") && revoked.contains("revoked"));
    let script = anon
        .get(format!("{}/install.sh?token={one_use}", app.base))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert!(
        script.contains("/api/agent/download/macos-universal"),
        "script:\n{script}"
    );

    drop(cookie);
}

async fn create_token_max1(app: &TestApp, c: &reqwest::Client) -> String {
    let v: Value = c
        .post(format!("{}/api/enroll-tokens", app.base))
        .json(&json!({ "label": "one", "default_mode": "unattended", "default_tags": [], "max_uses": 1 }))
        .send().await.unwrap().json().await.unwrap();
    v["token"].as_str().unwrap().to_string()
}

// ── helpers for the bundle / overrides / pagination tests ────────────────────

fn read_zip_entry(archive: &mut zip::ZipArchive<std::io::Cursor<Vec<u8>>>, name: &str) -> Vec<u8> {
    use std::io::Read;
    let mut entry = archive.by_name(name).expect(name);
    let mut buf = Vec::new();
    entry.read_to_end(&mut buf).unwrap();
    buf
}

async fn get_json<T: DeserializeOwned>(c: &reqwest::Client, url: &str) -> T {
    let r = c.get(url).send().await.expect("get");
    assert_eq!(r.status(), 200, "{}", url);
    r.json().await.expect("json")
}

#[tokio::test]
async fn device_overrides_from_hello_and_heartbeat() {
    let app = spawn_app().await;
    let admin = client();
    let cookie = setup_admin(&app, &admin).await;
    let token = create_token(&app, &admin, "unattended").await;
    let enrolled = enroll(&app, token["token"].as_str().unwrap()).await;
    let secret = enrolled.device_secret.clone();

    // UI socket subscribed before the agent connects
    let mut ui = connect_ws(&format!("{}/ws/ui", app.ws_base), Some(&cookie)).await;
    send(&mut ui, &UiToConsole::Subscribe).await;
    let _snapshot: ConsoleToUi = recv(&mut ui).await;

    // hello carries a help-me override
    let mut agent = connect_ws(&format!("{}/ws/agent", app.ws_base), None).await;
    send(
        &mut agent,
        &AgentToConsole::Hello {
            protocol_version: protocol::PROTOCOL_VERSION,
            device_id: enrolled.device_id.clone(),
            device_secret: secret.clone(),
            agent_version: "0.1.0".into(),
            hostname: "test-host".into(),
            os: Os::Macos,
            arch: Arch::Aarch64,
            mode: DeviceMode::HelpMe,
            capabilities: AgentCapabilities {
                codecs: vec![VideoCodec::H264],
                displays: vec![],
                input: true,
                clipboard: true,
                privacy_screen: PrivacyScreenSupport::Unsupported,
            },
            logged_in_user: None,
            local_overrides: LocalOverrides {
                mode: Some(DeviceMode::HelpMe),
                ..Default::default()
            },
            machine_id: None,
            desktop: None,
        },
    )
    .await;
    let _ack: ConsoleToAgent = recv(&mut agent).await;

    let update: ConsoleToUi = recv_until(
        &mut ui,
        |m: &ConsoleToUi| matches!(m, ConsoleToUi::DeviceUpdate { device } if device.online),
    )
    .await;
    let ConsoleToUi::DeviceUpdate { device } = update else {
        unreachable!()
    };
    assert_eq!(device.local_overrides.mode, Some(DeviceMode::HelpMe));
    assert_eq!(device.local_overrides.allow_input, None);

    // REST summary shows the same
    let devices: Vec<Value> = get_json(&admin, &format!("{}/api/devices", app.base)).await;
    assert_eq!(devices[0]["local_overrides"]["mode"], "help_me");
    assert!(devices[0]["local_overrides"].get("allow_input").is_none());
    // the banner toggle is gone from the config
    let detail: Value = get_json(
        &admin,
        &format!("{}/api/devices/{}", app.base, enrolled.device_id),
    )
    .await;
    assert!(detail["config"].get("show_session_indicator").is_none());

    // heartbeat with changed overrides → stored + pushed live
    send(
        &mut agent,
        &AgentToConsole::Heartbeat {
            uptime_s: 10,
            logged_in_user: None,
            cpu_percent: None,
            mem_percent: None,
            displays: None,
            local_overrides: Some(LocalOverrides {
                mode: Some(DeviceMode::HelpMe),
                allow_input: Some(false),
                allow_audio: Some(false),
                ..Default::default()
            }),
            desktop: None,
            capabilities: None,
        },
    )
    .await;
    let update: ConsoleToUi = recv_until(&mut ui, |m: &ConsoleToUi| {
        matches!(m, ConsoleToUi::DeviceUpdate { device } if device.local_overrides.allow_input == Some(false))
    })
    .await;
    let ConsoleToUi::DeviceUpdate { device } = update else {
        unreachable!()
    };
    assert_eq!(device.local_overrides.allow_audio, Some(false));
    let devices: Vec<Value> = get_json(&admin, &format!("{}/api/devices", app.base)).await;
    assert_eq!(devices[0]["local_overrides"]["allow_input"], false);

    // a heartbeat without overrides keeps the stored ones (COALESCE)
    send(
        &mut agent,
        &AgentToConsole::Heartbeat {
            uptime_s: 11,
            logged_in_user: None,
            cpu_percent: None,
            mem_percent: None,
            displays: None,
            local_overrides: None,
            desktop: None,
            capabilities: None,
        },
    )
    .await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let devices: Vec<Value> = get_json(&admin, &format!("{}/api/devices", app.base)).await;
    assert_eq!(devices[0]["local_overrides"]["allow_input"], false);

    // config patch ignores the removed field instead of failing
    let r = admin
        .patch(format!(
            "{}/api/devices/{}/config",
            app.base, enrolled.device_id
        ))
        .json(&json!({ "show_session_indicator": false, "max_fps": 24 }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let detail: Value = r.json().await.unwrap();
    assert_eq!(detail["config"]["max_fps"], 24);
}

#[tokio::test]
async fn sessions_paginate_with_before_cursor() {
    use remote_console::db;

    let app = spawn_app().await;
    let admin = client();
    let _cookie = setup_admin(&app, &admin).await;
    let token = create_token(&app, &admin, "unattended").await;
    let enrolled = enroll(&app, token["token"].as_str().unwrap()).await;
    let me: Value = get_json(&admin, &format!("{}/api/auth/me", app.base)).await;
    let operator_id = me["user"]["id"].as_str().unwrap().to_string();

    for i in 0..3 {
        db::sessions::insert(
            &app.state.db,
            &format!("ses_page{i}"),
            &enrolled.device_id,
            &operator_id,
            SessionState::Ended,
            None,
        )
        .await
        .unwrap();
        // distinct millisecond timestamps
        tokio::time::sleep(Duration::from_millis(5)).await;
    }

    let page1: Vec<Value> = get_json(&admin, &format!("{}/api/sessions?limit=2", app.base)).await;
    assert_eq!(page1.len(), 2);
    assert_eq!(page1[0]["id"], "ses_page2");
    assert_eq!(page1[1]["id"], "ses_page1");
    let cursor = page1[1]["started_at"].as_str().unwrap().to_string();

    let page2: Vec<Value> = get_json(
        &admin,
        &format!("{}/api/sessions?limit=2&before={cursor}", app.base),
    )
    .await;
    assert_eq!(page2.len(), 1, "{page2:?}");
    assert_eq!(page2[0]["id"], "ses_page0");

    let page3: Vec<Value> = get_json(
        &admin,
        &format!(
            "{}/api/sessions?limit=2&before={}",
            app.base,
            page2[0]["started_at"].as_str().unwrap()
        ),
    )
    .await;
    assert!(page3.is_empty());

    // per-device listing supports the same cursor
    let dev1: Vec<Value> = get_json(
        &admin,
        &format!(
            "{}/api/devices/{}/sessions?limit=1",
            app.base, enrolled.device_id
        ),
    )
    .await;
    assert_eq!(dev1.len(), 1);
    assert_eq!(dev1[0]["id"], "ses_page2");
    let dev2: Vec<Value> = get_json(
        &admin,
        &format!(
            "{}/api/devices/{}/sessions?limit=5&before={}",
            app.base,
            enrolled.device_id,
            dev1[0]["started_at"].as_str().unwrap()
        ),
    )
    .await;
    assert_eq!(dev2.len(), 2);

    // limit is capped at 200 (no error)
    let r = admin
        .get(format!("{}/api/sessions?limit=9999", app.base))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
}

#[tokio::test]
async fn signing_is_skipped_cleanly_when_not_configured() {
    let (app, _base) = spawn_app_with_binaries().await;
    let admin = client();
    let _cookie = setup_admin(&app, &admin).await;

    let downloads: Vec<Value> =
        get_json(&admin, &format!("{}/api/agent/downloads", app.base)).await;
    let mac = downloads
        .iter()
        .find(|d| d["platform"] == "macos-universal")
        .unwrap();
    assert_eq!(mac["signing_configured"], false);
    assert_eq!(mac["signed"], false);
    assert_eq!(mac["notarized"], false);

    let r = admin
        .get(format!("{}/api/agent/download/macos-universal", app.base))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(r.headers().get("x-agent-signed").unwrap(), "0");
    assert_eq!(r.headers().get("x-agent-notarized").unwrap(), "0");

    // ?sign=0 is accepted too
    let r = admin
        .get(format!(
            "{}/api/agent/download/macos-universal?sign=0",
            app.base
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);

    // outcome is reflected in the listing after the bake
    let downloads: Vec<Value> =
        get_json(&admin, &format!("{}/api/agent/downloads", app.base)).await;
    let mac = downloads
        .iter()
        .find(|d| d["platform"] == "macos-universal")
        .unwrap();
    assert_eq!(mac["signed"], false);
}

// ── privacy screen ────────────────────────────────────────────────────────────

/// Offer a session from `ui` and return the `session_request` the agent receives.
async fn offer_and_take_request(ui: &mut Ws, agent: &mut Ws, device_id: &str) -> ConsoleToAgent {
    send(
        ui,
        &UiToConsole::SessionOffer {
            device_id: device_id.to_string(),
            offer: SessionDescription {
                kind: "offer".into(),
                sdp: "v=0 offer".into(),
            },
            shadow_of: None,
        },
    )
    .await;
    let _created: ConsoleToUi =
        recv_until(ui, |m| matches!(m, ConsoleToUi::SessionCreated { .. })).await;
    recv_until(agent, |m| {
        matches!(m, ConsoleToAgent::SessionRequest { .. })
    })
    .await
}

#[tokio::test]
async fn device_config_privacy_screen_roundtrips_and_audits() {
    let app = spawn_app().await;
    let c = client();
    let _cookie = setup_admin(&app, &c).await;
    let tok = create_token(&app, &c, "unattended").await;
    let enrolled = enroll(&app, tok["token"].as_str().unwrap()).await;

    // off by default
    let detail: Value = get_json(
        &c,
        &format!("{}/api/devices/{}", app.base, enrolled.device_id),
    )
    .await;
    assert_eq!(detail["config"]["allow_privacy_screen"], false);

    let r = c
        .patch(format!(
            "{}/api/devices/{}/config",
            app.base, enrolled.device_id
        ))
        .json(&json!({ "allow_privacy_screen": true }))
        .send()
        .await
        .expect("patch");
    assert_eq!(r.status(), 200, "{}", r.text().await.unwrap_or_default());
    let detail: Value = get_json(
        &c,
        &format!("{}/api/devices/{}", app.base, enrolled.device_id),
    )
    .await;
    assert_eq!(detail["config"]["allow_privacy_screen"], true);
    // other flags untouched
    assert_eq!(detail["config"]["allow_annotations"], true);

    let audit: Vec<Value> = get_json(&c, &format!("{}/api/audit?limit=50", app.base)).await;
    let row = audit
        .iter()
        .find(|a| a["action"] == "device.config")
        .expect("device.config audit entry");
    assert_eq!(row["target"], enrolled.device_id);
    assert_eq!(row["details"]["allow_privacy_screen"], true);
}

#[tokio::test]
async fn session_request_privacy_screen_allowed_requires_manage() {
    let app = spawn_app().await;
    let admin = client();
    let admin_cookie = setup_admin(&app, &admin).await;

    // operator with `connect` on the device's group
    let r = admin
        .post(format!("{}/api/users", app.base))
        .json(&json!({ "email": "op@example.com", "name": "Olive", "password": "operator-pass-123", "role": "operator" }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 201);
    let op_id = r.json::<Value>().await.unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let (_op, op_cookie) = login(&app, "op@example.com", "operator-pass-123").await;
    let group = create_group(&app, &admin, "Support").await;
    let tok = create_token(&app, &admin, "unattended").await;
    let enrolled = enroll(&app, tok["token"].as_str().unwrap()).await;
    let r = put_json(
        &admin,
        &format!("{}/api/groups/{group}/devices", app.base),
        json!({ "device_ids": [enrolled.device_id] }),
    )
    .await;
    assert_eq!(r.status(), 204);
    let r = put_json(
        &admin,
        &format!("{}/api/groups/{group}/grants", app.base),
        json!({ "grants": [{ "user_id": op_id, "permission": "connect" }] }),
    )
    .await;
    assert_eq!(r.status(), 200);

    let mut agent = agent_hello(&app, &enrolled, &enrolled.device_secret).await;
    let _ack: ConsoleToAgent = recv(&mut agent).await;

    // admin (`manage`) → allowed
    let mut admin_ui = connect_ws(&format!("{}/ws/ui", app.ws_base), Some(&admin_cookie)).await;
    send(&mut admin_ui, &UiToConsole::Subscribe).await;
    let _snap: ConsoleToUi = recv(&mut admin_ui).await;
    let req = offer_and_take_request(&mut admin_ui, &mut agent, &enrolled.device_id).await;
    let ConsoleToAgent::SessionRequest {
        session_id,
        privacy_screen_allowed,
        role,
        ..
    } = req
    else {
        unreachable!()
    };
    assert_eq!(role, SessionRole::Operator);
    assert!(privacy_screen_allowed, "admin holds manage");

    // free the device again
    send(&mut admin_ui, &UiToConsole::SessionEnd { session_id }).await;
    let _ended: ConsoleToUi = recv_until(&mut admin_ui, |m| {
        matches!(m, ConsoleToUi::SessionUpdate { session } if session.state == SessionState::Ended)
    })
    .await;
    let _end: ConsoleToAgent = recv_until(&mut agent, |m| {
        matches!(m, ConsoleToAgent::SessionEnd { .. })
    })
    .await;

    // operator with only `connect` → not allowed
    let mut op_ui = connect_ws(&format!("{}/ws/ui", app.ws_base), Some(&op_cookie)).await;
    send(&mut op_ui, &UiToConsole::Subscribe).await;
    let _snap: ConsoleToUi = recv(&mut op_ui).await;
    let req = offer_and_take_request(&mut op_ui, &mut agent, &enrolled.device_id).await;
    assert!(matches!(
        req,
        ConsoleToAgent::SessionRequest {
            privacy_screen_allowed: false,
            ..
        }
    ));
}

#[tokio::test]
async fn privacy_screen_events_are_stored_pushed_and_audited() {
    use protocol::agent::SessionEvent;

    let app = spawn_app().await;
    let c = client();
    let cookie = setup_admin(&app, &c).await;
    let tok = create_token(&app, &c, "unattended").await;
    let enrolled = enroll(&app, tok["token"].as_str().unwrap()).await;

    let mut agent = agent_hello(&app, &enrolled, &enrolled.device_secret).await;
    let _ack: ConsoleToAgent = recv(&mut agent).await;
    let mut ui = connect_ws(&format!("{}/ws/ui", app.ws_base), Some(&cookie)).await;
    send(&mut ui, &UiToConsole::Subscribe).await;
    let _snap: ConsoleToUi = recv(&mut ui).await;
    let req = offer_and_take_request(&mut ui, &mut agent, &enrolled.device_id).await;
    let ConsoleToAgent::SessionRequest { session_id, .. } = req else {
        unreachable!()
    };

    // engaged by the operator, then lifted by the person at the device
    let engaged = SessionEvent::PrivacyScreen {
        active: true,
        reason: PrivacyScreenReason::Operator,
    };
    send(
        &mut agent,
        &AgentToConsole::SessionEvent {
            session_id: session_id.clone(),
            event: engaged.clone(),
            ts_ms: 1,
        },
    )
    .await;
    let pushed: ConsoleToUi =
        recv_until(&mut ui, |m| matches!(m, ConsoleToUi::SessionEvent { .. })).await;
    assert!(matches!(pushed, ConsoleToUi::SessionEvent { event, .. } if event == engaged));
    send(
        &mut agent,
        &AgentToConsole::SessionEvent {
            session_id: session_id.clone(),
            event: SessionEvent::PrivacyScreen {
                active: false,
                reason: PrivacyScreenReason::DeviceUser,
            },
            ts_ms: 2,
        },
    )
    .await;
    let _pushed: ConsoleToUi =
        recv_until(&mut ui, |m| matches!(m, ConsoleToUi::SessionEvent { .. })).await;

    // timeline
    let events: Vec<Value> = get_json(
        &c,
        &format!("{}/api/sessions/{session_id}/events", app.base),
    )
    .await;
    assert_eq!(events.len(), 2, "{events:?}");
    assert_eq!(events[0]["event"]["type"], "privacy_screen");
    assert_eq!(events[0]["event"]["active"], true);
    assert_eq!(events[0]["event"]["reason"], "operator");
    assert_eq!(events[1]["event"]["type"], "privacy_screen");
    assert_eq!(events[1]["event"]["active"], false);
    assert_eq!(events[1]["event"]["reason"], "device_user");

    // audit trail, one row per change
    let audit: Vec<Value> = get_json(&c, &format!("{}/api/audit?limit=50", app.base)).await;
    let mut rows: Vec<&Value> = audit
        .iter()
        .filter(|a| a["action"] == "session.privacy_screen")
        .collect();
    rows.sort_by_key(|a| a["id"].as_i64().unwrap());
    assert_eq!(rows.len(), 2, "{rows:?}");
    assert_eq!(rows[0]["target"], session_id);
    assert_eq!(rows[0]["user_name"], "Admin");
    assert_eq!(rows[0]["details"]["device_id"], enrolled.device_id);
    assert_eq!(rows[0]["details"]["active"], true);
    assert_eq!(rows[0]["details"]["reason"], "operator");
    assert_eq!(rows[1]["details"]["active"], false);
    assert_eq!(rows[1]["details"]["reason"], "device_user");
}

#[tokio::test]
async fn hello_reports_privacy_screen_support() {
    let app = spawn_app().await;
    let admin = client();
    let cookie = setup_admin(&app, &admin).await;
    let tok = create_token(&app, &admin, "unattended").await;
    let enrolled = enroll(&app, tok["token"].as_str().unwrap()).await;

    // before any hello: unsupported
    let devices: Vec<Value> = get_json(&admin, &format!("{}/api/devices", app.base)).await;
    assert_eq!(devices[0]["privacy_screen"], "unsupported");

    let mut ui = connect_ws(&format!("{}/ws/ui", app.ws_base), Some(&cookie)).await;
    send(&mut ui, &UiToConsole::Subscribe).await;
    let _snap: ConsoleToUi = recv(&mut ui).await;

    let mut agent = agent_hello_with(
        &app,
        &enrolled,
        &enrolled.device_secret,
        AgentCapabilities {
            privacy_screen: PrivacyScreenSupport::ScreenOnly,
            ..default_capabilities()
        },
    )
    .await;
    let _ack: ConsoleToAgent = recv(&mut agent).await;

    let update: ConsoleToUi = recv_until(
        &mut ui,
        |m: &ConsoleToUi| matches!(m, ConsoleToUi::DeviceUpdate { device } if device.online),
    )
    .await;
    let ConsoleToUi::DeviceUpdate { device } = update else {
        unreachable!()
    };
    assert_eq!(device.privacy_screen, PrivacyScreenSupport::ScreenOnly);
    let devices: Vec<Value> = get_json(&admin, &format!("{}/api/devices", app.base)).await;
    assert_eq!(devices[0]["privacy_screen"], "screen_only");
    let detail: Value = get_json(
        &admin,
        &format!("{}/api/devices/{}", app.base, enrolled.device_id),
    )
    .await;
    assert_eq!(detail["privacy_screen"], "screen_only");

    // the last reported value survives the agent going offline
    drop(agent);
    let offline: ConsoleToUi = recv_until(
        &mut ui,
        |m: &ConsoleToUi| matches!(m, ConsoleToUi::DeviceUpdate { device } if !device.online),
    )
    .await;
    let ConsoleToUi::DeviceUpdate { device } = offline else {
        unreachable!()
    };
    assert_eq!(device.privacy_screen, PrivacyScreenSupport::ScreenOnly);
    let devices: Vec<Value> = get_json(&admin, &format!("{}/api/devices", app.base)).await;
    assert_eq!(devices[0]["online"], false);
    assert_eq!(devices[0]["privacy_screen"], "screen_only");
}

// ── fleet readiness: protocol 2, re-enrollment, secrets, shutdown, updates ───────

/// `hello` as JSON so a test can tweak single fields (protocol version, os, desktop…).
fn hello_json(enrolled: &EnrollResponse, secret: &str) -> Value {
    serde_json::to_value(AgentToConsole::Hello {
        protocol_version: protocol::PROTOCOL_VERSION,
        device_id: enrolled.device_id.clone(),
        device_secret: secret.to_string(),
        agent_version: "0.1.0".into(),
        hostname: "test-host".into(),
        os: Os::Macos,
        arch: Arch::Aarch64,
        mode: DeviceMode::Unattended,
        capabilities: default_capabilities(),
        logged_in_user: None,
        local_overrides: LocalOverrides::default(),
        machine_id: None,
        desktop: None,
    })
    .unwrap()
}

async fn agent_connect(app: &TestApp, hello: &Value) -> Ws {
    let mut ws = connect_ws(&format!("{}/ws/agent", app.ws_base), None).await;
    send(&mut ws, hello).await;
    ws
}

fn enroll_body(token: &str, hostname: &str, os: Os, machine_id: Option<&str>) -> EnrollRequest {
    EnrollRequest {
        token: token.to_string(),
        hostname: hostname.into(),
        os,
        arch: if os == Os::Windows {
            Arch::X86_64
        } else {
            Arch::Aarch64
        },
        agent_version: "0.1.0".into(),
        display_name: None,
        machine_id: machine_id.map(String::from),
    }
}

async fn enroll_raw(app: &TestApp, body: &EnrollRequest) -> reqwest::Response {
    reqwest::Client::new()
        .post(format!("{}/api/enroll", app.base))
        .json(body)
        .send()
        .await
        .expect("enroll")
}

async fn audit_actions(app: &TestApp, admin: &reqwest::Client) -> Vec<Value> {
    get_json(admin, &format!("{}/api/audit?limit=200", app.base)).await
}

#[tokio::test]
async fn protocol_1_agents_are_accepted_and_never_get_protocol_2_messages() {
    let app = spawn_app().await;
    let admin = client();
    setup_admin(&app, &admin).await;
    let tok = create_token(&app, &admin, "unattended").await;
    let enrolled = enroll(&app, tok["token"].as_str().unwrap()).await;

    // out-of-range versions are refused
    for v in [0, protocol::PROTOCOL_VERSION + 1] {
        let mut h = hello_json(&enrolled, &enrolled.device_secret);
        h["protocol_version"] = json!(v);
        let mut ws = agent_connect(&app, &h).await;
        assert_eq!(expect_close(&mut ws).await, 4426, "protocol {v}");
    }

    // a protocol-1 hello (no machine_id / desktop) is accepted and acknowledged as 1
    let mut h = hello_json(&enrolled, &enrolled.device_secret);
    h["protocol_version"] = json!(1);
    let mut agent = agent_connect(&app, &h).await;
    match recv::<ConsoleToAgent>(&mut agent).await {
        ConsoleToAgent::HelloAck {
            protocol_version, ..
        } => assert_eq!(protocol_version, 1),
        other => panic!("expected hello_ack, got {other:?}"),
    }
    let detail: Value = get_json(
        &admin,
        &format!("{}/api/devices/{}", app.base, enrolled.device_id),
    )
    .await;
    assert_eq!(detail["agent_protocol"], 1);
    assert_eq!(detail["desktop"], "unknown");

    // deleting the device sends the old-style goodbye, not retire
    let r = admin
        .delete(format!("{}/api/devices/{}", app.base, enrolled.device_id))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 204);
    let bye: ConsoleToAgent = recv_until(&mut agent, |m: &ConsoleToAgent| {
        !matches!(m, ConsoleToAgent::Ping { .. })
    })
    .await;
    assert_eq!(
        bye,
        ConsoleToAgent::Goodbye {
            reason: "device deleted".into()
        }
    );
    assert_eq!(expect_close(&mut agent).await, 1000);
    // the old agent keeps retrying and is rejected
    let mut again = agent_connect(&app, &h).await;
    assert_eq!(expect_close(&mut again).await, 4409);
}

#[tokio::test]
async fn desktop_state_and_capabilities_follow_hello_and_heartbeats() {
    let app = spawn_app().await;
    let admin = client();
    let cookie = setup_admin(&app, &admin).await;
    let tok = create_token(&app, &admin, "unattended").await;
    let enrolled = enroll(&app, tok["token"].as_str().unwrap()).await;

    let mut ui = connect_ws(&format!("{}/ws/ui", app.ws_base), Some(&cookie)).await;
    send(&mut ui, &UiToConsole::Subscribe).await;
    let _snap: ConsoleToUi = recv(&mut ui).await;

    // signed out at the sign-in screen: still online and connectable
    let mut h = hello_json(&enrolled, &enrolled.device_secret);
    h["desktop"] = json!("sign_in");
    h["machine_id"] = json!("MACHINE-1");
    let mut agent = agent_connect(&app, &h).await;
    let _ack: ConsoleToAgent = recv(&mut agent).await;
    let update: ConsoleToUi = recv_until(
        &mut ui,
        |m: &ConsoleToUi| matches!(m, ConsoleToUi::DeviceUpdate { device } if device.online),
    )
    .await;
    let ConsoleToUi::DeviceUpdate { device } = update else {
        unreachable!()
    };
    assert_eq!(device.desktop, DesktopState::SignIn);
    let detail: Value = get_json(
        &admin,
        &format!("{}/api/devices/{}", app.base, enrolled.device_id),
    )
    .await;
    assert_eq!(detail["desktop"], "sign_in");
    assert_eq!(
        detail["machine_id"], "MACHINE-1",
        "machine id stored from hello"
    );
    assert_eq!(detail["agent_protocol"], protocol::PROTOCOL_VERSION);

    // locked, reported in a heartbeat
    send(
        &mut agent,
        &json!({ "type": "heartbeat", "uptime_s": 5, "desktop": "locked" }),
    )
    .await;
    let update: ConsoleToUi = recv_until(&mut ui, |m: &ConsoleToUi| {
        matches!(m, ConsoleToUi::DeviceUpdate { device } if device.desktop == DesktopState::Locked)
    })
    .await;
    assert!(matches!(update, ConsoleToUi::DeviceUpdate { .. }));

    // capabilities re-reported in a heartbeat (e.g. the user desktop became reachable)
    send(
        &mut agent,
        &AgentToConsole::Heartbeat {
            uptime_s: 6,
            logged_in_user: Some("bob".into()),
            cpu_percent: None,
            mem_percent: None,
            displays: None,
            local_overrides: None,
            desktop: Some(DesktopState::User),
            capabilities: Some(AgentCapabilities {
                codecs: vec![VideoCodec::H264],
                displays: vec![],
                input: true,
                clipboard: true,
                privacy_screen: PrivacyScreenSupport::Standard,
            }),
        },
    )
    .await;
    let update: ConsoleToUi = recv_until(&mut ui, |m: &ConsoleToUi| {
        matches!(m, ConsoleToUi::DeviceUpdate { device } if device.desktop == DesktopState::User)
    })
    .await;
    let ConsoleToUi::DeviceUpdate { device } = update else {
        unreachable!()
    };
    assert_eq!(device.codecs, vec![VideoCodec::H264]);
    assert!(device.displays.is_empty());
    assert_eq!(device.privacy_screen, PrivacyScreenSupport::Standard);
    assert_eq!(device.logged_in_user.as_deref(), Some("bob"));

    // offline: the desktop is unknown again
    drop(agent);
    let offline: ConsoleToUi = recv_until(
        &mut ui,
        |m: &ConsoleToUi| matches!(m, ConsoleToUi::DeviceUpdate { device } if !device.online),
    )
    .await;
    let ConsoleToUi::DeviceUpdate { device } = offline else {
        unreachable!()
    };
    assert_eq!(device.desktop, DesktopState::Unknown);
    let devices: Vec<Value> = get_json(&admin, &format!("{}/api/devices", app.base)).await;
    assert_eq!(devices[0]["desktop"], "unknown");
}

#[tokio::test]
async fn reenrollment_with_the_same_machine_id_reuses_the_device() {
    let app = spawn_app().await;
    let admin = client();
    setup_admin(&app, &admin).await;
    let tok: Value = admin
        .post(format!("{}/api/enroll-tokens", app.base))
        .json(&json!({ "label": "rollout", "default_mode": "unattended", "default_tags": [], "max_uses": 6 }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let token = tok["token"].as_str().unwrap().to_string();

    let r = enroll_raw(
        &app,
        &enroll_body(&token, "host-a", Os::Macos, Some("MID-1")),
    )
    .await;
    assert_eq!(r.status(), 201);
    let first: EnrollResponse = r.json().await.unwrap();
    // operators organise the device
    let group = create_group(&app, &admin, "Berlin").await;
    let r = put_json(
        &admin,
        &format!("{}/api/devices/{}/groups", app.base, first.device_id),
        json!({ "group_ids": [group] }),
    )
    .await;
    assert_eq!(r.status(), 200);
    let r = admin
        .patch(format!("{}/api/devices/{}", app.base, first.device_id))
        .json(&json!({ "name": "Reception Mac", "notes": "front desk", "tags": ["reception"] }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let r = admin
        .patch(format!(
            "{}/api/devices/{}/config",
            app.base, first.device_id
        ))
        .json(&json!({ "max_fps": 24 }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);

    // reinstall: same machine id + OS → same device, new secret
    let r = enroll_raw(
        &app,
        &enroll_body(&token, "host-a2", Os::Macos, Some("MID-1")),
    )
    .await;
    assert_eq!(r.status(), 200, "re-enrollment reuses the row");
    let second: EnrollResponse = r.json().await.unwrap();
    assert_eq!(second.device_id, first.device_id);
    assert_ne!(second.device_secret, first.device_secret);
    assert_eq!(second.config.max_fps, 24, "existing config returned");
    let detail: Value = get_json(
        &admin,
        &format!("{}/api/devices/{}", app.base, first.device_id),
    )
    .await;
    assert_eq!(detail["name"], "Reception Mac");
    assert_eq!(detail["hostname"], "host-a2");
    assert_eq!(detail["notes"], "front desk");
    assert_eq!(detail["tags"], json!(["reception"]));
    assert_eq!(detail["groups"][0]["id"], group);
    assert_eq!(detail["machine_id"], "MID-1");
    let devices: Vec<Value> = get_json(&admin, &format!("{}/api/devices", app.base)).await;
    assert_eq!(devices.len(), 1);
    // the old secret is dead, the new one works
    let mut old = agent_hello(&app, &first, &first.device_secret).await;
    assert_eq!(expect_close(&mut old).await, 4401);
    let mut agent = agent_hello(&app, &second, &second.device_secret).await;
    assert!(matches!(
        recv::<ConsoleToAgent>(&mut agent).await,
        ConsoleToAgent::HelloAck { .. }
    ));

    // re-enrolling while that agent is connected (same host — "test-host" from its hello)
    // replaces its connection
    let r = enroll_raw(
        &app,
        &enroll_body(&token, "test-host", Os::Macos, Some("MID-1")),
    )
    .await;
    assert_eq!(r.status(), 200);
    let third: EnrollResponse = r.json().await.unwrap();
    assert_eq!(third.device_id, first.device_id);
    let bye: ConsoleToAgent =
        recv_until(&mut agent, |m| matches!(m, ConsoleToAgent::Goodbye { .. })).await;
    assert_eq!(
        bye,
        ConsoleToAgent::Goodbye {
            reason: "replaced by a re-enrolled agent".into()
        }
    );
    assert_eq!(expect_close(&mut agent).await, 1000);

    // a connected device with a *different* hostname is a cloned image, not a reinstall
    let mut agent = agent_hello(&app, &third, &third.device_secret).await;
    let _ack: ConsoleToAgent = recv(&mut agent).await;
    let r = enroll_raw(
        &app,
        &enroll_body(&token, "clone-b", Os::Macos, Some("MID-1")),
    )
    .await;
    assert_eq!(r.status(), 201, "clone becomes its own device");
    let clone: EnrollResponse = r.json().await.unwrap();
    assert_ne!(clone.device_id, first.device_id);

    // same machine id on another OS → new device
    let r = enroll_raw(
        &app,
        &enroll_body(&token, "host-a", Os::Windows, Some("MID-1")),
    )
    .await;
    assert_eq!(r.status(), 201);
    let windows: EnrollResponse = r.json().await.unwrap();
    assert_ne!(windows.device_id, first.device_id);
    // no machine id → new device (old behaviour)
    let r = enroll_raw(&app, &enroll_body(&token, "host-a2", Os::Macos, None)).await;
    assert_eq!(r.status(), 201);
    let anon: EnrollResponse = r.json().await.unwrap();
    assert_ne!(anon.device_id, first.device_id);
    let devices: Vec<Value> = get_json(&admin, &format!("{}/api/devices", app.base)).await;
    assert_eq!(devices.len(), 4);

    // every enrollment consumed a token use: 1 + 2 re-enrollments + 3 new devices
    let tokens: Vec<Value> = get_json(&admin, &format!("{}/api/enroll-tokens", app.base)).await;
    assert_eq!(tokens[0]["uses"], 6);
    let r = enroll_raw(
        &app,
        &enroll_body(&token, "host-a2", Os::Macos, Some("MID-1")),
    )
    .await;
    assert_eq!(r.status(), 410, "re-enrollment still needs a token use");

    let audit = audit_actions(&app, &admin).await;
    let reenrolled: Vec<&Value> = audit
        .iter()
        .filter(|a| a["action"] == "device.reenrolled")
        .collect();
    assert_eq!(reenrolled.len(), 2);
    assert_eq!(reenrolled[0]["target"], first.device_id);
    assert_eq!(
        reenrolled.last().unwrap()["details"]["previous_hostname"],
        "host-a"
    );
}

#[tokio::test]
async fn device_secrets_use_sha256_and_legacy_hashes_are_upgraded() {
    let app = spawn_app().await;
    let admin = client();
    setup_admin(&app, &admin).await;
    let tok = create_token(&app, &admin, "unattended").await;
    let enrolled = enroll(&app, tok["token"].as_str().unwrap()).await;
    let stored = || async {
        remote_console::db::devices::by_id(&app.state.db, &enrolled.device_id)
            .await
            .unwrap()
            .unwrap()
            .secret_hash
    };
    assert!(
        stored().await.starts_with("sha256$"),
        "new secrets are sha256"
    );

    // a device enrolled by an older console: argon2 hash
    let legacy = remote_console::auth::hash_password(&enrolled.device_secret).unwrap();
    sqlx::query("UPDATE devices SET secret_hash = ? WHERE id = ?")
        .bind(&legacy)
        .bind(&enrolled.device_id)
        .execute(&app.state.db)
        .await
        .unwrap();
    let mut agent = agent_hello(&app, &enrolled, &enrolled.device_secret).await;
    assert!(matches!(
        recv::<ConsoleToAgent>(&mut agent).await,
        ConsoleToAgent::HelloAck { .. }
    ));
    let upgraded = stored().await;
    assert!(
        upgraded.starts_with("sha256$"),
        "rehashed after a good hello: {upgraded}"
    );
    drop(agent);
    tokio::time::sleep(Duration::from_millis(100)).await;
    let mut agent = agent_hello(&app, &enrolled, &enrolled.device_secret).await;
    assert!(matches!(
        recv::<ConsoleToAgent>(&mut agent).await,
        ConsoleToAgent::HelloAck { .. }
    ));
    let mut bad = agent_hello(&app, &enrolled, "wrong").await;
    assert_eq!(expect_close(&mut bad).await, 4401);
}

#[tokio::test]
async fn console_shutdown_says_goodbye_to_agents() {
    let app = spawn_app().await;
    let admin = client();
    setup_admin(&app, &admin).await;
    let tok = create_token(&app, &admin, "unattended").await;
    let enrolled = enroll(&app, tok["token"].as_str().unwrap()).await;
    let mut agent = agent_hello(&app, &enrolled, &enrolled.device_secret).await;
    let _ack: ConsoleToAgent = recv(&mut agent).await;

    let closed = app.state.hub.shutdown_agents(Duration::from_secs(3)).await;
    assert_eq!(closed, 1);
    let bye: ConsoleToAgent =
        recv_until(&mut agent, |m| matches!(m, ConsoleToAgent::Goodbye { .. })).await;
    assert_eq!(
        bye,
        ConsoleToAgent::Goodbye {
            reason: "console restarting".into()
        }
    );
    assert_eq!(expect_close(&mut agent).await, 1000, "clean close frame");
    assert!(!app.state.hub.is_online(&enrolled.device_id));

    // an agent that connects during shutdown is turned away the same way
    let mut late = agent_hello(&app, &enrolled, &enrolled.device_secret).await;
    let bye: ConsoleToAgent = recv(&mut late).await;
    assert!(matches!(bye, ConsoleToAgent::Goodbye { reason } if reason.contains("restart")));
    assert_eq!(expect_close(&mut late).await, 1012);
}

/// Console with a Windows x86_64 base binary that carries version `version`.
async fn spawn_app_with_windows_base(version: &str) -> TestApp {
    let dir = tempfile::tempdir().expect("tempdir");
    let db_path = dir.path().join("console.db");
    let bin_dir = dir.path().join("bins");
    std::fs::create_dir_all(&bin_dir).unwrap();
    let mut base = b"MZ fake windows agent".to_vec();
    base.extend_from_slice(protocol::bakery::VERSION_MARKER_PREFIX);
    base.extend_from_slice(version.as_bytes());
    base.extend_from_slice(b"\0rest of the binary");
    std::fs::write(bin_dir.join("remote-agent-windows-x86_64-base.exe"), &base).unwrap();
    let mut config = Config::for_tests(format!("sqlite://{}?mode=rwc", db_path.display()));
    config.agent_binary_dir = Some(bin_dir);
    let state = AppState::init(config).await.expect("state");
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
        _dir: dir,
    }
}

/// Enroll a Windows x86_64 device running `agent_version` and connect it with `protocol`.
async fn windows_agent(
    app: &TestApp,
    token: &str,
    host: &str,
    agent_version: &str,
    protocol_version: u32,
) -> (EnrollResponse, Ws) {
    let mut body = enroll_body(token, host, Os::Windows, None);
    body.agent_version = agent_version.into();
    let r = enroll_raw(app, &body).await;
    assert_eq!(r.status(), 201);
    let enrolled: EnrollResponse = r.json().await.unwrap();
    let mut h = hello_json(&enrolled, &enrolled.device_secret);
    h["protocol_version"] = json!(protocol_version);
    h["os"] = json!("windows");
    h["arch"] = json!("x86_64");
    h["hostname"] = json!(host);
    h["agent_version"] = json!(agent_version);
    let mut ws = agent_connect(app, &h).await;
    assert!(matches!(
        recv::<ConsoleToAgent>(&mut ws).await,
        ConsoleToAgent::HelloAck { .. }
    ));
    (enrolled, ws)
}

#[tokio::test]
async fn fleet_updates_announce_a_stable_package() {
    use sha2::{Digest, Sha256};

    let app = spawn_app_with_windows_base("0.2.0").await;
    let admin = client();
    setup_admin(&app, &admin).await;
    let tok = create_token(&app, &admin, "unattended").await;
    let token = tok["token"].as_str().unwrap().to_string();

    // the console knows what it hands out
    let versions: Value = get_json(&admin, &format!("{}/api/agent/versions", app.base)).await;
    assert_eq!(versions["windows-x86_64"], "0.2.0");
    assert_eq!(versions["macos-universal"], Value::Null);
    let downloads: Vec<Value> =
        get_json(&admin, &format!("{}/api/agent/downloads", app.base)).await;
    let win = downloads
        .iter()
        .find(|d| d["platform"] == "windows-x86_64")
        .unwrap();
    assert_eq!(win["version"], "0.2.0");

    let (dev, mut agent) = windows_agent(&app, &token, "win-1", "0.1.0", 2).await;
    let r = admin
        .post(format!("{}/api/devices/{}/update", app.base, dev.device_id))
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 202, "{}", r.text().await.unwrap_or_default());
    let update: ConsoleToAgent =
        recv_until(&mut agent, |m| matches!(m, ConsoleToAgent::Update { .. })).await;
    let ConsoleToAgent::Update {
        version,
        url,
        sha256,
    } = update
    else {
        unreachable!()
    };
    assert_eq!(version, "0.2.0");
    assert_eq!(
        url,
        "http://localhost:8080/api/agent/package/windows-x86_64"
    );

    // the package endpoint serves exactly the announced bytes, every time
    let package_url = format!("{}/api/agent/package/windows-x86_64", app.base);
    let auth = format!("Device {}:{}", dev.device_id, dev.device_secret);
    let anon = reqwest::Client::new();
    let mut bodies = Vec::new();
    for _ in 0..2 {
        let r = anon
            .get(&package_url)
            .header("authorization", &auth)
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 200);
        assert_eq!(r.headers()["x-agent-version"], "0.2.0");
        bodies.push(r.bytes().await.unwrap().to_vec());
    }
    assert_eq!(bodies[0], bodies[1], "stable bytes");
    assert_eq!(hex::encode(Sha256::digest(&bodies[0])), sha256);
    let trailer = protocol::bakery::read_trailer(&bodies[0])
        .unwrap()
        .expect("baked trailer");
    assert_eq!(
        trailer.config.enroll_token, None,
        "no enrollment token in updates"
    );
    assert!(!trailer.config.quick_support);
    // credentials are required and checked
    let r = anon.get(&package_url).send().await.unwrap();
    assert_eq!(r.status(), 401);
    let r = anon
        .get(&package_url)
        .header("authorization", format!("Device {}:wrong", dev.device_id))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 401);
    let r = anon
        .get(format!("{}/api/agent/package/linux-x86_64", app.base))
        .header("authorization", &auth)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 404);

    // up to date / too old / offline are refused with a reason
    let (current, _current_ws) = windows_agent(&app, &token, "win-2", "0.2.0", 2).await;
    let (old, mut old_ws) = windows_agent(&app, &token, "win-3", "0.1.0", 1).await;
    for (id, code) in [
        (&current.device_id, "up_to_date"),
        (&old.device_id, "agent_too_old"),
    ] {
        let r = admin
            .post(format!("{}/api/devices/{id}/update", app.base))
            .json(&json!({}))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 409);
        let body: Value = r.json().await.unwrap();
        assert_eq!(body["error"]["code"], code);
    }

    // bulk: only the outdated protocol-2 device is asked; the old agent is counted
    let r = admin
        .post(format!("{}/api/devices/update-outdated", app.base))
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 202);
    let bulk: Value = r.json().await.unwrap();
    assert_eq!(bulk["requested"], json!([dev.device_id]));
    assert_eq!(bulk["versions"]["windows-x86_64"], "0.2.0");
    assert_eq!(bulk["skipped"]["agent_too_old"], 1);
    let again: ConsoleToAgent =
        recv_until(&mut agent, |m| matches!(m, ConsoleToAgent::Update { .. })).await;
    assert!(matches!(again, ConsoleToAgent::Update { sha256: s, .. } if s == sha256));
    // nothing protocol-2-only reaches the old agent
    let quiet = tokio::time::timeout(Duration::from_millis(300), async {
        loop {
            let m: ConsoleToAgent = recv(&mut old_ws).await;
            if !matches!(m, ConsoleToAgent::Ping { .. }) {
                return m;
            }
        }
    })
    .await;
    assert!(quiet.is_err(), "old agent got {quiet:?}");

    // bulk limited to a group with no members → nothing to do
    let group = create_group(&app, &admin, "Empty").await;
    let r = admin
        .post(format!("{}/api/devices/update-outdated", app.base))
        .json(&json!({ "group_id": group }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 202);
    let bulk: Value = r.json().await.unwrap();
    assert_eq!(bulk["requested"], json!([]));

    // operators cannot trigger updates
    let r = admin
        .post(format!("{}/api/users", app.base))
        .json(&json!({ "email": "op@example.com", "name": "Op", "password": "operator-password-1", "role": "operator" }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 201);
    let (op, _) = login(&app, "op@example.com", "operator-password-1").await;
    let r = op
        .post(format!("{}/api/devices/{}/update", app.base, dev.device_id))
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 404, "invisible to an operator without grants");
    let r = op
        .post(format!("{}/api/devices/update-outdated", app.base))
        .json(&json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 403);

    let audit = audit_actions(&app, &admin).await;
    let requested = audit
        .iter()
        .filter(|a| a["action"] == "device.update_requested")
        .count();
    assert_eq!(requested, 2);
}

#[tokio::test]
async fn group_policy_applies_a_config_patch_to_every_member() {
    let app = spawn_app().await;
    let admin = client();
    setup_admin(&app, &admin).await;
    let tok = create_token(&app, &admin, "unattended").await;
    let token = tok["token"].as_str().unwrap();
    let a = enroll(&app, token).await;
    let b = enroll(&app, token).await;
    let outside = enroll(&app, token).await;
    let group = create_group(&app, &admin, "Kiosks").await;
    let r = put_json(
        &admin,
        &format!("{}/api/groups/{group}/devices", app.base),
        json!({ "device_ids": [a.device_id, b.device_id] }),
    )
    .await;
    assert_eq!(r.status(), 204);
    // a is online and gets the change live; give it a distinct setting that must survive
    let r = admin
        .patch(format!("{}/api/devices/{}/config", app.base, a.device_id))
        .json(&json!({ "max_fps": 24 }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let mut agent = agent_hello(&app, &a, &a.device_secret).await;
    let _ack: ConsoleToAgent = recv(&mut agent).await;

    let url = format!("{}/api/groups/{group}/config", app.base);
    // validation happens before anything is written
    for (body, code) in [
        (json!({ "display_name": "x" }), 422),
        (json!({}), 422),
        (json!({ "allow_audio": false, "max_fps": 1000 }), 422),
    ] {
        let r = admin.patch(&url).json(&body).send().await.unwrap();
        assert_eq!(r.status(), code, "{body}");
    }
    let r = admin
        .patch(&url)
        .json(&json!({ "allow_audio": false, "mode": "help_me" }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let applied: Value = r.json().await.unwrap();
    assert_eq!(applied["updated"], 2);
    assert_eq!(applied["online"], 1);
    let pushed: ConsoleToAgent = recv_until(&mut agent, |m| {
        matches!(m, ConsoleToAgent::ConfigUpdate { .. })
    })
    .await;
    let ConsoleToAgent::ConfigUpdate { config } = pushed else {
        unreachable!()
    };
    assert!(!config.allow_audio);
    assert_eq!(config.mode, DeviceMode::HelpMe);
    assert_eq!(config.max_fps, 24, "untouched settings stay per device");
    for (id, expect_audio) in [
        (&a.device_id, false),
        (&b.device_id, false),
        (&outside.device_id, true),
    ] {
        let d: Value = get_json(&admin, &format!("{}/api/devices/{id}", app.base)).await;
        assert_eq!(d["config"]["allow_audio"], expect_audio, "{id}");
    }
    let audit = audit_actions(&app, &admin).await;
    let entry = audit
        .iter()
        .find(|a| a["action"] == "group.config")
        .unwrap();
    assert_eq!(entry["details"]["devices"], 2);
    assert_eq!(entry["details"]["fields"], json!(["mode", "allow_audio"]));

    // operators may not
    let r = admin
        .post(format!("{}/api/users", app.base))
        .json(&json!({ "email": "op2@example.com", "name": "Op", "password": "operator-password-1", "role": "operator" }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 201);
    let (op, _) = login(&app, "op2@example.com", "operator-password-1").await;
    let r = op
        .patch(&url)
        .json(&json!({ "allow_audio": true }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 403);
}
