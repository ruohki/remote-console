//! Live state: connected agents, connected UIs and in-flight sessions.
//!
//! The hub is the only place where the two WebSocket kinds meet. All in-memory state sits
//! behind one `parking_lot::Mutex` that is never held across an `.await`; database work
//! happens outside the lock.

pub mod agent_ws;
pub mod events;
pub mod ui_ws;

use crate::auth::access::AccessMap;
use crate::config::Config;
use crate::db::{self, audit::Actor, Db};
use events::EventLimiter;
use parking_lot::Mutex;
use protocol::agent::{ConsoleToAgent, SessionEvent};
use protocol::common::{
    EndReason, IceServer, OperatorInfo, SessionDescription, SessionRole, SessionState,
};
use protocol::config::AgentConfig;
use protocol::ui::{ConsoleToUi, DeviceSummary, SessionSummary};
use serde_json::json;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// Devices are considered gone after this many missed heartbeats.
pub const MISSED_HEARTBEATS: u32 = 3;
/// Extra slack on top of the device's approval timeout before the console gives up.
pub const APPROVAL_GRACE: Duration = Duration::from_secs(5);
/// Interval of the offline reaper.
const REAPER_INTERVAL: Duration = Duration::from_secs(5);
/// Agents may still report events this long after a session ended (late transfer results).
pub const EVENT_GRACE_AFTER_END: Duration = Duration::from_secs(60);
/// Per-session event rate limit (events per second).
pub const EVENTS_PER_SECOND: u32 = 50;
/// Idle event limiters are dropped after this long.
const EVENT_LIMITER_IDLE: Duration = Duration::from_secs(120);

pub struct AgentConn {
    pub conn_id: u64,
    pub tx: mpsc::UnboundedSender<ConsoleToAgent>,
    pub cancel: CancellationToken,
    pub heartbeat_interval: Duration,
    pub last_seen: Instant,
}

pub struct UiConn {
    pub tx: mpsc::UnboundedSender<ConsoleToUi>,
    pub user_id: String,
    /// What this user may see / do; refreshed by [`Hub::refresh_access`].
    pub access: AccessMap,
}

#[derive(Clone)]
pub struct ActiveSession {
    pub device_id: String,
    pub operator: OperatorInfo,
    pub ui_conn_id: u64,
    pub state: SessionState,
}

#[derive(Default)]
struct HubState {
    agents: HashMap<String, AgentConn>,
    uis: HashMap<u64, UiConn>,
    sessions: HashMap<String, ActiveSession>,
    /// Per-session rate limiters for `session_event`s (purged when idle).
    event_limiters: HashMap<String, EventLimiter>,
}

pub struct Hub {
    pub config: Arc<Config>,
    pub db: Db,
    state: Mutex<HubState>,
    next_id: AtomicU64,
}

/// Outcome of [`Hub::start_session`].
pub enum StartError {
    NotFound,
    /// The user may see the device but holds no `connect` grant.
    Forbidden,
    DeviceOffline,
    DeviceBusy,
    Internal(String),
}

impl StartError {
    pub fn code(&self) -> &'static str {
        match self {
            StartError::NotFound => "not_found",
            StartError::Forbidden => "forbidden",
            StartError::DeviceOffline => "device_offline",
            StartError::DeviceBusy => "device_busy",
            StartError::Internal(_) => "internal",
        }
    }

    pub fn message(&self) -> String {
        match self {
            StartError::NotFound => "device not found".into(),
            StartError::Forbidden => "you are not allowed to connect to this device".into(),
            StartError::DeviceOffline => "device is offline".into(),
            StartError::DeviceBusy => "device already has an active session".into(),
            StartError::Internal(m) => m.clone(),
        }
    }
}

impl Hub {
    pub fn new(config: Arc<Config>, db: Db) -> Arc<Self> {
        Arc::new(Self {
            config,
            db,
            state: Mutex::new(HubState::default()),
            next_id: AtomicU64::new(1),
        })
    }

