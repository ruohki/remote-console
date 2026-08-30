//! Code signing and notarization of baked macOS bundles (best effort).
//!
//! Two backends:
//!
//! * **`codesign` / `notarytool`** (macOS host): `MACOS_SIGN_IDENTITY` names a
//!   `Developer ID Application` identity in the keychain; `MACOS_NOTARY_PROFILE` names a
//!   `notarytool` keychain profile (`xcrun notarytool store-credentials <profile>`).
//! * **`rcodesign`** (any host, e.g. the Docker image): `MACOS_SIGN_P12` +
//!   `MACOS_SIGN_P12_PASSWORD` for signing, `APPLE_API_KEY_JSON` (an App Store Connect API key
//!   file as produced by `rcodesign encode-app-store-connect-api-key`) for notarization.
//!
//! Every failure is logged and degrades to an unsigned bundle; the caller reports the outcome
//! through [`SignOutcome`] so the UI can show what it got.

use anyhow::{anyhow, Context, Result};
use std::path::{Path, PathBuf};
use std::process::Command;

/// Signing configuration read from the environment.
#[derive(Debug, Clone, Default)]
pub struct SignConfig {
    pub macos_identity: Option<String>,
    pub notary_profile: Option<String>,
    pub p12: Option<PathBuf>,
    /// Base64 of the certificate (`MACOS_SIGN_P12_BASE64`), for hosts that can only pass text
    /// — a Coolify file mount, a config map, a plain environment variable. A `.p12` *file*
    /// holding base64 instead of DER is accepted just the same.
    pub p12_base64: Option<String>,
    pub p12_password: Option<String>,
    /// File holding the `.p12` password (Docker/Kubernetes secrets); wins over the env value.
    pub p12_password_file: Option<PathBuf>,
    pub api_key_json: Option<PathBuf>,
    pub windows_pfx: Option<PathBuf>,
    pub windows_pfx_password: Option<String>,
}

/// Which tool will sign a macOS bundle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MacBackend {
    Codesign,
    Rcodesign,
}

/// What signing achieved for one bundle.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SignOutcome {
    pub signed: bool,
    pub notarized: bool,
}

fn env_opt(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

impl SignConfig {
    pub fn from_env() -> Self {
        Self {
            macos_identity: env_opt("MACOS_SIGN_IDENTITY"),
            notary_profile: env_opt("MACOS_NOTARY_PROFILE"),
            p12: env_opt("MACOS_SIGN_P12").map(PathBuf::from),
            p12_base64: env_opt("MACOS_SIGN_P12_BASE64"),
            p12_password: env_opt("MACOS_SIGN_P12_PASSWORD"),
            p12_password_file: env_opt("MACOS_SIGN_P12_PASSWORD_FILE").map(PathBuf::from),
            api_key_json: env_opt("APPLE_API_KEY_JSON").map(PathBuf::from),
            windows_pfx: env_opt("WINDOWS_SIGN_PFX").map(PathBuf::from),
            windows_pfx_password: env_opt("WINDOWS_SIGN_PFX_PASSWORD"),
        }
    }

    /// The backend a macOS bundle would be signed with on this host, if any.
    pub fn macos_backend(&self) -> Option<MacBackend> {
        if self.macos_identity.is_some() && tool_on_path("codesign") {
            return Some(MacBackend::Codesign);
        }
        if (self.p12.is_some() || self.p12_base64.is_some())
            && (self.p12_password.is_some() || self.p12_password_file.is_some())
            && tool_on_path("rcodesign")
        {
            return Some(MacBackend::Rcodesign);
        }
        None
    }

    pub fn macos_configured(&self) -> bool {
        self.macos_backend().is_some()
    }

    /// Whether notarization would be attempted after signing.
    pub fn macos_notary_configured(&self) -> bool {
        match self.macos_backend() {
            Some(MacBackend::Codesign) => self.notary_profile.is_some() && tool_on_path("xcrun"),
            Some(MacBackend::Rcodesign) => self.api_key_json.is_some(),
            None => false,
        }
    }

    /// Windows Authenticode signing is configured (see [`sign_windows_exe`] for the caveat).
    pub fn windows_configured(&self) -> bool {
        self.windows_pfx.is_some() && tool_on_path("osslsigncode")
    }
}

/// Write `secret` to `path` readable by the owner only.
fn write_secret(path: &Path, secret: &[u8]) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        f.write_all(secret)
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, secret)
    }
}

