//! Outgoing email: the [`Mailer`] abstraction, the SMTP implementation and the branded
//! templates. Password resets and email second-factor codes go through here.
//!
//! The SMTP configuration is an admin setting (`smtp_config`, password sealed with the master
//! key) and is read on every send, so changes made in the UI apply without a restart.

pub mod smtp;
pub mod templates;

pub use smtp::{
    is_configured, load, merge_input, store, SmtpConfig, SmtpConfigInput, SmtpConfigPublic,
    SmtpMailer, SmtpSecurity, SETTINGS_KEY,
};

use parking_lot::Mutex;

/// One addressee.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Recipient {
    pub address: String,
    pub name: Option<String>,
}

impl Recipient {
    pub fn new(address: impl Into<String>, name: Option<String>) -> Self {
        Self {
            address: address.into(),
            name: name.filter(|n| !n.trim().is_empty()),
        }
    }
}

/// A fully rendered message. Templates produce it without recipients; the caller fills `to`.
#[derive(Debug, Clone)]
pub struct OutgoingMail {
    pub to: Vec<Recipient>,
    pub subject: String,
    pub text: String,
    pub html: String,
    /// PNG attached inline as `Content-ID: <logo>` so the HTML can use `src="cid:logo"`.
    pub inline_logo_png: Option<Vec<u8>>,
}

impl OutgoingMail {
    pub fn to(mut self, recipient: Recipient) -> Self {
        self.to.push(recipient);
        self
    }
}

#[async_trait::async_trait]
pub trait Mailer: Send + Sync {
    /// Deliver with the stored SMTP configuration.
    async fn send(&self, mail: OutgoingMail) -> anyhow::Result<()>;

    /// Deliver with an explicit (possibly unsaved) configuration — the admin "send test
    /// email" button. Implementations that do not talk SMTP just record the message.
    async fn send_with(&self, cfg: &SmtpConfig, mail: OutgoingMail) -> anyhow::Result<()> {
        let _ = cfg;
        self.send(mail).await
    }
}

/// Test double: keeps every message in memory.
#[derive(Default)]
pub struct RecordingMailer {
    pub sent: Mutex<Vec<OutgoingMail>>,
}

impl RecordingMailer {
    /// Snapshot of everything sent so far.
    pub fn messages(&self) -> Vec<OutgoingMail> {
        self.sent.lock().clone()
    }

    pub fn last(&self) -> Option<OutgoingMail> {
        self.sent.lock().last().cloned()
    }
}

#[async_trait::async_trait]
impl Mailer for RecordingMailer {
    async fn send(&self, mail: OutgoingMail) -> anyhow::Result<()> {
        self.sent.lock().push(mail);
        Ok(())
    }
}

/// `alice@example.com` → `a***@example.com` (shown to the user so they know where to look
/// without echoing the full address to someone who only holds the password).
pub fn mask_email(email: &str) -> String {
    match email.split_once('@') {
        Some((local, domain)) => {
            let first = local.chars().next().map(String::from).unwrap_or_default();
            format!("{first}***@{domain}")
        }
        None => "***".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_local_part() {
        assert_eq!(mask_email("alice@example.com"), "a***@example.com");
        assert_eq!(mask_email("é@x.y"), "é***@x.y");
        assert_eq!(mask_email("broken"), "***");
    }

    #[tokio::test]
    async fn recording_mailer_keeps_messages() {
        let m = RecordingMailer::default();
        m.send(OutgoingMail {
            to: vec![Recipient::new("a@b", None)],
            subject: "s".into(),
            text: "t".into(),
            html: "h".into(),
            inline_logo_png: None,
        })
        .await
        .unwrap();
        assert_eq!(m.messages().len(), 1);
        assert_eq!(m.last().unwrap().subject, "s");
    }
}
