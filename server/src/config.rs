//! Environment based configuration.

use anyhow::{Context, Result};
use std::path::PathBuf;

/// Runtime configuration, read from environment variables (and `.env` via `dotenvy`).
#[derive(Debug, Clone)]
pub struct Config {
    /// Public base URL used by agents and install scripts, without trailing slash.
    pub public_url: String,
    /// sqlx connection string. Only SQLite is supported in this release.
    pub database_url: String,
    /// Socket address of the HTTP / WebSocket listener.
    pub listen_addr: String,
    /// TURN URLs handed to peers (empty when no TURN server is configured).
    pub turn_urls: Vec<String>,
    /// coturn `static-auth-secret`; enables short-lived TURN credentials.
    pub turn_secret: Option<String>,
    /// STUN URLs, always included in ICE server lists.
    pub stun_urls: Vec<String>,
    /// Base URL the install scripts download agent binaries from (no trailing slash).
    pub agent_download_base: String,
    /// Lifetime of a login session.
    pub session_ttl_hours: i64,
}

pub const DEFAULT_PUBLIC_URL: &str = "http://localhost:8080";
pub const DEFAULT_DATABASE_URL: &str = "sqlite://data/console.db?mode=rwc";
pub const DEFAULT_LISTEN_ADDR: &str = "0.0.0.0:8080";
pub const DEFAULT_STUN_URLS: &str = "stun:stun.l.google.com:19302";
pub const DEFAULT_AGENT_DOWNLOAD_BASE: &str =
    "https://github.com/ruohki/remote-agent/releases/latest/download";
pub const DEFAULT_SESSION_TTL_HOURS: i64 = 168;

impl Config {
    /// Read configuration from the process environment.
    pub fn from_env() -> Result<Self> {
        let public_url = env_or("CONSOLE_PUBLIC_URL", DEFAULT_PUBLIC_URL);
        let public_url = public_url.trim_end_matches('/').to_string();
        url::Url::parse(&public_url).context("CONSOLE_PUBLIC_URL is not a valid URL")?;

        let session_ttl_hours = match std::env::var("SESSION_TTL_HOURS") {
            Ok(v) if !v.trim().is_empty() => v
                .trim()
                .parse::<i64>()
                .context("SESSION_TTL_HOURS must be an integer")?,
            _ => DEFAULT_SESSION_TTL_HOURS,
        };

        Ok(Self {
            public_url,
            database_url: env_or("DATABASE_URL", DEFAULT_DATABASE_URL),
            listen_addr: env_or("LISTEN_ADDR", DEFAULT_LISTEN_ADDR),
            turn_urls: split_list(&env_or("TURN_URLS", "")),
            turn_secret: std::env::var("TURN_SECRET")
                .ok()
                .filter(|s| !s.trim().is_empty()),
            stun_urls: split_list(&env_or("STUN_URLS", DEFAULT_STUN_URLS)),
            agent_download_base: env_or("AGENT_DOWNLOAD_BASE", DEFAULT_AGENT_DOWNLOAD_BASE)
                .trim_end_matches('/')
                .to_string(),
            session_ttl_hours: session_ttl_hours.max(1),
        })
    }

    /// Configuration suitable for tests: in-memory-like temp database, no TURN.
    pub fn for_tests(database_url: String) -> Self {
        Self {
            public_url: DEFAULT_PUBLIC_URL.to_string(),
            database_url,
            listen_addr: "127.0.0.1:0".to_string(),
            turn_urls: vec![],
            turn_secret: None,
            stun_urls: split_list(DEFAULT_STUN_URLS),
            agent_download_base: DEFAULT_AGENT_DOWNLOAD_BASE.to_string(),
            session_ttl_hours: DEFAULT_SESSION_TTL_HOURS,
        }
    }

    /// Whether cookies must carry the `Secure` attribute.
    pub fn is_https(&self) -> bool {
        self.public_url.starts_with("https://")
    }

    pub fn turn_enabled(&self) -> bool {
        self.turn_secret.is_some() && !self.turn_urls.is_empty()
    }

    /// Filesystem path of the SQLite database, if the URL points to a file.
    pub fn sqlite_path(&self) -> Option<PathBuf> {
        let rest = self.database_url.strip_prefix("sqlite://")?;
        let path = rest.split('?').next().unwrap_or(rest);
        if path.is_empty() || path == ":memory:" {
            return None;
        }
        Some(PathBuf::from(path))
    }
}

fn env_or(key: &str, default: &str) -> String {
    match std::env::var(key) {
        Ok(v) if !v.trim().is_empty() => v.trim().to_string(),
        _ => default.to_string(),
    }
}

fn split_list(s: &str) -> Vec<String> {
    s.split(',')
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sqlite_path_extraction() {
        let mut c = Config::for_tests("sqlite://data/console.db?mode=rwc".into());
        assert_eq!(c.sqlite_path(), Some(PathBuf::from("data/console.db")));
        c.database_url = "sqlite::memory:".into();
        assert_eq!(c.sqlite_path(), None);
        c.database_url = "postgres://x".into();
        assert_eq!(c.sqlite_path(), None);
    }

    #[test]
    fn list_splitting() {
        assert_eq!(split_list(" a, b ,,c"), vec!["a", "b", "c"]);
        assert!(split_list("").is_empty());
    }
}
