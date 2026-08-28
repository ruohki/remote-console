//! Row types and their conversions to API / protocol types.

use crate::db::{enum_parse, enum_str};
use protocol::common::{Arch, DeviceMode, DisplayInfo, EndReason, Os, SessionState, VideoCodec};
use protocol::config::{AgentConfig, LocalOverrides};
use protocol::ui::{DevicePermission, DeviceSummary, GroupRef, SessionSummary};
use serde::{Deserialize, Serialize};

// ── users ──────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Admin,
    Operator,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Admin => "admin",
            Role::Operator => "operator",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "admin" => Some(Role::Admin),
            "operator" => Some(Role::Operator),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct UserRow {
    pub id: String,
    pub email: String,
    pub name: String,
    pub password_hash: String,
    pub role: String,
    pub disabled: bool,
    pub created_at: String,
    pub last_login_at: Option<String>,
}

impl UserRow {
    pub fn role(&self) -> Role {
        Role::parse(&self.role).unwrap_or(Role::Operator)
    }

    pub fn is_admin(&self) -> bool {
        self.role() == Role::Admin
    }

    pub fn public(&self) -> UserPublic {
        UserPublic {
            id: self.id.clone(),
            email: self.email.clone(),
            name: self.name.clone(),
            role: self.role(),
            disabled: self.disabled,
            created_at: self.created_at.clone(),
            last_login_at: self.last_login_at.clone(),
        }
    }
}

/// `User` as defined in API.md.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserPublic {
    pub id: String,
    pub email: String,
    pub name: String,
    pub role: Role,
    pub disabled: bool,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_login_at: Option<String>,
}

// ── enrollment tokens ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct EnrollTokenRow {
    pub id: String,
    pub label: String,
    pub token_hash: String,
    pub token_prefix: String,
    pub created_by: Option<String>,
    pub created_at: String,
    pub expires_at: Option<String>,
    pub max_uses: Option<i64>,
    pub uses: i64,
    pub revoked: bool,
    pub default_mode: String,
    pub default_tags: String,
    pub default_group_id: Option<String>,
}

impl EnrollTokenRow {
    pub fn default_mode(&self) -> DeviceMode {
        enum_parse(&self.default_mode).unwrap_or_default()
    }

    pub fn default_tags(&self) -> Vec<String> {
        serde_json::from_str(&self.default_tags).unwrap_or_default()
    }

    /// Public view; `default_group` is resolved by the caller (needs the group name).
    pub fn public(&self, default_group: Option<GroupRef>) -> EnrollTokenPublic {
        EnrollTokenPublic {
            id: self.id.clone(),
            label: self.label.clone(),
            token_prefix: self.token_prefix.clone(),
            created_by: self.created_by.clone().unwrap_or_default(),
            created_at: self.created_at.clone(),
            expires_at: self.expires_at.clone(),
            max_uses: self.max_uses,
            uses: self.uses,
            revoked: self.revoked,
            default_mode: self.default_mode(),
            default_tags: self.default_tags(),
            default_group,
        }
    }
}

/// `EnrollToken` as defined in API.md.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnrollTokenPublic {
    pub id: String,
    pub label: String,
    pub token_prefix: String,
    pub created_by: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_uses: Option<i64>,
    pub uses: i64,
    pub revoked: bool,
    pub default_mode: DeviceMode,
    pub default_tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_group: Option<GroupRef>,
}

// ── devices ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct DeviceRow {
    pub id: String,
    pub name: String,
    pub hostname: String,
    pub os: String,
    pub arch: String,
    pub agent_version: String,
    pub secret_hash: String,
    pub config: String,
    pub tags: String,
    pub notes: String,
    pub online: bool,
    pub last_seen_at: Option<String>,
    pub last_ip: Option<String>,
    pub logged_in_user: Option<String>,
    pub codecs: String,
    pub displays: String,
    pub enrolled_with: Option<String>,
    pub created_at: String,
    /// `protocol::config::LocalOverrides` JSON (restrictions set at the device).
    pub local_overrides: String,
}

