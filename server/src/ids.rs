//! Random identifiers and secrets.

const BASE62: &[u8; 62] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/// `len` random base62 characters from the OS CSPRNG.
pub fn base62(len: usize) -> String {
    let mut out = String::with_capacity(len);
    let mut buf = [0u8; 64];
    while out.len() < len {
        rand::fill(&mut buf);
        for b in buf {
            // Rejection sampling keeps the distribution uniform (248 = 4 * 62).
            if b < 248 {
                out.push(BASE62[(b % 62) as usize] as char);
                if out.len() == len {
                    break;
                }
            }
        }
    }
    out
}

pub fn device_id() -> String {
    format!("dev_{}", base62(22))
}

pub fn session_id() -> String {
    format!("ses_{}", base62(22))
}

pub fn enroll_token_id() -> String {
    format!("enr_{}", base62(22))
}

pub fn group_id() -> String {
    format!("grp_{}", base62(22))
}

pub fn user_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Plain enrollment token / device secret: 32 random bytes encoded as base62 (43 chars).
pub fn secret() -> String {
    base62(43)
}

/// Opaque login session id (URL-safe base64 of 32 random bytes).
pub fn passkey_id() -> String {
    format!("pk_{}", base62(22))
}

/// Ids of pending auth ceremonies (2FA challenges, WebAuthn, OIDC state, SAML requests).
pub fn auth_state_id() -> String {
    format!("ast_{}", base62(32))
}

pub fn login_session_id() -> String {
    use base64::Engine;
    let mut bytes = [0u8; 32];
    rand::fill(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// Hex SHA-256, used for enrollment tokens (high entropy → no salt needed).
pub fn sha256_hex(input: &str) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(input.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_have_expected_shape() {
        assert_eq!(device_id().len(), 26);
        assert!(device_id().starts_with("dev_"));
        assert!(session_id().starts_with("ses_"));
        assert!(enroll_token_id().starts_with("enr_"));
        assert!(group_id().starts_with("grp_"));
        assert_eq!(secret().len(), 43);
        assert!(secret().bytes().all(|b| BASE62.contains(&b)));
        assert_ne!(secret(), secret());
        assert_eq!(login_session_id().len(), 43);
    }

    #[test]
    fn sha256_is_stable() {
        assert_eq!(
            sha256_hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