/// A PKCS#12 blob is DER: it starts with a SEQUENCE tag. Anything else we are handed is text
/// (base64), because the host could only pass the certificate as characters.
fn looks_like_pkcs12(bytes: &[u8]) -> bool {
    bytes.first() == Some(&0x30)
}

/// Decode base64 that may be wrapped across lines or padded with whitespace.
fn decode_base64_text(text: &str) -> Result<Vec<u8>> {
    use base64::Engine as _;
    let compact: String = text.split_whitespace().collect();
    base64::engine::general_purpose::STANDARD
        .decode(compact.as_bytes())
        .map_err(|e| anyhow!("not valid base64: {e}"))
}

/// The certificate `rcodesign` should use, written into `work_dir` when it had to be decoded.
/// Returns the path and whether it is a temporary copy the caller must delete.
///
/// Accepts three shapes, so a host that can only surface text (Coolify file mounts, config
/// maps, plain environment variables) works without a binary volume: `MACOS_SIGN_P12_BASE64`,
/// a `MACOS_SIGN_P12` file holding base64, or a real `.p12`.
fn p12_file(cfg: &SignConfig, work_dir: &Path) -> Result<(PathBuf, bool)> {
    let decoded = match (cfg.p12_base64.as_deref(), cfg.p12.as_deref()) {
        (Some(b64), _) => {
            decode_base64_text(b64).context("MACOS_SIGN_P12_BASE64 is not valid base64")?
        }
        (None, Some(path)) => {
            let bytes = std::fs::read(path)
                .with_context(|| format!("reading {}", path.display()))?;
            if looks_like_pkcs12(&bytes) {
                return Ok((path.to_path_buf(), false));
            }
            let text = std::str::from_utf8(&bytes).map_err(|_| {
                anyhow!("{} is neither a PKCS#12 file nor base64 text", path.display())
            })?;
            decode_base64_text(text)
                .with_context(|| format!("{} is not a PKCS#12 file", path.display()))?
        }
        (None, None) => return Err(anyhow!("no signing certificate configured")),
    };
    if !looks_like_pkcs12(&decoded) {
        return Err(anyhow!("the decoded signing certificate is not PKCS#12"));
    }
    let path = work_dir.join("developer-id.p12");
    write_secret(&path, &decoded).context("writing the decoded certificate")?;
    Ok((path, true))
}

/// Whether an executable named `name` exists on `PATH` (plus the usual macOS locations).
pub fn tool_on_path(name: &str) -> bool {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    dirs.push(PathBuf::from("/usr/bin"));
    dirs.push(PathBuf::from("/usr/local/bin"));
    dirs.push(PathBuf::from("/opt/homebrew/bin"));
    dirs.iter().any(|d| d.join(name).is_file())
}

/// Sign (and, when configured, notarize + staple) the bundle at `app_dir`.
/// `work_dir` receives temporary artefacts (the zip submitted for notarization).
/// Never fails: problems are logged and reflected in the outcome.
pub fn sign_bundle(cfg: &SignConfig, app_dir: &Path, work_dir: &Path) -> SignOutcome {
    let Some(backend) = cfg.macos_backend() else {
        return SignOutcome::default();
    };
    match sign_with(backend, cfg, app_dir, work_dir) {
        Ok(outcome) => outcome,
        Err(err) => {
            tracing::warn!("signing {} failed: {err:#}", app_dir.display());
            // A failed notarization still leaves a signed bundle behind; report what holds.
            SignOutcome {
                signed: is_signed(app_dir),
                notarized: false,
            }
        }
    }
}

