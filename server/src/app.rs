//! Application state and router assembly.

use crate::agent_bakery::Bakery;
use crate::auth::{Limits, LoginLimiter};
use crate::config::Config;
use crate::db::Db;
use crate::hub::Hub;
use anyhow::{Context, Result};
use axum::extract::DefaultBodyLimit;
use axum::http::{header, HeaderName, HeaderValue};
use axum::routing::get;
use axum::Router;
use std::sync::Arc;
use tower_http::compression::CompressionLayer;
use tower_http::set_header::SetResponseHeaderLayer;
use tower_http::trace::TraceLayer;

/// Largest JSON body accepted on `/api` (branding with a 1 MiB PNG fits comfortably).
pub const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;

/// Content-Security-Policy for the embedded SPA. Verified against `web/dist/index.html`:
/// module script + stylesheet from `/assets`, `data:`/`blob:` for logos, screenshots and
/// downloads, WebSocket to the same host, WebAudio chime and WebRTC need no directive.
/// `'unsafe-inline'` for styles only: Tailwind injects no inline scripts but React sets
/// inline `style=` attributes for the accent variables.
pub const CONTENT_SECURITY_POLICY: &str = "default-src 'self'; \
    script-src 'self'; \
    style-src 'self' 'unsafe-inline'; \
    img-src 'self' data: blob:; \
    media-src 'self' blob:; \
    font-src 'self' data:; \
    connect-src 'self' ws: wss:; \
    worker-src 'self' blob:; \
    frame-ancestors 'none'; \
    base-uri 'self'; \
    form-action 'self'; \
    object-src 'none'";

pub const PERMISSIONS_POLICY: &str =
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()";

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub db: Db,
    pub hub: Arc<Hub>,
    /// Failed-login limiter per IP (see also [`Limits::login_ip`]; kept for compatibility).
    pub limiter: Arc<LoginLimiter>,
    pub limits: Arc<Limits>,
    pub bakery: Arc<Bakery>,
    /// WebAuthn context, OIDC discovery/JWKS caches and the SAML SP key.
    pub auth: Arc<crate::auth::AuthContext>,
}

impl AppState {
    /// Connect to the database, reset stale state and build the shared state.
    pub async fn init(config: Config) -> Result<Self> {
        let db = crate::db::connect(&config).await?;
        // Fail fast on a wrong/missing master key instead of at the first bake.
        crate::db::settings::signing_key(&db, &config)
            .await
            .context("loading the bakery signing key")?;
        crate::db::devices::mark_all_offline(&db).await?;
        let stale =
            crate::db::sessions::end_all_active(&db, protocol::common::EndReason::AgentOffline)
                .await?;
        if stale > 0 {
            tracing::info!("ended {stale} stale sessions from a previous run");
        }
        // LOCAL_LOGIN=0 without a break-glass admin would lock everyone out of a console
        // that already has users; refuse to start instead of failing silently.
        if !config.local_login
            && crate::db::users::count(&db).await? > 0
            && crate::db::users::count_break_glass_admins(&db).await? == 0
        {
            anyhow::bail!(
                "LOCAL_LOGIN=0 but no enabled administrator has the break_glass flag; set it \
                 with PATCH /api/users/:id {{ \"break_glass\": true }} before disabling local login"
            );
        }
        let config = Arc::new(config);
        let auth = Arc::new(crate::auth::AuthContext::new(&config, &db).await?);
        let hub = Hub::new(Arc::clone(&config), db.clone());
        hub.spawn_background_tasks();
        Ok(Self {
            config,
            db,
            hub,
            limiter: Arc::new(LoginLimiter::default()),
            limits: Arc::new(Limits::default()),
            bakery: Bakery::new(),
            auth,
        })
    }

    /// Client address honouring `TRUST_PROXY`.
    pub fn client_ip(
        &self,
        headers: &axum::http::HeaderMap,
        peer: Option<&axum::extract::ConnectInfo<std::net::SocketAddr>>,
    ) -> String {
        crate::auth::client_ip(headers, peer, self.config.trust_proxy)
    }
}

/// Build the full router (API, WebSockets, install scripts, embedded SPA).
pub fn build_router(state: AppState) -> Router {
    let https = state.config.is_https();
    let mut router = Router::new()
        .nest("/api", crate::api::router())
        .route(protocol::AGENT_WS_PATH, get(crate::hub::agent_ws::upgrade))
        .route(protocol::UI_WS_PATH, get(crate::hub::ui_ws::upgrade))
        .route("/install.sh", get(crate::install::install_sh))
        .route("/install.ps1", get(crate::install::install_ps1))
        .fallback(crate::static_files::serve)
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            crate::auth::csrf_guard,
        ))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .layer(CompressionLayer::new())
        .layer(SetResponseHeaderLayer::if_not_present(
            header::X_FRAME_OPTIONS,
            HeaderValue::from_static("DENY"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::REFERRER_POLICY,
            HeaderValue::from_static("strict-origin-when-cross-origin"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(CONTENT_SECURITY_POLICY),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            HeaderName::from_static("permissions-policy"),
            HeaderValue::from_static(PERMISSIONS_POLICY),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            HeaderName::from_static("cross-origin-opener-policy"),
            HeaderValue::from_static("same-origin"),
        ));
    if https {
        router = router.layer(SetResponseHeaderLayer::if_not_present(
            header::STRICT_TRANSPORT_SECURITY,
            HeaderValue::from_static("max-age=31536000; includeSubDomains"),
        ));
    }
    router.layer(TraceLayer::new_for_http()).with_state(state)
}
