//! Environment based configuration.

use anyhow::{bail, Context, Result};
use std::net::IpAddr;
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
    /// Long-term TURN credentials, for hosted relays that issue a fixed username/password
    /// instead of accepting the `use-auth-secret` scheme. Ignored when `turn_secret` is set.
    pub turn_username: Option<String>,
    pub turn_password: Option<String>,
    /// STUN URLs, always included in ICE server lists.
    pub stun_urls: Vec<String>,
    /// Base URL the install scripts download agent binaries from (no trailing slash).
    pub agent_download_base: String,
    /// Absolute lifetime of a login session.
    pub session_ttl_hours: i64,
    /// Optional directory holding base agent binaries to bake (release-named files).
    pub agent_binary_dir: Option<PathBuf>,
    /// `ALLOW_INSECURE_PUBLIC_URL=1`: run with a plain-http public URL on a non-local host.
    pub allow_insecure_public_url: bool,
    /// `TRUST_PROXY=1`: honour `X-Forwarded-For` / `X-Forwarded-Proto` from a reverse proxy.
    pub trust_proxy: bool,
    /// `CONSOLE_MASTER_KEY`: 32 bytes (base64) that encrypt secrets at rest (signing key).
    pub master_key: Option<[u8; 32]>,
    /// SHA-256 of the console's TLS certificate SubjectPublicKeyInfo, base64 (SPKI pin).
    pub tls_spki_sha256: Option<String>,
    /// `REQUIRE_2FA=admins|all|off` (default `admins`).
    pub require_2fa: TwoFactorPolicy,
    /// `LOCAL_LOGIN=1|0`: password login for non-break-glass accounts.
    pub local_login: bool,
}

/// Who must have a second factor enrolled before using the console.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TwoFactorPolicy {
    Admins,
    All,
    Off,
}

impl TwoFactorPolicy {
    pub fn parse(s: &str) -> Result<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "" | "admins" | "admin" => Ok(Self::Admins),
            "all" | "everyone" => Ok(Self::All),
            "off" | "none" | "0" | "false" => Ok(Self::Off),
            other => bail!("REQUIRE_2FA must be admins, all or off (got {other:?})"),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Admins => "admins",
            Self::All => "all",
            Self::Off => "off",
        }
    }

    /// Whether the policy applies to a user with this role.
    pub fn applies_to(self, is_admin: bool) -> bool {
        match self {
            Self::Admins => is_admin,
            Self::All => true,
            Self::Off => false,
        }
    }
}

pub const DEFAULT_PUBLIC_URL: &str = "http://localhost:8080";
pub const DEFAULT_DATABASE_URL: &str = "sqlite://data/console.db?mode=rwc";
pub const DEFAULT_LISTEN_ADDR: &str = "0.0.0.0:8080";
pub const DEFAULT_STUN_URLS: &str = "stun:stun.l.google.com:19302";
pub const DEFAULT_AGENT_DOWNLOAD_BASE: &str =
    "https://github.com/ruohki/remote-agent/releases/latest/download";
pub const DEFAULT_SESSION_TTL_HOURS: i64 = 168;
/// Login sessions not used for this long are invalidated even before `SESSION_TTL_HOURS`.
pub const SESSION_IDLE_HOURS: i64 = 12;

