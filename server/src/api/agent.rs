//! Branded agent downloads (bakery) and the update package connected agents fetch.

use crate::agent_bakery::{Availability, Platform};
use crate::app::AppState;
use crate::auth::{self, AdminUser, AuthUser};
use crate::db;
use crate::error::{ApiError, ApiResult};
use crate::install;
use axum::extract::{ConnectInfo, Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use std::collections::BTreeMap;
use std::net::SocketAddr;

pub async fn downloads(
    State(state): State<AppState>,
    _admin: AdminUser,
) -> ApiResult<Json<Vec<Availability>>> {
    Ok(Json(state.bakery.availability(&state.config).await))
}

/// `GET /api/agent/versions`: agent version the console hands out per platform (`null` when
/// unknown), for the "update available" badges.
pub async fn versions(
    State(state): State<AppState>,
    _user: AuthUser,
) -> Json<BTreeMap<&'static str, Option<String>>> {
    let versions = state.bakery.versions(&state.config).await;
    Json(
        versions
            .into_iter()
            .map(|(platform, version)| (platform.slug(), version))
            .collect(),
    )
}

/// `GET /api/agent/package/{platform}` with `Authorization: Device <id>:<secret>`: the
/// token-less update build (see [`crate::agent_bakery::Bakery::package`]).
pub async fn package(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(platform): Path<String>,
    headers: HeaderMap,
) -> Response {
    let ip = state.client_ip(&headers, Some(&ConnectInfo(peer)));
    match package_inner(&state, &platform, &headers, &ip).await {
        Ok(resp) => resp,
        Err(e) => e.into_response(),
    }
}

async fn package_inner(
    state: &AppState,
    platform: &str,
    headers: &HeaderMap,
    ip: &str,
) -> ApiResult<Response> {
    let platform =
        Platform::parse(platform).ok_or_else(|| ApiError::not_found("agent platform"))?;
    let (device_id, secret) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(auth::device::parse_authorization)
        .ok_or_else(ApiError::unauthorized)?;
    let auth_key = auth::agent_auth_key(ip, device_id);
    if let Some(wait) = state.limits.agent_hello.blocked_for(&auth_key) {
        return Err(ApiError::rate_limited(
            "too many failed attempts, try again later",
            wait.as_secs(),
        ));
    }
    let device = match auth::device::authenticate(
        &state.db,
        &state.limits.device_verify_slots,
        device_id,
        secret,
    )
    .await
    {
        Ok(d) => d,
        Err(auth::device::DeviceAuthError::Internal(err)) => return Err(ApiError::internal(err)),
        Err(_) => {
            state.limits.agent_hello.record_failure(&auth_key);
            return Err(ApiError::unauthorized());
        }
    };
    state.limits.agent_hello.clear(&auth_key);
    if let Err(wait) = state.limits.package_device.hit(&device.id) {
        return Err(ApiError::rate_limited(
            "too many update downloads for this device, try again later",
            wait.as_secs(),
        ));
    }

    let pkg = state
        .bakery
        .package(&state.config, &state.db, platform)
        .await
        .map_err(|e| {
            tracing::warn!(
                platform = platform.slug(),
                "update package unavailable: {e:#}"
            );
            ApiError::new(
                StatusCode::NOT_FOUND,
                "no_base_binary",
                "no agent binary is available for this platform",
            )
        })?;
    tracing::info!(
        device = %device.id,
        platform = platform.slug(),
        version = pkg.version.as_deref().unwrap_or("unknown"),
        %ip,
        "serving update package"
    );

    let mut resp = (StatusCode::OK, pkg.bytes.clone()).into_response();
    let h = resp.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(pkg.content_type),
    );
    if let Ok(v) = HeaderValue::from_str(&format!("attachment; filename=\"{}\"", pkg.filename)) {
        h.insert(header::CONTENT_DISPOSITION, v);
    }
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if let Ok(v) = HeaderValue::from_str(&pkg.sha256) {
        h.insert("x-agent-sha256", v);
    }
    if let Some(v) = pkg
        .version
        .as_deref()
        .and_then(|v| HeaderValue::from_str(v).ok())
    {
        h.insert("x-agent-version", v);
    }
    h.insert(
        "x-agent-signed",
        HeaderValue::from_static(if pkg.signed { "1" } else { "0" }),
    );
    Ok(resp)
}

