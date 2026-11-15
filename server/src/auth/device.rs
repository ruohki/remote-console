//! Device credentials: hashing and verifying the secret an agent proves itself with (WebSocket
//! `hello`, `Authorization: Device <id>:<secret>` on the package download).
//!
//! Device secrets are 32 random bytes from the CSPRNG, so a slow password hash buys nothing:
//! there is no dictionary to slow down. New secrets are stored as `sha256$<hex>` and verified
//! with one hash and a constant-time compare. Hashes written by older consoles are argon2id
//! PHC strings; they still verify (on their own small set of blocking slots, never the operator
//! login slots) and are rewritten to the SHA-256 scheme after the first successful check.

use crate::db::{self, models::DeviceRow, Db};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tokio::sync::Semaphore;

/// Scheme prefix of SHA-256 device secret hashes (argon2 PHC strings start with `$argon2`).
pub const SHA256_PREFIX: &str = "sha256$";

/// Stored form of a new device secret.
pub fn hash_secret(secret: &str) -> String {
    format!(
        "{SHA256_PREFIX}{}",
        hex::encode(Sha256::digest(secret.as_bytes()))
    )
}

/// Outcome of checking a secret against a stored hash.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretCheck {
    Valid,
    /// Valid, and the stored hash is a legacy argon2 hash that should be replaced.
    ValidLegacy,
    Invalid,
}

/// Check `secret` against `stored`. SHA-256 hashes are checked inline; argon2 hashes wait for
/// one of `legacy_slots` and run on the blocking pool.
pub async fn check_secret(secret: &str, stored: &str, legacy_slots: &Semaphore) -> SecretCheck {
    if let Some(expected) = stored.strip_prefix(SHA256_PREFIX) {
        let got = hex::encode(Sha256::digest(secret.as_bytes()));
        return if bool::from(got.as_bytes().ct_eq(expected.as_bytes())) {
            SecretCheck::Valid
        } else {
            SecretCheck::Invalid
        };
    }
    let _slot = legacy_slots.acquire().await;
    if super::verify_password_async(secret.to_string(), stored.to_string()).await {
        SecretCheck::ValidLegacy
    } else {
        SecretCheck::Invalid
    }
}

/// Why a device could not be authenticated.
#[derive(Debug)]
pub enum DeviceAuthError {
    UnknownDevice,
    BadSecret,
    Internal(String),
}

/// Look the device up and check its secret; a legacy hash is upgraded on success.
pub async fn authenticate(
    db: &Db,
    legacy_slots: &Semaphore,
    device_id: &str,
    secret: &str,
) -> Result<DeviceRow, DeviceAuthError> {
    let device = match db::devices::by_id(db, device_id).await {
        Ok(Some(d)) => d,
        Ok(None) => return Err(DeviceAuthError::UnknownDevice),
        Err(err) => return Err(DeviceAuthError::Internal(err.to_string())),
    };
    match check_secret(secret, &device.secret_hash, legacy_slots).await {
        SecretCheck::Valid => Ok(device),
        SecretCheck::ValidLegacy => {
            let new_hash = hash_secret(secret);
            match db::devices::replace_secret_hash(db, &device.id, &device.secret_hash, &new_hash)
                .await
            {
                Ok(true) => {
                    tracing::debug!(device = %device.id, "device secret rehashed to sha256")
                }
                Ok(false) => {}
                Err(err) => tracing::warn!(device = %device.id, "rehashing device secret: {err}"),
            }
            Ok(device)
        }
        SecretCheck::Invalid => Err(DeviceAuthError::BadSecret),
    }
}

/// Parse `Authorization: Device <device_id>:<device_secret>`.
pub fn parse_authorization(value: &str) -> Option<(&str, &str)> {
    let (scheme, rest) = value.trim().split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("device") {
        return None;
    }
    let (id, secret) = rest.trim().split_once(':')?;
    let valid = |s: &str| !s.is_empty() && s.len() <= 128;
    (valid(id) && valid(secret)).then_some((id, secret))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn sha256_scheme_roundtrip() {
        let slots = Semaphore::new(1);
        let h = hash_secret("s3cret-device-value");
        assert!(h.starts_with(SHA256_PREFIX));
        assert_eq!(h.len(), SHA256_PREFIX.len() + 64);
        assert_eq!(
            check_secret("s3cret-device-value", &h, &slots).await,
            SecretCheck::Valid
        );
        assert_eq!(
            check_secret("wrong", &h, &slots).await,
            SecretCheck::Invalid
        );
        assert_eq!(
            check_secret("", "sha256$", &slots).await,
            SecretCheck::Invalid
        );
    }

    #[tokio::test]
    async fn legacy_argon2_hashes_still_verify() {
        let slots = Semaphore::new(1);
        let legacy = crate::auth::hash_password("old-device-secret").unwrap();
        assert_eq!(
            check_secret("old-device-secret", &legacy, &slots).await,
            SecretCheck::ValidLegacy
        );
        assert_eq!(
            check_secret("nope", &legacy, &slots).await,
            SecretCheck::Invalid
        );
        assert_eq!(
            check_secret("x", "garbage", &slots).await,
            SecretCheck::Invalid
        );
    }

    #[test]
    fn authorization_header() {
        assert_eq!(
            parse_authorization("Device dev_abc:s3cret"),
            Some(("dev_abc", "s3cret"))
        );
        assert_eq!(
            parse_authorization("device  dev_abc:s:3"),
            Some(("dev_abc", "s:3"))
        );
        assert_eq!(parse_authorization("Bearer dev_abc:s3cret"), None);
        assert_eq!(parse_authorization("Device dev_abc"), None);
        assert_eq!(parse_authorization("Device :x"), None);
        assert_eq!(parse_authorization("Device x:"), None);
    }
}