impl Config {
    /// Read configuration from the process environment.
    pub fn from_env() -> Result<Self> {
        let public_url = env_or("CONSOLE_PUBLIC_URL", DEFAULT_PUBLIC_URL);
        let public_url = public_url.trim_end_matches('/').to_string();
        let parsed =
            url::Url::parse(&public_url).context("CONSOLE_PUBLIC_URL is not a valid URL")?;
        if !matches!(parsed.scheme(), "http" | "https") {
            bail!("CONSOLE_PUBLIC_URL must start with http:// or https://");
        }

        let session_ttl_hours = match std::env::var("SESSION_TTL_HOURS") {
            Ok(v) if !v.trim().is_empty() => v
                .trim()
                .parse::<i64>()
                .context("SESSION_TTL_HOURS must be an integer")?,
            _ => DEFAULT_SESSION_TTL_HOURS,
        };

        let master_key = match std::env::var("CONSOLE_MASTER_KEY") {
            Ok(v) if !v.trim().is_empty() => Some(parse_master_key(v.trim())?),
            _ => None,
        };

        let tls_spki_sha256 = match (
            std::env::var("CONSOLE_TLS_SPKI_SHA256")
                .ok()
                .filter(|s| !s.trim().is_empty()),
            std::env::var("CONSOLE_TLS_CERT_PEM")
                .ok()
                .filter(|s| !s.trim().is_empty()),
        ) {
            (Some(pin), _) => Some(validate_spki_pin(pin.trim())?),
            (None, Some(path)) => Some(spki_sha256_from_pem_file(PathBuf::from(path.trim()))?),
            (None, None) => None,
        };

        Ok(Self {
            public_url,
            database_url: env_or("DATABASE_URL", DEFAULT_DATABASE_URL),
            listen_addr: env_or("LISTEN_ADDR", DEFAULT_LISTEN_ADDR),
            turn_urls: split_list(&env_or("TURN_URLS", "")),
            turn_secret: std::env::var("TURN_SECRET")
                .ok()
                .filter(|s| !s.trim().is_empty()),
            turn_username: std::env::var("TURN_USERNAME")
                .ok()
                .filter(|s| !s.trim().is_empty()),
            turn_password: std::env::var("TURN_PASSWORD")
                .ok()
                .filter(|s| !s.trim().is_empty()),
            stun_urls: split_list(&env_or("STUN_URLS", DEFAULT_STUN_URLS)),
            agent_download_base: env_or("AGENT_DOWNLOAD_BASE", DEFAULT_AGENT_DOWNLOAD_BASE)
                .trim_end_matches('/')
                .to_string(),
            session_ttl_hours: session_ttl_hours.max(1),
            agent_binary_dir: std::env::var("AGENT_BINARY_DIR")
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .map(PathBuf::from),
            allow_insecure_public_url: env_flag("ALLOW_INSECURE_PUBLIC_URL"),
            trust_proxy: env_flag("TRUST_PROXY"),
            master_key,
            tls_spki_sha256,
            require_2fa: TwoFactorPolicy::parse(&env_or("REQUIRE_2FA", "admins"))?,
            local_login: std::env::var("LOCAL_LOGIN")
                .map(|v| !matches!(v.trim(), "0" | "false" | "no" | "off"))
                .unwrap_or(true),
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
            turn_username: None,
            turn_password: None,
            stun_urls: split_list(DEFAULT_STUN_URLS),
            // Unroutable on purpose: tests must not reach the real release host. With the
            // default the bakery really downloads published binaries, and cases like
            // "no base binary for this platform" stop failing the way they should.
            agent_download_base: "http://127.0.0.1:1/no-such-release".to_string(),
            session_ttl_hours: DEFAULT_SESSION_TTL_HOURS,
            agent_binary_dir: None,
            allow_insecure_public_url: false,
            trust_proxy: false,
            master_key: None,
            tls_spki_sha256: None,
            require_2fa: TwoFactorPolicy::Off,
            local_login: true,
        }
    }

    /// Directory for server-managed data (agent cache, etc.). Derived from the SQLite path's
    /// parent, else `data/`.
    pub fn data_dir(&self) -> PathBuf {
        self.sqlite_path()
            .and_then(|p| p.parent().map(|d| d.to_path_buf()))
            .filter(|d| !d.as_os_str().is_empty())
            .unwrap_or_else(|| PathBuf::from("data"))
    }

    /// Whether cookies must carry the `Secure` attribute.
    pub fn is_https(&self) -> bool {
        self.public_url.starts_with("https://")
    }

    /// Host part of the public URL (without port).
    pub fn public_host(&self) -> String {
        url::Url::parse(&self.public_url)
            .ok()
            .and_then(|u| u.host_str().map(|h| h.to_string()))
            .unwrap_or_default()
    }

    /// `scheme://host[:port]` of the public URL, for `Origin` comparisons.
    pub fn public_origin(&self) -> String {
        url::Url::parse(&self.public_url)
            .ok()
            .map(|u| u.origin().ascii_serialization())
            .unwrap_or_default()
    }

    pub fn turn_enabled(&self) -> bool {
        !self.turn_urls.is_empty()
            && (self.turn_secret.is_some()
                || (self.turn_username.is_some() && self.turn_password.is_some()))
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

    /// Why the transport is insecure, if it is: a plain-http public URL on a host that is
    /// neither loopback nor a private (RFC 1918 / ULA / link-local) address.
    pub fn transport_violation(&self) -> Option<String> {
        if self.is_https() {
            return None;
        }
        let host = self.public_host();
        if is_local_or_private_host(&host) {
            return None;
        }
        Some(format!(
            "CONSOLE_PUBLIC_URL is {} — agents would send their device secret and operators \
             their session cookie in clear text. Put the console behind TLS (https://) or set \
             ALLOW_INSECURE_PUBLIC_URL=1 to run insecurely on purpose.",
            self.public_url
        ))
    }

    /// Checks that only matter for `serve`: transport policy and configuration warnings.
    pub fn validate_for_serve(&self) -> Result<()> {
        if let Some(reason) = self.transport_violation() {
            if self.allow_insecure_public_url {
                tracing::warn!("INSECURE DEPLOYMENT: {reason}");
            } else {
                bail!("{reason}");
            }
        }
        if self.turn_username.is_some() != self.turn_password.is_some() {
            tracing::warn!(
                "TURN_USERNAME and TURN_PASSWORD must both be set: no relay will be offered"
            );
        }
        if self.turn_secret.is_some() || self.turn_enabled() {
            if self.turn_urls.is_empty() {
                tracing::warn!(
                    "TURN credentials are set but TURN_URLS is empty: no relay will be offered"
                );
            } else if !self.turn_urls.iter().any(|u| u.starts_with("turns:")) {
                tracing::warn!(
                    "TURN_URLS has no turns: (TLS) entry — browsers behind strict firewalls or \
                     with 'disable non-proxied UDP' cannot reach the relay; add \
                     turns:HOST:443?transport=tcp"
                );
            }
        }
        if self.master_key.is_none() {
            tracing::warn!(
                "CONSOLE_MASTER_KEY is not set: the bakery signing key is stored in plain text \
                 in the database file"
            );
        }
        Ok(())
    }
}

/// Loopback, unspecified, RFC 1918, CGNAT, link-local and ULA hosts, plus `localhost` names.
pub fn is_local_or_private_host(host: &str) -> bool {
    let host = host.trim().trim_start_matches('[').trim_end_matches(']');
    if host.eq_ignore_ascii_case("localhost") || host.ends_with(".localhost") {
        return true;
    }
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(v4)) => {
            let o = v4.octets();
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || (o[0] == 100 && (64..=127).contains(&o[1]))
        }
        Ok(IpAddr::V6(v6)) => {
            let seg = v6.segments();
            v6.is_loopback()
                || v6.is_unspecified()
                || (seg[0] & 0xfe00) == 0xfc00
                || (seg[0] & 0xffc0) == 0xfe80
                || v6.to_ipv4_mapped().is_some_and(|v4| {
                    let o = v4.octets();
                    v4.is_loopback()
                        || v4.is_private()
                        || v4.is_link_local()
                        || (o[0] == 100 && (64..=127).contains(&o[1]))
                })
        }
        Err(_) => false,
    }
}

