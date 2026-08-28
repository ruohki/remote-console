//! Serving branded, signed agent binaries.
//!
//! A base binary (from `AGENT_BINARY_DIR` or fetched from `AGENT_DOWNLOAD_BASE` and cached)
//! is combined with a signed [`protocol::bakery`] payload containing this console's URL, an
//! optional enrollment token, the quick-support flag and the branding:
//!
//! * **macOS** → a zip holding `<Product>.app` (payload as a sidecar inside the bundle, see
//!   [`bundle`]), code-signed and notarized when configured (see [`sign`]);
//! * **Windows** → the executable with the payload appended as a trailer.

pub mod bundle;
pub mod sign;

use crate::config::Config;
use crate::db::{self, Db};
use anyhow::{anyhow, Context, Result};
use parking_lot::Mutex;
use protocol::bakery::{self, BakedConfig, BakedPayload, Branding};
use sign::{SignConfig, SignOutcome};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// A downloadable agent platform.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
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
    /// Whether signing would be attempted for this platform on this host.
    pub signing_configured: bool,
    /// Outcome of the last bake for this platform (false until one happened).
    pub signed: bool,
    pub notarized: bool,
}

/// Result of a bake, ready to be served.
pub struct Baked {
    pub bytes: Vec<u8>,
    pub filename: String,
    pub content_type: &'static str,
    pub signed: bool,
    pub notarized: bool,
}

/// Caches the release `SHA256SUMS`, signing configuration and last outcomes.
pub struct Bakery {
    sums: Mutex<Option<(Instant, HashMap<String, String>)>>,
    sign: SignConfig,
    last: Mutex<HashMap<Platform, SignOutcome>>,
    /// Serialises signing/notarization runs (they share the keychain and Apple's queue).
    sign_lock: tokio::sync::Mutex<()>,
}

const SUMS_TTL: Duration = Duration::from_secs(600);
const FALLBACK_VERSION: &str = "0.1.0";

impl Default for Bakery {
    fn default() -> Self {
        Self::with_signing(SignConfig::default())
    }
}

impl Bakery {
    /// Bakery with signing configured from the environment.
    pub fn new() -> Arc<Self> {
        Arc::new(Self::with_signing(SignConfig::from_env()))
    }

    pub fn with_signing(sign: SignConfig) -> Self {
        Self {
            sums: Mutex::new(None),
            sign,
            last: Mutex::new(HashMap::new()),
            sign_lock: tokio::sync::Mutex::new(()),
        }
    }

    fn cache_dir(config: &Config) -> PathBuf {
        config.data_dir().join("agent-cache")
    }

    fn local_path(config: &Config, platform: Platform) -> Option<PathBuf> {
        let dir = config.agent_binary_dir.as_ref()?;
        let p = dir.join(platform.asset());
        p.is_file().then_some(p)
    }

    fn signing_configured(&self, platform: Platform) -> bool {
        if platform.is_windows() {
            self.sign.windows_configured()
        } else {
            self.sign.macos_configured()
        }
    }

    /// Report availability of every platform (without downloading).
    pub async fn availability(&self, config: &Config) -> Vec<Availability> {
        let sums = self.release_sums(config).await.unwrap_or_default();
        Platform::ALL
            .iter()
            .map(|&p| {
                let last = self.last.lock().get(&p).copied().unwrap_or_default();
                let (available, source, size) = if let Some(path) = Self::local_path(config, p) {
                    let size = std::fs::metadata(&path).ok().map(|m| m.len());
                    (true, Source::Local, size)
                } else {
                    let cached = Self::cache_dir(config).join(p.asset());
                    let size = std::fs::metadata(&cached).ok().map(|m| m.len());
                    (sums.contains_key(p.asset()), Source::Release, size)
                };
                Availability {
                    platform: p.slug().to_string(),
                    available,
                    source,
                    size,
                    signing_configured: self.signing_configured(p),
                    signed: last.signed,
                    notarized: last.notarized,
                }
            })
            .collect()
    }

