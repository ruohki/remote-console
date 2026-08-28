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
}

pub async fn info(State(state): State<AppState>) -> Json<Info> {
    Json(Info {
        version: crate::VERSION,
        protocol_version: protocol::PROTOCOL_VERSION,
        public_url: state.config.public_url.clone(),
        stun_urls: state.config.stun_urls.clone(),
        turn_enabled: state.config.turn_enabled(),
    })
}
