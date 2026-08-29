//! Recovery codes, passkeys, short-lived auth ceremony state, SSO links and SSO-managed grants.

use super::models::GroupPermission;
use super::{format_ts, now, Db};
use chrono::{Duration, Utc};
use serde::{de::DeserializeOwned, Serialize};
use sqlx::Result;

// ── recovery codes ────────────────────────────────────────────────────────────

/// Replace all recovery codes of a user with the given hashes.
pub async fn replace_recovery_codes(db: &Db, user_id: &str, hashes: &[String]) -> Result<()> {
    let mut tx = db.begin().await?;
    sqlx::query("DELETE FROM user_recovery_codes WHERE user_id = ?")
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    for h in hashes {
        sqlx::query("INSERT INTO user_recovery_codes (user_id, code_hash) VALUES (?, ?)")
            .bind(user_id)
            .bind(h)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct RecoveryCodeRow {
    pub id: i64,
    pub code_hash: String,
}

/// Unused recovery code hashes of a user.
pub async fn unused_recovery_codes(db: &Db, user_id: &str) -> Result<Vec<RecoveryCodeRow>> {
    sqlx::query_as::<_, RecoveryCodeRow>(
        "SELECT id, code_hash FROM user_recovery_codes WHERE user_id = ? AND used_at IS NULL",
    )
    .bind(user_id)
    .fetch_all(db)
    .await
}

pub async fn mark_recovery_code_used(db: &Db, id: i64) -> Result<()> {
    sqlx::query("UPDATE user_recovery_codes SET used_at = ? WHERE id = ?")
        .bind(now())
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

pub async fn delete_recovery_codes(db: &Db, user_id: &str) -> Result<()> {
    sqlx::query("DELETE FROM user_recovery_codes WHERE user_id = ?")
        .bind(user_id)
        .execute(db)
        .await?;
    Ok(())
}

// ── passkeys ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct PasskeyRow {
    pub id: String,
    pub user_id: String,
    pub name: String,
    pub credential_id: String,
    pub passkey_json: String,
    pub counter: i64,
    pub backup_eligible: bool,
    pub backup_state: bool,
    pub transports: String,
    pub created_at: String,
    pub last_used_at: Option<String>,
}

impl PasskeyRow {
    pub fn public(&self) -> PasskeyPublic {
        PasskeyPublic {
            id: self.id.clone(),
            name: self.name.clone(),
            created_at: self.created_at.clone(),
            last_used_at: self.last_used_at.clone(),
            backup_eligible: self.backup_eligible,
            transports: serde_json::from_str(&self.transports).unwrap_or_default(),
        }
    }
}

/// `Passkey` as defined in API.md.
#[derive(Debug, Clone, Serialize)]
pub struct PasskeyPublic {
    pub id: String,
    pub name: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<String>,
    pub backup_eligible: bool,
    pub transports: Vec<String>,
}

pub struct NewPasskey<'a> {
    pub user_id: &'a str,
    pub name: &'a str,
    pub credential_id: &'a str,
    pub passkey_json: &'a str,
    pub counter: i64,
    pub backup_eligible: bool,
    pub backup_state: bool,
    pub transports: &'a [String],
}

pub async fn insert_passkey(db: &Db, p: NewPasskey<'_>) -> Result<PasskeyRow> {
    let id = crate::ids::passkey_id();
    sqlx::query(
        "INSERT INTO user_passkeys (id, user_id, name, credential_id, passkey_json, counter,
            backup_eligible, backup_state, transports, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(p.user_id)
    .bind(p.name.trim())
    .bind(p.credential_id)
    .bind(p.passkey_json)
    .bind(p.counter)
    .bind(p.backup_eligible)
    .bind(p.backup_state)
    .bind(serde_json::to_string(p.transports).unwrap_or_else(|_| "[]".into()))
    .bind(now())
    .execute(db)
    .await?;
    passkey_by_id(db, &id)
        .await?
        .ok_or(sqlx::Error::RowNotFound)
}

pub async fn passkey_by_id(db: &Db, id: &str) -> Result<Option<PasskeyRow>> {
    sqlx::query_as::<_, PasskeyRow>("SELECT * FROM user_passkeys WHERE id = ?")
        .bind(id)
        .fetch_optional(db)
        .await
}

pub async fn passkey_by_credential(db: &Db, credential_id: &str) -> Result<Option<PasskeyRow>> {
    sqlx::query_as::<_, PasskeyRow>("SELECT * FROM user_passkeys WHERE credential_id = ?")
        .bind(credential_id)
        .fetch_optional(db)
        .await
}

pub async fn passkeys_for_user(db: &Db, user_id: &str) -> Result<Vec<PasskeyRow>> {
    sqlx::query_as::<_, PasskeyRow>(
        "SELECT * FROM user_passkeys WHERE user_id = ? ORDER BY created_at ASC",
    )
    .bind(user_id)
    .fetch_all(db)
    .await
}

/// Persist the updated credential (counter / backup state) after a successful assertion.
pub async fn update_passkey_after_use(
    db: &Db,
    id: &str,
    passkey_json: &str,
    counter: i64,
    backup_state: bool,
) -> Result<()> {
    sqlx::query(
        "UPDATE user_passkeys SET passkey_json = ?, counter = ?, backup_state = ?, last_used_at = ?
         WHERE id = ?",
    )
    .bind(passkey_json)
    .bind(counter)
    .bind(backup_state)
    .bind(now())
    .bind(id)
    .execute(db)
    .await?;
    Ok(())
}

pub async fn rename_passkey(db: &Db, id: &str, name: &str) -> Result<()> {
    sqlx::query("UPDATE user_passkeys SET name = ? WHERE id = ?")
        .bind(name)
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

pub async fn delete_passkey(db: &Db, id: &str) -> Result<bool> {
    let res = sqlx::query("DELETE FROM user_passkeys WHERE id = ?")
        .bind(id)
        .execute(db)
        .await?;
    Ok(res.rows_affected() > 0)
}

pub async fn delete_passkeys_for_user(db: &Db, user_id: &str) -> Result<()> {
    sqlx::query("DELETE FROM user_passkeys WHERE user_id = ?")
        .bind(user_id)
        .execute(db)
        .await?;
    Ok(())
}

// ── auth ceremony state ───────────────────────────────────────────────────────

/// Store a short-lived, JSON-serialisable state under a fresh id.
pub async fn put_state<T: Serialize>(
    db: &Db,
    kind: &str,
    user_id: Option<&str>,
    payload: &T,
    ttl: Duration,
) -> Result<String> {
    let id = crate::ids::auth_state_id();
    put_state_with_id(db, &id, kind, user_id, payload, ttl).await?;
    Ok(id)
}

pub async fn put_state_with_id<T: Serialize>(
    db: &Db,
    id: &str,
    kind: &str,
    user_id: Option<&str>,
    payload: &T,
    ttl: Duration,
) -> Result<()> {
    let json = serde_json::to_string(payload).map_err(|e| sqlx::Error::Encode(Box::new(e)))?;
    sqlx::query(
        "INSERT OR REPLACE INTO auth_states (id, kind, user_id, payload_enc, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(id)
    .bind(kind)
    .bind(user_id)
    .bind(json)
    .bind(now())
    .bind(format_ts(Utc::now() + ttl))
    .execute(db)
    .await?;
    Ok(())
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct StateRow {
    pub id: String,
    pub kind: String,
    pub user_id: Option<String>,
    pub payload_enc: String,
    pub expires_at: String,
}

/// Fetch an unexpired state of the given kind.
pub async fn get_state(db: &Db, id: &str, kind: &str) -> Result<Option<StateRow>> {
    sqlx::query_as::<_, StateRow>(
        "SELECT id, kind, user_id, payload_enc, expires_at FROM auth_states
         WHERE id = ? AND kind = ? AND expires_at > ?",
    )
    .bind(id)
    .bind(kind)
    .bind(now())
    .fetch_optional(db)
    .await
}

pub fn decode_state<T: DeserializeOwned>(row: &StateRow) -> Option<T> {
    serde_json::from_str(&row.payload_enc).ok()
}

/// Overwrite the payload of an existing state (keeps expiry).
pub async fn update_state<T: Serialize>(db: &Db, id: &str, payload: &T) -> Result<()> {
    let json = serde_json::to_string(payload).map_err(|e| sqlx::Error::Encode(Box::new(e)))?;
    sqlx::query("UPDATE auth_states SET payload_enc = ? WHERE id = ?")
        .bind(json)
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

pub async fn delete_state(db: &Db, id: &str) -> Result<()> {
    sqlx::query("DELETE FROM auth_states WHERE id = ?")
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

/// Whether a state id of this kind exists (replay protection for SAML assertion ids).
pub async fn state_exists(db: &Db, id: &str, kind: &str) -> Result<bool> {
    let n: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM auth_states WHERE id = ? AND kind = ? AND expires_at > ?",
    )
    .bind(id)
    .bind(kind)
    .bind(now())
    .fetch_one(db)
    .await?;
    Ok(n > 0)
}

/// Drop every state of one kind belonging to a user (e.g. earlier password-reset tokens
/// when a new one is issued).
pub async fn delete_states_for_user_kind(db: &Db, user_id: &str, kind: &str) -> Result<u64> {
    let res = sqlx::query("DELETE FROM auth_states WHERE user_id = ? AND kind = ?")
        .bind(user_id)
        .bind(kind)
        .execute(db)
        .await?;
    Ok(res.rows_affected())
}

pub async fn purge_expired_states(db: &Db) -> Result<u64> {
    let res = sqlx::query("DELETE FROM auth_states WHERE expires_at <= ?")
        .bind(now())
        .execute(db)
        .await?;
    Ok(res.rows_affected())
}

// ── SSO links ─────────────────────────────────────────────────────────────────

pub async fn link_user(
    db: &Db,
    user_id: &str,
    provider: &str,
    subject: &str,
    email: Option<&str>,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO sso_links (user_id, provider, subject, email, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(provider, subject) DO UPDATE SET user_id = excluded.user_id, email = excluded.email",
    )
    .bind(user_id)
    .bind(provider)
    .bind(subject)
    .bind(email)
    .bind(now())
    .execute(db)
    .await?;
    Ok(())
}

pub async fn user_id_for_link(db: &Db, provider: &str, subject: &str) -> Result<Option<String>> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT user_id FROM sso_links WHERE provider = ? AND subject = ?")
            .bind(provider)
            .bind(subject)
            .fetch_optional(db)
            .await?;
    Ok(row.map(|(id,)| id))
}

// ── SSO-managed grants ────────────────────────────────────────────────────────

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct UserGrantSource {
    pub group_id: String,
    pub permission: String,
    pub source: String,
}

pub async fn grants_with_source(db: &Db, user_id: &str) -> Result<Vec<UserGrantSource>> {
    sqlx::query_as::<_, UserGrantSource>(
        "SELECT group_id, permission, source FROM group_grants WHERE user_id = ?",
    )
    .bind(user_id)
    .fetch_all(db)
    .await
}

/// Insert or upgrade an SSO-managed grant. A manual grant is never downgraded or re-sourced;
/// an existing `view` grant is upgraded to `connect` when the mapping says so.
pub async fn upsert_sso_grant(
    db: &Db,
    user_id: &str,
    group_id: &str,
    permission: GroupPermission,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO group_grants (group_id, user_id, permission, source) VALUES (?, ?, ?, 'sso')
         ON CONFLICT(group_id, user_id) DO UPDATE SET
            permission = CASE
                WHEN group_grants.permission = 'connect' THEN 'connect'
                ELSE excluded.permission END",
    )
    .bind(group_id)
    .bind(user_id)
    .bind(permission.as_str())
    .execute(db)
    .await?;
    Ok(())
}

pub async fn delete_sso_grant(db: &Db, user_id: &str, group_id: &str) -> Result<()> {
    sqlx::query("DELETE FROM group_grants WHERE user_id = ? AND group_id = ? AND source = 'sso'")
        .bind(user_id)
        .bind(group_id)
        .execute(db)
        .await?;
    Ok(())
}
