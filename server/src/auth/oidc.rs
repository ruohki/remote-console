//! OpenID Connect login (authorization code flow with PKCE) against any discoverable provider.

use crate::app::AppState;
use crate::auth::sso::{self, ProviderPolicy, SsoIdentity};
use crate::config::Config;
use crate::db::{self, models::AuthMethod, settings};
use crate::error::ApiError;
use anyhow::{bail, Context, Result};
use axum::http::StatusCode;
use chrono::Duration;
use jsonwebtoken::jwk::JwkSet;
use jsonwebtoken::{decode, decode_header, DecodingKey, Validation};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::time::{Duration as StdDuration, Instant};

pub const SETTINGS_KEY: &str = "oidc_config";
pub const STATE_KIND: &str = "oidc";
const DISCOVERY_TTL: StdDuration = StdDuration::from_secs(600);
const JWKS_TTL: StdDuration = StdDuration::from_secs(600);
const HTTP_TIMEOUT: StdDuration = StdDuration::from_secs(15);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AdminClaim {
    pub name: String,
    pub value: String,
}

/// Stored configuration (`client_secret_enc` sealed with the master key when set).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OidcConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_display_name")]
    pub display_name: String,
    #[serde(default)]
    pub issuer: String,
    #[serde(default)]
    pub client_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_secret_enc: Option<String>,
    #[serde(default = "default_scopes")]
    pub scopes: String,
    #[serde(default = "default_groups_claim")]
    pub groups_claim: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub admin_claim: Option<AdminClaim>,
    #[serde(flatten)]
    pub policy: ProviderPolicy,
}

fn default_display_name() -> String {
    "Single sign-on".into()
}
fn default_scopes() -> String {
    "openid email profile".into()
}
fn default_groups_claim() -> String {
    "groups".into()
}

impl Default for OidcConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            display_name: default_display_name(),
            issuer: String::new(),
            client_id: String::new(),
            client_secret_enc: None,
            scopes: default_scopes(),
            groups_claim: default_groups_claim(),
            admin_claim: None,
            policy: ProviderPolicy::default(),
        }
    }
}

/// Admin-facing view: the secret is never returned, only whether one is set.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OidcConfigPublic {
    pub enabled: bool,
    pub display_name: String,
    pub issuer: String,
    pub client_id: String,
    pub client_secret_set: bool,
    pub scopes: String,
    pub groups_claim: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub admin_claim: Option<AdminClaim>,
    #[serde(flatten)]
    pub policy: ProviderPolicy,
    pub redirect_uri: String,
}

/// Body of `PUT /api/auth/oidc/config` (secret optional: keep the stored one when absent).
#[derive(Debug, Clone, Deserialize)]
pub struct OidcConfigInput {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_display_name")]
    pub display_name: String,
    #[serde(default)]
    pub issuer: String,
    #[serde(default)]
    pub client_id: String,
    #[serde(default)]
    pub client_secret: Option<String>,
    #[serde(default = "default_scopes")]
    pub scopes: String,
    #[serde(default = "default_groups_claim")]
    pub groups_claim: String,
    #[serde(default)]
    pub admin_claim: Option<AdminClaim>,
    #[serde(flatten)]
    pub policy: ProviderPolicy,
}

impl OidcConfig {
    pub fn public(&self, config: &Config) -> OidcConfigPublic {
        OidcConfigPublic {
            enabled: self.enabled,
            display_name: self.display_name.clone(),
            issuer: self.issuer.clone(),
            client_id: self.client_id.clone(),
            client_secret_set: self.client_secret_enc.is_some(),
            scopes: self.scopes.clone(),
            groups_claim: self.groups_claim.clone(),
            admin_claim: self.admin_claim.clone(),
            policy: self.policy.clone(),
            redirect_uri: redirect_uri(config),
        }
    }

    pub fn client_secret(&self, config: &Config) -> Result<Option<String>> {
        match &self.client_secret_enc {
            Some(enc) => settings::open(config, enc).map(Some),
            None => Ok(None),
        }
    }
}

pub fn redirect_uri(config: &Config) -> String {
    format!("{}/api/auth/oidc/callback", config.public_url)
}

pub async fn load(db: &db::Db) -> Result<OidcConfig> {
    Ok(match settings::get(db, SETTINGS_KEY).await? {
        Some(json) => serde_json::from_str(&json).unwrap_or_default(),
        None => OidcConfig::default(),
    })
}

pub async fn store(db: &db::Db, cfg: &OidcConfig) -> Result<()> {
    settings::put(db, SETTINGS_KEY, &serde_json::to_string(cfg)?).await
}

