//! Application state and router assembly.

use crate::auth::LoginLimiter;
use crate::config::Config;
use crate::db::Db;
use crate::hub::Hub;
use anyhow::Result;
use axum::extract::DefaultBodyLimit;
use axum::http::{header, HeaderValue};
use axum::routing::get;
use axum::Router;
use std::sync::Arc;
use tower_http::compression::CompressionLayer;
use tower_http::set_header::SetResponseHeaderLayer;
use tower_http::trace::TraceLayer;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub db: Db,
    pub hub: Arc<Hub>,
    pub limiter: Arc<LoginLimiter>,
}

impl AppState {
    /// Connect to the database, reset stale state and build the shared state.
    pub async fn init(config: Config) -> Result<Self> {
        let db = crate::db::connect(&config).await?;
        crate::db::devices::mark_all_offline(&db).await?;
        let stale =
            crate::db::sessions::end_all_active(&db, protocol::common::EndReason::AgentOffline)
                .await?;
        if stale > 0 {
            tracing::info!("ended {stale} stale sessions from a previous run");
        }
        let config = Arc::new(config);
        let hub = Hub::new(Arc::clone(&config), db.clone());
        hub.spawn_background_tasks();
        Ok(Self {
            config,
            db,
            hub,
            limiter: Arc::new(LoginLimiter::default()),
        })
    }
}

/// Build the full router (API, WebSockets, install scripts, embedded SPA).
pub fn build_router(state: AppState) -> Router {
    Router::new()
        .nest("/api", crate::api::router())
        .route(protocol::AGENT_WS_PATH, get(crate::hub::agent_ws::upgrade))
        .route(protocol::UI_WS_PATH, get(crate::hub::ui_ws::upgrade))
        .route("/install.sh", get(crate::install::install_sh))
        .route("/install.ps1", get(crate::install::install_ps1))
        .fallback(crate::static_files::serve)
        .layer(axum::middleware::from_fn(crate::auth::json_guard))
        .layer(DefaultBodyLimit::max(1024 * 1024))
        .layer(CompressionLayer::new())
        .layer(SetResponseHeaderLayer::if_not_present(
            header::X_FRAME_OPTIONS,
            HeaderValue::from_static("DENY"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::REFERRER_POLICY,
            HeaderValue::from_static("same-origin"),
        ))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}
