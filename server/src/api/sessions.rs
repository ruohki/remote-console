//! Session listing and termination.

use crate::app::AppState;
use crate::auth::access;
use crate::auth::AuthUser;
use crate::db::models::SessionEventEntry;
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
    /// Only sessions started strictly before this ISO-8601 timestamp (pagination cursor).
    #[serde(default)]
    pub before: Option<String>,
}

fn default_limit() -> i64 {
    50
}

pub async fn list(
    State(state): State<AppState>,
    user: AuthUser,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<Vec<SessionSummary>>> {
    let active_only = q
        .active
        .as_deref()
        .is_some_and(|v| v == "1" || v.eq_ignore_ascii_case("true"));
    let access = access::for_user(&state, &user.0).await?;
    if let Some(d) = q.device_id.as_deref() {
        access::require_visible(&access, d)?;
    }
    let visible: Option<Vec<String>> = access
        .visible_device_ids()
        .map(|set| set.into_iter().collect());
    let rows = db::sessions::list(
        &state.db,
        Filter {
            active_only,
            device_id: q.device_id.as_deref(),
            device_ids: visible.as_deref(),
            limit: q.limit.clamp(1, 200),
            before: q.before.as_deref(),
        },
    )
    .await?;
    Ok(Json(rows.iter().map(|s| s.summary()).collect()))
}

#[derive(Deserialize)]
pub struct EventsQuery {
    #[serde(default = "default_events_limit")]
    pub limit: i64,
    #[serde(default)]
    pub after: Option<i64>,
}

fn default_events_limit() -> i64 {
    500
}

/// `GET /api/sessions/:id/events` — oldest first; `after` continues a previous page.
pub async fn events(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    Query(q): Query<EventsQuery>,
) -> ApiResult<Json<Vec<SessionEventEntry>>> {
    let session = db::sessions::by_id(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("session"))?;
    let access = access::for_user(&state, &user.0).await?;
    if !access.can_see(&session.device_id) {
        return Err(ApiError::not_found("session"));
    }
    let rows = db::session_events::list(&state.db, &id, q.limit, q.after).await?;
    Ok(Json(rows.iter().filter_map(|r| r.public()).collect()))
}

pub async fn end(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let session = db::sessions::by_id(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("session"))?;
    let access = access::for_user(&state, &user.0).await?;
    if !access.can_see(&session.device_id) {
        return Err(ApiError::not_found("session"));
    }
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
