//! ICE server lists with short-lived TURN credentials (coturn `use-auth-secret` scheme).

use crate::config::Config;
use base64::Engine;
use hmac::{Hmac, Mac};
use protocol::common::IceServer;
use sha1::Sha1;

/// Lifetime of TURN credentials.
pub const TURN_TTL_SECS: i64 = 3600;

/// Build the ICE server list for a session: STUN always, TURN when configured.
pub fn ice_servers(config: &Config, session_id: &str, now_unix: i64) -> Vec<IceServer> {
    let mut servers = Vec::new();
    if !config.stun_urls.is_empty() {
        servers.push(IceServer {
            urls: config.stun_urls.clone(),
            username: None,
            credential: None,
        });
    }
    if let (Some(secret), false) = (&config.turn_secret, config.turn_urls.is_empty()) {
        let (username, credential) = turn_credentials(secret, session_id, now_unix + TURN_TTL_SECS);
        servers.push(IceServer {
            urls: config.turn_urls.clone(),
            username: Some(username),
            credential: Some(credential),
        });
    }
    servers
}

/// `username = "<expiry>:<session_id>"`, `credential = base64(HMAC-SHA1(secret, username))`.
pub fn turn_credentials(secret: &str, session_id: &str, expiry_unix: i64) -> (String, String) {
    let username = format!("{expiry_unix}:{session_id}");
    let mut mac =
        Hmac::<Sha1>::new_from_slice(secret.as_bytes()).expect("HMAC accepts keys of any length");
    mac.update(username.as_bytes());
    let credential = base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes());
    (username, credential)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credentials_match_coturn_scheme() {
        // Reference computed with: printf '1700000000:ses_x' | openssl dgst -sha1 -hmac 'secret' -binary | base64
        let (user, cred) = turn_credentials("secret", "ses_x", 1_700_000_000);
        assert_eq!(user, "1700000000:ses_x");
        assert_eq!(cred, "0izqZwf29p5/TechDdlDYcM8NhA=");
    }

    #[test]
    fn stun_only_without_secret() {
        let cfg = Config::for_tests("sqlite::memory:".into());
        let servers = ice_servers(&cfg, "ses_a", 0);
        assert_eq!(servers.len(), 1);
        assert!(servers[0].username.is_none());
    }

    #[test]
    fn turn_added_when_configured() {
        let mut cfg = Config::for_tests("sqlite::memory:".into());
        cfg.turn_secret = Some("s".into());
        cfg.turn_urls = vec!["turn:turn.example.com:3478".into()];
        let servers = ice_servers(&cfg, "ses_a", 100);
        assert_eq!(servers.len(), 2);
        assert_eq!(servers[1].username.as_deref(), Some("3700:ses_a"));
        assert!(servers[1].credential.is_some());
    }
}
