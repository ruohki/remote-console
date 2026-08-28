//! Public server information.

use crate::app::AppState;
use axum::extract::State;
use axum::Json;
use serde::Serialize;

#[derive(Serialize)]
pub struct Info {
    pub version: &'static str,
    pub protocol_version: u32,
    pub public_url: String,
    pub stun_urls: Vec<String>,
    pub turn_enabled: bool,
    pub console_public_key: String,
    pub branding_product_name: String,
    /// base64 SHA-256 of the console TLS certificate's SubjectPublicKeyInfo (when configured).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub console_tls_spki_sha256: Option<String>,
}

pub async fn info(State(state): State<AppState>) -> Json<Info> {
    use base64::Engine;
    let (public_key, product_name) = match (
        crate::db::settings::signing_key(&state.db, &state.config).await,
        crate::db::settings::branding(&state.db).await,
    ) {
        (Ok(key), Ok(branding)) => (
            base64::engine::general_purpose::STANDARD.encode(key.verifying_key().as_bytes()),
            branding.product_name,
        ),
        _ => (
            String::new(),
            crate::db::settings::default_branding().product_name,
        ),
    };
    Json(Info {
        version: crate::VERSION,
        protocol_version: protocol::PROTOCOL_VERSION,
        public_url: state.config.public_url.clone(),
        stun_urls: state.config.stun_urls.clone(),
        turn_enabled: state.config.turn_enabled(),
        console_public_key: public_key,
        branding_product_name: product_name,
        console_tls_spki_sha256: state.config.tls_spki_sha256.clone(),
    })
}
