//! Fleet agent updates: ask connected agents to install the console's update package.
//!
//! The console only *announces* an update (`ConsoleToAgent::Update { version, url, sha256 }`);
//! the agent's privileged service downloads `url` (`GET /api/agent/package/{platform}` with its
//! device credentials), checks the SHA-256 and replaces itself. Only protocol 2+ agents get
//! the message — older ones would try to update from the unprivileged process. Devices already
//! on (or past) the console's version are skipped.

use crate::agent_bakery::{Package, Platform};
use crate::app::AppState;
use crate::auth::access;
use crate::auth::AuthUser;
use crate::db::{self, models::DeviceRow};
use crate::error::{ApiError, ApiResult};
use crate::hub::PROTOCOL_RETIRE_UPDATE;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use protocol::agent::ConsoleToAgent;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::Duration;

/// Bulk updates are announced in batches so a fleet does not download at the same moment.
const BATCH: usize = 25;
const BATCH_GAP: Duration = Duration::from_secs(15);

/// Whether `current` is an older semver than `available`. Unparsable versions never count as
/// outdated (no badge, no update) rather than guessing.
pub fn is_outdated(current: &str, available: &str) -> bool {
    let parse = |v: &str| semver::Version::parse(v.trim().trim_start_matches('v')).ok();
    match (parse(current), parse(available)) {
        (Some(c), Some(a)) => c < a,
        _ => false,
    }
}

/// Why a device was not asked to update.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Skip {
    DeviceOffline,
    /// Connected with protocol 1: it cannot update from the service; reinstall it.
    AgentTooOld,
    UnsupportedPlatform,
    /// The console's base binary for the platform carries no version (or there is none).
    NoAgentVersion,
    UpToDate,
}

impl Skip {
    fn error(self, version: Option<&str>) -> ApiError {
        match self {
            Skip::DeviceOffline => ApiError::conflict("device_offline", "device is offline"),
            Skip::AgentTooOld => ApiError::conflict(
                "agent_too_old",
                "this agent cannot update itself; reinstall it with the install command",
            ),
            Skip::UnsupportedPlatform => ApiError::conflict(
                "unsupported_platform",
                "no agent builds exist for this platform",
            ),
            Skip::NoAgentVersion => ApiError::conflict(
                "no_agent_version",
                "the console has no agent binary with a known version for this platform",
            ),
            Skip::UpToDate => ApiError::conflict(
                "up_to_date",
                format!(
                    "the agent already runs {} or newer",
                    version.unwrap_or("the console's version")
                ),
            ),
        }
    }
}

/// One device to update.
struct Target {
    device_id: String,
    name: String,
    platform: Platform,
    from: String,
    version: String,
}

fn plan(
    row: &DeviceRow,
    online: &HashMap<String, u32>,
    versions: &HashMap<Platform, Option<String>>,
) -> Result<Target, (Skip, Option<String>)> {
    let platform =
        Platform::for_device(row.os(), row.arch()).ok_or((Skip::UnsupportedPlatform, None))?;
    let version = versions
        .get(&platform)
        .cloned()
        .flatten()
        .ok_or((Skip::NoAgentVersion, None))?;
    if !is_outdated(&row.agent_version, &version) {
        return Err((Skip::UpToDate, Some(version)));
    }
    match online.get(&row.id) {
        None => return Err((Skip::DeviceOffline, Some(version))),
        Some(&p) if p < PROTOCOL_RETIRE_UPDATE => return Err((Skip::AgentTooOld, Some(version))),
        Some(_) => {}
    }
    Ok(Target {
        device_id: row.id.clone(),
        name: row.name.clone(),
        platform,
        from: row.agent_version.clone(),
        version,
    })
}

#[derive(Serialize)]
pub struct UpdateRequested {
    pub device_id: String,
    pub version: String,
}

