//! Key/value console settings: branding and the bakery signing key.

use super::{now, Db};
use anyhow::{Context, Result};
use ed25519_dalek::SigningKey;
use protocol::bakery::Branding;

const KEY_BRANDING: &str = "branding";
const KEY_SIGNING: &str = "bakery_signing_key";

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

/// The console signing key, generated and persisted on first use.
pub async fn signing_key(db: &Db) -> Result<SigningKey> {
    use base64::Engine;
    let engine = base64::engine::general_purpose::STANDARD;
    if let Some(b64) = get(db, KEY_SIGNING).await? {
        if let Ok(bytes) = engine.decode(&b64) {
            if let Ok(arr) = <[u8; 32]>::try_from(bytes.as_slice()) {
                return Ok(SigningKey::from_bytes(&arr));
            }
        }
        tracing::warn!("stored bakery signing key is corrupt; regenerating");
    }
    let mut seed = [0u8; 32];
    rand::fill(&mut seed);
    let key = SigningKey::from_bytes(&seed);
    put(db, KEY_SIGNING, &engine.encode(seed)).await?;
    tracing::info!("generated a new bakery signing key");
    Ok(key)
}
