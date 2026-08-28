//! `/ws/agent` — the agent side of the hub.

use super::{AgentConn, Hub};
use crate::app::AppState;
use crate::auth;
use crate::db::{self, audit::Actor, devices::Presence};
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, State};
use axum::http::HeaderMap;
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use protocol::agent::{AgentToConsole, ConsoleToAgent};
use protocol::common::{EndReason, SessionState};
use protocol::ui::ConsoleToUi;
use serde_json::json;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// Close codes (see API.md).
pub const CLOSE_BAD_CREDENTIALS: u16 = 4401;
pub const CLOSE_DEVICE_DELETED: u16 = 4409;
pub const CLOSE_PROTOCOL_VERSION: u16 = 4426;
const CLOSE_PROTOCOL_ERROR: u16 = 4400;

const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
const PING_INTERVAL: Duration = Duration::from_secs(30);

pub async fn upgrade(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    let ip = auth::client_ip(&headers, Some(&ConnectInfo(peer)));
    ws.on_upgrade(move |socket| handle(state.hub, socket, ip))
}

async fn handle(hub: Arc<Hub>, socket: WebSocket, ip: String) {
    let (mut sink, mut stream) = socket.split();

    // ── hello ────────────────────────────────────────────────────────────────
    let first = tokio::time::timeout(HELLO_TIMEOUT, async {
        loop {
            match stream.next().await {
                Some(Ok(Message::Text(t))) => return Some(t.to_string()),
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
                Some(Ok(Message::Binary(_))) => continue,
                _ => return None,
            }
        }
    })
    .await
    .ok()
    .flatten();
    let Some(first) = first else {
        let _ = close(&mut sink, CLOSE_PROTOCOL_ERROR, "expected hello").await;
        return;
    };
    let hello = match serde_json::from_str::<AgentToConsole>(&first) {
        Ok(AgentToConsole::Hello {
            protocol_version,
            device_id,
            device_secret,
            agent_version,
            hostname,
            os,
            arch,
            mode,
            capabilities,
            logged_in_user,
        }) => Hello {
            protocol_version,
            device_id,
            device_secret,
            agent_version,
            hostname,
            os,
            arch,
            mode,
            capabilities,
            logged_in_user,
        },
        Ok(_) => {
            let _ = close(
                &mut sink,
                CLOSE_PROTOCOL_ERROR,
                "first message must be hello",
            )
            .await;
            return;
        }
        Err(err) => {
            let _ = close(
                &mut sink,
                CLOSE_PROTOCOL_ERROR,
                &format!("invalid hello: {err}"),
            )
            .await;
            return;
        }
    };
    if hello.protocol_version != protocol::PROTOCOL_VERSION {
        let _ = close(
            &mut sink,
            CLOSE_PROTOCOL_VERSION,
            "unsupported protocol version",
        )
        .await;
        return;
    }

    let device = match db::devices::by_id(&hub.db, &hello.device_id).await {
        Ok(Some(d)) => d,
        Ok(None) => {
            let _ = close(&mut sink, CLOSE_DEVICE_DELETED, "unknown device").await;
            return;
        }
        Err(err) => {
            tracing::error!("device lookup failed: {err}");
            let _ = close(&mut sink, 1011, "internal error").await;
            return;
        }
    };
    if !auth::verify_password_async(hello.device_secret.clone(), device.secret_hash.clone()).await {
        tracing::warn!(device = %hello.device_id, %ip, "agent hello with bad secret");
        let _ = close(&mut sink, CLOSE_BAD_CREDENTIALS, "bad credentials").await;
        return;
    }

    let config = device.config();
    let device_id = device.id.clone();
    let conn_id = hub.next_conn_id();
    let cancel = CancellationToken::new();
    let (tx, mut rx) = mpsc::unbounded_channel::<ConsoleToAgent>();

    if let Err(err) = db::devices::mark_online(
        &hub.db,
        &device_id,
        Presence {
            hostname: &hello.hostname,
            os: hello.os,
            arch: hello.arch,
            agent_version: &hello.agent_version,
            codecs: &hello.capabilities.codecs,
            displays: &hello.capabilities.displays,
            logged_in_user: hello.logged_in_user.as_deref(),
            ip: &ip,
        },
    )
    .await
    {
        tracing::error!("marking device online: {err}");
    }

    hub.register_agent(
        &device_id,
        AgentConn {
            conn_id,
            tx: tx.clone(),
            cancel: cancel.clone(),
            heartbeat_interval: Duration::from_secs(u64::from(config.heartbeat_interval_s.max(1))),
            last_seen: Instant::now(),
        },
    );
    tracing::info!(
        device = %device_id,
        host = %hello.hostname,
        version = %hello.agent_version,
        %ip,
        reported_mode = ?hello.mode,
        "agent connected"
    );

    let _ = tx.send(ConsoleToAgent::HelloAck {
        protocol_version: protocol::PROTOCOL_VERSION,
        server_time_ms: chrono::Utc::now().timestamp_millis().max(0) as u64,
        config: config.clone(),
    });
    hub.broadcast_device(&device_id).await;

    // ── writer ───────────────────────────────────────────────────────────────
    let writer_cancel = cancel.clone();
    let writer = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = writer_cancel.cancelled() => {
                    // Flush anything still queued (e.g. a `goodbye`) before closing.
                    while let Ok(msg) = rx.try_recv() {
                        if let Ok(text) = serde_json::to_string(&msg) {
                            if sink.send(Message::Text(text.into())).await.is_err() {
                                break;
                            }
                        }
                    }
                    let _ = sink
                        .send(Message::Close(Some(CloseFrame {
                            code: 1000,
                            reason: "bye".into(),
                        })))
                        .await;
                    break;
                }

                msg = rx.recv() => {
                    let Some(msg) = msg else { break };
                    let text = match serde_json::to_string(&msg) {
                        Ok(t) => t,
                        Err(err) => { tracing::error!("serializing agent message: {err}"); continue; }
                    };
                    if sink.send(Message::Text(text.into())).await.is_err() {
                        break;
                    }
                }
            }
        }
    });

    // ── reader ───────────────────────────────────────────────────────────────
    let mut ping = tokio::time::interval(PING_INTERVAL);
    ping.tick().await;
    let mut nonce: u64 = 0;
    let mut last_user = hello.logged_in_user.clone();
    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,
            _ = ping.tick() => {
                nonce = nonce.wrapping_add(1);
                if tx.send(ConsoleToAgent::Ping { nonce }).is_err() { break; }
            }
            incoming = stream.next() => {
                let Some(Ok(msg)) = incoming else { break };
                let text = match msg {
                    Message::Text(t) => t,
                    Message::Close(_) => break,
                    _ => continue,
                };
                let parsed = match serde_json::from_str::<AgentToConsole>(&text) {
                    Ok(p) => p,
                    Err(err) => {
                        tracing::warn!(device = %device_id, "invalid agent message: {err}");
                        continue;
                    }
                };
                hub.touch_agent(&device_id, conn_id);
                handle_message(&hub, &device_id, &mut last_user, parsed).await;
            }
        }
    }

    // ── cleanup ──────────────────────────────────────────────────────────────
    cancel.cancel();
    let _ = writer.await;
    if hub.unregister_agent(&device_id, conn_id) {
        tracing::info!(device = %device_id, "agent disconnected");
        if let Err(err) = db::devices::mark_offline(&hub.db, &device_id).await {
            tracing::error!("marking device offline: {err}");
        }
        hub.end_sessions_for_device(&device_id, EndReason::AgentOffline)
            .await;
        hub.broadcast_device(&device_id).await;
    } else {
        tracing::debug!(device = %device_id, "agent connection replaced");
    }
}

