//! Branding shown in the console and baked into agents.

use crate::app::AppState;
use crate::auth::AdminUser;
use crate::db;
use crate::error::{ApiError, ApiResult};
use axum::extract::State;
use axum::Json;
use protocol::bakery::Branding;

pub async fn get(State(state): State<AppState>) -> ApiResult<Json<Branding>> {
    Ok(Json(db::settings::branding(&state.db).await?))
}

pub async fn put(
    State(state): State<AppState>,
    admin: AdminUser,
    Json(mut branding): Json<Branding>,
) -> ApiResult<Json<Branding>> {
    validate(&mut branding)?;
    db::settings::set_branding(&state.db, &branding).await?;
    db::audit::record_lossy(
        &state.db,
        Some(admin.actor()),
        "branding.update",
        None,
        serde_json::json!({ "product_name": branding.product_name }),
    )
    .await;
    Ok(Json(branding))
}

/// Validate and normalise branding in place.
fn validate(b: &mut Branding) -> Result<(), ApiError> {
    b.product_name = b.product_name.trim().to_string();
    let name_len = b.product_name.chars().count();
    if !(1..=60).contains(&name_len) {
        return Err(ApiError::validation("product name must be 1–60 characters"));
    }
    b.accent = b.accent.trim().to_lowercase();
    if !is_hex_color(&b.accent) {
        return Err(ApiError::validation("accent must be a #rrggbb colour"));
    }
    b.support_text = b.support_text.trim().to_string();
    if b.support_text.chars().count() > 200 {
        return Err(ApiError::validation(
            "support text must be ≤ 200 characters",
        ));
    }
    b.organization = b.organization.trim().to_string();
    if b.organization.chars().count() > 80 {
        return Err(ApiError::validation("organization must be ≤ 80 characters"));
    }
    match &b.logo_png_base64 {
        Some(logo) if !logo.is_empty() => {
            use base64::Engine;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(logo)
                .map_err(|_| ApiError::validation("logo must be base64"))?;
            if bytes.len() > 512 * 1024 {
                return Err(ApiError::validation("logo must be ≤ 512 KiB"));
            }
            if !bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
                return Err(ApiError::validation("logo must be a PNG"));
            }
        }
        _ => b.logo_png_base64 = None,
    }
    Ok(())
}

fn is_hex_color(s: &str) -> bool {
    let bytes = s.as_bytes();
    bytes.len() == 7 && bytes[0] == b'#' && bytes[1..].iter().all(|c| c.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> Branding {
        Branding {
            product_name: "Acme".into(),
            accent: "#AABBCC".into(),
            logo_png_base64: None,
            support_text: "  hi ".into(),
            organization: "Acme Inc".into(),
            apply_to_console: true,
        }
    }

    #[test]
    fn normalises_and_accepts() {
        let mut b = base();
        validate(&mut b).unwrap();
        assert_eq!(b.accent, "#aabbcc");
        assert_eq!(b.support_text, "hi");
    }

    #[test]
    fn rejects_bad_values() {
        let mut b = base();
        b.product_name = "  ".into();
        assert!(validate(&mut b).is_err());
        let mut b = base();
        b.accent = "red".into();
        assert!(validate(&mut b).is_err());
        let mut b = base();
        b.logo_png_base64 = Some("bm90cG5n".into()); // "notpng"
        assert!(validate(&mut b).is_err());
    }
}
