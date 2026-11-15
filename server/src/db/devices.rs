//! Devices.

use super::models::DeviceRow;
use super::{enum_str, now, Db};
use protocol::agent::AgentCapabilities;
use protocol::common::{Arch, DesktopState, DisplayInfo, Os, PrivacyScreenSupport, VideoCodec};
use protocol::config::{AgentConfig, LocalOverrides};
use sqlx::Result;

pub struct NewDevice<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub hostname: &'a str,
    pub os: Os,
    pub arch: Arch,
    pub agent_version: &'a str,
    pub secret_hash: &'a str,
    pub config: &'a AgentConfig,
    pub tags: &'a [String],
    pub enrolled_with: Option<&'a str>,
    pub machine_id: Option<&'a str>,
}

fn json<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "null".into())
}

pub async fn insert(db: &Db, d: NewDevice<'_>) -> Result<DeviceRow> {
    sqlx::query(
        "INSERT INTO devices
            (id, name, hostname, os, arch, agent_version, secret_hash, config, tags, notes,
             online, last_seen_at, last_ip, logged_in_user, codecs, displays, enrolled_with, created_at,
             machine_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', 0, NULL, NULL, NULL, '[]', '[]', ?, ?, ?)",
    )
    .bind(d.id)
    .bind(d.name)
    .bind(d.hostname)
    .bind(enum_str(&d.os))
    .bind(enum_str(&d.arch))
    .bind(d.agent_version)
    .bind(d.secret_hash)
    .bind(json(d.config))
    .bind(json(&d.tags))
    .bind(d.enrolled_with)
    .bind(now())
    .bind(d.machine_id)
    .execute(db)
    .await?;
    by_id(db, d.id).await?.ok_or(sqlx::Error::RowNotFound)
}

/// The device a re-enrolling machine already is: same hardware id and OS, most recently seen
/// first (older consoles may hold duplicates from before machine ids were recorded).
pub async fn by_machine_id(db: &Db, machine_id: &str, os: Os) -> Result<Option<DeviceRow>> {
    sqlx::query_as::<_, DeviceRow>(
        "SELECT * FROM devices WHERE machine_id = ? AND os = ?
         ORDER BY COALESCE(last_seen_at, created_at) DESC LIMIT 1",
    )
    .bind(machine_id)
    .bind(enum_str(&os))
    .fetch_optional(db)
    .await
}

/// What a re-enrollment replaces on an existing device row; everything operators set (name,
/// tags, notes, config, groups) and the session history stay.
pub struct ReEnrollment<'a> {
    pub hostname: &'a str,
    pub arch: Arch,
    pub agent_version: &'a str,
    pub secret_hash: &'a str,
    pub enrolled_with: Option<&'a str>,
    pub machine_id: &'a str,
}

pub async fn reenroll(db: &Db, id: &str, r: ReEnrollment<'_>) -> Result<Option<DeviceRow>> {
    sqlx::query(
        "UPDATE devices SET
            hostname = ?, arch = ?, agent_version = ?, secret_hash = ?, enrolled_with = ?,
            machine_id = ?
         WHERE id = ?",
    )
    .bind(r.hostname)
    .bind(enum_str(&r.arch))
    .bind(r.agent_version)
    .bind(r.secret_hash)
    .bind(r.enrolled_with)
    .bind(r.machine_id)
    .bind(id)
    .execute(db)
    .await?;
    by_id(db, id).await
}

/// Replace a device secret hash, but only if it is still `old` (a concurrent re-enrollment
/// wins). Used to move legacy argon2 hashes to the cheap SHA-256 scheme.
pub async fn replace_secret_hash(db: &Db, id: &str, old: &str, new: &str) -> Result<bool> {
    let res = sqlx::query("UPDATE devices SET secret_hash = ? WHERE id = ? AND secret_hash = ?")
        .bind(new)
        .bind(id)
        .bind(old)
        .execute(db)
        .await?;
    Ok(res.rows_affected() > 0)
}

pub async fn by_id(db: &Db, id: &str) -> Result<Option<DeviceRow>> {
    sqlx::query_as::<_, DeviceRow>("SELECT * FROM devices WHERE id = ?")
        .bind(id)
        .fetch_optional(db)
        .await
}

pub async fn list(db: &Db) -> Result<Vec<DeviceRow>> {
    sqlx::query_as::<_, DeviceRow>("SELECT * FROM devices ORDER BY name COLLATE NOCASE ASC")
        .fetch_all(db)
        .await
}

pub async fn update_meta(
    db: &Db,
    id: &str,
    name: Option<&str>,
    tags: Option<&[String]>,
    notes: Option<&str>,
) -> Result<Option<DeviceRow>> {
    sqlx::query(
        "UPDATE devices SET
            name = COALESCE(?, name),
            tags = COALESCE(?, tags),
            notes = COALESCE(?, notes)
         WHERE id = ?",
    )
    .bind(name.map(str::trim))
    .bind(tags.map(|t| json(&t)))
    .bind(notes)
    .bind(id)
    .execute(db)
    .await?;
    by_id(db, id).await
}