    /// Fetch (and cache in memory) the release `SHA256SUMS`.
    async fn release_sums(&self, config: &Config) -> Result<HashMap<String, String>> {
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
        let map: HashMap<String, String> = text
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

    /// Produce a signed, branded download for `platform`.
    ///
    /// `sign = false` skips code signing even when configured (`?sign=0`).
    #[allow(clippy::too_many_arguments)]
    pub async fn bake(
        &self,
        config: &Config,
        db: &Db,
        platform: Platform,
        token: Option<String>,
        quick_support: bool,
        branding: Branding,
        sign: bool,
    ) -> Result<Baked> {
        let base = self.base_binary(config, platform).await?;
        let key = db::settings::signing_key(db, config).await?;
        let server_url = config.public_url.clone();
        let issued_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let baked_config = BakedConfig {
            version: bakery::BAKED_VERSION,
            server_url,
            enroll_token: token,
            quick_support,
            branding,
            issued_at,
            console_tls_spki_sha256: config.tls_spki_sha256.clone(),
        };
        let product = baked_config.branding.product_name.clone();

        if platform.is_windows() {
            let filename = download_filename(&product, platform);
            let bytes = tokio::task::spawn_blocking(move || {
                let payload = bakery::sign_payload(baked_config, &key);
                bakery::append_trailer(bakery::strip_trailer(&base), &payload)
            })
            .await
            .context("baking task")?;
            let outcome = sign::sign_windows_exe(&self.sign, Path::new(&filename));
            self.last.lock().insert(platform, outcome);
            return Ok(Baked {
                bytes,
                filename,
                content_type: "application/octet-stream",
                signed: outcome.signed,
                notarized: outcome.notarized,
            });
        }

        // ── macOS bundle ────────────────────────────────────────────────────────
        let want_sign = sign && self.sign.macos_configured();
        let cache_key = bundle_cache_key(&base, &baked_config);
        let bundles_dir = Self::cache_dir(config).join("bundles");
        let filename = download_filename(&product, platform);

        if want_sign {
            if let Some((bytes, outcome)) = read_cached_bundle(&bundles_dir, &cache_key).await {
                // A bundle cached before notarization was configured must be re-processed;
                // otherwise the console keeps serving "signed, not notarized" forever.
                let stale = !outcome.notarized && self.sign.macos_notary_configured();
                if stale {
                    tracing::info!(platform = %platform.slug(), "re-baking cached bundle to notarize it");
                }
                if !stale {
                    self.last.lock().insert(platform, outcome);
                    return Ok(Baked {
                        bytes,
                        filename,
                        content_type: "application/zip",
                        signed: outcome.signed,
                        notarized: outcome.notarized,
                    });
                }
            }
        }

        let version = bundle::detect_version(
            Self::local_path(config, platform).as_deref(),
            FALLBACK_VERSION,
        );
        let sign_cfg = self.sign.clone();
        // Hold the signing lock across the blocking task so notarizations never overlap.
        let _guard = if want_sign {
            Some(self.sign_lock.lock().await)
        } else {
            None
        };
        let (bytes, outcome) =
            tokio::task::spawn_blocking(move || -> Result<(Vec<u8>, SignOutcome)> {
                let payload = bakery::sign_payload(baked_config, &key);
                let logo = payload
                    .config
                    .branding
                    .logo_png_base64
                    .as_deref()
                    .and_then(decode_b64);
                let work = tempfile::tempdir().context("creating work dir")?;
                let app = bundle::create_bundle(
                    work.path(),
                    &bundle::BundleSpec {
                        product: &product,
                        version: &version,
                        binary: bakery::strip_trailer(&base),
                        payload: &payload,
                        logo_png: logo.as_deref(),
                    },
                )?;
                let outcome = if want_sign {
                    sign::sign_bundle(&sign_cfg, &app, work.path())
                } else {
                    SignOutcome::default()
                };
                let app_name = app
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "Remote Agent.app".into());
                let zipped = bundle::zip_dir(&app, &app_name)?;
                Ok((zipped, outcome))
            })
            .await
            .context("bundle task")??;
        drop(_guard);

        if outcome.signed {
            write_cached_bundle(&bundles_dir, &cache_key, &bytes, outcome).await;
        }
        self.last.lock().insert(platform, outcome);
        Ok(Baked {
            bytes,
            filename,
            content_type: "application/zip",
            signed: outcome.signed,
            notarized: outcome.notarized,
        })
    }
}

