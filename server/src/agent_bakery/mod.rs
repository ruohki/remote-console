//! Serving branded, signed agent binaries.
//!
//! A base binary (from `AGENT_BINARY_DIR` or fetched from `AGENT_DOWNLOAD_BASE` and cached)
//! is combined with a signed [`protocol::bakery`] payload containing this console's URL, an
//! optional enrollment token, the quick-support flag and the branding:
//!
//! * **macOS** → a zip holding `<Product>.app` (payload as a sidecar inside the bundle, see
//!   [`bundle`]), code-signed and notarized when configured (see [`sign`]);
//! * **Windows** → the executable with the payload appended as a trailer.
//!
//! Besides downloads with an enrollment token, the bakery keeps one token-less **update
//! package** per platform ([`Bakery::package`]): the build connected agents fetch when the
//! console asks them to update. It is baked once per base binary + branding and served from
//! memory, so the bytes (and their SHA-256 announced in `update`) stay the same until either
//! changes — the Windows trailer embeds `issued_at`, so re-baking per request would not.

pub mod bundle;
pub mod sign;

use crate::config::Config;
use crate::db::{self, Db};
use anyhow::{anyhow, Context, Result};
use axum::body::Bytes;
use parking_lot::Mutex;
use protocol::bakery::{self, BakedConfig, BakedPayload, Branding};
use protocol::common::{Arch, Os};
use sign::{SignConfig, SignOutcome};
use std::collections::{HashMap, HashSet};
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
    ///
    /// The `-base` suffix marks the binaries that exist to be *baked*: the release also ships
    /// run-anywhere builds (a `.app` for macOS, the plain `.exe` for Windows) under the
    /// unsuffixed names, and picking those up here would serve them as if they were branded.
    pub fn asset(self) -> &'static str {
        match self {
            Self::MacosUniversal => "remote-agent-macos-universal-base",
            Self::WindowsX86_64 => "remote-agent-windows-x86_64-base.exe",
            Self::WindowsAarch64 => "remote-agent-windows-aarch64-base.exe",
        }
    }

    /// What the base binary was called before the `-base` suffix.
    ///
    /// Releases published before the rename carry only these, and an `AGENT_BINARY_DIR` filled
    /// in by hand still holds them, so both are accepted wherever a base binary is looked up.
    pub fn legacy_asset(self) -> &'static str {
        match self {
            Self::MacosUniversal => "remote-agent-macos-universal",
            Self::WindowsX86_64 => "remote-agent-windows-x86_64.exe",
            Self::WindowsAarch64 => "remote-agent-windows-aarch64.exe",
        }
    }

    pub fn is_windows(self) -> bool {
        matches!(self, Self::WindowsX86_64 | Self::WindowsAarch64)
    }

    /// The download a device runs: one universal build for macOS, per-arch for Windows.
    pub fn for_device(os: Os, arch: Arch) -> Option<Self> {
        match (os, arch) {
            (Os::Macos, _) => Some(Self::MacosUniversal),
            (Os::Windows, Arch::X86_64) => Some(Self::WindowsX86_64),
            (Os::Windows, Arch::Aarch64) => Some(Self::WindowsAarch64),
            (Os::Linux, _) => None,
        }
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
    /// Agent version of the base binary (from its embedded version marker); absent when the
    /// binary carries none (built before markers) or is not downloaded yet.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

/// Result of a bake, ready to be served.
pub struct Baked {
    pub bytes: Vec<u8>,
    pub filename: String,
    pub content_type: &'static str,
    pub signed: bool,
    pub notarized: bool,
}

/// What the console knows about a base binary without baking it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BaseInfo {
    pub sha256: String,
    /// From the embedded version marker; `None` for binaries built before markers existed.
    pub version: Option<String>,
}

/// Cheap identity of the base binary a [`BaseInfo`] was computed from.
#[derive(Debug, Clone, PartialEq, Eq)]
enum BaseStamp {
    Local {
        path: PathBuf,
        len: u64,
        modified: Option<SystemTime>,
    },
    Release {
        sha256: String,
    },
}

/// The token-less update build of one platform, served byte-identical until the base binary
/// or the branding changes.
pub struct Package {
    /// Base binary + branding + console identity this package was baked from.
    key: String,
    pub bytes: Bytes,
    pub sha256: String,
    pub version: Option<String>,
    pub filename: String,
    pub content_type: &'static str,
    pub signed: bool,
    pub notarized: bool,
}

