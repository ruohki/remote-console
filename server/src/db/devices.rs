//! Devices.

use super::models::DeviceRow;
use super::{enum_str, now, Db};
use protocol::common::{Arch, DisplayInfo, Os, VideoCodec};
use protocol::config::AgentConfig;
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
}

fn json<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "null".into())
}

pub async fn insert(db: &Db, d: NewDevice<'_>) -> Result<DeviceRow> {
    sqlx::query(
        "INSERT INTO devices
            (id, name, hostname, os, arch, agent_version, secret_hash, config, tags, notes,
             online, last_seen_at, last_ip, logged_in_user, codecs, displays, enrolled_with, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', 0, NULL, NULL, NULL, '[]', '[]', ?, ?)",
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
    .execute(db)
    .await?;
    by_id(db, d.id).await?.ok_or(sqlx::Error::RowNotFound)
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
}

/// Called on `hello`: refresh everything the agent reports and mark it online.
pub async fn mark_online(db: &Db, id: &str, p: Presence<'_>) -> Result<()> {
    sqlx::query(
        "UPDATE devices SET
            hostname = ?, os = ?, arch = ?, agent_version = ?, codecs = ?, displays = ?,
            logged_in_user = ?, last_ip = ?, online = 1, last_seen_at = ?
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
    .bind(id)
    .execute(db)
    .await?;
    Ok(())
}

pub async fn heartbeat(
    db: &Db,
    id: &str,
    logged_in_user: Option<&str>,
    displays: Option<&[DisplayInfo]>,
) -> Result<()> {
    sqlx::query(
        "UPDATE devices SET
            last_seen_at = ?, online = 1,
            logged_in_user = COALESCE(?, logged_in_user),
            displays = COALESCE(?, displays)
         WHERE id = ?",
    )
    .bind(now())
    .bind(logged_in_user)
    .bind(displays.map(|d| json(&d)))
    .bind(id)
    .execute(db)
    .await?;
    Ok(())
}

pub async fn mark_offline(db: &Db, id: &str) -> Result<()> {
    sqlx::query("UPDATE devices SET online = 0, last_seen_at = ? WHERE id = ?")
        .bind(now())
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

/// At startup no agent can be connected.
pub async fn mark_all_offline(db: &Db) -> Result<()> {
    sqlx::query("UPDATE devices SET online = 0 WHERE online = 1")
        .execute(db)
        .await?;
    Ok(())
}
