//! Agent enrollment (`POST /api/enroll`, unauthenticated, token based).

use crate::app::AppState;
use crate::auth;
use crate::db::{self, devices::NewDevice};
use crate::error::{ApiError, ApiResult};
use crate::ids;
use crate::install::{validate_token, TokenProblem};
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use protocol::config::{AgentConfig, EnrollRequest, EnrollResponse};
use serde_json::json;
use std::net::SocketAddr;

pub async fn enroll(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<EnrollRequest>,
) -> ApiResult<(StatusCode, Json<EnrollResponse>)> {
    let ip = state.client_ip(&headers, Some(&ConnectInfo(peer)));
    let token_key = ids::sha256_hex(req.token.trim());
    if !state.limits.enroll_ip.check(&ip) || !state.limits.enroll_token.check(&token_key) {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "too many enrollment attempts, try again later",
        ));
    }
    let token = match validate_token(&state.db, Some(&req.token)).await {
        Ok(t) => t,
        Err(TokenProblem::Exhausted) => {
            return Err(ApiError::new(
                StatusCode::GONE,
                "token_exhausted",
                TokenProblem::Exhausted.message(),
            ))
        }
        Err(problem) => {
            return Err(ApiError::new(
                StatusCode::UNAUTHORIZED,
                "invalid_token",
                problem.message(),
            ))
        }
    };
    if !db::tokens::consume(&state.db, &token.id).await? {
        return Err(ApiError::new(
            StatusCode::GONE,
            "token_exhausted",
            TokenProblem::Exhausted.message(),
        ));
    }

    let hostname = req.hostname.trim();
    let hostname = if hostname.is_empty() {
        "unknown"
    } else {
        hostname
    };
    // Operator-facing name: `--name` from the installer/CLI when given, else the hostname.
    let name = req
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .unwrap_or(hostname);
    let device_id = ids::device_id();
    let device_secret = ids::secret();
    let secret_hash = auth::hash_password(&device_secret)?;

    let config = AgentConfig {
        display_name: name.to_string(),
        mode: token.default_mode(),
        ice_servers: crate::turn::ice_servers(&state.config, &device_id, 0)
            .into_iter()
            .filter(|s| s.username.is_none())
            .collect(),
        ..AgentConfig::default()
    };
    let tags = token.default_tags();

    let device = db::devices::insert(
        &state.db,
        NewDevice {
            id: &device_id,
            name,
            hostname,
            os: req.os,
            arch: req.arch,
            agent_version: &req.agent_version,
            secret_hash: &secret_hash,
            config: &config,
            tags: &tags,
            enrolled_with: Some(&token.id),
        },
    )
    .await?;

    if let Some(group_id) = token.default_group_id.as_deref() {
        // The group may have been deleted meanwhile (column is SET NULL, but race-safe).
        if db::groups::by_id(&state.db, group_id).await?.is_some() {
            db::groups::add_member(&state.db, group_id, &device.id).await?;
        }
    }

    db::audit::record(
        &state.db,
        None,
        "enroll",
        Some(&device.id),
        json!({ "hostname": hostname, "os": req.os, "arch": req.arch, "token": token.label, "ip": ip, "group_id": token.default_group_id }),
    )
    .await?;
    state.hub.refresh_access().await;
    state.hub.broadcast_device(&device.id).await;

    Ok((
        StatusCode::CREATED,
        Json(EnrollResponse {
            device_id,
            device_secret,
            server_url: state.config.public_url.clone(),
            config,
        }),
    ))
}