fn sign_with(
    backend: MacBackend,
    cfg: &SignConfig,
    app_dir: &Path,
    work_dir: &Path,
) -> Result<SignOutcome> {
    let mut outcome = SignOutcome::default();
    match backend {
        MacBackend::Codesign => {
            let identity = cfg.macos_identity.as_deref().unwrap_or_default();
            run(
                "codesign",
                &[
                    "--force",
                    "--options",
                    "runtime",
                    "--timestamp",
                    "--sign",
                    identity,
                    &app_dir.to_string_lossy(),
                ],
            )
            .context("codesign")?;
            run(
                "codesign",
                &["--verify", "--strict", "--deep", &app_dir.to_string_lossy()],
            )
            .context("codesign --verify")?;
            outcome.signed = true;
            tracing::info!(app = %app_dir.display(), "bundle signed with {identity}");

            if let Some(profile) = cfg.notary_profile.as_deref() {
                let zip = work_dir.join("notarize.zip");
                run(
                    "ditto",
                    &[
                        "-c",
                        "-k",
                        "--keepParent",
                        &app_dir.to_string_lossy(),
                        &zip.to_string_lossy(),
                    ],
                )
                .context("ditto")?;
                let out = run(
                    "xcrun",
                    &[
                        "notarytool",
                        "submit",
                        &zip.to_string_lossy(),
                        "--keychain-profile",
                        profile,
                        "--wait",
                    ],
                )
                .context("notarytool submit")?;
                if !out.contains("status: Accepted") {
                    return Err(anyhow!("notarization was not accepted:\n{out}"));
                }
                run("xcrun", &["stapler", "staple", &app_dir.to_string_lossy()])
                    .context("stapler staple")?;
                outcome.notarized = true;
                tracing::info!(app = %app_dir.display(), "bundle notarized and stapled");
            }
        }
        MacBackend::Rcodesign => {
            let (p12, p12_is_temporary) = p12_file(cfg, work_dir)?;
            // The password goes through a file so it never shows up in the process list.
            let password_file = match cfg.p12_password_file.as_deref() {
                Some(f) => f.to_path_buf(),
                None => {
                    let f = work_dir.join("p12-password");
                    write_secret(
                        &f,
                        cfg.p12_password.as_deref().unwrap_or_default().as_bytes(),
                    )
                    .context("writing p12 password file")?;
                    f
                }
            };
            let result = run(
                "rcodesign",
                &[
                    "sign",
                    "--p12-file",
                    &p12.to_string_lossy(),
                    "--p12-password-file",
                    &password_file.to_string_lossy(),
                    "--code-signature-flags",
                    "runtime",
                    &app_dir.to_string_lossy(),
                ],
            );
            if cfg.p12_password_file.is_none() {
                let _ = std::fs::remove_file(&password_file);
            }
            if p12_is_temporary {
                let _ = std::fs::remove_file(&p12);
            }
            result.context("rcodesign sign")?;
            outcome.signed = true;
            if let Some(key) = cfg.api_key_json.as_deref() {
                run(
                    "rcodesign",
                    &[
                        "notary-submit",
                        "--api-key-file",
                        &key.to_string_lossy(),
                        "--staple",
                        &app_dir.to_string_lossy(),
                    ],
                )
                .context("rcodesign notary-submit")?;
                outcome.notarized = true;
            }
        }
    }
    Ok(outcome)
}

/// Windows Authenticode signing of a baked executable.
///
/// Not performed yet: the bakery appends the configuration trailer *after* the PE image, and
/// Authenticode's hash covers everything up to the certificate table, so a signature would be
/// invalidated by the trailer (or hide it behind the certificate table). Proper support means
/// storing the payload inside the certificate table; until then this reports `signed:false`.
pub fn sign_windows_exe(cfg: &SignConfig, _exe: &Path) -> SignOutcome {
    if cfg.windows_configured() {
        tracing::warn!(
            "WINDOWS_SIGN_PFX is set but Authenticode signing of trailer-baked executables is not supported yet; serving unsigned"
        );
    }
    SignOutcome::default()
}

/// Whether `codesign` considers the bundle validly signed (macOS host only).
fn is_signed(app_dir: &Path) -> bool {
    tool_on_path("codesign")
        && run(
            "codesign",
            &["--verify", "--strict", &app_dir.to_string_lossy()],
        )
        .is_ok()
}