fn parse_master_key(b64: &str) -> Result<[u8; 32]> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .context("CONSOLE_MASTER_KEY must be base64")?;
    <[u8; 32]>::try_from(bytes.as_slice())
        .map_err(|_| anyhow::anyhow!("CONSOLE_MASTER_KEY must decode to exactly 32 bytes"))
}

fn validate_spki_pin(b64: &str) -> Result<String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .context("CONSOLE_TLS_SPKI_SHA256 must be base64")?;
    if bytes.len() != 32 {
        bail!("CONSOLE_TLS_SPKI_SHA256 must be a base64 SHA-256 digest (32 bytes)");
    }
    Ok(b64.to_string())
}

/// SHA-256 over the DER SubjectPublicKeyInfo of the first certificate in a PEM file, base64.
pub fn spki_sha256_from_pem_file(path: PathBuf) -> Result<String> {
    let pem = std::fs::read(&path)
        .with_context(|| format!("reading CONSOLE_TLS_CERT_PEM {}", path.display()))?;
    spki_sha256_from_pem(&pem)
}

pub fn spki_sha256_from_pem(pem: &[u8]) -> Result<String> {
    use base64::Engine;
    use sha2::{Digest, Sha256};
    let (_, parsed) = x509_parser::pem::parse_x509_pem(pem).context("parsing certificate PEM")?;
    let cert = parsed.parse_x509().context("parsing X.509 certificate")?;
    let spki_der = cert.tbs_certificate.subject_pki.raw;
    let digest = Sha256::digest(spki_der);
    Ok(base64::engine::general_purpose::STANDARD.encode(digest))
}

