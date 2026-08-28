//! End-to-end tests: real HTTP server on a random port, real WebSockets, temp SQLite.

use futures_util::{SinkExt, StreamExt};
use protocol::agent::{AgentCapabilities, AgentToConsole, ConsoleToAgent};
use protocol::common::*;
use protocol::config::{EnrollRequest, EnrollResponse};
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
    _dir: tempfile::TempDir,
}

async fn spawn_app() -> TestApp {
    let dir = tempfile::tempdir().expect("tempdir");
    let db_path = dir.path().join("console.db");
    let config = Config::for_tests(format!("sqlite://{}?mode=rwc", db_path.display()));
    let state = AppState::init(config).await.expect("state");
    let app = build_router(state);
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

async fn agent_hello(app: &TestApp, enrolled: &EnrollResponse, secret: &str) -> Ws {
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
            capabilities: AgentCapabilities {
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
            },
            logged_in_user: Some("alice".into()),
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

    // delete device → second connection is told goodbye and closed
    let r = c
        .delete(format!("{}/api/devices/{}", app.base, enrolled.device_id))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 204);
    let bye: ConsoleToAgent =
        recv_until(&mut second, |m| matches!(m, ConsoleToAgent::Goodbye { .. })).await;
    assert!(matches!(bye, ConsoleToAgent::Goodbye { .. }));
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
