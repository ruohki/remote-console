//! Enrollment tokens (admin only).

use crate::app::AppState;
use crate::auth::AdminUser;
use crate::db::{self, models::EnrollTokenPublic, tokens::NewToken};
use crate::error::{ApiError, ApiResult};
use crate::ids;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use protocol::common::DeviceMode;
use serde::{Deserialize, Serialize};
use serde_json::json;

pub async fn list(
    State(state): State<AppState>,
    _admin: AdminUser,
) -> ApiResult<Json<Vec<EnrollTokenPublic>>> {
    let rows = db::tokens::list(&state.db).await?;
    Ok(Json(rows.iter().map(|t| t.public()).collect()))
}

#[derive(Deserialize)]
pub struct CreateBody {
    pub label: String,
    #[serde(default)]
    pub expires_in_hours: Option<i64>,
    #[serde(default)]
    pub max_uses: Option<i64>,
    #[serde(default)]
    pub default_mode: DeviceMode,
    #[serde(default)]
    pub default_tags: Vec<String>,
}

#[derive(Serialize)]
pub struct InstallCommands {
    pub macos: String,
    pub windows: String,
}

#[derive(Serialize)]
pub struct CreatedToken {
    #[serde(flatten)]
    pub token_info: EnrollTokenPublic,
    /// Plain token — returned exactly once.
    pub token: String,
    pub install: InstallCommands,
}

pub async fn create(
    State(state): State<AppState>,
    admin: AdminUser,
    Json(body): Json<CreateBody>,
) -> ApiResult<(StatusCode, Json<CreatedToken>)> {
    if body.label.trim().is_empty() {
        return Err(ApiError::validation("label is required"));
    }
    if body.expires_in_hours.is_some_and(|h| h <= 0) {
        return Err(ApiError::validation("expires_in_hours must be positive"));
    }
    if body.max_uses.is_some_and(|m| m <= 0) {
        return Err(ApiError::validation("max_uses must be positive"));
    }
    let tags: Vec<String> = body
        .default_tags
        .iter()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .collect();

    let token = ids::secret();
    let token_hash = ids::sha256_hex(&token);
    let expires_at = body
        .expires_in_hours
        .map(|h| db::format_ts(chrono::Utc::now() + chrono::Duration::hours(h)));

    let row = db::tokens::create(
        &state.db,
        NewToken {
            label: &body.label,
            token_hash: &token_hash,
            token_prefix: &token[..8],
            created_by: &admin.0.id,
            expires_at,
            max_uses: body.max_uses,
            default_mode: body.default_mode,
            default_tags: &tags,
        },
    )
    .await?;
    db::audit::record(
        &state.db,
        Some(admin.actor()),
        "token.create",
        Some(&row.id),
        json!({ "label": row.label, "max_uses": row.max_uses, "expires_at": row.expires_at }),
    )
    .await?;

    let (macos, windows) = crate::install::one_liners(&state.config.public_url, &token);
    Ok((
        StatusCode::CREATED,
        Json(CreatedToken {
            token_info: row.public(),
            token,
            install: InstallCommands { macos, windows },
        }),
    ))
}

pub async fn revoke(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    if !db::tokens::revoke(&state.db, &id).await? {
        return Err(ApiError::not_found("token"));
    }
    db::audit::record(
        &state.db,
        Some(admin.actor()),
        "token.revoke",
        Some(&id),
        json!({}),
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}
