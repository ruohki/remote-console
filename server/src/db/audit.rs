//! Audit log.

use super::models::AuditRow;
use super::{now, Db};
use sqlx::Result;

/// Who performed an action (`None` for agents / anonymous).
#[derive(Debug, Clone, Copy)]
pub struct Actor<'a> {
    pub id: &'a str,
    pub name: &'a str,
}

pub async fn record(
    db: &Db,
    actor: Option<Actor<'_>>,
    action: &str,
    target: Option<&str>,
    details: serde_json::Value,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO audit_log (ts, user_id, user_name, action, target, details)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(now())
    .bind(actor.map(|a| a.id))
    .bind(actor.map(|a| a.name))
    .bind(action)
    .bind(target)
    .bind(details.to_string())
    .execute(db)
    .await?;
    Ok(())
}

/// Best-effort variant used from hot paths: logs instead of failing.
pub async fn record_lossy(
    db: &Db,
    actor: Option<Actor<'_>>,
    action: &str,
    target: Option<&str>,
    details: serde_json::Value,
) {
    if let Err(err) = record(db, actor, action, target, details).await {
        tracing::warn!("audit write failed for {action}: {err}");
    }
}

pub async fn list(db: &Db, limit: i64, before: Option<i64>) -> Result<Vec<AuditRow>> {
    let limit = limit.clamp(1, 1000);
    match before {
        Some(b) => {
            sqlx::query_as::<_, AuditRow>(
                "SELECT * FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT ?",
            )
            .bind(b)
            .bind(limit)
            .fetch_all(db)
            .await
        }
        None => {
            sqlx::query_as::<_, AuditRow>("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?")
                .bind(limit)
                .fetch_all(db)
                .await
        }
    }
}