/// Validate and merge an admin update into the stored config.
pub fn merge_input(
    existing: &OidcConfig,
    input: OidcConfigInput,
    config: &Config,
) -> Result<OidcConfig, ApiError> {
    let issuer = input.issuer.trim().trim_end_matches('/').to_string();
    if input.enabled {
        if !(issuer.starts_with("https://")
            || issuer.starts_with("http://localhost")
            || issuer.starts_with("http://127.0.0.1"))
        {
            return Err(ApiError::validation(
                "issuer must be an https:// URL (http only for localhost)",
            ));
        }
        if input.client_id.trim().is_empty() {
            return Err(ApiError::validation("client_id is required"));
        }
    }
    if input.display_name.trim().is_empty() || input.display_name.len() > 60 {
        return Err(ApiError::validation("display_name must be 1–60 characters"));
    }
    if !input.scopes.split_whitespace().any(|s| s == "openid") {
        return Err(ApiError::validation("scopes must include openid"));
    }
    let client_secret_enc = match input.client_secret.as_deref().map(str::trim) {
        Some(s) if !s.is_empty() => Some(settings::seal(config, s)),
        _ => existing.client_secret_enc.clone(),
    };
    Ok(OidcConfig {
        enabled: input.enabled,
        display_name: input.display_name.trim().to_string(),
        issuer,
        client_id: input.client_id.trim().to_string(),
        client_secret_enc,
        scopes: input.scopes.trim().to_string(),
        groups_claim: if input.groups_claim.trim().is_empty() {
            default_groups_claim()
        } else {
            input.groups_claim.trim().to_string()
        },
        admin_claim: input.admin_claim,
        policy: input.policy,
    })
}

// ── discovery + JWKS caches ─────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Discovery {
    pub issuer: String,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub jwks_uri: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub userinfo_endpoint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_session_endpoint: Option<String>,
}

#[derive(Default)]
pub struct OidcCache {
    discovery: Mutex<HashMap<String, (Instant, Discovery)>>,
    jwks: Mutex<HashMap<String, (Instant, JwkSet)>>,
}

fn http() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .user_agent("remote-console")
        .build()
        .context("building HTTP client")
}

impl OidcCache {
    pub async fn discover(&self, issuer: &str) -> Result<Discovery> {
        if let Some((at, doc)) = self.discovery.lock().get(issuer) {
            if at.elapsed() < DISCOVERY_TTL {
                return Ok(doc.clone());
            }
        }
        let url = format!(
            "{}/.well-known/openid-configuration",
            issuer.trim_end_matches('/')
        );
        let doc: Discovery = http()?
            .get(&url)
            .send()
            .await
            .with_context(|| format!("fetching {url}"))?
            .error_for_status()
            .context("discovery document")?
            .json()
            .await
            .context("parsing the discovery document")?;
        if doc.issuer.trim_end_matches('/') != issuer.trim_end_matches('/') {
            bail!(
                "discovery issuer {} does not match the configured issuer {issuer}",
                doc.issuer
            );
        }
        self.discovery
            .lock()
            .insert(issuer.to_string(), (Instant::now(), doc.clone()));
        Ok(doc)
    }

    pub async fn jwks(&self, uri: &str, force: bool) -> Result<JwkSet> {
        if !force {
            if let Some((at, set)) = self.jwks.lock().get(uri) {
                if at.elapsed() < JWKS_TTL {
                    return Ok(set.clone());
                }
            }
        }
        let set: JwkSet = http()?
            .get(uri)
            .send()
            .await
            .with_context(|| format!("fetching {uri}"))?
            .error_for_status()
            .context("JWKS")?
            .json()
            .await
            .context("parsing JWKS")?;
        self.jwks
            .lock()
            .insert(uri.to_string(), (Instant::now(), set.clone()));
        Ok(set)
    }
}

// ── flow ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct PendingLogin {
    pub nonce: String,
    pub pkce_verifier: String,
    pub return_to: String,
}

