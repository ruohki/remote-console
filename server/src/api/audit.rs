//! Audit log (admin only).

use crate::app::AppState;
use crate::auth::AdminUser;
use crate::db::{self, models::AuditEntry};
use crate::error::ApiResult;
use axum::extract::{Query, State};
use axum::Json;
use serde::Deserialize;

#[derive(Deserialize)]
pub struct AuditQuery {
    #[serde(default = "default_limit")]
    pub limit: i64,
    #[serde(default)]
    pub before: Option<i64>,
}

fn default_limit() -> i64 {
    100
}

pub async fn list(
    State(state): State<AppState>,
    _admin: AdminUser,
    Query(q): Query<AuditQuery>,
) -> ApiResult<Json<Vec<AuditEntry>>> {
    let rows = db::audit::list(&state.db, q.limit, q.before).await?;
    Ok(Json(rows.iter().map(|r| r.public()).collect()))
}
