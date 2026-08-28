//! SAML 2.0 service provider: SP metadata, SP-initiated redirect-binding AuthnRequests
//! (optionally signed), and an assertion consumer service that verifies XML signatures with
//! the pure-Rust `xml-sec` crate against the IdP certificates from its metadata.

use crate::app::AppState;
use crate::auth::sso::{self, ProviderPolicy, SsoIdentity};
use crate::config::Config;
use crate::db::{self, models::AuthMethod, settings};
use crate::error::ApiError;
use anyhow::{bail, Context, Result};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use std::io::Write;

pub const SETTINGS_KEY: &str = "saml_config";
const SP_KEY_SETTING: &str = "saml_sp_key_pem";
const SP_CERT_SETTING: &str = "saml_sp_cert_pem";
pub const REQUEST_STATE_KIND: &str = "saml_request";
const ASSERTION_STATE_KIND: &str = "saml_assertion";
const CLOCK_SKEW_SECS: i64 = 180;
const NS_SAML: &str = "urn:oasis:names:tc:SAML:2.0:assertion";
const NS_SAMLP: &str = "urn:oasis:names:tc:SAML:2.0:protocol";
const NS_MD: &str = "urn:oasis:names:tc:SAML:2.0:metadata";
const NS_DS: &str = "http://www.w3.org/2000/09/xmldsig#";
const BINDING_REDIRECT: &str = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect";
const BINDING_POST: &str = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST";
const SIG_ALG_RSA_SHA256: &str = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AttributeMap {
    #[serde(default = "default_email_attr")]
    pub email: String,
    #[serde(default = "default_name_attr")]
    pub name: String,
    #[serde(default = "default_groups_attr")]
    pub groups: String,
}

fn default_email_attr() -> String {
    "email".into()
}
fn default_name_attr() -> String {
    "displayName".into()
}
fn default_groups_attr() -> String {
    "groups".into()
}

impl Default for AttributeMap {
    fn default() -> Self {
        Self {
            email: default_email_attr(),
            name: default_name_attr(),
            groups: default_groups_attr(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SamlConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_display_name")]
    pub display_name: String,
    /// Stored IdP metadata (fetched from `idp_metadata_url` at save time when given).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idp_metadata_xml: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idp_metadata_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sp_entity_id: Option<String>,
    #[serde(default)]
    pub attribute_map: AttributeMap,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub admin_group: Option<String>,
    #[serde(default)]
    pub sign_requests: bool,
    #[serde(default)]
    pub allow_idp_initiated: bool,
    #[serde(flatten)]
    pub policy: ProviderPolicy,
}

fn default_display_name() -> String {
    "Corporate SSO (SAML)".into()
}

impl Default for SamlConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            display_name: default_display_name(),
            idp_metadata_xml: None,
            idp_metadata_url: None,
            sp_entity_id: None,
            attribute_map: AttributeMap::default(),
            admin_group: None,
            sign_requests: false,
            allow_idp_initiated: false,
            policy: ProviderPolicy::default(),
        }
    }
}

impl SamlConfig {
    pub fn sp_entity_id(&self, config: &Config) -> String {
        self.sp_entity_id
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| format!("{}/saml", config.public_url))
    }

    /// Admin group works like a mapping rule that grants admin.
    pub fn effective_policy(&self) -> ProviderPolicy {
        let mut p = self.policy.clone();
        if let Some(g) = self.admin_group.as_deref().filter(|g| !g.trim().is_empty()) {
            p.mappings.insert(
                0,
                sso::Mapping {
                    idp_group: g.trim().to_string(),
                    role: Some(crate::db::models::Role::Admin),
                    groups: vec![],
                },
            );
        }
        p
    }
}

/// Admin-facing config view plus derived SP endpoints.
#[derive(Debug, Serialize)]
pub struct SamlConfigPublic {
    #[serde(flatten)]
    pub config: SamlConfig,
    pub sp_entity_id_effective: String,
    pub acs_url: String,
    pub metadata_url: String,
    pub sp_certificate_pem: Option<String>,
    pub idp: Option<IdpSummary>,
}

