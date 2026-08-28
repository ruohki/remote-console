//! Users and login sessions.

use super::models::{Role, UserRow};
use super::{format_ts, now, Db};
use chrono::{Duration, Utc};
use sqlx::Result;

pub async fn count(db: &Db) -> Result<i64> {
    sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(db)
        .await
}

pub async fn count_active_admins(db: &Db) -> Result<i64> {
    sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE role = 'admin' AND disabled = 0")
        .fetch_one(db)
        .await
}

pub async fn create(
    db: &Db,
    email: &str,
    name: &str,
    password_hash: &str,
    role: Role,
) -> Result<UserRow> {
    let id = crate::ids::user_id();
    sqlx::query(
        "INSERT INTO users (id, email, name, password_hash, role, disabled, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?)",
    )
    .bind(&id)
    .bind(email.trim().to_lowercase())
    .bind(name.trim())
    .bind(password_hash)
    .bind(role.as_str())
    .bind(now())
    .execute(db)
    .await?;
    by_id(db, &id).await?.ok_or(sqlx::Error::RowNotFound)
}

pub async fn by_id(db: &Db, id: &str) -> Result<Option<UserRow>> {
    sqlx::query_as::<_, UserRow>("SELECT * FROM users WHERE id = ?")
        .bind(id)
        .fetch_optional(db)
        .await
}

pub async fn by_email(db: &Db, email: &str) -> Result<Option<UserRow>> {
    sqlx::query_as::<_, UserRow>("SELECT * FROM users WHERE email = ? COLLATE NOCASE")
        .bind(email.trim().to_lowercase())
        .fetch_optional(db)
        .await
}

pub async fn list(db: &Db) -> Result<Vec<UserRow>> {
    sqlx::query_as::<_, UserRow>("SELECT * FROM users ORDER BY created_at ASC")
        .fetch_all(db)
        .await
}

pub struct UserUpdate<'a> {
    pub name: Option<&'a str>,
    pub role: Option<Role>,
    pub password_hash: Option<&'a str>,
    pub disabled: Option<bool>,
}

pub async fn update(db: &Db, id: &str, u: UserUpdate<'_>) -> Result<Option<UserRow>> {
    sqlx::query(
        "UPDATE users SET
            name = COALESCE(?, name),
            role = COALESCE(?, role),
            password_hash = COALESCE(?, password_hash),
            disabled = COALESCE(?, disabled)
         WHERE id = ?",
    )
    .bind(u.name.map(str::trim))
    .bind(u.role.map(Role::as_str))
    .bind(u.password_hash)
    .bind(u.disabled)
    .bind(id)
    .execute(db)
    .await?;
    by_id(db, id).await
}

pub async fn delete(db: &Db, id: &str) -> Result<bool> {
    let res = sqlx::query("DELETE FROM users WHERE id = ?")
        .bind(id)
        .execute(db)
        .await?;
    Ok(res.rows_affected() > 0)
}

pub async fn set_last_login(db: &Db, id: &str) -> Result<()> {
    sqlx::query("UPDATE users SET last_login_at = ? WHERE id = ?")
        .bind(now())
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

// ── login sessions ────────────────────────────────────────────────────────────

pub async fn create_login_session(db: &Db, user_id: &str, ttl_hours: i64) -> Result<String> {
    let id = crate::ids::login_session_id();
    let expires = Utc::now() + Duration::hours(ttl_hours);
    sqlx::query(
        "INSERT INTO user_sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(user_id)
    .bind(now())
    .bind(format_ts(expires))
    .execute(db)
    .await?;
    Ok(id)
}

/// Resolve a cookie value to its (enabled, unexpired, not idle) user and refresh the
/// session's activity timestamp (at most every few minutes to keep writes low).
pub async fn user_by_login_session(db: &Db, session_id: &str) -> Result<Option<UserRow>> {
    let now_ts = Utc::now();
    let idle_cutoff = format_ts(now_ts - Duration::hours(crate::config::SESSION_IDLE_HOURS));
    let user = sqlx::query_as::<_, UserRow>(
        "SELECT u.* FROM users u
         JOIN user_sessions s ON s.user_id = u.id
         WHERE s.id = ? AND s.expires_at > ? AND u.disabled = 0
           AND COALESCE(s.last_seen_at, s.created_at) > ?",
    )
    .bind(session_id)
    .bind(format_ts(now_ts))
    .bind(&idle_cutoff)
    .fetch_optional(db)
    .await?;
    if user.is_some() {
        let refresh_cutoff = format_ts(now_ts - Duration::minutes(5));
        sqlx::query(
            "UPDATE user_sessions SET last_seen_at = ?
             WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)",
        )
        .bind(format_ts(now_ts))
        .bind(session_id)
        .bind(&refresh_cutoff)
        .execute(db)
        .await?;
    }
    Ok(user)
}

/// Mark a session idle-expired (tests / admin tooling).
pub async fn touch_login_session(
    db: &Db,
    session_id: &str,
    last_seen: chrono::DateTime<Utc>,
) -> Result<()> {
    sqlx::query("UPDATE user_sessions SET last_seen_at = ? WHERE id = ?")
        .bind(format_ts(last_seen))
        .bind(session_id)
        .execute(db)
        .await?;
    Ok(())
}

pub async fn delete_login_session(db: &Db, session_id: &str) -> Result<()> {
    sqlx::query("DELETE FROM user_sessions WHERE id = ?")
        .bind(session_id)
        .execute(db)
        .await?;
    Ok(())
}

/// Log the user out everywhere (used when disabling / deleting accounts).
pub async fn delete_login_sessions_for_user(db: &Db, user_id: &str) -> Result<()> {
    sqlx::query("DELETE FROM user_sessions WHERE user_id = ?")
        .bind(user_id)
        .execute(db)
        .await?;
    Ok(())
}

pub async fn purge_expired_login_sessions(db: &Db) -> Result<u64> {
    let res = sqlx::query("DELETE FROM user_sessions WHERE expires_at <= ?")
        .bind(now())
        .execute(db)
        .await?;
    Ok(res.rows_affected())
}