pub async fn update_config(db: &Db, id: &str, config: &AgentConfig) -> Result<Option<DeviceRow>> {
    sqlx::query("UPDATE devices SET config = ? WHERE id = ?")
        .bind(json(config))
        .bind(id)
        .execute(db)
        .await?;
    by_id(db, id).await
}

pub async fn delete(db: &Db, id: &str) -> Result<bool> {
    let res = sqlx::query("DELETE FROM devices WHERE id = ?")
        .bind(id)
        .execute(db)
        .await?;
    Ok(res.rows_affected() > 0)
}

pub struct Presence<'a> {
    pub hostname: &'a str,
    pub os: Os,
    pub arch: Arch,
    pub agent_version: &'a str,
    pub codecs: &'a [VideoCodec],
    pub displays: &'a [DisplayInfo],
    pub logged_in_user: Option<&'a str>,
    pub ip: &'a str,
    pub local_overrides: &'a LocalOverrides,
    pub privacy_screen: PrivacyScreenSupport,
    /// Protocol 2+; `None` keeps the stored value.
    pub machine_id: Option<&'a str>,
    pub desktop: DesktopState,
}

/// Called on `hello`: refresh everything the agent reports and mark it online.
pub async fn mark_online(db: &Db, id: &str, p: Presence<'_>) -> Result<()> {
    sqlx::query(
        "UPDATE devices SET
            hostname = ?, os = ?, arch = ?, agent_version = ?, codecs = ?, displays = ?,
            logged_in_user = ?, last_ip = ?, online = 1, last_seen_at = ?, local_overrides = ?,
            privacy_screen = ?, machine_id = COALESCE(?, machine_id), desktop = ?
         WHERE id = ?",
    )
    .bind(p.hostname)
    .bind(enum_str(&p.os))
    .bind(enum_str(&p.arch))
    .bind(p.agent_version)
    .bind(json(&p.codecs))
    .bind(json(&p.displays))
    .bind(p.logged_in_user)
    .bind(p.ip)
    .bind(now())
    .bind(json(p.local_overrides))
    .bind(enum_str(&p.privacy_screen))
    .bind(p.machine_id)
    .bind(enum_str(&p.desktop))
    .bind(id)
    .execute(db)
    .await?;
    Ok(())
}

/// What a heartbeat may carry; every `None` keeps the stored value.
#[derive(Default)]
pub struct HeartbeatUpdate<'a> {
    pub logged_in_user: Option<&'a str>,
    pub displays: Option<&'a [DisplayInfo]>,
    pub local_overrides: Option<&'a LocalOverrides>,
    pub desktop: Option<DesktopState>,
    /// Re-reported capabilities (protocol 2+): codecs, displays and privacy screen support.
    pub capabilities: Option<&'a AgentCapabilities>,
}

pub async fn heartbeat(db: &Db, id: &str, h: HeartbeatUpdate<'_>) -> Result<()> {
    // Capabilities carry the full display list; a separate `displays` in the same heartbeat
    // is the more specific report and wins.
    let displays = h.displays.or(h.capabilities.map(|c| c.displays.as_slice()));
    sqlx::query(
        "UPDATE devices SET
            last_seen_at = ?, online = 1,
            logged_in_user = COALESCE(?, logged_in_user),
            displays = COALESCE(?, displays),
            local_overrides = COALESCE(?, local_overrides),
            desktop = COALESCE(?, desktop),
            codecs = COALESCE(?, codecs),
            privacy_screen = COALESCE(?, privacy_screen)
         WHERE id = ?",
    )
    .bind(now())
    .bind(h.logged_in_user)
    .bind(displays.map(|d| json(&d)))
    .bind(h.local_overrides.map(json))
    .bind(h.desktop.map(|d| enum_str(&d)))
    .bind(h.capabilities.map(|c| json(&c.codecs)))
    .bind(h.capabilities.map(|c| enum_str(&c.privacy_screen)))
    .bind(id)
    .execute(db)
    .await?;
    Ok(())
}

pub async fn mark_offline(db: &Db, id: &str) -> Result<()> {
    sqlx::query(
        "UPDATE devices SET online = 0, last_seen_at = ?, desktop = 'unknown' WHERE id = ?",
    )
    .bind(now())
    .bind(id)
    .execute(db)
    .await?;
    Ok(())
}

/// At startup no agent can be connected.
pub async fn mark_all_offline(db: &Db) -> Result<()> {
    sqlx::query("UPDATE devices SET online = 0, desktop = 'unknown' WHERE online = 1")
        .execute(db)
        .await?;
    Ok(())
}