#[derive(Debug, Clone, Serialize)]
pub struct IdpSummary {
    pub entity_id: String,
    pub sso_url: String,
    pub certificates: usize,
}

pub fn acs_url(config: &Config) -> String {
    format!("{}/api/auth/saml/acs", config.public_url)
}

pub async fn load(db: &db::Db) -> Result<SamlConfig> {
    Ok(match settings::get(db, SETTINGS_KEY).await? {
        Some(json) => serde_json::from_str(&json).unwrap_or_default(),
        None => SamlConfig::default(),
    })
}

pub async fn store(db: &db::Db, cfg: &SamlConfig) -> Result<()> {
    settings::put(db, SETTINGS_KEY, &serde_json::to_string(cfg)?).await
}

pub async fn public_view(state: &AppState, cfg: &SamlConfig) -> Result<SamlConfigPublic> {
    let idp = cfg
        .idp_metadata_xml
        .as_deref()
        .and_then(|xml| parse_idp_metadata(xml).ok())
        .map(|m| IdpSummary {
            entity_id: m.entity_id,
            sso_url: m.sso_redirect_url,
            certificates: m.certificates_der.len(),
        });
    Ok(SamlConfigPublic {
        sp_entity_id_effective: cfg.sp_entity_id(&state.config),
        acs_url: acs_url(&state.config),
        metadata_url: format!("{}/api/auth/saml/metadata", state.config.public_url),
        sp_certificate_pem: settings::get(&state.db, SP_CERT_SETTING).await?,
        idp,
        config: cfg.clone(),
    })
}

// ── IdP metadata ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct IdpMetadata {
    pub entity_id: String,
    pub sso_redirect_url: String,
    pub certificates_der: Vec<Vec<u8>>,
}

pub fn parse_idp_metadata(xml: &str) -> Result<IdpMetadata> {
    use base64::Engine;
    let doc = roxmltree::Document::parse(xml).context("IdP metadata is not well-formed XML")?;
    let root = doc.root_element();
    let entity = if root.has_tag_name((NS_MD, "EntityDescriptor")) {
        root
    } else {
        root.descendants()
            .find(|n| n.has_tag_name((NS_MD, "EntityDescriptor")))
            .context("no EntityDescriptor in IdP metadata")?
    };
    let entity_id = entity
        .attribute("entityID")
        .context("EntityDescriptor has no entityID")?
        .to_string();
    let idp = entity
        .children()
        .find(|n| n.has_tag_name((NS_MD, "IDPSSODescriptor")))
        .context("metadata has no IDPSSODescriptor")?;
    let sso_redirect_url = idp
        .children()
        .filter(|n| n.has_tag_name((NS_MD, "SingleSignOnService")))
        .find(|n| n.attribute("Binding") == Some(BINDING_REDIRECT))
        .and_then(|n| n.attribute("Location"))
        .context("IdP metadata has no HTTP-Redirect SingleSignOnService")?
        .to_string();
    let mut certificates_der = Vec::new();
    for kd in idp
        .children()
        .filter(|n| n.has_tag_name((NS_MD, "KeyDescriptor")))
        .filter(|n| matches!(n.attribute("use"), None | Some("signing")))
    {
        for cert in kd
            .descendants()
            .filter(|n| n.has_tag_name((NS_DS, "X509Certificate")))
        {
            let b64: String = cert
                .text()
                .unwrap_or_default()
                .chars()
                .filter(|c| !c.is_whitespace())
                .collect();
            if let Ok(der) = base64::engine::general_purpose::STANDARD.decode(b64) {
                certificates_der.push(der);
            }
        }
    }
    if certificates_der.is_empty() {
        bail!("IdP metadata has no signing certificate");
    }
    Ok(IdpMetadata {
        entity_id,
        sso_redirect_url,
        certificates_der,
    })
}

pub async fn fetch_metadata(url: &str) -> Result<String> {
    if !url.starts_with("https://")
        && !url.starts_with("http://localhost")
        && !url.starts_with("http://127.0.0.1")
    {
        bail!("idp_metadata_url must be https://");
    }
    let xml = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()?
        .get(url)
        .send()
        .await
        .with_context(|| format!("fetching {url}"))?
        .error_for_status()?
        .text()
        .await?;
    parse_idp_metadata(&xml)?;
    Ok(xml)
}

