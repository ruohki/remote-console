//! Passkeys and FIDO2 security keys (WebAuthn) via `webauthn-rs`.
//!
//! Registration never restricts the authenticator attachment, so platform passkeys (Touch ID,
//! Windows Hello, phone) and roaming keys (YubiKey etc.) both work. Resident credentials enable
//! usernameless login; non-resident ones are used as a second factor through
//! `allowCredentials`. Ceremony state is stored server-side in `auth_states` with a short TTL.

use crate::config::Config;
use anyhow::{Context, Result};
use uuid::Uuid;
use webauthn_rs::prelude::*;

/// Build the WebAuthn context for the console's public origin.
pub fn build(config: &Config, rp_name: &str) -> Result<Webauthn> {
    let origin = url::Url::parse(&config.public_url).context("CONSOLE_PUBLIC_URL")?;
    let rp_id = origin
        .host_str()
        .context("CONSOLE_PUBLIC_URL has no host")?
        .to_string();
    WebauthnBuilder::new(&rp_id, &origin)
        .context("WebAuthn configuration")?
        .rp_name(rp_name)
        .allow_subdomains(false)
        .build()
        .context("building WebAuthn context")
}

/// Stable WebAuthn user handle derived from the console user id.
pub fn user_handle(user_id: &str) -> Uuid {
    Uuid::new_v5(&Uuid::NAMESPACE_OID, user_id.as_bytes())
}

/// base64url (no padding) of a credential id, as stored in `user_passkeys.credential_id`.
pub fn credential_id_string(id: &CredentialID) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(id.as_ref())
}

pub fn parse_passkey(json: &str) -> Result<Passkey> {
    serde_json::from_str(json).context("stored passkey is corrupt")
}

pub fn passkey_json(pk: &Passkey) -> Result<String> {
    serde_json::to_string(pk).context("serialising passkey")
}

/// Counter and backup flags of a credential, read from its serialised form (the crate keeps
/// the credential internals private).
#[derive(Debug, Default, Clone, Copy)]
pub struct CredentialFlags {
    pub counter: i64,
    pub backup_eligible: bool,
    pub backup_state: bool,
}

pub fn credential_flags(pk: &Passkey) -> CredentialFlags {
    let v = serde_json::to_value(pk).unwrap_or_default();
    let cred = v.get("cred").unwrap_or(&v);
    CredentialFlags {
        counter: cred.get("counter").and_then(|c| c.as_i64()).unwrap_or(0),
        backup_eligible: cred
            .get("backup_eligible")
            .and_then(|b| b.as_bool())
            .unwrap_or(false),
        backup_state: cred
            .get("backup_state")
            .and_then(|b| b.as_bool())
            .unwrap_or(false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handle_is_stable_and_distinct() {
        assert_eq!(user_handle("usr_a"), user_handle("usr_a"));
        assert_ne!(user_handle("usr_a"), user_handle("usr_b"));
    }

    #[test]
    fn builds_for_public_url() {
        let cfg = Config::for_tests("sqlite://x".into());
        let w = build(&cfg, "Remote Console").unwrap();
        // The RP id is the host of the public URL.
        let _ = w;
    }
}