/// `POST /api/devices/{id}/update` (manage).
pub async fn update_one(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> ApiResult<(StatusCode, Json<UpdateRequested>)> {
    let access = access::for_user(&state, &user.0).await?;
    access::require_manage(&access, &id)?;
    let row = db::devices::by_id(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("device"))?;
    let versions = state.bakery.versions(&state.config).await;
    let target = plan(&row, &state.hub.online_agents(), &versions)
        .map_err(|(skip, version)| skip.error(version.as_deref()))?;
    audit_requested(&state, &user, &target, false).await;
    let response = UpdateRequested {
        device_id: target.device_id.clone(),
        version: target.version.clone(),
    };
    dispatch(state, vec![target]);
    Ok((StatusCode::ACCEPTED, Json(response)))
}

#[derive(Deserialize, Default)]
pub struct BulkBody {
    /// Only devices in this group.
    #[serde(default)]
    pub group_id: Option<String>,
}

#[derive(Serialize)]
pub struct BulkRequested {
    /// Devices asked to update.
    pub requested: Vec<String>,
    /// Version handed out per platform (only platforms with a known version).
    pub versions: BTreeMap<&'static str, String>,
    /// Outdated online devices that were left alone, by reason (`agent_too_old`).
    pub skipped: BTreeMap<Skip, usize>,
}

/// `POST /api/devices/update-outdated` — every outdated, online device the caller may
/// manage (optionally one group's), announced in batches.
pub async fn update_outdated(
    State(state): State<AppState>,
    user: AuthUser,
    body: Option<Json<BulkBody>>,
) -> ApiResult<(StatusCode, Json<BulkRequested>)> {
    let body = body.map(|Json(b)| b).unwrap_or_default();
    let access = access::for_user(&state, &user.0).await?;
    let rows = db::devices::list(&state.db).await?;
    let members = match body.group_id.as_deref() {
        Some(gid) => {
            if db::groups::by_id(&state.db, gid).await?.is_none() {
                return Err(ApiError::not_found("group"));
            }
            Some(db::groups::member_device_ids(&state.db, gid).await?)
        }
        None => None,
    };
    let manageable: Vec<&DeviceRow> = rows
        .iter()
        .filter(|d| access.can_manage(&d.id))
        .filter(|d| members.as_ref().is_none_or(|m| m.contains(&d.id)))
        .collect();
    if manageable.is_empty() && !access.is_admin() {
        return Err(ApiError::forbidden());
    }

    let versions = state.bakery.versions(&state.config).await;
    let online = state.hub.online_agents();
    let mut targets = Vec::new();
    let mut skipped: BTreeMap<Skip, usize> = BTreeMap::new();
    for row in manageable {
        match plan(row, &online, &versions) {
            Ok(t) => targets.push(t),
            // Only report what an admin can act on: old agents need a reinstall.
            Err((skip @ Skip::AgentTooOld, _)) => *skipped.entry(skip).or_default() += 1,
            Err(_) => {}
        }
    }
    for t in &targets {
        audit_requested(&state, &user, t, true).await;
    }
    let response = BulkRequested {
        requested: targets.iter().map(|t| t.device_id.clone()).collect(),
        versions: versions
            .iter()
            .filter_map(|(p, v)| v.clone().map(|v| (p.slug(), v)))
            .collect(),
        skipped,
    };
    dispatch(state, targets);
    Ok((StatusCode::ACCEPTED, Json(response)))
}

async fn audit_requested(state: &AppState, user: &AuthUser, t: &Target, bulk: bool) {
    db::audit::record_lossy(
        &state.db,
        Some(user.actor()),
        "device.update_requested",
        Some(&t.device_id),
        json!({
            "name": t.name,
            "platform": t.platform.slug(),
            "from": t.from,
            "version": t.version,
            "bulk": bulk,
        }),
    )
    .await;
}

/// Bake (or reuse) each platform's package and announce it, `BATCH` devices at a time. Runs
/// in the background: the first macOS package may wait for signing and notarization.
fn dispatch(state: AppState, targets: Vec<Target>) {
    if targets.is_empty() {
        return;
    }
    tokio::spawn(async move {
        let mut packages: HashMap<Platform, Option<Arc<Package>>> = HashMap::new();
        for (i, batch) in targets.chunks(BATCH).enumerate() {
            if i > 0 {
                tokio::time::sleep(BATCH_GAP).await;
            }
            for t in batch {
                let pkg = match packages.get(&t.platform) {
                    Some(p) => p.clone(),
                    None => {
                        let p = match state
                            .bakery
                            .package(&state.config, &state.db, t.platform)
                            .await
                        {
                            Ok(p) => Some(p),
                            Err(err) => {
                                tracing::error!(
                                    platform = t.platform.slug(),
                                    "update package failed: {err:#}"
                                );
                                None
                            }
                        };
                        packages.insert(t.platform, p.clone());
                        p
                    }
                };
                let Some(pkg) = pkg else { continue };
                // The package is the authority on its version (the base binary may have
                // changed since the request was planned).
                let Some(version) = pkg.version.clone() else {
                    continue;
                };
                if !is_outdated(&t.from, &version) {
                    continue;
                }
                let sent = state.hub.send_to_agent_min_protocol(
                    &t.device_id,
                    PROTOCOL_RETIRE_UPDATE,
                    ConsoleToAgent::Update {
                        version: version.clone(),
                        url: package_url(&state.config.public_url, t.platform),
                        sha256: pkg.sha256.clone(),
                    },
                );
                if sent {
                    tracing::info!(device = %t.device_id, from = %t.from, %version, "update announced");
                } else {
                    tracing::info!(device = %t.device_id, "update not announced: agent went offline");
                }
            }
        }
    });
}

/// Where an agent downloads the update package for its platform.
pub fn package_url(public_url: &str, platform: Platform) -> String {
    format!(
        "{}/api/agent/package/{}",
        public_url.trim_end_matches('/'),
        platform.slug()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semver_comparison() {
        assert!(is_outdated("0.1.2", "0.2.0"));
        assert!(is_outdated("0.2.0-beta.1", "0.2.0"));
        assert!(is_outdated("v0.1.0", "0.1.1"));
        assert!(!is_outdated("0.2.0", "0.2.0"));
        assert!(!is_outdated("0.3.0", "0.2.0"));
        assert!(
            !is_outdated("dev", "0.2.0"),
            "unparsable never counts as outdated"
        );
        assert!(!is_outdated("0.1.0", "garbage"));
    }

    #[test]
    fn package_urls() {
        assert_eq!(
            package_url("https://c.example/", Platform::WindowsAarch64),
            "https://c.example/api/agent/package/windows-aarch64"
        );
    }
}
