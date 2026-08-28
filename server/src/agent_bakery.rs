//! Serving branded, signed agent binaries.
//!
//! A base binary (from `AGENT_BINARY_DIR` or fetched from `AGENT_DOWNLOAD_BASE` and cached)
//! gets a signed [`protocol::bakery`] trailer appended containing this console's URL, an
//! optional enrollment token, the quick-support flag and the branding.

use crate::config::Config;
use crate::db::{self, Db};
use anyhow::{anyhow, Context, Result};
use parking_lot::Mutex;
use protocol::bakery::{self, BakedConfig, Branding};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// A downloadable agent platform.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    MacosUniversal,
    WindowsX86_64,
    WindowsAarch64,
}

impl Platform {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "macos-universal" => Some(Self::MacosUniversal),
            "windows-x86_64" => Some(Self::WindowsX86_64),
            "windows-aarch64" => Some(Self::WindowsAarch64),
            _ => None,
        }
    }

    pub fn slug(self) -> &'static str {
        match self {
            Self::MacosUniversal => "macos-universal",
            Self::WindowsX86_64 => "windows-x86_64",
            Self::WindowsAarch64 => "windows-aarch64",
        }
    }

    /// Release asset / base-binary file name.
    pub fn asset(self) -> &'static str {
        match self {
            Self::MacosUniversal => "remote-agent-macos-universal",
            Self::WindowsX86_64 => "remote-agent-windows-x86_64.exe",
            Self::WindowsAarch64 => "remote-agent-windows-aarch64.exe",
        }
    }

    pub fn is_windows(self) -> bool {
        matches!(self, Self::WindowsX86_64 | Self::WindowsAarch64)
    }

    pub const ALL: [Platform; 3] = [
        Platform::MacosUniversal,
        Platform::WindowsX86_64,
        Platform::WindowsAarch64,
    ];
}

