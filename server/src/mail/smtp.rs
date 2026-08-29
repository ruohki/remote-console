//! SMTP configuration (admin setting, password sealed) and the SMTP [`Mailer`].

use super::{Mailer, OutgoingMail};
use crate::config::Config;
use crate::db::{self, settings};
use crate::error::ApiError;
use anyhow::{bail, Context, Result};
use lettre::message::header::ContentType;
use lettre::message::{Attachment, Mailbox, MultiPart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;

pub const SETTINGS_KEY: &str = "smtp_config";
const SEND_TIMEOUT: Duration = Duration::from_secs(15);

/// How the connection to the relay is protected.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SmtpSecurity {
    /// Plain connection upgraded with STARTTLS (port 587).
    #[default]
    Starttls,
    /// Implicit TLS from the first byte (port 465).
    Tls,
    /// No encryption at all — only for relays on a trusted network.
    None,
}

/// Stored configuration (`password_enc` sealed with the master key when set).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SmtpConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub security: SmtpSecurity,
    #[serde(default)]
    pub username: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password_enc: Option<String>,
    #[serde(default)]
    pub from_address: String,
    /// Display name of the sender; empty means the branding product name.
    #[serde(default)]
    pub from_name: String,
    #[serde(default)]
    pub reply_to: String,
}

fn default_port() -> u16 {
    587
}

impl Default for SmtpConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            host: String::new(),
            port: default_port(),
            security: SmtpSecurity::Starttls,
            username: String::new(),
            password_enc: None,
            from_address: String::new(),
            from_name: String::new(),
            reply_to: String::new(),
        }
    }
}

/// Admin-facing view: the password is never returned, only whether one is set.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SmtpConfigPublic {
    pub enabled: bool,
    pub host: String,
    pub port: u16,
    pub security: SmtpSecurity,
    pub username: String,
    pub password_set: bool,
    pub from_address: String,
    pub from_name: String,
    pub reply_to: String,
}

/// Body of `PUT /api/email/config` (password optional: keep the stored one when absent/empty).
#[derive(Debug, Clone, Deserialize)]
pub struct SmtpConfigInput {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub security: SmtpSecurity,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub from_address: String,
    #[serde(default)]
    pub from_name: String,
    #[serde(default)]
    pub reply_to: String,
}

impl SmtpConfig {
    pub fn public(&self) -> SmtpConfigPublic {
        SmtpConfigPublic {
            enabled: self.enabled,
            host: self.host.clone(),
            port: self.port,
            security: self.security,
            username: self.username.clone(),
            password_set: self.password_enc.is_some(),
            from_address: self.from_address.clone(),
            from_name: self.from_name.clone(),
            reply_to: self.reply_to.clone(),
        }
    }

    pub fn password(&self, config: &Config) -> Result<Option<String>> {
        match &self.password_enc {
            Some(enc) => settings::open(config, enc).map(Some),
            None => Ok(None),
        }
    }

    /// Enabled with a relay host and a sender address: mail can be attempted.
    pub fn is_usable(&self) -> bool {
        self.enabled && !self.host.is_empty() && !self.from_address.is_empty()
    }
}

pub async fn load(db: &db::Db) -> Result<SmtpConfig> {
    Ok(match settings::get(db, SETTINGS_KEY).await? {
        Some(json) => serde_json::from_str(&json).unwrap_or_default(),
        None => SmtpConfig::default(),
    })
}

pub async fn store(db: &db::Db, cfg: &SmtpConfig) -> Result<()> {
    settings::put(db, SETTINGS_KEY, &serde_json::to_string(cfg)?).await
}

/// Whether outgoing mail is enabled and configured (host + sender set).
pub async fn is_configured(db: &db::Db) -> bool {
    match load(db).await {
        Ok(cfg) => cfg.is_usable(),
        Err(err) => {
            tracing::warn!("reading the SMTP configuration failed: {err:#}");
            false
        }
    }
}

