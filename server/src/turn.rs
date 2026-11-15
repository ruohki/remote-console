//! ICE server lists: STUN, plus TURN from one of three sources —
//!
//! * **Cloudflare Realtime TURN** (`CLOUDFLARE_TURN_KEY_ID` + `CLOUDFLARE_TURN_API_TOKEN`):
//!   anycast, so each peer reaches the relay nearest to it — a US operator and a US device relay
//!   in the US even though the console runs in Europe. Credentials come from Cloudflare's API;
//!   [`run_cloudflare_refresher`] keeps one set (valid 24 h) cached and renews it every 4 h, so
//!   handing them out never waits on the network and any set handed out outlives a session.
//! * a coturn with `use-auth-secret` (`TURN_SECRET`): per-session credentials derived here;
//! * fixed long-term credentials (`TURN_USERNAME` / `TURN_PASSWORD`).

use crate::config::Config;
use base64::Engine;
use hmac::{Hmac, Mac};
use parking_lot::RwLock;
use protocol::common::IceServer;
use sha1::Sha1;
use std::time::Duration;

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
    if config.cloudflare_turn() {
        match cloudflare_cached(now_unix) {
            Some(cf) => servers.extend(cf),
            None => tracing::warn!(
                "Cloudflare TURN credentials not available yet; session without relay"
            ),
        }
        return servers;
    }
    if config.turn_urls.is_empty() {
        return servers;
    }
    if let Some(secret) = &config.turn_secret {
        // coturn `use-auth-secret`: credentials are derived per session and expire.
        let (username, credential) = turn_credentials(secret, session_id, now_unix + TURN_TTL_SECS);
        servers.push(IceServer {
            urls: config.turn_urls.clone(),
            username: Some(username),
            credential: Some(credential),
        });
    } else if let (Some(username), Some(credential)) =
        (&config.turn_username, &config.turn_password)
    {
        // Long-term credentials, as hosted relays hand them out. They do not expire on their
        // own and every session gets the same pair, so prefer a secret-based relay when you
        // run your own coturn.
        servers.push(IceServer {
            urls: config.turn_urls.clone(),
            username: Some(username.clone()),
            credential: Some(credential.clone()),
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

// ─── Cloudflare Realtime TURN ───────────────────────────────────────────────────────────

/// Lifetime requested for Cloudflare credentials, and how often they are renewed. A set handed
/// out just before a renewal is still valid for `TTL - REFRESH` (20 h) — longer than any session.
const CLOUDFLARE_TTL: Duration = Duration::from_secs(24 * 3600);
const CLOUDFLARE_REFRESH: Duration = Duration::from_secs(4 * 3600);
/// Retry interval after a failed fetch.
const CLOUDFLARE_RETRY: Duration = Duration::from_secs(60);

struct CloudflareCache {
    servers: Vec<IceServer>,
    expires_unix: i64,
}

static CLOUDFLARE: RwLock<Option<CloudflareCache>> = RwLock::new(None);

/// The cached Cloudflare ICE servers, unless missing or expired.
fn cloudflare_cached(now_unix: i64) -> Option<Vec<IceServer>> {
    let cache = CLOUDFLARE.read();
    let c = cache.as_ref()?;
    (now_unix < c.expires_unix).then(|| c.servers.clone())
}

fn store_cloudflare(servers: Vec<IceServer>, expires_unix: i64) {
    *CLOUDFLARE.write() = Some(CloudflareCache {
        servers,
        expires_unix,
    });
}

/// Response of `POST /v1/turn/keys/{id}/credentials/generate-ice-servers`.
#[derive(serde::Deserialize)]
struct GenerateResponse {
    #[serde(rename = "iceServers")]
    ice_servers: Vec<CfIceServer>,
}

#[derive(serde::Deserialize)]
struct CfIceServer {
    urls: UrlList,
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    credential: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(untagged)]
enum UrlList {
    One(String),
    Many(Vec<String>),
}

/// Turn Cloudflare's answer into our ICE servers. Port-53 URLs are dropped (browsers block the
/// port; without them nothing waits on a guaranteed timeout), and so is Cloudflare's own STUN
/// entry when it duplicates nothing useful — it is kept, it costs nothing.
fn parse_cloudflare(body: &str) -> anyhow::Result<Vec<IceServer>> {
    let resp: GenerateResponse = serde_json::from_str(body)?;
    let servers: Vec<IceServer> = resp
        .ice_servers
        .into_iter()
        .filter_map(|s| {
            let urls: Vec<String> = match s.urls {
                UrlList::One(u) => vec![u],
                UrlList::Many(v) => v,
            }
            .into_iter()
            .filter(|u| !u.contains(":53?") && !u.ends_with(":53"))
            .collect();
            (!urls.is_empty()).then_some(IceServer {
                urls,
                username: s.username,
                credential: s.credential,
            })
        })
        .collect();
    if !servers.iter().any(|s| s.credential.is_some()) {
        anyhow::bail!("Cloudflare returned no TURN credentials");
    }
    Ok(servers)
}

/// Fetch one credential set from Cloudflare.
async fn fetch_cloudflare(
    client: &reqwest::Client,
    api_base: &str,
    key_id: &str,
    token: &str,
) -> anyhow::Result<Vec<IceServer>> {
    use anyhow::Context;
    let url = format!(
        "{}/v1/turn/keys/{key_id}/credentials/generate-ice-servers",
        api_base.trim_end_matches('/')
    );
    let resp = client
        .post(&url)
        .bearer_auth(token)
        .json(&serde_json::json!({ "ttl": CLOUDFLARE_TTL.as_secs() }))
        .send()
        .await
        .context("requesting Cloudflare TURN credentials")?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        anyhow::bail!(
            "Cloudflare TURN API answered {status}: {}",
            body.chars().take(200).collect::<String>()
        );
    }
    parse_cloudflare(&body)
}

/// Keep Cloudflare TURN credentials cached for the life of the process. No-op unless Cloudflare
/// TURN is configured. `CLOUDFLARE_TURN_API_BASE` overrides the API host (tests).
pub async fn run_cloudflare_refresher(config: Config) {
    let (Some(key_id), Some(token)) = (
        config.cloudflare_turn_key_id.clone(),
        config.cloudflare_turn_api_token.clone(),
    ) else {
        return;
    };
    let api_base = std::env::var("CLOUDFLARE_TURN_API_BASE")
        .unwrap_or_else(|_| "https://rtc.live.cloudflare.com".to_string());
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            tracing::error!("Cloudflare TURN client: {e}");
            return;
        }
    };
    loop {
        let wait = match fetch_cloudflare(&client, &api_base, &key_id, &token).await {
            Ok(servers) => {
                let expires = chrono::Utc::now().timestamp() + CLOUDFLARE_TTL.as_secs() as i64;
                tracing::info!(
                    urls = servers.iter().map(|s| s.urls.len()).sum::<usize>(),
                    "Cloudflare TURN credentials refreshed"
                );
                store_cloudflare(servers, expires);
                CLOUDFLARE_REFRESH
            }
            Err(e) => {
                // The previous set stays in use until it expires.
                tracing::warn!("Cloudflare TURN: {e:#}");
                CLOUDFLARE_RETRY
            }
        };
        tokio::time::sleep(wait).await;
    }
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

    #[test]
    fn long_term_credentials_are_passed_through_unchanged() {
        let mut cfg = Config::for_tests("sqlite::memory:".into());
        cfg.turn_urls = vec!["turn:relay.example.com:3478?transport=udp".into()];
        cfg.turn_username = Some("000000002103401017".into());
        cfg.turn_password = Some("s3cret/w1th+base64=".into());
        let servers = ice_servers(&cfg, "ses_a", 100);
        assert_eq!(servers.len(), 2);
        assert_eq!(servers[1].username.as_deref(), Some("000000002103401017"));
        assert_eq!(
            servers[1].credential.as_deref(),
            Some("s3cret/w1th+base64=")
        );
        // Same pair on every session: nothing is derived from the session id.
        assert_eq!(ice_servers(&cfg, "ses_b", 99_999)[1], servers[1]);
        assert!(cfg.turn_enabled());
    }

    #[test]
    fn a_secret_wins_over_long_term_credentials() {
        let mut cfg = Config::for_tests("sqlite::memory:".into());
        cfg.turn_urls = vec!["turn:turn.example.com:3478".into()];
        cfg.turn_secret = Some("s".into());
        cfg.turn_username = Some("static".into());
        cfg.turn_password = Some("pw".into());
        let servers = ice_servers(&cfg, "ses_a", 100);
        assert_eq!(servers[1].username.as_deref(), Some("3700:ses_a"));
    }

    #[test]
    fn half_configured_long_term_credentials_offer_no_relay() {
        let mut cfg = Config::for_tests("sqlite::memory:".into());
        cfg.turn_urls = vec!["turn:relay.example.com:3478".into()];
        cfg.turn_username = Some("user".into());
        assert_eq!(ice_servers(&cfg, "ses_a", 0).len(), 1);
        assert!(!cfg.turn_enabled());
    }

    const CF_SAMPLE: &str = r#"{"iceServers":[{"urls":["stun:stun.cloudflare.com:3478","stun:stun.cloudflare.com:53"]},{"urls":["turn:turn.cloudflare.com:3478?transport=udp","turn:turn.cloudflare.com:53?transport=udp","turn:turn.cloudflare.com:3478?transport=tcp","turns:turn.cloudflare.com:5349?transport=tcp","turns:turn.cloudflare.com:443?transport=tcp"],"username":"u1","credential":"c1"}]}"#;

    #[test]
    fn cloudflare_answer_is_parsed_and_port_53_dropped() {
        let servers = parse_cloudflare(CF_SAMPLE).unwrap();
        assert_eq!(servers.len(), 2);
        assert_eq!(servers[0].urls, vec!["stun:stun.cloudflare.com:3478"]);
        assert!(servers[1].urls.iter().all(|u| !u.contains(":53?")));
        assert!(
            servers[1].urls.iter().any(|u| u.contains(":5349")),
            "5349 is not port 53"
        );
        assert!(servers[1]
            .urls
            .iter()
            .any(|u| u.starts_with("turns:") && u.contains(":443")));
        assert_eq!(servers[1].username.as_deref(), Some("u1"));
        assert!(parse_cloudflare(r#"{"iceServers":[{"urls":"stun:x:3478"}]}"#).is_err());
    }

    #[tokio::test]
    async fn cloudflare_credentials_are_fetched_cached_and_served() {
        use axum::{routing::post, Json, Router};
        let app = Router::new().route(
            "/v1/turn/keys/{id}/credentials/generate-ice-servers",
            post(
                |axum::extract::Path(id): axum::extract::Path<String>,
                 headers: axum::http::HeaderMap,
                 Json(body): Json<serde_json::Value>| async move {
                    assert_eq!(id, "key1");
                    assert_eq!(headers.get("authorization").unwrap(), "Bearer tok");
                    assert_eq!(body["ttl"], 86400);
                    (axum::http::StatusCode::CREATED, CF_SAMPLE)
                },
            ),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = reqwest::Client::new();
        let servers = fetch_cloudflare(&client, &format!("http://{addr}"), "key1", "tok")
            .await
            .unwrap();
        store_cloudflare(servers, 1_000);

        let mut cfg = Config::for_tests("sqlite::memory:".into());
        cfg.cloudflare_turn_key_id = Some("key1".into());
        cfg.cloudflare_turn_api_token = Some("tok".into());
        assert!(cfg.turn_enabled());
        let list = ice_servers(&cfg, "ses_a", 999);
        // Configured STUN + Cloudflare STUN + Cloudflare TURN.
        assert_eq!(list.len(), 3);
        assert_eq!(list[2].credential.as_deref(), Some("c1"));
        // Expired: no relay rather than dead credentials.
        assert_eq!(ice_servers(&cfg, "ses_a", 1_000).len(), 1);
        *CLOUDFLARE.write() = None;
    }
}