struct Hello {
    protocol_version: u32,
    device_id: String,
    device_secret: String,
    agent_version: String,
    hostname: String,
    os: protocol::common::Os,
    arch: protocol::common::Arch,
    mode: protocol::common::DeviceMode,
    capabilities: protocol::agent::AgentCapabilities,
    logged_in_user: Option<String>,
}

async fn handle_message(
    hub: &Arc<Hub>,
    device_id: &str,
    last_user: &mut Option<String>,
    msg: AgentToConsole,
) {
    match msg {
        AgentToConsole::Hello { .. } => {
            tracing::warn!(device = %device_id, "duplicate hello ignored");
        }
        AgentToConsole::Heartbeat {
            logged_in_user,
            displays,
            ..
        } => {
            if let Err(err) = db::devices::heartbeat(
                &hub.db,
                device_id,
                logged_in_user.as_deref(),
                displays.as_deref(),
            )
            .await
            {
                tracing::error!("heartbeat update failed: {err}");
            }
            let user_changed = logged_in_user.is_some() && logged_in_user != *last_user;
            if user_changed {
                *last_user = logged_in_user;
            }
            if displays.is_some() || user_changed {
                hub.broadcast_device(device_id).await;
            }
        }
        AgentToConsole::Pong { .. } => {}
        AgentToConsole::ApprovalResult {
            session_id,
            approved,
        } => {
            let Some(session) = hub.active_session(&session_id) else {
                return;
            };
            if session.device_id != device_id {
                return;
            }
            let actor = Actor {
                id: &session.operator.id,
                name: &session.operator.name,
            };
            if approved {
                db::audit::record_lossy(
                    &hub.db,
                    Some(actor),
                    "session.approve",
                    Some(&session_id),
                    json!({ "device_id": device_id }),
                )
                .await;
                hub.set_session_state(&session_id, SessionState::Connecting)
                    .await;
            } else {
                db::audit::record_lossy(
                    &hub.db,
                    Some(actor),
                    "session.deny",
                    Some(&session_id),
                    json!({ "device_id": device_id }),
                )
                .await;
                hub.end_session(&session_id, EndReason::Denied, None).await;
            }
        }
        AgentToConsole::SessionAnswer {
            session_id,
            answer,
            codec,
        } => {
            let Some(session) = hub.active_session(&session_id) else {
                return;
            };
            if session.device_id != device_id {
                return;
            }
            if let Err(err) = db::sessions::set_codec(&hub.db, &session_id, codec).await {
                tracing::error!("storing codec: {err}");
            }
            hub.send_to_ui(
                session.ui_conn_id,
                ConsoleToUi::SessionAnswer {
                    session_id: session_id.clone(),
                    answer,
                    codec,
                },
            );
            if session.state != SessionState::Connected {
                hub.set_session_state(&session_id, SessionState::Connecting)
                    .await;
            }
        }
        AgentToConsole::IceCandidate {
            session_id,
            candidate,
        } => {
            if let Some(session) = hub.active_session(&session_id) {
                if session.device_id == device_id {
                    hub.send_to_ui(
                        session.ui_conn_id,
                        ConsoleToUi::IceCandidate {
                            session_id,
                            candidate,
                        },
                    );
                }
            }
        }
        AgentToConsole::SessionState {
            session_id,
            state,
            reason,
        } => {
            let Some(session) = hub.active_session(&session_id) else {
                return;
            };
            if session.device_id != device_id {
                return;
            }
            match state {
                SessionState::Ended => {
                    hub.end_session(&session_id, reason.unwrap_or(EndReason::Error), None)
                        .await;
                }
                other => {
                    hub.set_session_state(&session_id, other).await;
                }
            }
        }
        AgentToConsole::Log { level, message } => {
            let message: String = message.chars().take(500).collect();
            match level.as_str() {
                "error" => tracing::error!(device = %device_id, "agent: {message}"),
                "warn" => tracing::warn!(device = %device_id, "agent: {message}"),
                _ => tracing::info!(device = %device_id, "agent: {message}"),
            }
        }
    }
}

async fn close(
    sink: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    code: u16,
    reason: &str,
) -> Result<(), axum::Error> {
    sink.send(Message::Close(Some(CloseFrame {
        code,
        reason: reason.to_string().into(),
    })))
    .await
}
