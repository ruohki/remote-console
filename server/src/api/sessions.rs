//! Session listing and termination.

use crate::app::AppState;
use crate::auth::AuthUser;
use crate::db::{self, sessions::Filter};
use crate::error::{ApiError, ApiResult};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use protocol::common::{EndReason, SessionState};
use protocol::ui::SessionSummary;
use serde::Deserialize;

#[derive(Deserialize)]
pub struct ListQuery {
    #[serde(default)]
    pub active: Option<String>,
    #[serde(default)]
    pub device_id: Option<String>,
    #[serde(default = "default_limit")]
    pub limit: i64,
}

fn default_limit() -> i64 {
    50
}

pub async fn list(
    State(state): State<AppState>,
    _user: AuthUser,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<Vec<SessionSummary>>> {
    let active_only = q
        .active
        .as_deref()
        .is_some_and(|v| v == "1" || v.eq_ignore_ascii_case("true"));
    let rows = db::sessions::list(
        &state.db,
        Filter {
            active_only,
            device_id: q.device_id.as_deref(),
            limit: q.limit,
        },
    )
    .await?;
    Ok(Json(rows.iter().map(|s| s.summary()).collect()))
}

pub async fn end(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let session = db::sessions::by_id(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("session"))?;
    let own = session.operator_id.as_deref() == Some(user.0.id.as_str());
    if !own && !user.0.is_admin() {
        return Err(ApiError::forbidden());
    }
    if session.state() == SessionState::Ended {
        return Err(ApiError::conflict(
            "already_ended",
            "session has already ended",
        ));
    }
    state
        .hub
        .end_session(&id, EndReason::OperatorClosed, Some(user.actor()))
        .await;
    Ok(StatusCode::NO_CONTENT)
}