impl DeviceRow {
    pub fn config(&self) -> AgentConfig {
        serde_json::from_str(&self.config).unwrap_or_default()
    }

    pub fn local_overrides(&self) -> LocalOverrides {
        serde_json::from_str(&self.local_overrides).unwrap_or_default()
    }

    pub fn tags(&self) -> Vec<String> {
        serde_json::from_str(&self.tags).unwrap_or_default()
    }

    pub fn codecs(&self) -> Vec<VideoCodec> {
        serde_json::from_str(&self.codecs).unwrap_or_default()
    }

    pub fn displays(&self) -> Vec<DisplayInfo> {
        serde_json::from_str(&self.displays).unwrap_or_default()
    }

    pub fn os(&self) -> Os {
        enum_parse(&self.os).unwrap_or(Os::Linux)
    }

    pub fn arch(&self) -> Arch {
        enum_parse(&self.arch).unwrap_or(Arch::X86_64)
    }

    /// Summary for one requesting user: `permission` is per user, `groups` per device.
    pub fn summary(
        &self,
        active_session_id: Option<String>,
        groups: Vec<GroupRef>,
        permission: DevicePermission,
    ) -> DeviceSummary {
        let config = self.config();
        DeviceSummary {
            id: self.id.clone(),
            name: self.name.clone(),
            hostname: self.hostname.clone(),
            os: self.os(),
            arch: self.arch(),
            agent_version: self.agent_version.clone(),
            mode: config.mode,
            tags: self.tags(),
            online: self.online,
            last_seen_at: self.last_seen_at.clone(),
            logged_in_user: self.logged_in_user.clone(),
            last_ip: self.last_ip.clone(),
            codecs: self.codecs(),
            displays: self.displays(),
            active_session_id,
            groups,
            permission,
            local_overrides: self.local_overrides(),
        }
    }

    pub fn detail(
        &self,
        active_session_id: Option<String>,
        enrolled_with: Option<String>,
        groups: Vec<GroupRef>,
        permission: DevicePermission,
    ) -> DeviceDetail {
        DeviceDetail {
            summary: self.summary(active_session_id, groups, permission),
            notes: self.notes.clone(),
            created_at: self.created_at.clone(),
            enrolled_with,
            config: self.config(),
        }
    }
}

/// `DeviceDetail` as defined in API.md (`DeviceSummary` fields flattened).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceDetail {
    #[serde(flatten)]
    pub summary: DeviceSummary,
    pub notes: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enrolled_with: Option<String>,
    pub config: AgentConfig,
}

// ── device groups ─────────────────────────────────────────────────────────────

/// Permission an operator holds on a group (`API.md` `GroupPermission`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GroupPermission {
    View,
    Connect,
}

impl GroupPermission {
    pub fn as_str(self) -> &'static str {
        match self {
            GroupPermission::View => "view",
            GroupPermission::Connect => "connect",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "view" => Some(GroupPermission::View),
            "connect" => Some(GroupPermission::Connect),
            _ => None,
        }
    }

    pub fn as_device_permission(self) -> DevicePermission {
        match self {
            GroupPermission::View => DevicePermission::View,
            GroupPermission::Connect => DevicePermission::Connect,
        }
    }
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct GroupRow {
    pub id: String,
    pub name: String,
    pub description: String,
    pub created_at: String,
    pub device_count: i64,
}

impl GroupRow {
    pub fn public(&self) -> GroupPublic {
        GroupPublic {
            id: self.id.clone(),
            name: self.name.clone(),
            description: self.description.clone(),
            device_count: self.device_count,
            created_at: self.created_at.clone(),
        }
    }

    pub fn group_ref(&self) -> GroupRef {
        GroupRef {
            id: self.id.clone(),
            name: self.name.clone(),
        }
    }
}

/// `Group` as defined in API.md.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupPublic {
    pub id: String,
    pub name: String,
    pub description: String,
    pub device_count: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct GroupGrantRow {
    pub user_id: String,
    pub user_name: String,
    pub user_email: String,
    pub permission: String,
}

impl GroupGrantRow {
    pub fn permission(&self) -> GroupPermission {
        GroupPermission::parse(&self.permission).unwrap_or(GroupPermission::View)
    }