#[derive(Deserialize)]
pub struct DownloadQuery {
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub quick: Option<u8>,
    /// `0` skips code signing even when it is configured.
    #[serde(default)]
    pub sign: Option<u8>,
}

pub async fn download(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(platform): Path<String>,
    Query(q): Query<DownloadQuery>,
    headers: HeaderMap,
) -> Response {
    let ip = state.client_ip(&headers, Some(&ConnectInfo(peer)));
    match download_inner(&state, &platform, &q, &headers, &ip).await {
        Ok(resp) => resp,
        Err(e) => e.into_response(),
    }
}

async fn download_inner(
    state: &AppState,
    platform: &str,
    q: &DownloadQuery,
    headers: &HeaderMap,
    ip: &str,
) -> ApiResult<Response> {
    let platform =
        Platform::parse(platform).ok_or_else(|| ApiError::not_found("agent platform"))?;

    // Auth: admin session cookie OR a known, unrevoked enrollment token. Expired and used-up
    // tokens still download (an installer re-run on an enrolled machine must not fail);
    // enrolling with them is refused by `POST /api/enroll`.
    let admin = auth::user_from_headers(state, headers)
        .await
        .filter(|u| u.is_admin());
    let token_label = match &admin {
        Some(_) => None,
        None => {
            // Bakes are expensive (signing, notarization): unauthenticated token downloads
            // are rate limited per client address; admins are not.
            if let Err(wait) = state.limits.download_ip.hit(ip) {
                return Err(ApiError::rate_limited(
                    "too many downloads, try again in a minute",
                    wait.as_secs(),
                ));
            }
            match install::token_for_install(&state.db, q.token.as_deref()).await {
                Ok(row) => Some(row.label),
                Err(_) => return Err(ApiError::unauthorized()),
            }
        }
    };

    let branding = db::settings::branding(&state.db).await?;
    let quick = q.quick == Some(1);
    let sign = q.sign != Some(0);
    let baked = state
        .bakery
        .bake(
            &state.config,
            &state.db,
            platform,
            q.token
                .as_deref()
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .map(String::from),
            quick,
            branding,
            sign,
        )
        .await
        .map_err(|e| {
            tracing::warn!(platform = platform.slug(), "bake failed: {e:#}");
            ApiError::new(
                StatusCode::NOT_FOUND,
                "no_base_binary",
                "no agent binary is available for this platform",
            )
        })?;

    let actor_id = admin.as_ref().map(|u| u.id.clone());
    let actor_name = admin.as_ref().map(|u| u.name.clone());
    db::audit::record_lossy(
        &state.db,
        actor_id
            .as_deref()
            .zip(actor_name.as_deref())
            .map(|(id, name)| db::audit::Actor { id, name }),
        "agent.bake",
        Some(platform.slug()),
        serde_json::json!({
            "quick": quick,
            "token": token_label,
            "signed": baked.signed,
            "notarized": baked.notarized,
        }),
    )
    .await;

    let filename = baked.filename;
    let content_type = baked.content_type;
    let (signed, notarized) = (baked.signed, baked.notarized);
    let mut resp = (StatusCode::OK, baked.bytes).into_response();
    let h = resp.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    if let Ok(v) = HeaderValue::from_str(&format!("attachment; filename=\"{filename}\"")) {
        h.insert(header::CONTENT_DISPOSITION, v);
    }
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(
        "x-agent-signed",
        HeaderValue::from_static(if signed { "1" } else { "0" }),
    );
    h.insert(
        "x-agent-notarized",
        HeaderValue::from_static(if notarized { "1" } else { "0" }),
    );
    Ok(resp)
}
