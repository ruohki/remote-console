//! Devices (operator+; config and deletion admin only).

use crate::app::AppState;
use crate::auth::{AdminUser, AuthUser};
use crate::db::{self, models::DeviceDetail, sessions::Filter};
use crate::error::{ApiError, ApiResult};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use protocol::common::EndReason;
use protocol::config::AgentConfig;
use protocol::ui::{DeviceSummary, SessionSummary};
use serde::Deserialize;
use serde_json::json;

pub async fn list(
    State(state): State<AppState>,
    _user: AuthUser,
) -> ApiResult<Json<Vec<DeviceSummary>>> {
    let rows = db::devices::list(&state.db).await?;
    let active = state.hub.active_sessions_by_device();
    Ok(Json(
        rows.iter()
            .map(|d| d.summary(active.get(&d.id).cloned()))
            .collect(),
    ))
}

async fn load_detail(state: &AppState, id: &str) -> ApiResult<DeviceDetail> {
    let row = db::devices::by_id(&state.db, id)
        .await?
        .ok_or_else(|| ApiError::not_found("device"))?;
    let label = match &row.enrolled_with {
        Some(t) => db::tokens::label(&state.db, t).await?,
        None => None,
    };
    Ok(row.detail(state.hub.active_session_id(id), label))
}

pub async fn get_one(
    State(state): State<AppState>,
    _user: AuthUser,
    Path(id): Path<String>,
) -> ApiResult<Json<DeviceDetail>> {
    Ok(Json(load_detail(&state, &id).await?))
}

#[derive(Deserialize, Default)]
pub struct UpdateBody {
    pub name: Option<String>,
    pub tags: Option<Vec<String>>,
    pub notes: Option<String>,
}

pub async fn update(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Json(body): Json<UpdateBody>,
) -> ApiResult<Json<DeviceDetail>> {
    if body.name.as_deref().is_some_and(|n| n.trim().is_empty()) {
        return Err(ApiError::validation("name must not be empty"));
    }
    let tags: Option<Vec<String>> = body.tags.map(|t| {
        t.into_iter()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    });
    db::devices::update_meta(
        &state.db,
        &id,
        body.name.as_deref(),
        tags.as_deref(),
        body.notes.as_deref(),
    )
    .await?
    .ok_or_else(|| ApiError::not_found("device"))?;
    db::audit::record(
        &state.db,
        Some(user.actor()),
        "device.update",
        Some(&id),
        json!({ "name": body.name, "tags": tags, "notes_changed": body.notes.is_some() }),
    )
    .await?;
    state.hub.broadcast_device(&id).await;
    Ok(Json(load_detail(&state, &id).await?))
}

/// `Partial<AgentConfig>`: every field optional, merged onto the stored config.
#[derive(Deserialize, Default)]
pub struct ConfigPatch {
    pub display_name: Option<String>,
    pub mode: Option<protocol::common::DeviceMode>,
    pub heartbeat_interval_s: Option<u32>,
    pub ice_servers: Option<Vec<protocol::common::IceServer>>,
    pub max_fps: Option<u32>,
    pub max_bitrate_kbps: Option<u32>,
    pub preferred_codec: Option<protocol::common::VideoCodec>,
    pub allow_input: Option<bool>,
    pub allow_clipboard: Option<bool>,
    pub approval_timeout_s: Option<u32>,
    pub show_session_indicator: Option<bool>,
    pub allow_file_transfer: Option<bool>,
    /// `""` (or whitespace) clears the override back to the agent default.
    pub transfer_dir: Option<String>,
    pub allow_audio: Option<bool>,
}