    pub fn public(&self) -> GroupGrant {
        GroupGrant {
            user_id: self.user_id.clone(),
            user_name: self.user_name.clone(),
            user_email: self.user_email.clone(),
            permission: self.permission(),
        }
    }
}

/// `GroupGrant` as defined in API.md.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupGrant {
    pub user_id: String,
    pub user_name: String,
    pub user_email: String,
    pub permission: GroupPermission,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct UserGrantRow {
    pub group_id: String,
    pub group_name: String,
    pub permission: String,
}

impl UserGrantRow {
    pub fn public(&self) -> UserGrant {
        UserGrant {
            group_id: self.group_id.clone(),
            group_name: self.group_name.clone(),
            permission: GroupPermission::parse(&self.permission).unwrap_or(GroupPermission::View),
        }
    }
}

/// One row of `GET /api/users/:id/grants`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserGrant {
    pub group_id: String,
    pub group_name: String,
    pub permission: GroupPermission,
}

// ── remote sessions ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct SessionRow {
    pub id: String,
    pub device_id: String,
    pub device_name: String,
    pub operator_id: Option<String>,
    pub operator_name: Option<String>,
    pub state: String,
    pub started_at: String,
    pub connected_at: Option<String>,
    pub ended_at: Option<String>,
    pub end_reason: Option<String>,
    pub codec: Option<String>,
    pub client_ip: Option<String>,
}

impl SessionRow {
    pub fn state(&self) -> SessionState {
        enum_parse(&self.state).unwrap_or(SessionState::Ended)
    }

    pub fn summary(&self) -> SessionSummary {
        SessionSummary {
            id: self.id.clone(),
            device_id: self.device_id.clone(),
            device_name: self.device_name.clone(),
            operator_id: self.operator_id.clone().unwrap_or_default(),
            operator_name: self
                .operator_name
                .clone()
                .unwrap_or_else(|| "deleted user".into()),
            state: self.state(),
            started_at: self.started_at.clone(),
            connected_at: self.connected_at.clone(),
            ended_at: self.ended_at.clone(),
            end_reason: self.end_reason.as_deref().and_then(enum_parse::<EndReason>),
            codec: self.codec.as_deref().and_then(enum_parse::<VideoCodec>),
            role: protocol::common::SessionRole::Operator,
            shadow_of: None,
            observers: Vec::new(),
        }
    }
}

pub fn state_str(s: SessionState) -> String {
    enum_str(&s)
}

pub fn reason_str(r: EndReason) -> String {
    enum_str(&r)
}

// ── session events ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct SessionEventRow {
    pub id: i64,
    pub session_id: String,
    pub ts: String,
    pub event: String,
}

/// Session event entry as returned by `GET /api/sessions/:id/events`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionEventEntry {
    pub id: i64,
    pub session_id: String,
    pub ts: String,
    pub event: protocol::agent::SessionEvent,
}

impl SessionEventRow {
    /// `None` when the stored JSON no longer matches the protocol (skipped by the API).
    pub fn public(&self) -> Option<SessionEventEntry> {
        let event = serde_json::from_str(&self.event).ok()?;
        Some(SessionEventEntry {
            id: self.id,
            session_id: self.session_id.clone(),
            ts: self.ts.clone(),
            event,
        })
    }
}

// ── audit ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct AuditRow {
    pub id: i64,
    pub ts: String,
    pub user_id: Option<String>,
    pub user_name: Option<String>,
    pub action: String,
    pub target: Option<String>,
    pub details: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEntry {
    pub id: i64,
    pub ts: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_name: Option<String>,
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    pub details: serde_json::Value,
}

impl AuditRow {
    pub fn public(&self) -> AuditEntry {
        AuditEntry {
            id: self.id,
            ts: self.ts.clone(),
            user_id: self.user_id.clone(),
            user_name: self.user_name.clone(),
            action: self.action.clone(),
            target: self.target.clone(),
            details: serde_json::from_str(&self.details).unwrap_or(serde_json::Value::Null),
        }
    }
}