/// Where a base binary would come from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    Local,
    Release,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Availability {
    pub platform: String,
    pub available: bool,
    pub source: Source,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

/// Caches the release `SHA256SUMS` so `downloads` doesn't hit the network every call.
#[derive(Default)]
pub struct Bakery {
    sums: Mutex<Option<(Instant, std::collections::HashMap<String, String>)>>,
}

const SUMS_TTL: Duration = Duration::from_secs(600);

impl Bakery {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn cache_dir(config: &Config) -> PathBuf {
        config.data_dir().join("agent-cache")
    }

    fn local_path(config: &Config, platform: Platform) -> Option<PathBuf> {
        let dir = config.agent_binary_dir.as_ref()?;
        let p = dir.join(platform.asset());
        p.is_file().then_some(p)
    }

    /// Report availability of every platform (without downloading).
    pub async fn availability(&self, config: &Config) -> Vec<Availability> {
        let sums = self.release_sums(config).await.unwrap_or_default();
        Platform::ALL
            .iter()
            .map(|&p| {
                if let Some(path) = Self::local_path(config, p) {
                    let size = std::fs::metadata(&path).ok().map(|m| m.len());
                    Availability {
                        platform: p.slug().to_string(),
                        available: true,
                        source: Source::Local,
                        size,
                    }
                } else {
                    let cached = Self::cache_dir(config).join(p.asset());
                    let size = std::fs::metadata(&cached).ok().map(|m| m.len());
                    Availability {
                        platform: p.slug().to_string(),
                        available: sums.contains_key(p.asset()),
                        source: Source::Release,
                        size,
                    }
                }
            })
            .collect()
    }

    /// Fetch (and cache in memory) the release `SHA256SUMS`.
    async fn release_sums(
        &self,
        config: &Config,
    ) -> Result<std::collections::HashMap<String, String>> {
        if let Some((at, map)) = self.sums.lock().as_ref() {
            if at.elapsed() < SUMS_TTL {
                return Ok(map.clone());
            }
        }
        let url = format!("{}/SHA256SUMS", config.agent_download_base);
        let text = reqwest::Client::new()
            .get(&url)
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .context("fetching SHA256SUMS")?
            .text()
            .await
            .context("reading SHA256SUMS")?;
        let map: std::collections::HashMap<String, String> = text
            .lines()
            .filter_map(|l| {
                let mut it = l.split_whitespace();
                let sum = it.next()?;
                let name = it.next()?.trim_start_matches('*');
                Some((name.to_string(), sum.to_string()))
            })
            .collect();
        *self.sums.lock() = Some((Instant::now(), map.clone()));
        Ok(map)
    }

    /// Resolve the raw base binary bytes for `platform`, downloading and verifying when needed.
    pub async fn base_binary(&self, config: &Config, platform: Platform) -> Result<Vec<u8>> {
        if let Some(path) = Self::local_path(config, platform) {
            return tokio::fs::read(&path)
                .await
                .with_context(|| format!("reading {}", path.display()));
        }
        let cache_dir = Self::cache_dir(config);
        let cached = cache_dir.join(platform.asset());
        let sums = self.release_sums(config).await?;
        let expected = sums
            .get(platform.asset())
            .ok_or_else(|| anyhow!("no base binary available for {}", platform.slug()))?
            .to_lowercase();

        if let Ok(bytes) = tokio::fs::read(&cached).await {
            if sha256_hex(&bytes) == expected {
                return Ok(bytes);
            }
        }
        let url = format!("{}/{}", config.agent_download_base, platform.asset());
        let bytes = reqwest::Client::new()
            .get(&url)
            .timeout(Duration::from_secs(120))
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .with_context(|| format!("downloading {url}"))?
            .bytes()
            .await
            .context("reading download")?
            .to_vec();
        if sha256_hex(&bytes) != expected {
            return Err(anyhow!("checksum mismatch for {}", platform.asset()));
        }
        tokio::fs::create_dir_all(&cache_dir).await.ok();
        tokio::fs::write(&cached, &bytes).await.ok();
        Ok(bytes)
    }

    /// Produce a signed, branded binary for `platform`.
    pub async fn bake(
        &self,
        config: &Config,
        db: &Db,
        platform: Platform,
        token: Option<String>,
        quick_support: bool,
        branding: Branding,
    ) -> Result<Vec<u8>> {
        let base = self.base_binary(config, platform).await?;
        let key = db::settings::signing_key(db).await?;
        let server_url = config.public_url.clone();
        // Signing + trailer assembly is CPU/alloc work → run on a blocking thread.
        let baked = tokio::task::spawn_blocking(move || {
            let payload = bakery::sign_payload(
                BakedConfig {
                    version: bakery::BAKED_VERSION,
                    server_url,
                    enroll_token: token,
                    quick_support,
                    branding,
                    issued_at: SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map(|d| d.as_secs())
                        .unwrap_or(0),
                },
                &key,
            );
            bakery::append_trailer(bakery::strip_trailer(&base), &payload)
        })
        .await
        .context("baking task")?;
        Ok(baked)
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(bytes))
}

/// Sanitise a product name into a download file stem.
pub fn download_filename(product: &str, platform: Platform) -> String {
    let stem: String = product
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let stem = stem.trim_matches('-');
    let stem = if stem.is_empty() {
        "remote-agent"
    } else {
        stem
    };
    let ext = if platform.is_windows() { ".exe" } else { "" };
    format!("{stem}-{}{ext}", platform.slug())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_roundtrip() {
        for p in Platform::ALL {
            assert_eq!(Platform::parse(p.slug()), Some(p));
        }
        assert_eq!(Platform::parse("nope"), None);
    }

    #[test]
    fn filenames_are_sanitised() {
        assert_eq!(
            download_filename("Acme Remote/Support", Platform::WindowsX86_64),
            "Acme-Remote-Support-windows-x86_64.exe"
        );
        assert_eq!(
            download_filename("", Platform::MacosUniversal),
            "remote-agent-macos-universal"
        );
        assert_eq!(
            download_filename("  ---  ", Platform::MacosUniversal),
            "remote-agent-macos-universal"
        );
    }
}