// ── SP key material ──────────────────────────────────────────────────────────

pub struct SpKeys {
    pub key_pem: String,
    pub cert_pem: String,
}

/// Load or generate the SP signing key + self-signed certificate (key sealed at rest).
pub async fn sp_keys(state: &AppState) -> Result<SpKeys> {
    if let (Some(key), Some(cert)) = (
        settings::get(&state.db, SP_KEY_SETTING).await?,
        settings::get(&state.db, SP_CERT_SETTING).await?,
    ) {
        return Ok(SpKeys {
            key_pem: settings::open(&state.config, &key)?,
            cert_pem: cert,
        });
    }
    let host = state.config.public_host();
    let keys = tokio::task::spawn_blocking(move || generate_sp_keys(&host))
        .await
        .context("key generation task")??;
    settings::put(
        &state.db,
        SP_KEY_SETTING,
        &settings::seal(&state.config, &keys.key_pem),
    )
    .await?;
    settings::put(&state.db, SP_CERT_SETTING, &keys.cert_pem).await?;
    tracing::info!("generated the SAML service provider key and certificate");
    Ok(keys)
}

pub fn generate_sp_keys(host: &str) -> Result<SpKeys> {
    use rsa::pkcs8::{EncodePrivateKey, LineEnding};
    let mut rng = rand_core::OsRng;
    let key = rsa::RsaPrivateKey::new(&mut rng, 2048).context("generating RSA key")?;
    let key_pem = key
        .to_pkcs8_pem(LineEnding::LF)
        .context("encoding key")?
        .to_string();
    let kp = rcgen::KeyPair::from_pkcs8_pem_and_sign_algo(&key_pem, &rcgen::PKCS_RSA_SHA256)
        .context("loading key into rcgen")?;
    let mut params =
        rcgen::CertificateParams::new(vec![host.to_string()]).context("certificate params")?;
    params
        .distinguished_name
        .push(rcgen::DnType::CommonName, host);
    params.not_before = rcgen::date_time_ymd(2024, 1, 1);
    params.not_after = rcgen::date_time_ymd(2044, 1, 1);
    let cert = params
        .self_signed(&kp)
        .context("self-signing SP certificate")?;
    Ok(SpKeys {
        key_pem,
        cert_pem: cert.pem(),
    })
}

fn cert_pem_to_b64(pem: &str) -> String {
    pem.lines()
        .filter(|l| !l.starts_with("-----"))
        .collect::<Vec<_>>()
        .join("")
}

// ── SP metadata ──────────────────────────────────────────────────────────────

pub fn sp_metadata_xml(config: &Config, cfg: &SamlConfig, sp_cert_pem: Option<&str>) -> String {
    let entity_id = xml_escape(&cfg.sp_entity_id(config));
    let acs = xml_escape(&acs_url(config));
    let key_descriptor = match (cfg.sign_requests, sp_cert_pem) {
        (true, Some(pem)) => format!(
            "<md:KeyDescriptor use=\"signing\"><ds:KeyInfo xmlns:ds=\"{NS_DS}\"><ds:X509Data>\
             <ds:X509Certificate>{}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>",
            cert_pem_to_b64(pem)
        ),
        _ => String::new(),
    };
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\
<md:EntityDescriptor xmlns:md=\"{NS_MD}\" entityID=\"{entity_id}\">\
<md:SPSSODescriptor AuthnRequestsSigned=\"{signed}\" WantAssertionsSigned=\"true\" \
protocolSupportEnumeration=\"{NS_SAMLP}\">{key_descriptor}\
<md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>\
<md:NameIDFormat>urn:oasis:names:tc:SAML:2.0:nameid-format:persistent</md:NameIDFormat>\
<md:AssertionConsumerService Binding=\"{BINDING_POST}\" Location=\"{acs}\" index=\"0\" isDefault=\"true\"/>\
</md:SPSSODescriptor></md:EntityDescriptor>",
        signed = cfg.sign_requests
    )
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

// ── SP-initiated request ─────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct PendingRequest {
    pub request_id: String,
    pub return_to: String,
}

fn request_id() -> String {
    format!("_{}", crate::ids::base62(32))
}