/// Validate and merge an admin update into the stored config.
pub fn merge_input(
    config: &Config,
    existing: &SmtpConfig,
    input: SmtpConfigInput,
) -> Result<SmtpConfig, ApiError> {
    let host = input.host.trim().to_string();
    let from_address = input.from_address.trim().to_string();
    let reply_to = input.reply_to.trim().to_string();
    if input.enabled && host.is_empty() {
        return Err(ApiError::validation("host is required to enable email"));
    }
    if host.len() > 253 || host.contains(char::is_whitespace) {
        return Err(ApiError::validation("host is not a valid hostname"));
    }
    if input.port == 0 {
        return Err(ApiError::validation("port must be 1–65535"));
    }
    if input.enabled || !from_address.is_empty() {
        crate::auth::validate_email(&from_address)
            .map_err(|_| ApiError::validation("from_address is not a valid email address"))?;
    }
    if !reply_to.is_empty() {
        crate::auth::validate_email(&reply_to)
            .map_err(|_| ApiError::validation("reply_to is not a valid email address"))?;
    }
    if input.from_name.chars().count() > 120 {
        return Err(ApiError::validation("from_name is too long"));
    }
    let password_enc = match input.password.as_deref() {
        Some(p) if !p.is_empty() => Some(settings::seal(config, p)),
        _ => existing.password_enc.clone(),
    };
    Ok(SmtpConfig {
        enabled: input.enabled,
        host,
        port: input.port,
        security: input.security,
        username: input.username.trim().to_string(),
        password_enc,
        from_address,
        from_name: input.from_name.trim().to_string(),
        reply_to,
    })
}

// ── sending ───────────────────────────────────────────────────────────────────

/// Sends through the relay from the stored configuration, read on every call.
pub struct SmtpMailer {
    db: db::Db,
    config: Arc<Config>,
}

impl SmtpMailer {
    pub fn new(db: db::Db, config: Arc<Config>) -> Self {
        Self { db, config }
    }

    async fn deliver(&self, cfg: &SmtpConfig, mail: OutgoingMail) -> Result<()> {
        if !cfg.is_usable() {
            bail!("email is not configured (enable SMTP and set a host and sender address)");
        }
        let product = settings::branding(&self.db)
            .await
            .map(|b| b.product_name)
            .unwrap_or_else(|_| settings::default_branding().product_name);
        let message = build_message(cfg, &product, mail)?;
        let transport = build_transport(&self.config, cfg)?;
        transport
            .send(message)
            .await
            .map(|_| ())
            .with_context(|| format!("sending through {}:{}", cfg.host, cfg.port))
    }
}

#[async_trait::async_trait]
impl Mailer for SmtpMailer {
    async fn send(&self, mail: OutgoingMail) -> Result<()> {
        let cfg = load(&self.db).await?;
        self.deliver(&cfg, mail).await
    }

    async fn send_with(&self, cfg: &SmtpConfig, mail: OutgoingMail) -> Result<()> {
        self.deliver(cfg, mail).await
    }
}

fn build_transport(
    config: &Config,
    cfg: &SmtpConfig,
) -> Result<AsyncSmtpTransport<Tokio1Executor>> {
    let mut builder = match cfg.security {
        SmtpSecurity::Starttls => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&cfg.host)
            .context("SMTP relay (STARTTLS)")?,
        SmtpSecurity::Tls => {
            AsyncSmtpTransport::<Tokio1Executor>::relay(&cfg.host).context("SMTP relay (TLS)")?
        }
        SmtpSecurity::None => AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&cfg.host),
    };
    builder = builder.port(cfg.port).timeout(Some(SEND_TIMEOUT));
    if !cfg.username.is_empty() {
        let password = cfg.password(config)?.unwrap_or_default();
        builder = builder.credentials(Credentials::new(cfg.username.clone(), password));
    }
    Ok(builder.build())
}

