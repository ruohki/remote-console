//! Enrollment tokens.

use super::models::EnrollTokenRow;
use super::{enum_str, now, Db};
use protocol::common::DeviceMode;
use sqlx::Result;

pub struct NewToken<'a> {
    pub label: &'a str,
    pub token_hash: &'a str,
    pub token_prefix: &'a str,
    pub created_by: &'a str,
    pub expires_at: Option<String>,
    pub max_uses: Option<i64>,
    pub default_mode: DeviceMode,
    pub default_tags: &'a [String],
}

pub async fn create(db: &Db, t: NewToken<'_>) -> Result<EnrollTokenRow> {
    let id = crate::ids::enroll_token_id();
    sqlx::query(
        "INSERT INTO enroll_tokens
            (id, label, token_hash, token_prefix, created_by, created_at, expires_at, max_uses, uses, revoked, default_mode, default_tags)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)",
    )
    .bind(&id)
    .bind(t.label.trim())
    .bind(t.token_hash)
    .bind(t.token_prefix)
    .bind(t.created_by)
    .bind(now())
    .bind(t.expires_at)
    .bind(t.max_uses)
    .bind(enum_str(&t.default_mode))
    .bind(serde_json::to_string(t.default_tags).unwrap_or_else(|_| "[]".into()))
    .execute(db)
    .await?;
    by_id(db, &id).await?.ok_or(sqlx::Error::RowNotFound)
}

pub async fn by_id(db: &Db, id: &str) -> Result<Option<EnrollTokenRow>> {
    sqlx::query_as::<_, EnrollTokenRow>("SELECT * FROM enroll_tokens WHERE id = ?")
        .bind(id)
        .fetch_optional(db)
        .await
}

pub async fn by_hash(db: &Db, token_hash: &str) -> Result<Option<EnrollTokenRow>> {
    sqlx::query_as::<_, EnrollTokenRow>("SELECT * FROM enroll_tokens WHERE token_hash = ?")
        .bind(token_hash)
        .fetch_optional(db)
        .await
}

pub async fn list(db: &Db) -> Result<Vec<EnrollTokenRow>> {
    sqlx::query_as::<_, EnrollTokenRow>("SELECT * FROM enroll_tokens ORDER BY created_at DESC")
        .fetch_all(db)
        .await
}

pub async fn revoke(db: &Db, id: &str) -> Result<bool> {
    let res = sqlx::query("UPDATE enroll_tokens SET revoked = 1 WHERE id = ?")
        .bind(id)
        .execute(db)
        .await?;
    Ok(res.rows_affected() > 0)
}

/// Atomically consume one use. Returns `false` when the token is exhausted/revoked/expired.
pub async fn consume(db: &Db, id: &str) -> Result<bool> {
    let res = sqlx::query(
        "UPDATE enroll_tokens SET uses = uses + 1
         WHERE id = ? AND revoked = 0
           AND (max_uses IS NULL OR uses < max_uses)
           AND (expires_at IS NULL OR expires_at > ?)",
    )
    .bind(id)
    .bind(now())
    .execute(db)
    .await?;
    Ok(res.rows_affected() > 0)
}

pub async fn label(db: &Db, id: &str) -> Result<Option<String>> {
    sqlx::query_scalar("SELECT label FROM enroll_tokens WHERE id = ?")
        .bind(id)
        .fetch_optional(db)
        .await
}
