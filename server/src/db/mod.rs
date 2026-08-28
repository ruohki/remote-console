//! Database access. SQLite through sqlx; all SQL is kept portable.

pub mod audit;
pub mod devices;
pub mod groups;
pub mod models;
pub mod session_events;
pub mod sessions;
pub mod tokens;
pub mod users;

use crate::config::Config;
use anyhow::{Context, Result};
use chrono::{DateTime, SecondsFormat, Utc};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
use std::str::FromStr;

pub type Db = sqlx::SqlitePool;

/// Open the pool, enable WAL + foreign keys and run pending migrations.
pub async fn connect(config: &Config) -> Result<Db> {
    if !config.database_url.starts_with("sqlite:") {
        anyhow::bail!("only sqlite DATABASE_URLs are supported in this release");
    }
    if let Some(path) = config.sqlite_path() {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)
                    .with_context(|| format!("creating {}", parent.display()))?;
            }
        }
    }
    let opts = SqliteConnectOptions::from_str(&config.database_url)
        .context("parsing DATABASE_URL")?
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .foreign_keys(true)
        .busy_timeout(std::time::Duration::from_secs(5));
    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(opts)
        .await
        .context("opening database")?;
    migrate(&pool).await?;
    Ok(pool)
}

pub async fn migrate(db: &Db) -> Result<()> {
    sqlx::migrate!("./migrations")
        .run(db)
        .await
        .context("running migrations")?;
    Ok(())
}

/// Current time as ISO-8601 UTC with millisecond precision.
pub fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn format_ts(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn parse_ts(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|d| d.with_timezone(&Utc))
}

/// Serialize a serde enum with string representation to its wire name (e.g. `help_me`).
pub fn enum_str<T: serde::Serialize>(value: &T) -> String {
    match serde_json::to_value(value) {
        Ok(serde_json::Value::String(s)) => s,
        Ok(other) => other.to_string(),
        Err(_) => String::new(),
    }
}

/// Inverse of [`enum_str`].
pub fn enum_parse<T: serde::de::DeserializeOwned>(s: &str) -> Option<T> {
    serde_json::from_value(serde_json::Value::String(s.to_string())).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::common::DeviceMode;

    #[test]
    fn enum_roundtrip() {
        assert_eq!(enum_str(&DeviceMode::HelpMe), "help_me");
        assert_eq!(
            enum_parse::<DeviceMode>("unattended"),
            Some(DeviceMode::Unattended)
        );
        assert_eq!(enum_parse::<DeviceMode>("nope"), None);
    }

    #[test]
    fn timestamps_roundtrip() {
        let s = now();
        assert!(parse_ts(&s).is_some());
    }
}