/// Assemble the MIME message: `multipart/alternative` (text + HTML), wrapped in
/// `multipart/related` with the inline logo when there is one.
pub fn build_message(cfg: &SmtpConfig, product_name: &str, mail: OutgoingMail) -> Result<Message> {
    if mail.to.is_empty() {
        bail!("message has no recipient");
    }
    let from_name = if cfg.from_name.trim().is_empty() {
        product_name.trim()
    } else {
        cfg.from_name.trim()
    };
    let from = Mailbox::new(
        (!from_name.is_empty()).then(|| from_name.to_string()),
        cfg.from_address
            .parse()
            .with_context(|| format!("sender address {:?}", cfg.from_address))?,
    );
    let mut builder = Message::builder().from(from).subject(&mail.subject);
    for r in &mail.to {
        builder = builder.to(Mailbox::new(
            r.name.clone(),
            r.address
                .parse()
                .with_context(|| format!("recipient address {:?}", r.address))?,
        ));
    }
    if !cfg.reply_to.is_empty() {
        builder = builder.reply_to(Mailbox::new(
            None,
            cfg.reply_to
                .parse()
                .with_context(|| format!("reply-to address {:?}", cfg.reply_to))?,
        ));
    }
    let alternative = MultiPart::alternative_plain_html(mail.text, mail.html);
    let body = match mail.inline_logo_png {
        Some(png) => MultiPart::related().multipart(alternative).singlepart(
            Attachment::new_inline("logo".to_string()).body(png, ContentType::parse("image/png")?),
        ),
        None => alternative,
    };
    builder.multipart(body).context("assembling the message")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mail::Recipient;

    fn sample(logo: bool) -> OutgoingMail {
        OutgoingMail {
            to: vec![Recipient::new("alice@example.com", Some("Alice".into()))],
            subject: "Hello".into(),
            text: "plain body".into(),
            html: "<p>html body <img src=\"cid:logo\"></p>".into(),
            inline_logo_png: logo.then(|| vec![0x89, b'P', b'N', b'G']),
        }
    }

    #[test]
    fn message_structure_with_and_without_logo() {
        let cfg = SmtpConfig {
            from_address: "console@example.com".into(),
            reply_to: "help@example.com".into(),
            ..SmtpConfig::default()
        };
        let msg = build_message(&cfg, "Acme Remote", sample(true)).unwrap();
        let raw = String::from_utf8(msg.formatted()).unwrap();
        assert!(
            raw.contains("From: \"Acme Remote\" <console@example.com>"),
            "{raw}"
        );
        assert!(raw.contains("Reply-To: help@example.com"), "{raw}");
        assert!(raw.contains("To: Alice <alice@example.com>"), "{raw}");
        assert!(raw.contains("multipart/related"), "{raw}");
        assert!(raw.contains("multipart/alternative"), "{raw}");
        assert!(raw.contains("Content-ID: <logo>"), "{raw}");
        assert!(raw.contains("Content-Disposition: inline"), "{raw}");

        let plain = build_message(&cfg, "Acme Remote", sample(false)).unwrap();
        let raw = String::from_utf8(plain.formatted()).unwrap();
        assert!(!raw.contains("multipart/related"), "{raw}");
        assert!(raw.contains("multipart/alternative"), "{raw}");
        assert!(raw.contains("plain body"), "{raw}");
    }

    #[test]
    fn explicit_from_name_wins_over_product() {
        let cfg = SmtpConfig {
            from_address: "console@example.com".into(),
            from_name: "IT Desk".into(),
            ..SmtpConfig::default()
        };
        let msg = build_message(&cfg, "Acme Remote", sample(false)).unwrap();
        let raw = String::from_utf8(msg.formatted()).unwrap();
        assert!(
            raw.contains("From: \"IT Desk\" <console@example.com>"),
            "{raw}"
        );
    }

    #[test]
    fn merge_validates_and_keeps_password() {
        let config = Config::for_tests("sqlite::memory:".into());
        let existing = SmtpConfig {
            password_enc: Some("keep".into()),
            ..SmtpConfig::default()
        };
        let input = SmtpConfigInput {
            enabled: true,
            host: " smtp.example.com ".into(),
            port: 587,
            security: SmtpSecurity::Starttls,
            username: "user".into(),
            password: None,
            from_address: "console@example.com".into(),
            from_name: "".into(),
            reply_to: "".into(),
        };
        let merged = merge_input(&config, &existing, input).unwrap();
        assert_eq!(merged.host, "smtp.example.com");
        assert_eq!(merged.password_enc.as_deref(), Some("keep"));
        assert!(merged.is_usable());

        let bad_host = SmtpConfigInput {
            enabled: true,
            host: "".into(),
            port: 587,
            security: SmtpSecurity::Starttls,
            username: "".into(),
            password: None,
            from_address: "console@example.com".into(),
            from_name: "".into(),
            reply_to: "".into(),
        };
        assert!(merge_input(&config, &existing, bad_host).is_err());
        let bad_port = SmtpConfigInput {
            enabled: false,
            host: "h".into(),
            port: 0,
            security: SmtpSecurity::None,
            username: "".into(),
            password: None,
            from_address: "".into(),
            from_name: "".into(),
            reply_to: "".into(),
        };
        assert!(merge_input(&config, &existing, bad_port).is_err());
        let bad_reply = SmtpConfigInput {
            enabled: false,
            host: "h".into(),
            port: 25,
            security: SmtpSecurity::None,
            username: "".into(),
            password: Some("".into()),
            from_address: "".into(),
            from_name: "".into(),
            reply_to: "nope".into(),
        };
        assert!(merge_input(&config, &existing, bad_reply).is_err());
    }

    #[test]
    fn security_serialises_lowercase() {
        assert_eq!(
            serde_json::to_string(&SmtpSecurity::Starttls).unwrap(),
            "\"starttls\""
        );
        assert_eq!(
            serde_json::from_str::<SmtpSecurity>("\"none\"").unwrap(),
            SmtpSecurity::None
        );
    }
}
