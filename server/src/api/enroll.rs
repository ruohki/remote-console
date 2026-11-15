//! Agent enrollment (`POST /api/enroll`, unauthenticated, token based).
//!
//! A machine that enrolls again (reinstall, re-image, installer re-run after a reset) is
//! recognised by its hardware `machine_id`: when a device with the same machine id and OS
//! exists, that row is reused — new secret, refreshed hostname / version / arch — and keeps its
//! id, name, groups, tags, notes, config and session history.

use crate::app::AppState;
use crate::auth;
use crate::db::{self, devices::NewDevice, devices::ReEnrollment, models::DeviceRow};
use crate::error::{ApiError, ApiResult};
use crate::ids;
use crate::install::{validate_token, TokenProblem};
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use protocol::config::{AgentConfig, EnrollRequest, EnrollResponse};
use serde_json::json;
use std::net::SocketAddr;

/// `goodbye` reason for an agent whose device was enrolled again elsewhere (same machine id).
pub const GOODBYE_REENROLLED: &str = "replaced by a re-enrolled agent";

/// Trimmed machine id, or `None` when absent or implausible (empty, over 128 bytes, control
/// characters) — such values are ignored rather than rejected.
pub fn normalize_machine_id(raw: Option<&str>) -> Option<&str> {
    let id = raw?.trim();
    let plausible = !id.is_empty() && id.len() <= 128 && !id.chars().any(char::is_control);
    plausible.then_some(id)
}

pub async fn enroll(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<EnrollRequest>,
) -> ApiResult<(StatusCode, Json<EnrollResponse>)> {
    let ip = state.client_ip(&headers, Some(&ConnectInfo(peer)));
    let token_key = ids::sha256_hex(req.token.trim());
    if let Err(wait) = state.limits.enroll_ip.hit(&ip) {
        return Err(ApiError::rate_limited(
            "too many enrollment attempts, try again later",
            wait.as_secs(),
        ));
    }
    // Only failures count per token: a valid token has nothing to brute-force, and a rollout
    // enrolls many machines with the same one.
    if let Some(wait) = state.limits.enroll_token.blocked_for(&token_key) {
        return Err(ApiError::rate_limited(
            "too many failed enrollment attempts with this token, try again later",
            wait.as_secs(),
        ));
    }
    let token = match validate_token(&state.db, Some(&req.token)).await {
        Ok(t) => t,
        Err(problem) => {
            state.limits.enroll_token.record_failure(&token_key);
            return Err(match problem {
                TokenProblem::Exhausted => {
                    ApiError::new(StatusCode::GONE, "token_exhausted", problem.message())
                }
                _ => ApiError::new(StatusCode::UNAUTHORIZED, "invalid_token", problem.message()),
            });
        }
    };
    if !db::tokens::consume(&state.db, &token.id).await? {
        state.limits.enroll_token.record_failure(&token_key);
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
    let machine_id = normalize_machine_id(req.machine_id.as_deref());
    let device_secret = ids::secret();
    let secret_hash = auth::device::hash_secret(&device_secret);

    if let Some(machine_id) = machine_id {
        if let Some(existing) = db::devices::by_machine_id(&state.db, machine_id, req.os).await? {
            // Two live machines claiming one hardware id are clones (an image deployed without
            // regenerating it), not a reinstall: enroll the newcomer as its own device.
            let clone = state.hub.is_online(&existing.id)
                && !existing.hostname.eq_ignore_ascii_case(hostname);
            if clone {
                tracing::warn!(
                    device = %existing.id,
                    existing_host = %existing.hostname,
                    new_host = %hostname,
                    "machine id already in use by a connected device; enrolling as a new device"
                );
            } else {
                let response = reenroll(
                    &state,
                    existing,
                    ReEnrollment {
                        hostname,
                        arch: req.arch,
                        agent_version: &req.agent_version,
                        secret_hash: &secret_hash,
                        enrolled_with: Some(&token.id),
                        machine_id,
                    },
                    device_secret,
                    &token.label,
                    &ip,
                )
                .await?;
                return Ok((StatusCode::OK, Json(response)));
            }
        }
    }

    // Operator-facing name: `--name` from the installer/CLI when given, else the hostname.
    let name = req
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .unwrap_or(hostname);
    let device_id = ids::device_id();

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
            machine_id,
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

/// Reuse `existing` for a machine that enrolled again: rotate the secret, refresh what the
/// agent reports, close the old agent's connection.
async fn reenroll(
    state: &AppState,
    existing: DeviceRow,
    update: ReEnrollment<'_>,
    device_secret: String,
    token_label: &str,
    ip: &str,
) -> ApiResult<EnrollResponse> {
    let hostname = update.hostname.to_string();
    let device = db::devices::reenroll(&state.db, &existing.id, update)
        .await?
        .ok_or_else(|| ApiError::not_found("device"))?;
    db::audit::record(
        &state.db,
        None,
        "device.reenrolled",
        Some(&device.id),
        json!({
            "name": device.name,
            "hostname": hostname,
            "previous_hostname": existing.hostname,
            "os": device.os,
            "arch": device.arch,
            "agent_version": device.agent_version,
            "token": token_label,
            "ip": ip,
        }),
    )
    .await?;
    // The old installation's credentials are gone; its connection (if any) must not linger.
    state
        .hub
        .disconnect_device(&device.id, GOODBYE_REENROLLED)
        .await;
    state.hub.broadcast_device(&device.id).await;
    tracing::info!(device = %device.id, host = %hostname, "machine enrolled again; device reused");
    Ok(EnrollResponse {
        device_id: device.id.clone(),
        device_secret,
        server_url: state.config.public_url.clone(),
        config: device.config(),
    })
}

#[cfg(test)]
mod tests {
    use super::normalize_machine_id;

    #[test]
    fn machine_ids_are_trimmed_and_sanity_checked() {
        assert_eq!(normalize_machine_id(Some("  ABC-123 ")), Some("ABC-123"));
        assert_eq!(normalize_machine_id(Some("   ")), None);
        assert_eq!(normalize_machine_id(None), None);
        assert_eq!(normalize_machine_id(Some(&"x".repeat(129))), None);
        assert_eq!(normalize_machine_id(Some("a\nb")), None);
    }
}
