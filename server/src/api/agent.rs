//! Branded agent downloads (bakery).

use crate::agent_bakery::{Availability, Platform};
use crate::app::AppState;
use crate::auth::{self, AdminUser};
use crate::db;
use crate::error::{ApiError, ApiResult};
use crate::install::{self, TokenProblem};
use axum::extract::{ConnectInfo, Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use std::net::SocketAddr;

pub async fn downloads(
    State(state): State<AppState>,
    _admin: AdminUser,
) -> ApiResult<Json<Vec<Availability>>> {
    Ok(Json(state.bakery.availability(&state.config).await))
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

    // Auth: admin session cookie OR a valid, unexhausted enrollment token.
    let admin = auth::user_from_headers(state, headers)
        .await
        .filter(|u| u.is_admin());
    let token_label = match &admin {
        Some(_) => None,
        None => {
            // Bakes are expensive (signing, notarization): unauthenticated token downloads
            // are rate limited per client address; admins are not.
            if !state.limits.download_ip.check(ip) {
                return Err(ApiError::new(
                    StatusCode::TOO_MANY_REQUESTS,
                    "rate_limited",
                    "too many downloads, try again in a minute",
                ));
            }
            let token = q.token.as_deref();
            match install::validate_token(&state.db, token).await {
                Ok(row) => Some(row.label),
                Err(TokenProblem::Missing | TokenProblem::Unknown | TokenProblem::Revoked) => {
                    return Err(ApiError::unauthorized());
                }
                Err(problem @ (TokenProblem::Expired | TokenProblem::Exhausted)) => {
                    return Err(ApiError::new(
                        StatusCode::GONE,
                        "token_exhausted",
                        problem.message(),
                    ));
                }
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
