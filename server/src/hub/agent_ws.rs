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
const CLOSE_RATE_LIMITED: u16 = 4429;
/// Largest WebSocket message accepted from an agent (JSON only; file data never comes here).
pub const MAX_MESSAGE_BYTES: usize = 256 * 1024;

const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
const PING_INTERVAL: Duration = Duration::from_secs(30);

pub async fn upgrade(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    let ip = state.client_ip(&headers, Some(&ConnectInfo(peer)));
    let limits = state.limits.clone();
    ws.max_message_size(MAX_MESSAGE_BYTES)
        .max_frame_size(MAX_MESSAGE_BYTES)
        .on_upgrade(move |socket| handle(state.hub, limits, socket, ip))
}

async fn handle(hub: Arc<Hub>, limits: Arc<crate::auth::Limits>, socket: WebSocket, ip: String) {
    let (mut sink, mut stream) = socket.split();

    // ── hello ────────────────────────────────────────────────────────────────
    let first = tokio::time::timeout(HELLO_TIMEOUT, async {
        loop {
            match stream.next().await {
                Some(Ok(Message::Text(t))) => return Some(t.to_string()),
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
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
            local_overrides,
            machine_id,
            desktop,
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
            local_overrides,
            machine_id: crate::api::enroll::normalize_machine_id(machine_id.as_deref())
                .map(str::to_string),
            desktop: desktop.unwrap_or_default(),
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
    if !(protocol::MIN_PROTOCOL_VERSION..=protocol::PROTOCOL_VERSION)
        .contains(&hello.protocol_version)
    {
        let _ = close(
            &mut sink,
            CLOSE_PROTOCOL_VERSION,
            "unsupported protocol version",
        )
        .await;
        return;
    }

    // Failures back off per address *and* device: one retired machine behind a NAT must not
    // lock out the other agents at that site.
    let auth_key = auth::agent_auth_key(&ip, &hello.device_id);
    if let Some(wait) = limits.agent_hello.blocked_for(&auth_key) {
        tracing::warn!(%ip, device = %hello.device_id, ?wait, "agent hello rate limited");
        let _ = close(&mut sink, CLOSE_RATE_LIMITED, "too many failed connections").await;
        return;
    }
    let device = match auth::device::authenticate(
        &hub.db,
        &limits.device_verify_slots,
        &hello.device_id,
        &hello.device_secret,
    )
    .await
    {
        Ok(d) => d,
        Err(auth::device::DeviceAuthError::UnknownDevice) => {
            limits.agent_hello.record_failure(&auth_key);
            let _ = close(&mut sink, CLOSE_DEVICE_DELETED, "unknown device").await;
            return;
        }
        Err(auth::device::DeviceAuthError::BadSecret) => {
            limits.agent_hello.record_failure(&auth_key);
            tracing::warn!(device = %hello.device_id, %ip, "agent hello with bad secret");
            let _ = close(&mut sink, CLOSE_BAD_CREDENTIALS, "bad credentials").await;
            return;
        }
        Err(auth::device::DeviceAuthError::Internal(err)) => {
            tracing::error!("device lookup failed: {err}");
            let _ = close(&mut sink, 1011, "internal error").await;
            return;
        }
    };
    limits.agent_hello.clear(&auth_key);
    if hub.is_shutting_down() {
        let _ = send_now(
            &mut sink,
            &ConsoleToAgent::Goodbye {
                reason: super::GOODBYE_RESTARTING.into(),
            },
        )
        .await;
        let _ = close(&mut sink, 1012, "console restarting").await;
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
            local_overrides: &hello.local_overrides,
            privacy_screen: hello.capabilities.privacy_screen,
            machine_id: hello.machine_id.as_deref(),
            desktop: hello.desktop,
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
            protocol_version: hello.protocol_version,
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
        protocol = hello.protocol_version,
        %ip,
        reported_mode = ?hello.mode,
        "agent connected"
    );

    let _ = tx.send(ConsoleToAgent::HelloAck {
        // The version both sides speak: an older agent gets its own version back.
        protocol_version: hello.protocol_version.min(protocol::PROTOCOL_VERSION),
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
    let mut last_overrides = hello.local_overrides.clone();
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
                    Message::Binary(_) => {
                        tracing::warn!(device = %device_id, "binary frame from agent; closing");
                        break;
                    }
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
                handle_message(&hub, &device_id, &mut last_user, &mut last_overrides, parsed).await;
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
    local_overrides: protocol::config::LocalOverrides,
    machine_id: Option<String>,
    desktop: protocol::common::DesktopState,
}

async fn handle_message(
    hub: &Arc<Hub>,
    device_id: &str,
    last_user: &mut Option<String>,
    last_overrides: &mut protocol::config::LocalOverrides,
    msg: AgentToConsole,
) {
    match msg {
        AgentToConsole::Hello { .. } => {
            tracing::warn!(device = %device_id, "duplicate hello ignored");
        }
        AgentToConsole::Heartbeat {
            logged_in_user,
            displays,
            local_overrides,
            desktop,
            capabilities,
            ..
        } => {
            if let Err(err) = db::devices::heartbeat(
                &hub.db,
                device_id,
                db::devices::HeartbeatUpdate {
                    logged_in_user: logged_in_user.as_deref(),
                    displays: displays.as_deref(),
                    local_overrides: local_overrides.as_ref(),
                    desktop,
                    capabilities: capabilities.as_ref(),
                },
            )
            .await
            {
                tracing::error!("heartbeat update failed: {err}");
            }
            let user_changed = logged_in_user.is_some() && logged_in_user != *last_user;
            if user_changed {
                *last_user = logged_in_user;
            }
            let overrides_changed = local_overrides
                .as_ref()
                .is_some_and(|o| *o != *last_overrides);
            if let Some(o) = local_overrides {
                if overrides_changed {
                    tracing::info!(device = %device_id, ?o, "device-side overrides changed");
                }
                *last_overrides = o;
            }
            if let Some(d) = desktop {
                tracing::debug!(device = %device_id, desktop = ?d, "desktop state changed");
            }
            // `desktop` and `capabilities` are only sent when they changed.
            if displays.is_some()
                || user_changed
                || overrides_changed
                || desktop.is_some()
                || capabilities.is_some()
            {
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
        AgentToConsole::SessionEvent {
            session_id, event, ..
        } => {
            if let Err(reason) = hub
                .record_session_event(device_id, &session_id, event)
                .await
            {
                tracing::warn!(device = %device_id, session = %session_id, "session event rejected: {reason}");
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

/// Write one message straight to the socket (before the writer task exists).
async fn send_now(
    sink: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    msg: &ConsoleToAgent,
) -> Result<(), axum::Error> {
    let text = serde_json::to_string(msg).map_err(axum::Error::new)?;
    sink.send(Message::Text(text.into())).await
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
