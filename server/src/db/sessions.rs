//! Remote (operator ↔ device) sessions.

use super::models::{reason_str, state_str, SessionRow};
use super::{enum_str, now, Db};
use protocol::common::{EndReason, SessionState, VideoCodec};
use sqlx::Result;

const SELECT: &str =
    "SELECT s.id, s.device_id, d.name AS device_name, s.operator_id, u.name AS operator_name,
       s.state, s.started_at, s.connected_at, s.ended_at, s.end_reason, s.codec, s.client_ip
  FROM remote_sessions s
  JOIN devices d ON d.id = s.device_id
  LEFT JOIN users u ON u.id = s.operator_id";

pub async fn insert(
    db: &Db,
    id: &str,
    device_id: &str,
    operator_id: &str,
    state: SessionState,
    client_ip: Option<&str>,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO remote_sessions (id, device_id, operator_id, state, started_at, client_ip)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(device_id)
    .bind(operator_id)
    .bind(state_str(state))
    .bind(now())
    .bind(client_ip)
    .execute(db)
    .await?;
    Ok(())
}

pub async fn by_id(db: &Db, id: &str) -> Result<Option<SessionRow>> {
    sqlx::query_as::<_, SessionRow>(&format!("{SELECT} WHERE s.id = ?"))
        .bind(id)
        .fetch_optional(db)
        .await
}

pub struct Filter<'a> {
    pub active_only: bool,
    pub device_id: Option<&'a str>,
    pub limit: i64,
}

pub async fn list(db: &Db, f: Filter<'_>) -> Result<Vec<SessionRow>> {
    let mut sql = format!("{SELECT} WHERE 1 = 1");
    if f.active_only {
        sql.push_str(" AND s.state <> 'ended'");
    }
    if f.device_id.is_some() {
        sql.push_str(" AND s.device_id = ?");
    }
    sql.push_str(" ORDER BY s.started_at DESC LIMIT ?");
    let mut q = sqlx::query_as::<_, SessionRow>(&sql);
    if let Some(d) = f.device_id {
        q = q.bind(d);
    }
    q.bind(f.limit.clamp(1, 500)).fetch_all(db).await
}

pub async fn set_state(db: &Db, id: &str, state: SessionState) -> Result<()> {
    let connected = if state == SessionState::Connected {
        Some(now())
    } else {
        None
    };
    sqlx::query(
        "UPDATE remote_sessions SET state = ?, connected_at = COALESCE(connected_at, ?)
         WHERE id = ? AND state <> 'ended'",
    )
    .bind(state_str(state))
    .bind(connected)
    .bind(id)
    .execute(db)
    .await?;
    Ok(())
}

pub async fn set_codec(db: &Db, id: &str, codec: VideoCodec) -> Result<()> {
    sqlx::query("UPDATE remote_sessions SET codec = ? WHERE id = ?")
        .bind(enum_str(&codec))
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

/// Mark ended; returns `false` if it was already ended.
pub async fn end(db: &Db, id: &str, reason: EndReason) -> Result<bool> {
    let res = sqlx::query(
        "UPDATE remote_sessions SET state = 'ended', ended_at = ?, end_reason = ?
         WHERE id = ? AND state <> 'ended'",
    )
    .bind(now())
    .bind(reason_str(reason))
    .bind(id)
    .execute(db)
    .await?;
    Ok(res.rows_affected() > 0)
}

/// At startup every non-ended session is stale.
pub async fn end_all_active(db: &Db, reason: EndReason) -> Result<u64> {
    let res = sqlx::query(
        "UPDATE remote_sessions SET state = 'ended', ended_at = ?, end_reason = ?
         WHERE state <> 'ended'",
    )
    .bind(now())
    .bind(reason_str(reason))
    .execute(db)
    .await?;
    Ok(res.rows_affected())
}
