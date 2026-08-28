//! Time-based one-time passwords (RFC 6238) and recovery codes.

use anyhow::{Context, Result};
use totp_rs::{Algorithm, Builder, Secret, Totp};

/// Six digits, 30 s steps, ±1 step of clock drift accepted.
const DIGITS: u8 = 6;
const SKEW: u16 = 1;
const STEP: u64 = 30;
pub const RECOVERY_CODE_COUNT: usize = 10;

/// A freshly generated base32 secret (160 bits).
pub fn generate_secret() -> String {
    let mut bytes = [0u8; 20];
    rand::fill(&mut bytes);
    Secret::from(bytes).to_base32()
}

fn totp(secret_b32: &str, issuer: &str, account: &str) -> Result<Totp> {
    let secret = Secret::try_from_base32(secret_b32)
        .map_err(|e| anyhow::anyhow!("invalid TOTP secret: {e:?}"))?;
    Builder::new()
        .with_algorithm(Algorithm::SHA1)
        .with_digits(DIGITS)
        .with_skew(SKEW)
        .with_step_duration(STEP)
        .with_secret(secret)
        .with_issuer(Some(issuer))
        .with_account_name(account)
        .build()
        .map_err(|e| anyhow::anyhow!("building TOTP: {e:?}"))
}

/// `otpauth://totp/...` URL for authenticator apps.
pub fn otpauth_url(secret_b32: &str, issuer: &str, account: &str) -> Result<String> {
    totp(secret_b32, issuer, account)?
        .to_url()
        .map_err(|e| anyhow::anyhow!("otpauth url: {e:?}"))
}

/// The otpauth URL rendered as an SVG QR code.
pub fn qr_svg(url: &str) -> Result<String> {
    let code = qrcode::QrCode::new(url.as_bytes()).context("encoding QR code")?;
    Ok(code
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(200, 200)
        .quiet_zone(true)
        .build())
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Verify a code against the secret at the current time (with drift).
pub fn verify(secret_b32: &str, code: &str) -> bool {
    verify_at(secret_b32, code, unix_now())
}

/// Verify at an explicit time (tests for drift behaviour).
pub fn verify_at(secret_b32: &str, code: &str, unix_time: u64) -> bool {
    let code: String = code.chars().filter(|c| c.is_ascii_digit()).collect();
    if code.len() != DIGITS as usize {
        return false;
    }
    match totp(secret_b32, "x", "x") {
        Ok(t) => t.check(&code, unix_time).is_some(),
        Err(_) => false,
    }
}

pub fn code_at(secret_b32: &str, unix_time: u64) -> Result<String> {
    Ok(totp(secret_b32, "x", "x")?.generate(unix_time).to_string())
}

/// Fresh recovery codes in the form `xxxxx-xxxxx` (base32 without ambiguous letters).
pub fn generate_recovery_codes() -> Vec<String> {
    const ALPHABET: &[u8] = b"abcdefghjkmnpqrstuvwxyz23456789";
    (0..RECOVERY_CODE_COUNT)
        .map(|_| {
            let mut bytes = [0u8; 10];
            rand::fill(&mut bytes);
            let chars: String = bytes
                .iter()
                .map(|b| ALPHABET[(*b as usize) % ALPHABET.len()] as char)
                .collect();
            format!("{}-{}", &chars[..5], &chars[5..])
        })
        .collect()
}

/// Canonical form used before hashing / comparing recovery codes.
pub fn normalise_recovery_code(code: &str) -> String {
    code.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

/// Whether the input looks like a recovery code rather than a TOTP code.
pub fn looks_like_recovery_code(code: &str) -> bool {
    let n = normalise_recovery_code(code);
    n.len() == 10 && n.chars().any(|c| c.is_ascii_alphabetic())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verifies_current_and_adjacent_steps() {
        let secret = generate_secret();
        let t = 1_700_000_000u64;
        let code = code_at(&secret, t).unwrap();
        assert_eq!(code.len(), 6);
        assert!(verify_at(&secret, &code, t));
        assert!(
            verify_at(&secret, &code, t + STEP),
            "one step later still valid"
        );
        assert!(
            verify_at(&secret, &code, t - STEP),
            "one step earlier still valid"
        );
        assert!(
            !verify_at(&secret, &code, t + 2 * STEP),
            "two steps later rejected"
        );
        assert!(
            !verify_at(&secret, &code, t - 2 * STEP),
            "two steps earlier rejected"
        );
        assert!(!verify(&secret, "12345"), "wrong length rejected");
        assert!(!verify_at("not base32!", "123456", t));
    }

    #[test]
    fn otpauth_and_qr() {
        let secret = generate_secret();
        let url = otpauth_url(&secret, "Remote Console", "admin@example.com").unwrap();
        assert!(url.starts_with("otpauth://totp/"), "{url}");
        assert!(url.contains("issuer=Remote"), "{url}");
        let svg = qr_svg(&url).unwrap();
        assert!(svg.starts_with("<?xml") || svg.starts_with("<svg"));
    }

    #[test]
    fn recovery_codes_shape_and_normalisation() {
        let codes = generate_recovery_codes();
        assert_eq!(codes.len(), RECOVERY_CODE_COUNT);
        for c in &codes {
            assert_eq!(c.len(), 11);
            assert!(looks_like_recovery_code(c));
        }
        assert_eq!(normalise_recovery_code(" ABCDE-fghjk "), "abcdefghjk");
        assert!(!looks_like_recovery_code("123456"));
    }
}