fn random_token() -> String {
    use base64::Engine;
    let mut bytes = [0u8; 32];
    rand::fill(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn pkce_challenge(verifier: &str) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// Build the authorization URL and persist the pending state; returns `(state_id, url)`.
pub async fn start(
    state: &AppState,
    cfg: &OidcConfig,
    return_to: String,
) -> Result<(String, String), ApiError> {
    let doc = state
        .auth
        .oidc
        .discover(&cfg.issuer)
        .await
        .map_err(|e| provider_error(format!("OIDC discovery failed: {e:#}")))?;
    let pending = PendingLogin {
        nonce: random_token(),
        pkce_verifier: random_token(),
        return_to,
    };
    let state_id = db::auth::put_state(
        &state.db,
        STATE_KIND,
        None,
        &pending,
        Duration::minutes(crate::auth::PREAUTH_TTL_MINUTES),
    )
    .await?;
    let mut url = url::Url::parse(&doc.authorization_endpoint)
        .map_err(|e| provider_error(format!("bad authorization endpoint: {e}")))?;
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", &cfg.client_id)
        .append_pair("redirect_uri", &redirect_uri(&state.config))
        .append_pair("scope", &cfg.scopes)
        .append_pair("state", &state_id)
        .append_pair("nonce", &pending.nonce)
        .append_pair("code_challenge", &pkce_challenge(&pending.pkce_verifier))
        .append_pair("code_challenge_method", "S256");
    Ok((state_id, url.to_string()))
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    id_token: Option<String>,
    access_token: Option<String>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    error_description: Option<String>,
}

/// Exchange the code, validate the ID token and produce the identity plus the return URL.
pub async fn finish(
    state: &AppState,
    cfg: &OidcConfig,
    state_id: &str,
    code: &str,
) -> Result<(SsoIdentity, String), ApiError> {
    let row = db::auth::get_state(&state.db, state_id, STATE_KIND)
        .await?
        .ok_or_else(|| provider_error("the sign-in attempt expired; start again"))?;
    let pending: PendingLogin =
        db::auth::decode_state(&row).ok_or_else(|| provider_error("corrupt sign-in state"))?;
    db::auth::delete_state(&state.db, state_id).await?;

    let doc = state
        .auth
        .oidc
        .discover(&cfg.issuer)
        .await
        .map_err(|e| provider_error(format!("OIDC discovery failed: {e:#}")))?;
    let secret = cfg.client_secret(&state.config)?;
    let mut form = vec![
        ("grant_type", "authorization_code".to_string()),
        ("code", code.to_string()),
        ("redirect_uri", redirect_uri(&state.config)),
        ("client_id", cfg.client_id.clone()),
        ("code_verifier", pending.pkce_verifier.clone()),
    ];
    if let Some(s) = &secret {
        form.push(("client_secret", s.clone()));
    }
    let tokens: TokenResponse = http()?
        .post(&doc.token_endpoint)
        .form(&form)
        .send()
        .await
        .map_err(|e| provider_error(format!("token request failed: {e}")))?
        .json()
        .await
        .map_err(|e| provider_error(format!("token response unreadable: {e}")))?;
    if let Some(err) = tokens.error {
        return Err(provider_error(format!(
            "token endpoint error: {err} {}",
            tokens.error_description.unwrap_or_default()
        )));
    }
    let id_token = tokens
        .id_token
        .ok_or_else(|| provider_error("token response has no id_token"))?;

    let claims = verify_id_token(state, &doc, cfg, &id_token, &pending.nonce).await?;
    let mut groups = claim_groups(&claims, &cfg.groups_claim);
    let mut extra: Option<Value> = None;
    if groups.is_empty() || claims.get("email").is_none() {
        if let (Some(userinfo), Some(access)) = (&doc.userinfo_endpoint, &tokens.access_token) {
            if let Ok(resp) = http()?.get(userinfo).bearer_auth(access).send().await {
                if let Ok(v) = resp.json::<Value>().await {
                    if groups.is_empty() {
                        groups = claim_groups(&v, &cfg.groups_claim);
                    }
                    extra = Some(v);
                }
            }
        }
    }
    let get_str = |k: &str| -> Option<String> {
        claims
            .get(k)
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                extra
                    .as_ref()
                    .and_then(|v| v.get(k))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
    };
    let subject = get_str("sub").ok_or_else(|| provider_error("id_token has no sub"))?;
    let email = get_str("email").unwrap_or_default();
    let email_verified = claims
        .get("email_verified")
        .or_else(|| extra.as_ref().and_then(|v| v.get("email_verified")))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let name = get_str("name")
        .or_else(|| get_str("preferred_username"))
        .unwrap_or_default();
    // Admin claim: treated as an implicit mapping rule.
    if let Some(ac) = &cfg.admin_claim {
        let hit = match claims.get(&ac.name) {
            Some(Value::String(s)) => s == &ac.value,
            Some(Value::Array(arr)) => arr.iter().any(|v| v.as_str() == Some(ac.value.as_str())),
            Some(Value::Bool(b)) => b.to_string() == ac.value,
            _ => false,
        };
        if hit {
            groups.push(format!("__admin_claim__:{}", ac.name));
        }
    }
    let mut mfa_values: Vec<String> = Vec::new();
    if let Some(Value::Array(amr)) = claims.get("amr") {
        mfa_values.extend(amr.iter().filter_map(|v| v.as_str().map(str::to_string)));
    }
    if let Some(Value::String(acr)) = claims.get("acr") {
        mfa_values.push(acr.clone());
    }
    let identity = SsoIdentity {
        provider: AuthMethod::Oidc,
        subject,
        email,
        email_verified,
        name,
        groups,
        mfa: sso::indicates_mfa(mfa_values.iter().map(String::as_str)),
    };
    Ok((identity, pending.return_to))
}

/// Effective policy: the admin claim becomes a synthetic rule so mapping code stays uniform.
pub fn effective_policy(cfg: &OidcConfig) -> ProviderPolicy {
    let mut p = cfg.policy.clone();
    if let Some(ac) = &cfg.admin_claim {
        p.mappings.insert(
            0,
            sso::Mapping {
                idp_group: format!("__admin_claim__:{}", ac.name),
                role: Some(crate::db::models::Role::Admin),
                groups: vec![],
            },
        );
    }
    p
}

async fn verify_id_token(
    state: &AppState,
    doc: &Discovery,
    cfg: &OidcConfig,
    token: &str,
    nonce: &str,
) -> Result<Value, ApiError> {
    let header = decode_header(token).map_err(|e| provider_error(format!("bad id_token: {e}")))?;
    let kid = header.kid.clone();
    let find = |set: &JwkSet| -> Option<jsonwebtoken::jwk::Jwk> {
        match &kid {
            Some(k) => set.find(k).cloned(),
            None => set.keys.first().cloned(),
        }
    };
    let set = state
        .auth
        .oidc
        .jwks(&doc.jwks_uri, false)
        .await
        .map_err(|e| provider_error(format!("JWKS unavailable: {e:#}")))?;
    let jwk = match find(&set) {
        Some(j) => j,
        None => {
            // Key rotation: refetch once.
            let set = state
                .auth
                .oidc
                .jwks(&doc.jwks_uri, true)
                .await
                .map_err(|e| provider_error(format!("JWKS unavailable: {e:#}")))?;
            find(&set).ok_or_else(|| provider_error("id_token signed with an unknown key"))?
        }
    };
    let key = DecodingKey::from_jwk(&jwk).map_err(|e| provider_error(format!("bad JWK: {e}")))?;
    let mut validation = Validation::new(header.alg);
    validation.set_audience(&[cfg.client_id.as_str()]);
    validation.set_issuer(&[
        doc.issuer.trim_end_matches('/'),
        &format!("{}/", doc.issuer.trim_end_matches('/')),
    ]);
    validation.validate_exp = true;
    validation.leeway = 60;
    let data = decode::<Value>(token, &key, &validation)
        .map_err(|e| provider_error(format!("id_token rejected: {e}")))?;
    let claims = data.claims;
    match claims.get("nonce").and_then(Value::as_str) {
        Some(n) if n == nonce => {}
        _ => return Err(provider_error("id_token nonce mismatch")),
    }
    Ok(claims)
}

fn claim_groups(claims: &Value, claim: &str) -> Vec<String> {
    match claims.get(claim) {
        Some(Value::Array(arr)) => arr
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect(),
        Some(Value::String(s)) => s
            .split([',', ' '])
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect(),
        _ => vec![],
    }
}

pub fn provider_error(message: impl Into<String>) -> ApiError {
    let message = message.into();
    tracing::warn!("SSO error: {message}");
    ApiError::new(StatusCode::BAD_GATEWAY, "sso_provider_error", message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_is_s256() {
        // RFC 7636 appendix B test vector.
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn groups_from_array_or_string() {
        let v = serde_json::json!({ "groups": ["a", "b"], "roles": "x y" });
        assert_eq!(claim_groups(&v, "groups"), vec!["a", "b"]);
        assert_eq!(claim_groups(&v, "roles"), vec!["x", "y"]);
        assert!(claim_groups(&v, "missing").is_empty());
    }

    #[test]
    fn merge_validates_and_keeps_secret() {
        let cfg = Config::for_tests("sqlite://x".into());
        let existing = OidcConfig {
            client_secret_enc: Some("keep".into()),
            ..OidcConfig::default()
        };
        let input = OidcConfigInput {
            enabled: true,
            display_name: "Corp".into(),
            issuer: "https://idp.example/".into(),
            client_id: "abc".into(),
            client_secret: None,
            scopes: "openid email".into(),
            groups_claim: String::new(),
            admin_claim: None,
            policy: ProviderPolicy::default(),
        };
        let merged = merge_input(&existing, input, &cfg).unwrap();
        assert_eq!(merged.issuer, "https://idp.example");
        assert_eq!(merged.client_secret_enc.as_deref(), Some("keep"));
        assert_eq!(merged.groups_claim, "groups");
        let bad = OidcConfigInput {
            enabled: true,
            display_name: "x".into(),
            issuer: "http://idp.example".into(),
            client_id: "abc".into(),
            client_secret: None,
            scopes: "openid".into(),
            groups_claim: String::new(),
            admin_claim: None,
            policy: ProviderPolicy::default(),
        };
        assert!(
            merge_input(&existing, bad, &cfg).is_err(),
            "http issuer rejected"
        );
    }
}
