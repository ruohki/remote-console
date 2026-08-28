//! LDAP / Active Directory sign-in via simple bind.
//!
//! The console binds with a read-only service account, searches for the user, then re-binds as
//! the user's DN with the supplied password. Group membership comes from the user's `memberOf`
//! (or configured) attribute and feeds the same role/group mapping as OIDC/SAML. GSSAPI is
//! deliberately not supported: the console usually runs in a container without a keytab.

use crate::auth::sso::{self, ProviderPolicy, SsoIdentity};
use crate::db::{self, models::AuthMethod, settings};
use crate::error::ApiError;
use anyhow::{bail, Context, Result};
use ldap3::{ldap_escape, LdapConnAsync, LdapConnSettings, Scope, SearchEntry};
use serde::{Deserialize, Serialize};
use std::time::Duration;

pub const SETTINGS_KEY: &str = "ldap_config";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LdapAttributeMap {
    #[serde(default = "default_email_attr")]
    pub email: String,
    #[serde(default = "default_name_attr")]
    pub name: String,
    #[serde(default = "default_groups_attr")]
    pub groups: String,
}

fn default_email_attr() -> String {
    "mail".into()
}
fn default_name_attr() -> String {
    "displayName".into()
}
fn default_groups_attr() -> String {
    "memberOf".into()
}

impl Default for LdapAttributeMap {
    fn default() -> Self {
        Self {
            email: default_email_attr(),
            name: default_name_attr(),
            groups: default_groups_attr(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LdapConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_display_name")]
    pub display_name: String,
    /// `ldap://host:389` or `ldaps://host:636`.
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub starttls: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ca_cert_pem: Option<String>,
    #[serde(default)]
    pub bind_dn: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bind_password_enc: Option<String>,
    #[serde(default)]
    pub base_dn: String,
    /// `{username}` is replaced by the (escaped) login name.
    #[serde(default = "default_user_filter")]
    pub user_filter: String,
    #[serde(default)]
    pub attribute_map: LdapAttributeMap,
    /// Whether to use `groups` values as full DNs or reduce them to their first RDN value.
    #[serde(default = "default_true")]
    pub group_short_names: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub admin_group: Option<String>,
    #[serde(flatten)]
    pub policy: ProviderPolicy,
}

fn default_display_name() -> String {
    "Directory (LDAP)".into()
}
fn default_user_filter() -> String {
    "(|(uid={username})(sAMAccountName={username})(mail={username}))".into()
}
fn default_true() -> bool {
    true
}

impl Default for LdapConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            display_name: default_display_name(),
            url: String::new(),
            starttls: false,
            ca_cert_pem: None,
            bind_dn: String::new(),
            bind_password_enc: None,
            base_dn: String::new(),
            user_filter: default_user_filter(),
            attribute_map: LdapAttributeMap::default(),
            group_short_names: true,
            admin_group: None,
            policy: ProviderPolicy::default(),
        }
    }
}