fn env_or(key: &str, default: &str) -> String {
    match std::env::var(key) {
        Ok(v) if !v.trim().is_empty() => v.trim().to_string(),
        _ => default.to_string(),
    }
}

fn env_flag(key: &str) -> bool {
    matches!(
        std::env::var(key).map(|v| v.trim().to_ascii_lowercase()),
        Ok(v) if v == "1" || v == "true" || v == "yes"
    )
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

    #[test]
    fn private_host_detection() {
        for h in [
            "localhost",
            "dev.localhost",
            "127.0.0.1",
            "10.1.2.3",
            "192.168.69.207",
            "172.16.0.9",
            "100.64.1.1",
            "169.254.1.1",
            "::1",
            "[::1]",
            "fd12::1",
            "fe80::1",
            "::ffff:10.0.0.1",
        ] {
            assert!(is_local_or_private_host(h), "{h} should be private/local");
        }
        for h in [
            "remote.example.com",
            "8.8.8.8",
            "203.0.113.9",
            "2001:db8::1",
            "",
        ] {
            assert!(!is_local_or_private_host(h), "{h} should be public");
        }
    }

    #[test]
    fn transport_policy() {
        let mut c = Config::for_tests("sqlite::memory:".into());
        assert!(c.transport_violation().is_none(), "localhost http is fine");
        c.public_url = "http://192.168.1.10:8080".into();
        assert!(c.transport_violation().is_none(), "LAN http is tolerated");
        c.public_url = "http://remote.example.com".into();
        assert!(c.transport_violation().is_some(), "public http is refused");
        assert!(c.validate_for_serve().is_err());
        c.allow_insecure_public_url = true;
        assert!(
            c.validate_for_serve().is_ok(),
            "explicit override allows it"
        );
        c.public_url = "https://remote.example.com".into();
        c.allow_insecure_public_url = false;
        assert!(c.transport_violation().is_none());
        assert_eq!(c.public_origin(), "https://remote.example.com");
        assert_eq!(c.public_host(), "remote.example.com");
    }

    #[test]
    fn master_key_parsing() {
        use base64::Engine;
        let good = base64::engine::general_purpose::STANDARD.encode([7u8; 32]);
        assert_eq!(parse_master_key(&good).unwrap(), [7u8; 32]);
        let short = base64::engine::general_purpose::STANDARD.encode([7u8; 16]);
        assert!(parse_master_key(&short).is_err());
        assert!(parse_master_key("not base64!!").is_err());
    }

    #[test]
    fn spki_pin_from_pem() {
        // Self-signed test certificate generated with rcgen-style parameters; only the SPKI
        // digest matters here, so any valid certificate works.
        let pem = include_bytes!("../tests/fixtures/test-cert.pem");
        let pin = spki_sha256_from_pem(pem).expect("pin");
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&pin)
            .unwrap();
        assert_eq!(bytes.len(), 32);
        assert_eq!(pin, "EuFBOcAHR2Gqg51n83Ruzsr23mFMSpIN463ylxbk3HE=");
        assert!(validate_spki_pin(&pin).is_ok());
        assert!(validate_spki_pin("AAAA").is_err());
    }
}