    pub fn next_conn_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    /// Offline reaper and housekeeping.
    pub fn spawn_background_tasks(self: &Arc<Self>) {
        let hub = Arc::clone(self);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(REAPER_INTERVAL);
            loop {
                tick.tick().await;
                let stale: Vec<(String, CancellationToken)> = {
                    let st = hub.state.lock();
                    st.agents
                        .iter()
                        .filter(|(_, c)| {
                            c.last_seen.elapsed() > c.heartbeat_interval * MISSED_HEARTBEATS
                        })
                        .map(|(id, c)| (id.clone(), c.cancel.clone()))
                        .collect()
                };
                for (device_id, cancel) in stale {
                    tracing::warn!(device = %device_id, "no heartbeat, dropping agent connection");
                    cancel.cancel();
                }
                hub.state
                    .lock()
                    .event_limiters
                    .retain(|_, l| l.idle_for() < EVENT_LIMITER_IDLE);
            }
        });
        let hub = Arc::clone(self);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(3600));
            loop {
                tick.tick().await;
                match db::users::purge_expired_login_sessions(&hub.db).await {
                    Ok(n) if n > 0 => tracing::debug!("purged {n} expired login sessions"),
                    Ok(_) => {}
                    Err(err) => tracing::warn!("purging login sessions failed: {err}"),
                }
            }
        });
    }

    // ── queries ──────────────────────────────────────────────────────────────

    pub fn is_online(&self, device_id: &str) -> bool {
        self.state.lock().agents.contains_key(device_id)
    }

    pub fn active_session_id(&self, device_id: &str) -> Option<String> {
        self.state
            .lock()
            .sessions
            .iter()
            .find(|(_, s)| s.device_id == device_id)
            .map(|(id, _)| id.clone())
    }

    pub fn active_sessions_by_device(&self) -> HashMap<String, String> {
        self.state
            .lock()
            .sessions
            .iter()
            .map(|(id, s)| (s.device_id.clone(), id.clone()))
            .collect()
    }

    pub fn active_session(&self, session_id: &str) -> Option<ActiveSession> {
        self.state.lock().sessions.get(session_id).cloned()
    }

    // ── registration (used by the socket handlers) ───────────────────────────

    /// Register an agent connection, replacing (and cancelling) any previous one.
    pub(crate) fn register_agent(&self, device_id: &str, conn: AgentConn) -> Option<AgentConn> {
        let old = self.state.lock().agents.insert(device_id.to_string(), conn);
        if let Some(old) = &old {
            let _ = old.tx.send(ConsoleToAgent::Goodbye {
                reason: "replaced by a newer connection".into(),
            });
            old.cancel.cancel();
        }
        old
    }

    /// Remove the agent registration if it still belongs to `conn_id`.
    pub(crate) fn unregister_agent(&self, device_id: &str, conn_id: u64) -> bool {
        let mut st = self.state.lock();
        match st.agents.get(device_id) {
            Some(c) if c.conn_id == conn_id => {
                st.agents.remove(device_id);
                true
            }
            _ => false,
        }
    }

    pub(crate) fn touch_agent(&self, device_id: &str, conn_id: u64) {
        if let Some(c) = self.state.lock().agents.get_mut(device_id) {
            if c.conn_id == conn_id {
                c.last_seen = Instant::now();
            }
        }
    }

    pub(crate) fn register_ui(&self, conn_id: u64, conn: UiConn) {
        self.state.lock().uis.insert(conn_id, conn);
    }

    pub(crate) fn unregister_ui(&self, conn_id: u64) -> Vec<String> {
        let mut st = self.state.lock();
        st.uis.remove(&conn_id);
        st.sessions
            .iter()
            .filter(|(_, s)| s.ui_conn_id == conn_id)
            .map(|(id, _)| id.clone())
            .collect()
    }

    // ── messaging ────────────────────────────────────────────────────────────

    pub fn send_to_agent(&self, device_id: &str, msg: ConsoleToAgent) -> bool {
        match self.state.lock().agents.get(device_id) {
            Some(c) => c.tx.send(msg).is_ok(),
            None => false,
        }
    }

    pub fn send_to_ui(&self, conn_id: u64, msg: ConsoleToUi) -> bool {
        match self.state.lock().uis.get(&conn_id) {
            Some(c) => c.tx.send(msg).is_ok(),
            None => false,
        }
    }

    /// Current access map of a UI connection (kept fresh by [`Self::refresh_access`]).
    pub fn ui_access(&self, conn_id: u64) -> Option<AccessMap> {
        self.state
            .lock()
            .uis
            .get(&conn_id)
            .map(|c| c.access.clone())
    }

    /// Send `msg` to every UI connection allowed to see `device_id`.
    pub fn send_to_uis_seeing(&self, device_id: &str, msg: ConsoleToUi) {
        let senders: Vec<_> = self
            .state
            .lock()
            .uis
            .values()
            .filter(|c| c.access.can_see(device_id))
            .map(|c| c.tx.clone())
            .collect();
        for tx in senders {
            let _ = tx.send(msg.clone());
        }
    }

    /// Summary of a device as seen by `access` (`None` when it must stay invisible).
    pub async fn device_summary_for(
        &self,
        device_id: &str,
        access: &AccessMap,
    ) -> Option<DeviceSummary> {
        let permission = access.permission(device_id)?;
        match db::devices::by_id(&self.db, device_id).await {
            Ok(Some(row)) => {
                let groups = db::groups::groups_for_device(&self.db, device_id)
                    .await
                    .unwrap_or_default();
                Some(row.summary(self.active_session_id(device_id), groups, permission))
            }
            Ok(None) => None,
            Err(err) => {
                tracing::error!("loading device {device_id}: {err}");
                None
            }
        }
    }

    /// Push a `device_update` to every UI that may see the device, each with its own
    /// `permission`.
    pub async fn broadcast_device(&self, device_id: &str) {
        let row = match db::devices::by_id(&self.db, device_id).await {
            Ok(Some(row)) => row,
            Ok(None) => return,
            Err(err) => {
                tracing::error!("loading device {device_id}: {err}");
                return;
            }
        };
        let groups = db::groups::groups_for_device(&self.db, device_id)
            .await
            .unwrap_or_default();
        let active = self.active_session_id(device_id);
        let recipients: Vec<(
            mpsc::UnboundedSender<ConsoleToUi>,
            protocol::ui::DevicePermission,
        )> = self
            .state
            .lock()
            .uis
            .values()
            .filter_map(|c| c.access.permission(device_id).map(|p| (c.tx.clone(), p)))
            .collect();
        for (tx, permission) in recipients {
            let _ = tx.send(ConsoleToUi::DeviceUpdate {
                device: row.summary(active.clone(), groups.clone(), permission),
            });
        }
    }

    pub fn broadcast_device_removed(&self, device_id: &str) {
        self.send_to_uis_seeing(
            device_id,
            ConsoleToUi::DeviceRemoved {
                device_id: device_id.to_string(),
            },
        );
    }

    /// Recompute every UI connection's access map (after grant / membership / role changes)
    /// and push the resulting differences: newly visible devices arrive as `device_update`,
    /// lost ones as `device_removed`.
    pub async fn refresh_access(&self) {
        let conns: Vec<(u64, String, AccessMap)> = self
            .state
            .lock()
            .uis
            .iter()
            .map(|(id, c)| (*id, c.user_id.clone(), c.access.clone()))
            .collect();
        if conns.is_empty() {
            return;
        }
        let devices = match db::devices::list(&self.db).await {
            Ok(rows) => rows,
            Err(err) => {
                tracing::error!("refreshing access: listing devices: {err}");
                return;
            }
        };
        let groups = db::groups::groups_for_all_devices(&self.db)
            .await
            .unwrap_or_default();
        let active = self.active_sessions_by_device();
        for (conn_id, user_id, old) in conns {
            let user = match db::users::by_id(&self.db, &user_id).await {
                Ok(Some(u)) if !u.disabled => u,
                Ok(_) => {
                    // Deleted / disabled: drop everything they could see.
                    let tx = self.state.lock().uis.get(&conn_id).map(|c| c.tx.clone());
                    if let Some(tx) = tx {
                        for d in &devices {
                            if old.can_see(&d.id) {
                                let _ = tx.send(ConsoleToUi::DeviceRemoved {
                                    device_id: d.id.clone(),
                                });
                            }
                        }
                    }
                    if let Some(c) = self.state.lock().uis.get_mut(&conn_id) {
                        c.access = AccessMap::from_grants(false, Vec::new());
                    }
                    continue;
                }
                Err(err) => {
                    tracing::error!("refreshing access for {user_id}: {err}");
                    continue;
                }
            };
            let new = match AccessMap::load(&self.db, &user).await {
                Ok(a) => a,
                Err(err) => {
                    tracing::error!("refreshing access for {user_id}: {err}");
                    continue;
                }
            };
            let tx = {
                let mut st = self.state.lock();
                let Some(c) = st.uis.get_mut(&conn_id) else {
                    continue;
                };
                c.access = new.clone();
                c.tx.clone()
            };
            for d in &devices {
                match (old.permission(&d.id), new.permission(&d.id)) {
                    (Some(_), None) => {
                        let _ = tx.send(ConsoleToUi::DeviceRemoved {
                            device_id: d.id.clone(),
                        });
                    }
                    (before, Some(permission)) if before != Some(permission) => {
                        let _ = tx.send(ConsoleToUi::DeviceUpdate {
                            device: d.summary(
                                active.get(&d.id).cloned(),
                                groups.get(&d.id).cloned().unwrap_or_default(),
                                permission,
                            ),
                        });
                    }
                    _ => {}
                }
            }
        }
    }

    pub async fn session_summary(&self, session_id: &str) -> Option<SessionSummary> {
        match db::sessions::by_id(&self.db, session_id).await {
            Ok(Some(row)) => Some(row.summary()),
            Ok(None) => None,
            Err(err) => {
                tracing::error!("loading session {session_id}: {err}");
                None
            }
        }
    }

    pub async fn broadcast_session(&self, session_id: &str) {
        if let Some(session) = self.session_summary(session_id).await {
            let device_id = session.device_id.clone();
            self.send_to_uis_seeing(&device_id, ConsoleToUi::SessionUpdate { session });
        }
    }

    /// Push a new configuration to a connected agent (no-op when offline).
    pub async fn push_config(&self, device_id: &str, config: &AgentConfig) {
        {
            let mut st = self.state.lock();
            if let Some(c) = st.agents.get_mut(device_id) {
                c.heartbeat_interval =
                    Duration::from_secs(u64::from(config.heartbeat_interval_s.max(1)));
            }
        }
        self.send_to_agent(
            device_id,
            ConsoleToAgent::ConfigUpdate {
                config: config.clone(),
            },
        );
    }

    /// Say goodbye and drop the agent's connection.
    pub async fn disconnect_device(&self, device_id: &str, reason: &str) {
        let cancel = {
            let st = self.state.lock();
            st.agents.get(device_id).map(|c| {
                let _ = c.tx.send(ConsoleToAgent::Goodbye {
                    reason: reason.to_string(),
                });
                c.cancel.clone()
            })
        };
        if let Some(cancel) = cancel {
            // Give the writer a moment to flush the goodbye before closing.
            tokio::time::sleep(Duration::from_millis(50)).await;
            cancel.cancel();
        }
    }

    // ── sessions ─────────────────────────────────────────────────────────────

    pub fn ice_servers_for(&self, session_id: &str) -> Vec<IceServer> {
        crate::turn::ice_servers(&self.config, session_id, chrono::Utc::now().timestamp())
    }

    /// Operator wants to connect: validates, records, notifies both sides.
    pub async fn start_session(
        self: &Arc<Self>,
        ui_conn_id: u64,
        operator: OperatorInfo,
        device_id: &str,
        offer: SessionDescription,
        client_ip: &str,
    ) -> Result<String, StartError> {
        let device = match db::devices::by_id(&self.db, device_id).await {
            Ok(Some(d)) => d,
            Ok(None) => return Err(StartError::NotFound),
            Err(err) => return Err(StartError::Internal(format!("database: {err}"))),
        };
        // RBAC: the connection's current access map must grant `connect`.
        match self.ui_access(ui_conn_id) {
            Some(access) if access.can_connect(device_id) => {}
            Some(access) if access.can_see(device_id) => return Err(StartError::Forbidden),
            _ => return Err(StartError::NotFound),
        }
        let config = device.config();
        let help_me = config.mode == protocol::common::DeviceMode::HelpMe;
        let initial = if help_me {
            SessionState::AwaitingApproval
        } else {
            SessionState::Requested
        };
        let session_id = crate::ids::session_id();

        {
            let mut st = self.state.lock();
            if !st.agents.contains_key(device_id) {
                return Err(StartError::DeviceOffline);
            }
            if st.sessions.values().any(|s| s.device_id == device_id) {
                return Err(StartError::DeviceBusy);
            }
            st.sessions.insert(
                session_id.clone(),
                ActiveSession {
                    device_id: device_id.to_string(),
                    operator: operator.clone(),
                    ui_conn_id,
                    state: initial,
                },
            );
        }

        if let Err(err) = db::sessions::insert(
            &self.db,
            &session_id,
            device_id,
            &operator.id,
            initial,
            Some(client_ip),
        )
        .await
        {
            self.state.lock().sessions.remove(&session_id);
            return Err(StartError::Internal(format!("database: {err}")));
        }
        db::audit::record_lossy(
            &self.db,
            Some(Actor { id: &operator.id, name: &operator.name }),
            "session.start",
            Some(&session_id),
            json!({ "device_id": device_id, "device_name": device.name, "mode": config.mode, "ip": client_ip }),
        )
        .await;

        let ice_servers = self.ice_servers_for(&session_id);
        self.send_to_ui(
            ui_conn_id,
            ConsoleToUi::SessionCreated {
                session_id: session_id.clone(),
                device_id: device_id.to_string(),
                ice_servers: ice_servers.clone(),
            },
        );
        let delivered = self.send_to_agent(
            device_id,
            ConsoleToAgent::SessionRequest {
                session_id: session_id.clone(),
                operator,
                offer,
                ice_servers,
                role: SessionRole::Operator,
                shadow_of: None,
                notify_operator: true,
            },
        );
        if !delivered {
            self.end_session(&session_id, EndReason::AgentOffline, None)
                .await;
            return Err(StartError::DeviceOffline);
        }

        self.broadcast_session(&session_id).await;
        self.broadcast_device(device_id).await;

        if help_me {
            let hub = Arc::clone(self);
            let sid = session_id.clone();
            let timeout =
                Duration::from_secs(u64::from(config.approval_timeout_s.max(1))) + APPROVAL_GRACE;
            tokio::spawn(async move {
                tokio::time::sleep(timeout).await;
                let still_waiting = hub
                    .active_session(&sid)
                    .is_some_and(|s| s.state == SessionState::AwaitingApproval);
                if still_waiting {
                    hub.end_session(&sid, EndReason::ApprovalTimeout, None)
                        .await;
                }
            });
        }
        Ok(session_id)
    }

    /// Update the state of an active session (from the agent's `session_state`).
    pub async fn set_session_state(
        &self,
        session_id: &str,
        state: SessionState,
    ) -> Option<ActiveSession> {
        let session = {
            let mut st = self.state.lock();
            let s = st.sessions.get_mut(session_id)?;
            s.state = state;
            s.clone()
        };
        if let Err(err) = db::sessions::set_state(&self.db, session_id, state).await {
            tracing::error!("updating session {session_id}: {err}");
        }
        self.broadcast_session(session_id).await;
        Some(session)
    }

    /// End a session from any side. Returns `true` when it was still active in memory.
    pub async fn end_session(
        &self,
        session_id: &str,
        reason: EndReason,
        actor: Option<Actor<'_>>,
    ) -> bool {
        let active = self.state.lock().sessions.remove(session_id);
        match db::sessions::end(&self.db, session_id, reason).await {
            Ok(_) => {}
            Err(err) => tracing::error!("ending session {session_id}: {err}"),
        }
        let Some(active) = active else {
            return false;
        };

        self.send_to_agent(
            &active.device_id,
            ConsoleToAgent::SessionEnd {
                session_id: session_id.to_string(),
                reason,
            },
        );
        let error_code = match reason {
            EndReason::Denied => Some("denied"),
            EndReason::ApprovalTimeout => Some("approval_timeout"),
            EndReason::AgentOffline => Some("device_offline"),
            EndReason::ConnectionFailed | EndReason::Error => Some("agent_error"),
            EndReason::OperatorClosed | EndReason::DeviceUserClosed => None,
        };
        if let Some(code) = error_code {
            self.send_to_ui(
                active.ui_conn_id,
                ConsoleToUi::Error {
                    session_id: Some(session_id.to_string()),
                    code: code.into(),
                    message: format!("session ended: {}", db::enum_str(&reason)),
                },
            );
        }
        let owner = Actor {
            id: &active.operator.id,
            name: &active.operator.name,
        };
        db::audit::record_lossy(
            &self.db,
            Some(actor.unwrap_or(owner)),
            "session.end",
            Some(session_id),
            json!({ "device_id": active.device_id, "reason": reason }),
        )
        .await;
        self.broadcast_session(session_id).await;
        self.broadcast_device(&active.device_id).await;
        true
    }

    // ── session events ───────────────────────────────────────────────────────

    /// Store an agent-reported event, push it to every UI and audit transfers/clipboard.
    ///
    /// Returns `Ok(None)` when the event was dropped (rate limit / cap) and `Err` with a
    /// short reason when it was rejected (unknown session, wrong device, ended too long ago).
    pub async fn record_session_event(
        &self,
        device_id: &str,
        session_id: &str,
        event: SessionEvent,
    ) -> Result<Option<i64>, &'static str> {
        // Ownership + liveness: in-memory active session first, then a recently ended one.
        let operator = match self.active_session(session_id) {
            Some(s) if s.device_id == device_id => Some(s.operator),
            Some(_) => return Err("session belongs to another device"),
            None => {
                let row = db::sessions::by_id(&self.db, session_id)
                    .await
                    .map_err(|_| "database error")?
                    .ok_or("unknown session")?;
                if row.device_id != device_id {
                    return Err("session belongs to another device");
                }
                let recently_ended =
                    row.ended_at
                        .as_deref()
                        .and_then(db::parse_ts)
                        .is_some_and(|t| {
                            chrono::Utc::now()
                                .signed_duration_since(t)
                                .to_std()
                                .unwrap_or_default()
                                <= EVENT_GRACE_AFTER_END
                        });
                if row.state() == SessionState::Ended && !recently_ended {
                    return Err("session ended");
                }
                row.operator_id.as_ref().map(|id| OperatorInfo {
                    id: id.clone(),
                    name: row
                        .operator_name
                        .clone()
                        .unwrap_or_else(|| "deleted user".into()),
                })
            }
        };

        let allowed = self
            .state
            .lock()
            .event_limiters
            .entry(session_id.to_string())
            .or_insert_with(|| EventLimiter::new(EVENTS_PER_SECOND))
            .allow();
        if !allowed {
            tracing::warn!(session = %session_id, "session event rate limit exceeded, dropping");
            return Ok(None);
        }

        let stored = db::session_events::insert(&self.db, session_id, &event)
            .await
            .map_err(|err| {
                tracing::error!("storing session event: {err}");
                "database error"
            })?;
        let Some((id, ts)) = stored else {
            tracing::warn!(session = %session_id, "session event cap reached, dropping");
            return Ok(None);
        };

        let actor = operator.as_ref().map(|o| Actor {
            id: &o.id,
            name: &o.name,
        });
        match &event {
            SessionEvent::TransferCompleted {
                name,
                size,
                direction,
                path,
                ..
            } => {
                db::audit::record_lossy(
                    &self.db,
                    actor,
                    "session.transfer",
                    Some(session_id),
                    json!({ "device_id": device_id, "result": "completed", "name": name, "size": size, "direction": direction, "path": path }),
                )
                .await;
            }
            SessionEvent::TransferFailed { name, reason, .. } => {
                db::audit::record_lossy(
                    &self.db,
                    actor,
                    "session.transfer",
                    Some(session_id),
                    json!({ "device_id": device_id, "result": "failed", "name": name, "reason": reason }),
                )
                .await;
            }
            SessionEvent::ClipboardSync { direction, summary } => {
                db::audit::record_lossy(
                    &self.db,
                    actor,
                    "session.clipboard",
                    Some(session_id),
                    json!({ "device_id": device_id, "direction": direction, "summary": summary }),
                )
                .await;
            }
            _ => {}
        }

        self.send_to_uis_seeing(
            device_id,
            ConsoleToUi::SessionEvent {
                session_id: session_id.to_string(),
                event,
                ts,
            },
        );
        Ok(Some(id))
    }

    /// End every active session of a device (agent went away).
    pub async fn end_sessions_for_device(&self, device_id: &str, reason: EndReason) {
        let ids: Vec<String> = self
            .state
            .lock()
            .sessions
            .iter()
            .filter(|(_, s)| s.device_id == device_id)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            self.end_session(&id, reason, None).await;
        }
    }
}