/// Build the redirect URL for an AuthnRequest and remember its id; returns `(state_id, url)`.
pub async fn start(
    state: &AppState,
    cfg: &SamlConfig,
    return_to: String,
) -> Result<(String, String), ApiError> {
    use base64::Engine;
    let meta = cfg
        .idp_metadata_xml
        .as_deref()
        .ok_or_else(|| ApiError::validation("SAML is not configured: IdP metadata missing"))
        .and_then(|xml| {
            parse_idp_metadata(xml)
                .map_err(|e| ApiError::validation(format!("IdP metadata: {e:#}")))
        })?;
    let request_id = request_id();
    let pending = PendingRequest {
        request_id: request_id.clone(),
        return_to,
    };
    let state_id = db::auth::put_state(
        &state.db,
        REQUEST_STATE_KIND,
        None,
        &pending,
        Duration::minutes(crate::auth::PREAUTH_TTL_MINUTES),
    )
    .await?;
    let issue_instant = Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let request = format!(
        "<samlp:AuthnRequest xmlns:samlp=\"{NS_SAMLP}\" xmlns:saml=\"{NS_SAML}\" ID=\"{id}\" \
Version=\"2.0\" IssueInstant=\"{issue_instant}\" Destination=\"{dest}\" \
ProtocolBinding=\"{BINDING_POST}\" AssertionConsumerServiceURL=\"{acs}\">\
<saml:Issuer>{issuer}</saml:Issuer>\
<samlp:NameIDPolicy AllowCreate=\"true\"/>\
</samlp:AuthnRequest>",
        id = request_id,
        dest = xml_escape(&meta.sso_redirect_url),
        acs = xml_escape(&acs_url(&state.config)),
        issuer = xml_escape(&cfg.sp_entity_id(&state.config)),
    );
    let mut enc = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
    let deflated = enc
        .write_all(request.as_bytes())
        .and_then(|_| enc.finish())
        .map_err(|e| ApiError::internal(format!("deflating AuthnRequest: {e}")))?;
    let saml_request = base64::engine::general_purpose::STANDARD.encode(deflated);
    let mut query = format!(
        "SAMLRequest={}&RelayState={}",
        urlenc(&saml_request),
        urlenc(&state_id)
    );
    if cfg.sign_requests {
        query.push_str(&format!("&SigAlg={}", urlenc(SIG_ALG_RSA_SHA256)));
        let keys = sp_keys(state).await?;
        let sig = sign_redirect_query(&keys.key_pem, &query)
            .map_err(|e| ApiError::internal(format!("signing AuthnRequest: {e:#}")))?;
        query.push_str(&format!("&Signature={}", urlenc(&sig)));
    }
    let sep = if meta.sso_redirect_url.contains('?') {
        '&'
    } else {
        '?'
    };
    Ok((state_id, format!("{}{sep}{query}", meta.sso_redirect_url)))
}