/// Run a tool, returning combined stdout+stderr on success and an error carrying the same on
/// failure.
fn run(program: &str, args: &[&str]) -> Result<String> {
    let output = Command::new(program)
        .args(args)
        .output()
        .with_context(|| format!("running {program}"))?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if output.status.success() {
        Ok(text)
    } else {
        Err(anyhow!(
            "{program} {} exited with {}: {}",
            args.first().copied().unwrap_or(""),
            output.status,
            text.trim()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unconfigured_means_no_backend() {
        let cfg = SignConfig::default();
        assert_eq!(cfg.macos_backend(), None);
        assert!(!cfg.macos_configured());
        assert!(!cfg.macos_notary_configured());
        assert!(!cfg.windows_configured());
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(
            sign_bundle(&cfg, tmp.path(), tmp.path()),
            SignOutcome::default()
        );
    }

    #[test]
    fn rcodesign_backend_needs_both_p12_fields_and_the_tool() {
        let cfg = SignConfig {
            p12: Some(PathBuf::from("/nonexistent.p12")),
            p12_password: None,
            ..Default::default()
        };
        assert_eq!(cfg.macos_backend(), None);
    }

    #[test]
    fn p12_is_accepted_as_der_as_a_base64_file_and_as_base64_env() {
        use base64::Engine as _;
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path();
        // Minimal stand-in for a certificate: what matters here is the DER SEQUENCE tag.
        let der: Vec<u8> = vec![0x30, 0x82, 0x04, 0x01, 0xde, 0xad];
        let b64 = base64::engine::general_purpose::STANDARD.encode(&der);

        // A real .p12 is used in place, without a copy.
        let der_path = work.join("real.p12");
        std::fs::write(&der_path, &der).unwrap();
        let cfg = SignConfig {
            p12: Some(der_path.clone()),
            ..Default::default()
        };
        let (path, temporary) = p12_file(&cfg, work).unwrap();
        assert_eq!((path, temporary), (der_path, false));

        // A mounted file holding base64 (line-wrapped, as a text field tends to be).
        let text_path = work.join("mounted.p12");
        std::fs::write(&text_path, format!("{}\n{}\n", &b64[..4], &b64[4..])).unwrap();
        let cfg = SignConfig {
            p12: Some(text_path),
            ..Default::default()
        };
        let (path, temporary) = p12_file(&cfg, work).unwrap();
        assert!(temporary);
        assert_eq!(std::fs::read(&path).unwrap(), der);

        // MACOS_SIGN_P12_BASE64 wins over a path.
        let cfg = SignConfig {
            p12: Some(work.join("does-not-exist.p12")),
            p12_base64: Some(b64),
            ..Default::default()
        };
        let (path, temporary) = p12_file(&cfg, work).unwrap();
        assert!(temporary);
        assert_eq!(std::fs::read(&path).unwrap(), der);

        // Garbage is refused rather than handed to rcodesign.
        let cfg = SignConfig {
            p12_base64: Some("not base64!!".into()),
            ..Default::default()
        };
        assert!(p12_file(&cfg, work).is_err());
        let cfg = SignConfig {
            p12_base64: Some(base64::engine::general_purpose::STANDARD.encode(b"still not a p12")),
            ..Default::default()
        };
        assert!(p12_file(&cfg, work).is_err());
    }

    #[test]
    fn base64_alone_configures_the_rcodesign_backend() {
        let cfg = SignConfig {
            p12_base64: Some("MIIE".into()),
            p12_password: Some("pw".into()),
            ..Default::default()
        };
        // Only when rcodesign is actually installed, as before.
        assert_eq!(
            cfg.macos_backend().is_some(),
            super::tool_on_path("rcodesign")
        );
    }

    #[test]
    fn secret_files_are_owner_only() {
        let tmp = tempfile::tempdir().unwrap();
        let f = tmp.path().join("pw");
        write_secret(&f, b"hunter2").unwrap();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "hunter2");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&f).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn tool_lookup_finds_sh() {
        assert!(tool_on_path("sh"));
        assert!(!tool_on_path("definitely-not-a-tool-xyz"));
    }
}