impl ConfigPatch {
    fn apply(self, mut cfg: AgentConfig) -> Result<AgentConfig, ApiError> {
        if let Some(v) = self.display_name {
            if v.trim().is_empty() {
                return Err(ApiError::validation("display_name must not be empty"));
            }
            cfg.display_name = v.trim().to_string();
        }
        if let Some(v) = self.mode {
            cfg.mode = v;
        }
        if let Some(v) = self.heartbeat_interval_s {
            if !(5..=300).contains(&v) {
                return Err(ApiError::validation(
                    "heartbeat_interval_s must be between 5 and 300",
                ));
            }
            cfg.heartbeat_interval_s = v;
        }
        if let Some(v) = self.ice_servers {
            cfg.ice_servers = v;
        }
        if let Some(v) = self.max_fps {
            if !(1..=120).contains(&v) {
                return Err(ApiError::validation("max_fps must be between 1 and 120"));
            }
            cfg.max_fps = v;
        }
        if let Some(v) = self.max_bitrate_kbps {
            if !(200..=100_000).contains(&v) {
                return Err(ApiError::validation(
                    "max_bitrate_kbps must be between 200 and 100000",
                ));
            }
            cfg.max_bitrate_kbps = v;
        }
        if let Some(v) = self.preferred_codec {
            cfg.preferred_codec = v;
        }
        if let Some(v) = self.allow_input {
            cfg.allow_input = v;
        }
        if let Some(v) = self.allow_clipboard {
            cfg.allow_clipboard = v;
        }
        if let Some(v) = self.approval_timeout_s {
            if !(5..=600).contains(&v) {
                return Err(ApiError::validation(
                    "approval_timeout_s must be between 5 and 600",
                ));
            }
            cfg.approval_timeout_s = v;
        }
        if let Some(v) = self.show_session_indicator {
            cfg.show_session_indicator = v;
        }
        if let Some(v) = self.allow_file_transfer {
            cfg.allow_file_transfer = v;
        }
        if let Some(v) = self.transfer_dir {
            let v = v.trim();
            cfg.transfer_dir = if v.is_empty() {
                None
            } else {
                Some(v.to_string())
            };
        }
        if let Some(v) = self.allow_audio {
            cfg.allow_audio = v;
        }
        Ok(cfg)
    }
}

pub async fn update_config(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(id): Path<String>,
    Json(patch): Json<ConfigPatch>,
) -> ApiResult<Json<DeviceDetail>> {
    let row = db::devices::by_id(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("device"))?;
    let new_config = patch.apply(row.config())?;
    db::devices::update_config(&state.db, &id, &new_config).await?;
    db::audit::record(
        &state.db,
        Some(admin.actor()),
        "device.config",
        Some(&id),
        json!({
            "mode": new_config.mode,
            "max_fps": new_config.max_fps,
            "max_bitrate_kbps": new_config.max_bitrate_kbps,
            "allow_file_transfer": new_config.allow_file_transfer,
            "transfer_dir": new_config.transfer_dir,
            "allow_audio": new_config.allow_audio,
        }),
    )
    .await?;
    state.hub.push_config(&id, &new_config).await;
    state.hub.broadcast_device(&id).await;
    Ok(Json(load_detail(&state, &id).await?))
}

pub async fn delete(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let row = db::devices::by_id(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("device"))?;
    if let Some(sid) = state.hub.active_session_id(&id) {
        state
            .hub
            .end_session(&sid, EndReason::Error, Some(admin.actor()))
            .await;
    }
    state.hub.disconnect_device(&id, "device deleted").await;
    db::devices::delete(&state.db, &id).await?;
    db::audit::record(
        &state.db,
        Some(admin.actor()),
        "device.delete",
        Some(&id),
        json!({ "name": row.name, "hostname": row.hostname }),
    )
    .await?;
    state.hub.broadcast_device_removed(&id);
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct SessionsQuery {
    #[serde(default = "default_limit")]
    pub limit: i64,
}

fn default_limit() -> i64 {
    50
}

pub async fn sessions(
    State(state): State<AppState>,
    _user: AuthUser,
    Path(id): Path<String>,
    Query(q): Query<SessionsQuery>,
) -> ApiResult<Json<Vec<SessionSummary>>> {
    if db::devices::by_id(&state.db, &id).await?.is_none() {
        return Err(ApiError::not_found("device"));
    }
    let rows = db::sessions::list(
        &state.db,
        Filter {
            active_only: false,
            device_id: Some(&id),
            limit: q.limit,
        },
    )
    .await?;
    Ok(Json(rows.iter().map(|s| s.summary()).collect()))
}