fn decode_b64(s: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(s).ok()
}

/// Cache key: base binary bytes + everything in the config except the issue time.
fn bundle_cache_key(base: &[u8], config: &BakedConfig) -> String {
    let mut stable = config.clone();
    stable.issued_at = 0;
    let cfg_json = serde_json::to_vec(&stable).unwrap_or_default();
    format!(
        "{}-{}",
        &sha256_hex(base)[..16],
        &sha256_hex(&cfg_json)[..16]
    )
}

async fn read_cached_bundle(dir: &Path, key: &str) -> Option<(Vec<u8>, SignOutcome)> {
    let state = tokio::fs::read(dir.join(format!("{key}.json")))
        .await
        .ok()?;
    let outcome: SignOutcome = serde_json::from_slice(&state).ok()?;
    let bytes = tokio::fs::read(dir.join(format!("{key}.zip"))).await.ok()?;
    Some((bytes, outcome))
}

async fn write_cached_bundle(dir: &Path, key: &str, bytes: &[u8], outcome: SignOutcome) {
    if tokio::fs::create_dir_all(dir).await.is_err() {
        return;
    }
    let _ = tokio::fs::write(dir.join(format!("{key}.zip")), bytes).await;
    if let Ok(state) = serde_json::to_vec(&outcome) {
        let _ = tokio::fs::write(dir.join(format!("{key}.json")), state).await;
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(bytes))
}

/// Sanitise a product name into a download file name.
///
/// macOS downloads are zipped app bundles (`<Product>.zip`); Windows downloads are
/// executables (`<Product>-<platform>.exe`).
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
    if platform.is_windows() {
        format!("{stem}-{}.exe", platform.slug())
    } else {
        format!("{stem}.zip")
    }
}

/// Payload as it would be baked (used by tests and diagnostics).
pub fn payload_for(config: BakedConfig, key: &ed25519_dalek::SigningKey) -> BakedPayload {
    bakery::sign_payload(config, key)
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
            download_filename("Acme Remote", Platform::MacosUniversal),
            "Acme-Remote.zip"
        );
        assert_eq!(
            download_filename("", Platform::MacosUniversal),
            "remote-agent.zip"
        );
        assert_eq!(
            download_filename("  ---  ", Platform::WindowsAarch64),
            "remote-agent-windows-aarch64.exe"
        );
    }

    #[test]
    fn cache_key_ignores_issue_time() {
        let mk = |issued_at: u64, product: &str| BakedConfig {
            version: 1,
            server_url: "https://c".into(),
            enroll_token: Some("t".into()),
            quick_support: false,
            branding: Branding {
                product_name: product.into(),
                accent: "#000000".into(),
                logo_png_base64: None,
                support_text: String::new(),
                organization: String::new(),
                apply_to_console: true,
            },
            issued_at,
            console_tls_spki_sha256: None,
        };
        assert_eq!(
            bundle_cache_key(b"bin", &mk(1, "A")),
            bundle_cache_key(b"bin", &mk(2, "A"))
        );
        assert_ne!(
            bundle_cache_key(b"bin", &mk(1, "A")),
            bundle_cache_key(b"bin", &mk(1, "B"))
        );
        assert_ne!(
            bundle_cache_key(b"bin", &mk(1, "A")),
            bundle_cache_key(b"other", &mk(1, "A"))
        );
    }
}
