//! `/ws/ui` — the browser side of the hub.

use super::{Hub, UiConn};
use crate::app::AppState;
use crate::auth::access::AccessMap;
use crate::auth::{self, AuthUser};
use crate::db::{self, sessions::Filter};
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, State};
use axum::http::HeaderMap;
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use protocol::agent::ConsoleToAgent;
use protocol::common::{EndReason, OperatorInfo};
use protocol::ui::{ConsoleToUi, UiToConsole};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// Sockets without any client message for this long are closed.
const IDLE_TIMEOUT: Duration = Duration::from_secs(90);

pub async fn upgrade(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    let ip = auth::client_ip(&headers, Some(&ConnectInfo(peer)));
    ws.on_upgrade(move |socket| handle(state.hub, socket, user, ip))
}

async fn handle(hub: Arc<Hub>, socket: WebSocket, user: db::models::UserRow, ip: String) {
    let (mut sink, mut stream) = socket.split();
    let conn_id = hub.next_conn_id();
    let (tx, mut rx) = mpsc::unbounded_channel::<ConsoleToUi>();
    let access = match AccessMap::load(&hub.db, &user).await {
        Ok(a) => a,
        Err(err) => {
            tracing::error!(user = %user.email, "loading access map: {err}");
            AccessMap::from_grants(false, Vec::new())
        }
    };
    hub.register_ui(
        conn_id,
        UiConn {
            tx: tx.clone(),
            user_id: user.id.clone(),
            access,
        },
    );
    let operator = OperatorInfo {
        id: user.id.clone(),
        name: user.name.clone(),
    };
    tracing::debug!(user = %user.email, conn = conn_id, "ui connected");

    let cancel = CancellationToken::new();
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
                        Err(err) => { tracing::error!("serializing ui message: {err}"); continue; }
                    };
                    if sink.send(Message::Text(text.into())).await.is_err() {
                        break;
                    }
                }
            }
        }
    });

    loop {
        let incoming = match tokio::time::timeout(IDLE_TIMEOUT, stream.next()).await {
            Ok(Some(Ok(msg))) => msg,
            Ok(_) => break,
            Err(_) => {
                tracing::debug!(conn = conn_id, "ui socket idle, closing");
                break;
            }
        };
        let text = match incoming {
            Message::Text(t) => t,
            Message::Close(_) => break,
            _ => continue,
        };
        let msg = match serde_json::from_str::<UiToConsole>(&text) {
            Ok(m) => m,
            Err(err) => {
                let _ = tx.send(ConsoleToUi::Error {
                    session_id: None,
                    code: "bad_message".into(),
                    message: format!("invalid message: {err}"),
                });
                continue;
            }
        };
        handle_message(&hub, conn_id, &operator, &ip, &tx, msg).await;
    }

    cancel.cancel();
    let _ = writer.await;
    for session_id in hub.unregister_ui(conn_id) {
        hub.end_session(&session_id, EndReason::OperatorClosed, None)
            .await;
    }
    tracing::debug!(user = %user.email, conn = conn_id, "ui disconnected");
}

async fn handle_message(
    hub: &Arc<Hub>,
    conn_id: u64,
    operator: &OperatorInfo,
    ip: &str,
    tx: &mpsc::UnboundedSender<ConsoleToUi>,
    msg: UiToConsole,
) {
    match msg {
        UiToConsole::Subscribe => {
            let access = hub
                .ui_access(conn_id)
                .unwrap_or_else(|| AccessMap::from_grants(false, Vec::new()));
            let devices = match db::devices::list(&hub.db).await {
                Ok(rows) => {
                    let active = hub.active_sessions_by_device();
                    let mut groups = db::groups::groups_for_all_devices(&hub.db)
                        .await
                        .unwrap_or_default();
                    rows.iter()
                        .filter_map(|d| {
                            let permission = access.permission(&d.id)?;
                            Some(d.summary(
                                active.get(&d.id).cloned(),
                                groups.remove(&d.id).unwrap_or_default(),
                                permission,
                            ))
                        })
                        .collect()
                }
                Err(err) => {
                    tracing::error!("listing devices: {err}");
                    Vec::new()
                }
            };
            let visible: Option<Vec<String>> = access
                .visible_device_ids()
                .map(|set| set.into_iter().collect());
            let sessions = match db::sessions::list(
                &hub.db,
                Filter {
                    active_only: true,
                    device_id: None,
                    device_ids: visible.as_deref(),
                    limit: 500,
                    before: None,
                },
            )
            .await
            {
                Ok(rows) => rows.iter().map(|s| s.summary()).collect(),
                Err(err) => {
                    tracing::error!("listing sessions: {err}");
                    Vec::new()
                }
            };
            let _ = tx.send(ConsoleToUi::Snapshot { devices, sessions });
        }
        UiToConsole::Ping { nonce } => {
            let _ = tx.send(ConsoleToUi::Pong { nonce });
        }
        UiToConsole::SessionOffer {
            device_id,
            offer,
            shadow_of,
        } => {
            if shadow_of.is_some() {
                let _ = tx.send(ConsoleToUi::Error {
                    session_id: None,
                    code: "not_implemented".into(),
                    message: "session shadowing is not available yet".into(),
                });
                return;
            }
            if offer.kind != "offer" {
                let _ = tx.send(ConsoleToUi::Error {
                    session_id: None,
                    code: "bad_message".into(),
                    message: "session_offer must carry an SDP offer".into(),
                });
                return;
            }
            if let Err(err) = hub
                .start_session(conn_id, operator.clone(), &device_id, offer, ip)
                .await
            {
                let _ = tx.send(ConsoleToUi::Error {
                    session_id: None,
                    code: err.code().into(),
                    message: err.message(),
                });
            }
        }
        UiToConsole::IceCandidate {
            session_id,
            candidate,
        } => match hub.active_session(&session_id) {
            Some(s) if s.ui_conn_id == conn_id => {
                hub.send_to_agent(
                    &s.device_id,
                    ConsoleToAgent::IceCandidate {
                        session_id,
                        candidate,
                    },
                );
            }
            _ => {
                let _ = tx.send(ConsoleToUi::Error {
                    session_id: Some(session_id),
                    code: "not_found".into(),
                    message: "no such active session on this connection".into(),
                });
            }
        },
        UiToConsole::SessionEnd { session_id } => {
            let owned = hub
                .active_session(&session_id)
                .is_some_and(|s| s.ui_conn_id == conn_id || s.operator.id == operator.id);
            if owned {
                hub.end_session(&session_id, EndReason::OperatorClosed, None)
                    .await;
            } else {
                let _ = tx.send(ConsoleToUi::Error {
                    session_id: Some(session_id),
                    code: "not_found".into(),
                    message: "no such active session".into(),
                });
            }
        }
    }
}