/// Percent-encode a query value (RFC 3986 unreserved characters kept).
fn urlenc(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// RSA-SHA256 (PKCS#1 v1.5) over the redirect-binding query string, base64.
pub fn sign_redirect_query(key_pem: &str, query: &str) -> Result<String> {
    use base64::Engine;
    use rsa::pkcs8::DecodePrivateKey;
    use rsa::signature::{SignatureEncoding, Signer};
    let key = rsa::RsaPrivateKey::from_pkcs8_pem(key_pem).context("SP key")?;
    let signer = rsa::pkcs1v15::SigningKey::<sha2::Sha256>::new(key);
    let sig = signer.sign(query.as_bytes());
    Ok(base64::engine::general_purpose::STANDARD.encode(sig.to_bytes()))
}

// ── assertion consumer service ───────────────────────────────────────────────

pub struct AcsResult {
    pub identity: SsoIdentity,
    pub return_to: String,
}

/// Validate a `SAMLResponse` (base64 XML) and extract the identity.
pub async fn consume(
    state: &AppState,
    cfg: &SamlConfig,
    saml_response_b64: &str,
    relay_state: Option<&str>,
) -> Result<AcsResult, ApiError> {
    use base64::Engine;
    let meta = cfg
        .idp_metadata_xml
        .as_deref()
        .ok_or_else(|| ApiError::validation("SAML is not configured"))
        .and_then(|xml| {
            parse_idp_metadata(xml)
                .map_err(|e| ApiError::validation(format!("IdP metadata: {e:#}")))
        })?;
    let xml_bytes = base64::engine::general_purpose::STANDARD
        .decode(saml_response_b64.trim().replace(['\n', '\r', ' '], ""))
        .map_err(|_| bad("SAMLResponse is not base64"))?;
    if xml_bytes.len() > 512 * 1024 {
        return Err(bad("SAMLResponse is too large"));
    }
    let xml = String::from_utf8(xml_bytes).map_err(|_| bad("SAMLResponse is not UTF-8"))?;

    // Signature first: nothing below is trusted before this passes.
    let signed_ids = verify_signature(&xml, &meta.certificates_der).map_err(|e| {
        tracing::warn!("SAML signature rejected: {e:#}");
        bad("SAML response signature is invalid")
    })?;

    let doc = roxmltree::Document::parse(&xml).map_err(|_| bad("SAMLResponse is not XML"))?;
    let response = doc.root_element();
    if !response.has_tag_name((NS_SAMLP, "Response")) {
        return Err(bad("expected a samlp:Response"));
    }
    let status = response
        .children()
        .find(|n| n.has_tag_name((NS_SAMLP, "Status")))
        .and_then(|s| {
            s.children()
                .find(|n| n.has_tag_name((NS_SAMLP, "StatusCode")))
        })
        .and_then(|c| c.attribute("Value"))
        .unwrap_or_default();
    if status != "urn:oasis:names:tc:SAML:2.0:status:Success" {
        return Err(bad(format!("identity provider returned status {status}")));
    }
    if response
        .attribute("Destination")
        .is_some_and(|d| d != acs_url(&state.config))
    {
        return Err(bad("response Destination does not match this console"));
    }
    let assertion = response
        .children()
        .find(|n| n.has_tag_name((NS_SAML, "Assertion")))
        .ok_or_else(|| {
            bad("response has no plain Assertion (encrypted assertions are not supported)")
        })?;
    let response_id = response.attribute("ID").unwrap_or_default();
    let assertion_id = assertion.attribute("ID").unwrap_or_default().to_string();
    if !signed_ids
        .iter()
        .any(|id| id == response_id || id == &assertion_id)
    {
        return Err(bad(
            "the signature does not cover the response or its assertion",
        ));
    }

    // Issuer.
    let issuer = assertion
        .children()
        .find(|n| n.has_tag_name((NS_SAML, "Issuer")))
        .and_then(|n| n.text())
        .map(str::trim)
        .unwrap_or_default();
    if issuer != meta.entity_id {
        return Err(bad("assertion issuer does not match the IdP entity id"));
    }

    // Conditions.
    let now = Utc::now();
    if let Some(cond) = assertion
        .children()
        .find(|n| n.has_tag_name((NS_SAML, "Conditions")))
    {
        if let Some(nb) = cond.attribute("NotBefore").and_then(parse_instant) {
            if now + Duration::seconds(CLOCK_SKEW_SECS) < nb {
                return Err(bad("assertion is not yet valid"));
            }
        }
        if let Some(na) = cond.attribute("NotOnOrAfter").and_then(parse_instant) {
            if now - Duration::seconds(CLOCK_SKEW_SECS) >= na {
                return Err(bad("assertion has expired"));
            }
        }
        let audiences: Vec<&str> = cond
            .descendants()
            .filter(|n| n.has_tag_name((NS_SAML, "Audience")))
            .filter_map(|n| n.text())
            .map(str::trim)
            .collect();
        let sp = cfg.sp_entity_id(&state.config);
        if !audiences.is_empty() && !audiences.iter().any(|a| *a == sp) {
            return Err(bad(
                "assertion audience does not include this service provider",
            ));
        }
    }

    // Subject confirmation + InResponseTo.
    let subject = assertion
        .children()
        .find(|n| n.has_tag_name((NS_SAML, "Subject")))
        .ok_or_else(|| bad("assertion has no Subject"))?;
    let name_id = subject
        .children()
        .find(|n| n.has_tag_name((NS_SAML, "NameID")))
        .and_then(|n| n.text())
        .map(str::trim)
        .unwrap_or_default()
        .to_string();
    let mut in_response_to: Option<String> = response.attribute("InResponseTo").map(str::to_string);
    if let Some(scd) = subject
        .children()
        .filter(|n| n.has_tag_name((NS_SAML, "SubjectConfirmation")))
        .find(|n| {
            matches!(
                n.attribute("Method"),
                None | Some("urn:oasis:names:tc:SAML:2.0:cm:bearer")
            )
        })
        .and_then(|n| {
            n.children()
                .find(|c| c.has_tag_name((NS_SAML, "SubjectConfirmationData")))
        })
    {
        if let Some(r) = scd.attribute("Recipient") {
            if r != acs_url(&state.config) {
                return Err(bad(
                    "subject confirmation Recipient does not match this console",
                ));
            }
        }
        if let Some(na) = scd.attribute("NotOnOrAfter").and_then(parse_instant) {
            if now - Duration::seconds(CLOCK_SKEW_SECS) >= na {
                return Err(bad("subject confirmation has expired"));
            }
        }
        if let Some(irt) = scd.attribute("InResponseTo") {
            in_response_to.get_or_insert_with(|| irt.to_string());
        }
    }
    let return_to = match (in_response_to, relay_state) {
        (Some(irt), Some(rs)) => {
            let row = db::auth::get_state(&state.db, rs, REQUEST_STATE_KIND)
                .await?
                .ok_or_else(|| bad("the sign-in request expired; start again"))?;
            let pending: PendingRequest =
                db::auth::decode_state(&row).ok_or_else(|| bad("corrupt request state"))?;
            db::auth::delete_state(&state.db, rs).await?;
            if pending.request_id != irt {
                return Err(bad("InResponseTo does not match the pending request"));
            }
            pending.return_to
        }
        (None, _) if cfg.allow_idp_initiated => "/devices".to_string(),
        (None, _) => return Err(bad("unsolicited (IdP-initiated) responses are not enabled")),
        (Some(_), None) => return Err(bad("missing RelayState for a solicited response")),
    };

    // Replay protection: remember the assertion id until it expires.
    if assertion_id.is_empty() {
        return Err(bad("assertion has no ID"));
    }
    if db::auth::state_exists(&state.db, &assertion_id, ASSERTION_STATE_KIND).await? {
        return Err(bad("assertion replayed"));
    }
    db::auth::put_state_with_id(
        &state.db,
        &assertion_id,
        ASSERTION_STATE_KIND,
        None,
        &serde_json::json!({}),
        Duration::hours(8),
    )
    .await?;

    // Attributes.
    let attrs: Vec<(String, Vec<String>)> = assertion
        .children()
        .filter(|n| n.has_tag_name((NS_SAML, "AttributeStatement")))
        .flat_map(|st| {
            st.children()
                .filter(|n| n.has_tag_name((NS_SAML, "Attribute")))
        })
        .map(|a| {
            let values = a
                .children()
                .filter(|n| n.has_tag_name((NS_SAML, "AttributeValue")))
                .filter_map(|v| v.text())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            (a.attribute("Name").unwrap_or_default().to_string(), values)
        })
        .chain(
            assertion
                .children()
                .filter(|n| n.has_tag_name((NS_SAML, "AttributeStatement")))
                .flat_map(|st| {
                    st.children()
                        .filter(|n| n.has_tag_name((NS_SAML, "Attribute")))
                })
                .filter_map(|a| {
                    a.attribute("FriendlyName").map(|f| {
                        (
                            f.to_string(),
                            a.children()
                                .filter(|n| n.has_tag_name((NS_SAML, "AttributeValue")))
                                .filter_map(|v| v.text())
                                .map(|s| s.trim().to_string())
                                .collect(),
                        )
                    })
                }),
        )
        .collect();
    let attr = |name: &str| -> Vec<String> {
        attrs
            .iter()
            .filter(|(n, _)| n.eq_ignore_ascii_case(name) || n.ends_with(&format!("/{name}")))
            .flat_map(|(_, v)| v.clone())
            .collect()
    };
    let email = attr(&cfg.attribute_map.email)
        .into_iter()
        .next()
        .or_else(|| attr("mail").into_iter().next())
        .or_else(|| attr("emailaddress").into_iter().next())
        .or_else(|| name_id.contains('@').then(|| name_id.clone()))
        .unwrap_or_default();
    let name = attr(&cfg.attribute_map.name)
        .into_iter()
        .next()
        .or_else(|| attr("cn").into_iter().next())
        .unwrap_or_default();
    let groups = attr(&cfg.attribute_map.groups);
    let contexts: Vec<String> = assertion
        .descendants()
        .filter(|n| n.has_tag_name((NS_SAML, "AuthnContextClassRef")))
        .filter_map(|n| n.text())
        .map(|s| s.trim().to_string())
        .collect();
    let subject_id = if name_id.is_empty() {
        email.clone()
    } else {
        name_id
    };
    Ok(AcsResult {
        identity: SsoIdentity {
            provider: AuthMethod::Saml,
            subject: subject_id,
            email,
            email_verified: true,
            name,
            groups,
            mfa: sso::indicates_mfa(contexts.iter().map(String::as_str)),
        },
        return_to,
    })
}

fn parse_instant(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s)
        .map(|d| d.with_timezone(&Utc))
        .ok()
}