/// Caches the release `SHA256SUMS`, signing configuration and last outcomes.
pub struct Bakery {
    sums: Mutex<Option<(Instant, HashMap<String, String>)>>,
    /// Last failed `SHA256SUMS` fetch: not retried for [`SUMS_RETRY`].
    sums_failed: Mutex<Option<Instant>>,
    sign: SignConfig,
    last: Mutex<HashMap<Platform, SignOutcome>>,
    /// Serialises signing/notarization runs (they share the keychain and Apple's queue).
    sign_lock: tokio::sync::Mutex<()>,
    /// Bounds concurrent bakes: each holds a base binary (tens of MB) and its copy in memory.
    bake_slots: tokio::sync::Semaphore,
    base_infos: Mutex<HashMap<Platform, (BaseStamp, BaseInfo)>>,
    packages: Mutex<HashMap<Platform, Arc<Package>>>,
    /// Serialises package bakes so a fleet asking at once bakes each platform only once.
    package_lock: tokio::sync::Mutex<()>,
    /// Platforms whose release base binary is being fetched in the background.
    prefetching: Mutex<HashSet<Platform>>,
}

const SUMS_TTL: Duration = Duration::from_secs(600);
const SUMS_RETRY: Duration = Duration::from_secs(60);
const FALLBACK_VERSION: &str = "0.1.0";
const BAKE_SLOTS: usize = 4;

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
            sums_failed: Mutex::new(None),
            sign,
            last: Mutex::new(HashMap::new()),
            sign_lock: tokio::sync::Mutex::new(()),
            bake_slots: tokio::sync::Semaphore::new(BAKE_SLOTS),
            base_infos: Mutex::new(HashMap::new()),
            packages: Mutex::new(HashMap::new()),
            package_lock: tokio::sync::Mutex::new(()),
            prefetching: Mutex::new(HashSet::new()),
        }
    }

    fn cache_dir(config: &Config) -> PathBuf {
        config.data_dir().join("agent-cache")
    }

    fn local_path(config: &Config, platform: Platform) -> Option<PathBuf> {
        let dir = config.agent_binary_dir.as_ref()?;
        [platform.asset(), platform.legacy_asset()]
            .into_iter()
            .map(|name| dir.join(name))
            .find(|p| p.is_file())
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
        let mut versions = HashMap::new();
        for p in Platform::ALL {
            versions.insert(p, self.base_info(config, p).await.and_then(|i| i.version));
        }
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
                    let published =
                        sums.contains_key(p.asset()) || sums.contains_key(p.legacy_asset());
                    (published, Source::Release, size)
                };
                Availability {
                    platform: p.slug().to_string(),
                    available,
                    source,
                    size,
                    signing_configured: self.signing_configured(p),
                    signed: last.signed,
                    notarized: last.notarized,
                    version: versions.get(&p).cloned().flatten(),
                }
            })
            .collect()
    }

    /// Hash and version of the base binary for `platform`, from a cache keyed by the file's
    /// size + mtime (local) or its published checksum (release). `None` when there is no base
    /// binary, or a release binary has not been downloaded yet.
    pub async fn base_info(&self, config: &Config, platform: Platform) -> Option<BaseInfo> {
        let (stamp, path, expected) = if let Some(path) = Self::local_path(config, platform) {
            let meta = tokio::fs::metadata(&path).await.ok()?;
            let stamp = BaseStamp::Local {
                path: path.clone(),
                len: meta.len(),
                modified: meta.modified().ok(),
            };
            (stamp, path, None)
        } else {
            let sums = self.release_sums(config).await.ok()?;
            let expected = [platform.asset(), platform.legacy_asset()]
                .into_iter()
                .find_map(|name| sums.get(name).map(|s| s.to_lowercase()))?;
            let stamp = BaseStamp::Release {
                sha256: expected.clone(),
            };
            (
                stamp,
                Self::cache_dir(config).join(platform.asset()),
                Some(expected),
            )
        };
        if let Some((cached, info)) = self.base_infos.lock().get(&platform) {
            if *cached == stamp {
                return Some(info.clone());
            }
        }
        let bytes = tokio::fs::read(&path).await.ok()?;
        let info = tokio::task::spawn_blocking(move || BaseInfo {
            sha256: sha256_hex(&bytes),
            version: bakery::find_agent_version(&bytes),
        })
        .await
        .ok()?;
        if expected.is_some_and(|e| e != info.sha256) {
            return None; // stale cache file; the next bake re-downloads it
        }
        self.base_infos
            .lock()
            .insert(platform, (stamp, info.clone()));
        Some(info)
    }

    /// Agent version each platform's base binary carries (`None` = unknown). A release base
    /// binary that is not cached yet is fetched in the background, so its version shows up on
    /// a later call.
    pub async fn versions(
        self: &Arc<Self>,
        config: &Arc<Config>,
    ) -> HashMap<Platform, Option<String>> {
        let mut out = HashMap::new();
        for p in Platform::ALL {
            let info = self.base_info(config, p).await;
            if info.is_none() && Self::local_path(config, p).is_none() {
                self.prefetch(config, p).await;
            }
            out.insert(p, info.and_then(|i| i.version));
        }
        out
    }

    /// Download a published base binary into the cache in the background (once at a time).
    async fn prefetch(self: &Arc<Self>, config: &Arc<Config>, platform: Platform) {
        let published = self.release_sums(config).await.is_ok_and(|sums| {
            sums.contains_key(platform.asset()) || sums.contains_key(platform.legacy_asset())
        });
        if !published || !self.prefetching.lock().insert(platform) {
            return;
        }
        let bakery = Arc::clone(self);
        let config = Arc::clone(config);
        tokio::spawn(async move {
            if let Err(err) = bakery.base_binary(&config, platform).await {
                tracing::warn!(platform = platform.slug(), "fetching base binary: {err:#}");
            }
            bakery.prefetching.lock().remove(&platform);
        });
    }

    /// The token-less, branded update build for `platform` (signed when signing is
    /// configured). Baked on first use and whenever the base binary or branding changed;
    /// otherwise the cached bytes are returned, so their SHA-256 stays valid between the
    /// `update` announcement and the agent's download.
    pub async fn package(
        &self,
        config: &Config,
        db: &Db,
        platform: Platform,
    ) -> Result<Arc<Package>> {
        let branding = db::settings::branding(db).await?;
        let info = match self.base_info(config, platform).await {
            Some(info) => info,
            None => {
                self.base_binary(config, platform).await?;
                self.base_info(config, platform)
                    .await
                    .ok_or_else(|| anyhow!("no base binary available for {}", platform.slug()))?
            }
        };
        let key = package_key(&info, &branding, config, self.signing_configured(platform));
        let cached = |bakery: &Self| {
            bakery
                .packages
                .lock()
                .get(&platform)
                .filter(|p| p.key == key)
                .cloned()
        };
        if let Some(p) = cached(self) {
            return Ok(p);
        }
        let _guard = self.package_lock.lock().await;
        if let Some(p) = cached(self) {
            return Ok(p);
        }
        let baked = self
            .bake(config, db, platform, None, false, branding, true)
            .await?;
        let sha256 = sha256_hex(&baked.bytes);
        let package = Arc::new(Package {
            key,
            bytes: Bytes::from(baked.bytes),
            sha256,
            version: info.version,
            filename: baked.filename,
            content_type: baked.content_type,
            signed: baked.signed,
            notarized: baked.notarized,
        });
        tracing::info!(
            platform = platform.slug(),
            version = package.version.as_deref().unwrap_or("unknown"),
            sha256 = %package.sha256,
            "update package baked"
        );
        self.packages.lock().insert(platform, Arc::clone(&package));
        Ok(package)
    }

    /// Fetch (and cache in memory) the release `SHA256SUMS`. A failed fetch is not retried
    /// for a minute, so pages asking for versions do not wait on an unreachable release host.
    async fn release_sums(&self, config: &Config) -> Result<HashMap<String, String>> {
        if let Some((at, map)) = self.sums.lock().as_ref() {
            if at.elapsed() < SUMS_TTL {
                return Ok(map.clone());
            }
        }
        if self
            .sums_failed
            .lock()
            .is_some_and(|at| at.elapsed() < SUMS_RETRY)
        {
            return Err(anyhow!("release checksums unavailable (retrying shortly)"));
        }
        let url = format!("{}/SHA256SUMS", config.agent_download_base);
        let fetched = async {
            reqwest::Client::new()
                .get(&url)
                .timeout(Duration::from_secs(15))
                .send()
                .await
                .and_then(|r| r.error_for_status())
                .context("fetching SHA256SUMS")?
                .text()
                .await
                .context("reading SHA256SUMS")
        }
        .await;
        let text = match fetched {
            Ok(t) => t,
            Err(err) => {
                *self.sums_failed.lock() = Some(Instant::now());
                return Err(err);
            }
        };
        *self.sums_failed.lock() = None;
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
        // Releases from before the rename carry only the unsuffixed name.
        let (asset, expected) = [platform.asset(), platform.legacy_asset()]
            .into_iter()
            .find_map(|name| sums.get(name).map(|sum| (name, sum.to_lowercase())))
            .ok_or_else(|| anyhow!("no base binary available for {}", platform.slug()))?;

        if let Ok(bytes) = tokio::fs::read(&cached).await {
            if sha256_hex(&bytes) == expected {
                return Ok(bytes);
            }
        }
        let url = format!("{}/{}", config.agent_download_base, asset);
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
            return Err(anyhow!("checksum mismatch for {asset}"));
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
        let _slot = self.bake_slots.acquire().await.context("bakery closed")?;
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

        let version = match self
            .base_info(config, platform)
            .await
            .and_then(|i| i.version)
        {
            Some(v) => bundle_version(&v),
            None => bundle::detect_version(
                Self::local_path(config, platform).as_deref(),
                FALLBACK_VERSION,
            ),
        };
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

/// `CFBundleShortVersionString` wants `major.minor.patch`: drop pre-release / build suffixes.
fn bundle_version(version: &str) -> String {
    version
        .split(['-', '+'])
        .next()
        .filter(|v| !v.is_empty())
        .unwrap_or(FALLBACK_VERSION)
        .to_string()
}

/// Everything a token-less package depends on.
fn package_key(info: &BaseInfo, branding: &Branding, config: &Config, signing: bool) -> String {
    let material = serde_json::json!({
        "base": info.sha256,
        "branding": branding,
        "server_url": config.public_url,
        "tls_pin": config.tls_spki_sha256,
        "signing": signing,
    });
    sha256_hex(material.to_string().as_bytes())
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
    fn device_platforms() {
        assert_eq!(
            Platform::for_device(Os::Macos, Arch::Aarch64),
            Some(Platform::MacosUniversal)
        );
        assert_eq!(
            Platform::for_device(Os::Macos, Arch::X86_64),
            Some(Platform::MacosUniversal)
        );
        assert_eq!(
            Platform::for_device(Os::Windows, Arch::X86_64),
            Some(Platform::WindowsX86_64)
        );
        assert_eq!(
            Platform::for_device(Os::Windows, Arch::Aarch64),
            Some(Platform::WindowsAarch64)
        );
        assert_eq!(Platform::for_device(Os::Linux, Arch::X86_64), None);
    }

    #[test]
    fn bundle_versions_are_numeric() {
        assert_eq!(bundle_version("0.2.0"), "0.2.0");
        assert_eq!(bundle_version("0.2.0-beta.1"), "0.2.0");
        assert_eq!(bundle_version("1.0.0+abc"), "1.0.0");
        assert_eq!(bundle_version("-x"), FALLBACK_VERSION);
    }

    #[tokio::test]
    async fn base_info_reads_the_version_marker_and_caches_it() {
        let dir = tempfile::tempdir().unwrap();
        let mut config = Config::for_tests("sqlite::memory:".into());
        config.agent_binary_dir = Some(dir.path().to_path_buf());
        let mut bin = b"MZ fake".to_vec();
        bin.extend_from_slice(bakery::VERSION_MARKER_PREFIX);
        bin.extend_from_slice(b"0.3.1\0tail");
        std::fs::write(dir.path().join(Platform::WindowsX86_64.asset()), &bin).unwrap();
        let bakery = Bakery::default();
        let info = bakery
            .base_info(&config, Platform::WindowsX86_64)
            .await
            .expect("local base binary");
        assert_eq!(info.version.as_deref(), Some("0.3.1"));
        assert_eq!(info.sha256, sha256_hex(&bin));
        // No marker: version unknown, but the binary is still there.
        std::fs::write(dir.path().join(Platform::WindowsAarch64.asset()), b"MZ old").unwrap();
        let old = bakery
            .base_info(&config, Platform::WindowsAarch64)
            .await
            .expect("local base binary");
        assert_eq!(old.version, None);
        // Replacing the file (new size) invalidates the cached info.
        let newer = [
            b"MZ".as_slice(),
            bakery::VERSION_MARKER_PREFIX,
            b"0.4.0\0padding-padding".as_slice(),
        ]
        .concat();
        std::fs::write(dir.path().join(Platform::WindowsX86_64.asset()), &newer).unwrap();
        let info = bakery
            .base_info(&config, Platform::WindowsX86_64)
            .await
            .unwrap();
        assert_eq!(info.version.as_deref(), Some("0.4.0"));
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
    fn base_assets_carry_the_suffix_and_still_answer_to_the_old_name() {
        // The release also ships run-anywhere builds under the unsuffixed names; baking one of
        // those would hand out an agent that asks for a console URL instead of enrolling.
        assert_eq!(
            Platform::MacosUniversal.asset(),
            "remote-agent-macos-universal-base"
        );
        assert_eq!(
            Platform::WindowsX86_64.asset(),
            "remote-agent-windows-x86_64-base.exe"
        );
        for p in Platform::ALL {
            assert_ne!(p.asset(), p.legacy_asset());
            assert_eq!(p.legacy_asset(), p.asset().replace("-base", ""));
        }
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