impl LdapConfig {
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

#[derive(Debug, Serialize)]
pub struct LdapConfigPublic {
    #[serde(flatten)]
    pub config: LdapConfig,
    pub bind_password_set: bool,
}

/// Admin input: the bind password is write-only.
#[derive(Debug, Deserialize)]
pub struct LdapConfigInput {
    #[serde(flatten)]
    pub config: LdapConfig,
    #[serde(default)]
    pub bind_password: Option<String>,
}

pub async fn load(db: &db::Db) -> Result<LdapConfig> {
    Ok(match settings::get(db, SETTINGS_KEY).await? {
        Some(json) => serde_json::from_str(&json).unwrap_or_default(),
        None => LdapConfig::default(),
    })
}

pub async fn store(db: &db::Db, cfg: &LdapConfig) -> Result<()> {
    settings::put(db, SETTINGS_KEY, &serde_json::to_string(cfg)?).await
}

pub fn public_view(cfg: &LdapConfig) -> LdapConfigPublic {
    let mut c = cfg.clone();
    let set = c.bind_password_enc.take().is_some();
    LdapConfigPublic {
        config: c,
        bind_password_set: set,
    }
}

/// Merge admin input over the stored config, keeping the sealed bind password when absent.
pub fn merge_input(
    config: &crate::config::Config,
    existing: &LdapConfig,
    input: LdapConfigInput,
) -> Result<LdapConfig, ApiError> {
    let mut cfg = input.config;
    let name = cfg.display_name.trim();
    if name.is_empty() || name.len() > 60 {
        return Err(ApiError::validation("display_name must be 1–60 characters"));
    }
    cfg.display_name = name.to_string();
    cfg.url = cfg.url.trim().to_string();
    if cfg.enabled {
        if !(cfg.url.starts_with("ldap://") || cfg.url.starts_with("ldaps://")) {
            return Err(ApiError::validation(
                "url must start with ldap:// or ldaps://",
            ));
        }
        if cfg.base_dn.trim().is_empty() {
            return Err(ApiError::validation("base_dn is required"));
        }
        if !cfg.user_filter.contains("{username}") {
            return Err(ApiError::validation("user_filter must contain {username}"));
        }
    }
    cfg.bind_password_enc = match input.bind_password {
        Some(p) if !p.is_empty() => Some(settings::seal(config, &p)),
        Some(_) => None,
        None => existing.bind_password_enc.clone(),
    };
    Ok(cfg)
}

struct Conn {
    ldap: ldap3::Ldap,
}

async fn connect(cfg: &LdapConfig) -> Result<Conn> {
    let mut s = LdapConnSettings::new()
        .set_conn_timeout(Duration::from_secs(10))
        .set_starttls(cfg.starttls);
    if let Some(pem) = cfg.ca_cert_pem.as_deref().filter(|p| !p.trim().is_empty()) {
        let mut roots = rustls::RootCertStore::empty();
        for cert in rustls_pemfile::certs(&mut pem.as_bytes()) {
            roots.add(cert.context("ca_cert_pem")?)?;
        }
        let tls = rustls::ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth();
        s = s.set_config(std::sync::Arc::new(tls));
    }
    let (conn, ldap) = LdapConnAsync::with_settings(s, &cfg.url)
        .await
        .with_context(|| format!("connecting to {}", cfg.url))?;
    ldap3::drive!(conn);
    Ok(Conn { ldap })
}

fn short_group_name(dn: &str) -> String {
    dn.split(',')
        .next()
        .and_then(|rdn| rdn.split_once('='))
        .map(|(_, v)| v.trim().to_string())
        .unwrap_or_else(|| dn.to_string())
}

/// Verify the service-account bind and base DN (admin "test connection").
pub async fn test_connection(config: &crate::config::Config, cfg: &LdapConfig) -> Result<String> {
    let mut conn = connect(cfg).await?;
    service_bind(config, cfg, &mut conn).await?;
    let (rs, _) = conn
        .ldap
        .search(
            &cfg.base_dn,
            Scope::Base,
            "(objectClass=*)",
            vec!["objectClass"],
        )
        .await
        .context("base DN search")?
        .success()
        .context("base DN search")?;
    let _ = conn.ldap.unbind().await;
    Ok(format!(
        "bind OK, base DN reachable ({} entr{})",
        rs.len(),
        if rs.len() == 1 { "y" } else { "ies" }
    ))
}

async fn service_bind(
    config: &crate::config::Config,
    cfg: &LdapConfig,
    conn: &mut Conn,
) -> Result<()> {
    if cfg.bind_dn.trim().is_empty() {
        return Ok(()); // anonymous search
    }
    let password = match cfg.bind_password_enc.as_deref() {
        Some(enc) => settings::open(config, enc)?,
        None => String::new(),
    };
    conn.ldap
        .simple_bind(&cfg.bind_dn, &password)
        .await
        .context("service bind")?
        .success()
        .context("service account bind rejected")?;
    Ok(())
}

pub enum LdapLogin {
    Ok(SsoIdentity),
    BadCredentials,
}

/// Authenticate `username`/`password` against the directory.
pub async fn authenticate(
    config: &crate::config::Config,
    cfg: &LdapConfig,
    username: &str,
    password: &str,
) -> Result<LdapLogin> {
    if username.trim().is_empty() || password.is_empty() {
        return Ok(LdapLogin::BadCredentials);
    }
    let mut conn = connect(cfg).await?;
    service_bind(config, cfg, &mut conn).await?;
    let filter = cfg
        .user_filter
        .replace("{username}", &ldap_escape(username.trim()));
    let attrs = vec![
        cfg.attribute_map.email.as_str(),
        cfg.attribute_map.name.as_str(),
        cfg.attribute_map.groups.as_str(),
        "cn",
        "uid",
        "sAMAccountName",
    ];
    let (rs, _) = conn
        .ldap
        .search(&cfg.base_dn, Scope::Subtree, &filter, attrs)
        .await
        .context("user search")?
        .success()
        .context("user search")?;
    let entry = match rs.into_iter().next() {
        Some(e) => SearchEntry::construct(e),
        None => {
            let _ = conn.ldap.unbind().await;
            return Ok(LdapLogin::BadCredentials);
        }
    };
    let dn = entry.dn.clone();
    let bind = conn
        .ldap
        .simple_bind(&dn, password)
        .await
        .context("user bind")?;
    let _ = conn.ldap.unbind().await;
    if bind.rc != 0 {
        return Ok(LdapLogin::BadCredentials);
    }
    let first = |attr: &str| -> Option<String> {
        entry
            .attrs
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(attr))
            .and_then(|(_, v)| v.first().cloned())
            .filter(|v| !v.trim().is_empty())
    };
    let email = first(&cfg.attribute_map.email).unwrap_or_default();
    if email.is_empty() {
        bail!(
            "directory entry {dn} has no {} attribute",
            cfg.attribute_map.email
        );
    }
    let name = first(&cfg.attribute_map.name)
        .or_else(|| first("cn"))
        .unwrap_or_else(|| username.trim().to_string());
    let raw_groups: Vec<String> = entry
        .attrs
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(&cfg.attribute_map.groups))
        .map(|(_, v)| v.clone())
        .unwrap_or_default();
    let groups = if cfg.group_short_names {
        raw_groups.iter().map(|g| short_group_name(g)).collect()
    } else {
        raw_groups
    };
    Ok(LdapLogin::Ok(SsoIdentity {
        provider: AuthMethod::Ldap,
        subject: dn,
        email: email.to_lowercase(),
        email_verified: true,
        name,
        groups,
        mfa: false,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_names_from_dns() {
        assert_eq!(
            short_group_name("CN=Remote Admins,OU=Groups,DC=corp,DC=example"),
            "Remote Admins"
        );
        assert_eq!(short_group_name("plain"), "plain");
    }

    #[test]
    fn filter_escapes_username() {
        let cfg = LdapConfig::default();
        let f = cfg.user_filter.replace("{username}", &ldap_escape("a*b)("));
        assert!(!f.contains("a*b"));
        assert!(f.contains("a\\2ab\\29\\28"));
    }

    #[test]
    fn public_view_hides_secret() {
        let cfg = LdapConfig {
            bind_password_enc: Some("enc:v1:x".into()),
            ..Default::default()
        };
        let v = public_view(&cfg);
        assert!(v.bind_password_set);
        let json = serde_json::to_string(&v).unwrap();
        assert!(!json.contains("enc:v1"));
    }
}