fn bad(message: impl Into<String>) -> ApiError {
    ApiError::new(axum::http::StatusCode::BAD_REQUEST, "saml_invalid", message)
}

/// Verify the first XML signature in the document against any of the IdP certificates.
/// Returns the element ids the signature covers (`#id` references without the `#`).
pub fn verify_signature(xml: &str, certificates_der: &[Vec<u8>]) -> Result<Vec<String>> {
    use xml_sec::xmldsig::{DsigStatus, SignatureAlgorithm, VerificationKey, VerifyContext};
    use xml_sec::IdAttributeRegistration;
    let ids = [IdAttributeRegistration::global("ID")];
    let mut last_err = anyhow::anyhow!("no IdP certificate available");
    for der in certificates_der {
        let (_, cert) = x509_parser::parse_x509_certificate(der).context("IdP certificate")?;
        let key = VerificationKey {
            algorithm: SignatureAlgorithm::RsaSha256,
            public_key_bytes: cert.public_key().raw.to_vec(),
            certificate_der: None,
            name: None,
        };
        let result = VerifyContext::new()
            .key(&key)
            .id_attributes(&ids)
            .first_document_signature()
            .verify(xml);
        match result {
            Ok(r) if matches!(r.status, DsigStatus::Valid) => {
                return Ok(r
                    .signed_info_references
                    .iter()
                    .map(|reference| reference.uri.trim_start_matches('#').to_string())
                    .collect());
            }
            Ok(r) => last_err = anyhow::anyhow!("signature status {:?}", r.status),
            Err(e) => last_err = anyhow::anyhow!("{e}"),
        }
    }
    Err(last_err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urlenc_matches_rfc3986() {
        assert_eq!(urlenc("a b/c+d=e"), "a%20b%2Fc%2Bd%3De");
        assert_eq!(urlenc("~-_."), "~-_.");
    }

    #[test]
    fn parses_metadata() {
        let xml = r#"<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://idp.example/x">
  <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>
    AAEC
    </ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://idp.example/post"/>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example/sso"/>
  </md:IDPSSODescriptor></md:EntityDescriptor>"#;
        let m = parse_idp_metadata(xml).unwrap();
        assert_eq!(m.entity_id, "https://idp.example/x");
        assert_eq!(m.sso_redirect_url, "https://idp.example/sso");
        assert_eq!(m.certificates_der, vec![vec![0, 1, 2]]);
    }

    #[test]
    fn sp_metadata_is_well_formed() {
        let cfg = Config::for_tests("sqlite://x".into());
        let xml = sp_metadata_xml(&cfg, &SamlConfig::default(), None);
        let doc = roxmltree::Document::parse(&xml).unwrap();
        assert_eq!(
            doc.root_element().attribute("entityID").unwrap(),
            "http://localhost:8080/saml"
        );
        assert!(xml.contains("/api/auth/saml/acs"));
    }
}
