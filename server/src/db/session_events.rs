//! In-session activity reported by agents (`protocol::agent::SessionEvent`).

use super::models::SessionEventRow;
use super::{now, Db};
use protocol::agent::SessionEvent;
use sqlx::Result;

/// Stored events per session are capped here; later ones are dropped by the hub.
pub const MAX_EVENTS_PER_SESSION: i64 = 5000;

/// Insert one event; returns its id and the console timestamp, or `Ok(None)` when the
/// per-session cap is reached.
pub async fn insert(
    db: &Db,
    session_id: &str,
    event: &SessionEvent,
) -> Result<Option<(i64, String)>> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM session_events WHERE session_id = ?")
        .bind(session_id)
        .fetch_one(db)
        .await?;
    if count >= MAX_EVENTS_PER_SESSION {
        return Ok(None);
    }
    let ts = now();
    let json = serde_json::to_string(event).unwrap_or_else(|_| "{}".into());
    let res = sqlx::query("INSERT INTO session_events (session_id, ts, event) VALUES (?, ?, ?)")
        .bind(session_id)
        .bind(&ts)
        .bind(json)
        .execute(db)
        .await?;
    Ok(Some((res.last_insert_rowid(), ts)))
}

/// Events of a session, oldest first, optionally only those with `id > after`.
pub async fn list(
    db: &Db,
    session_id: &str,
    limit: i64,
    after: Option<i64>,
) -> Result<Vec<SessionEventRow>> {
    let limit = limit.clamp(1, MAX_EVENTS_PER_SESSION);
    sqlx::query_as::<_, SessionEventRow>(
        "SELECT id, session_id, ts, event FROM session_events
         WHERE session_id = ? AND id > ? ORDER BY id ASC LIMIT ?",
    )
    .bind(session_id)
    .bind(after.unwrap_or(0))
    .bind(limit)
    .fetch_all(db)
    .await
}
