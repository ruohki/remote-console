//! Key/value console settings: branding and the bakery signing key.
//!
//! The signing key is the most sensitive value the console holds (it authenticates baked
//! agents). With `CONSOLE_MASTER_KEY` configured it is stored encrypted
//! (XChaCha20-Poly1305, key derived with HKDF-SHA256); an existing plaintext key is encrypted
//! on the first start with a master key, and a wrong master key is a hard error rather than a
//! silent regeneration.

use super::{now, Db};
use crate::config::Config;
use anyhow::{bail, Context, Result};
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use ed25519_dalek::SigningKey;
use protocol::bakery::Branding;
use zeroize::Zeroizing;

const KEY_BRANDING: &str = "branding";
const KEY_SIGNING: &str = "bakery_signing_key";
/// Prefix of encrypted values (`enc:v1:<base64 nonce || ciphertext>`).
const ENC_PREFIX: &str = "enc:v1:";
const HKDF_INFO: &[u8] = b"remote-console/bakery-signing-key/v1";

pub async fn get(db: &Db, key: &str) -> Result<Option<String>> {
    let row: Option<(String,)> = sqlx::query_as("SELECT value FROM settings WHERE key = ?")
        .bind(key)
        .fetch_optional(db)
        .await
        .context("reading setting")?;
    Ok(row.map(|(v,)| v))
}

pub async fn put(db: &Db, key: &str, value: &str) -> Result<()> {
    sqlx::query(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
    .bind(key)
    .bind(value)
    .bind(now())
    .execute(db)
    .await
    .context("writing setting")?;
    Ok(())
}

/// Stored branding, or the default when none has been set.
pub async fn branding(db: &Db) -> Result<Branding> {
    match get(db, KEY_BRANDING).await? {
        Some(json) => Ok(serde_json::from_str(&json).unwrap_or_else(|_| default_branding())),
        None => Ok(default_branding()),
    }
}

pub async fn set_branding(db: &Db, branding: &Branding) -> Result<()> {
    put(db, KEY_BRANDING, &serde_json::to_string(branding)?).await
}

pub fn default_branding() -> Branding {
    Branding {
        product_name: "Remote Console".into(),
        accent: "#3b82f6".into(),
        logo_png_base64: None,
        support_text: String::new(),
        organization: String::new(),
        apply_to_console: true,
    }
}

/// The console signing key, generated and persisted on first use. Encrypted at rest when a
/// master key is configured (see module docs).
pub async fn signing_key(db: &Db, config: &Config) -> Result<SigningKey> {
    use base64::Engine;
    let engine = base64::engine::general_purpose::STANDARD;
    let master = config.master_key.as_ref();

    if let Some(stored) = get(db, KEY_SIGNING).await? {
        if let Some(payload) = stored.strip_prefix(ENC_PREFIX) {
            let Some(master) = master else {
                bail!(
                    "the bakery signing key is encrypted but CONSOLE_MASTER_KEY is not set; \
                     configure the same master key that was used before"
                );
            };
            let seed = decrypt_seed(master, payload)
                .context("decrypting the bakery signing key: CONSOLE_MASTER_KEY is wrong")?;
            return Ok(SigningKey::from_bytes(&seed));
        }
        // Legacy plaintext storage.
        if let Ok(bytes) = engine.decode(&stored) {
            if let Ok(seed) = <[u8; 32]>::try_from(bytes.as_slice()) {
                let seed = Zeroizing::new(seed);
                if let Some(master) = master {
                    put(db, KEY_SIGNING, &encrypt_seed(master, &seed)).await?;
                    tracing::info!("encrypted the bakery signing key with CONSOLE_MASTER_KEY");
                }
                return Ok(SigningKey::from_bytes(&seed));
            }
        }
        bail!("stored bakery signing key is corrupt; restore the database from backup");
    }

    let mut seed = Zeroizing::new([0u8; 32]);
    rand::fill(&mut *seed);
    let key = SigningKey::from_bytes(&seed);
    let value = match master {
        Some(master) => encrypt_seed(master, &seed),
        None => engine.encode(*seed),
    };
    put(db, KEY_SIGNING, &value).await?;
    tracing::info!("generated a new bakery signing key");
    Ok(key)
}

fn derive_key(master: &[u8; 32]) -> Zeroizing<[u8; 32]> {
    let hk = hkdf::Hkdf::<sha2::Sha256>::new(None, master);
    let mut okm = Zeroizing::new([0u8; 32]);
    hk.expand(HKDF_INFO, &mut *okm)
        .expect("32 bytes is a valid HKDF-SHA256 output length");
    okm
}

fn encrypt_seed(master: &[u8; 32], seed: &[u8; 32]) -> String {
    use base64::Engine;
    let key = derive_key(master);
    let cipher = XChaCha20Poly1305::new((&*key).into());
    let mut nonce = [0u8; 24];
    rand::fill(&mut nonce);
    let ct = cipher
        .encrypt(XNonce::from_slice(&nonce), seed.as_slice())
        .expect("XChaCha20-Poly1305 encryption cannot fail for 32 bytes");
    let mut out = nonce.to_vec();
    out.extend_from_slice(&ct);
    format!(
        "{ENC_PREFIX}{}",
        base64::engine::general_purpose::STANDARD.encode(out)
    )
}

fn decrypt_seed(master: &[u8; 32], payload_b64: &str) -> Result<Zeroizing<[u8; 32]>> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload_b64)
        .context("encrypted value is not base64")?;
    if bytes.len() < 24 + 16 {
        bail!("encrypted value is truncated");
    }
    let (nonce, ct) = bytes.split_at(24);
    let key = derive_key(master);
    let cipher = XChaCha20Poly1305::new((&*key).into());
    let plain = cipher
        .decrypt(XNonce::from_slice(nonce), ct)
        .map_err(|_| anyhow::anyhow!("authentication failed"))?;
    let seed = <[u8; 32]>::try_from(plain.as_slice())
        .map_err(|_| anyhow::anyhow!("decrypted value has the wrong length"))?;
    Ok(Zeroizing::new(seed))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_encryption_roundtrip_and_wrong_key() {
        let master = [1u8; 32];
        let seed = [9u8; 32];
        let enc = encrypt_seed(&master, &seed);
        assert!(enc.starts_with(ENC_PREFIX));
        let payload = enc.strip_prefix(ENC_PREFIX).unwrap();
        assert_eq!(*decrypt_seed(&master, payload).unwrap(), seed);
        assert!(
            decrypt_seed(&[2u8; 32], payload).is_err(),
            "wrong master key must fail"
        );
        // Nonces are random: encrypting twice yields different ciphertexts.
        assert_ne!(enc, encrypt_seed(&master, &seed));
        // Tampering is detected.
        let mut bytes = base64::engine::general_purpose::STANDARD
            .decode(payload)
            .unwrap();
        bytes[30] ^= 0xff;
        let tampered = base64::engine::general_purpose::STANDARD.encode(bytes);
        assert!(decrypt_seed(&master, &tampered).is_err());
    }

    use base64::Engine;
}
