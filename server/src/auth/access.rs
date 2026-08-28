//! Device visibility and permissions (RBAC).
//!
//! Admins may do everything. Operators reach devices only through *grants* on the device
//! groups they belong to; the strongest grant over a device's groups is the effective
//! [`DevicePermission`]. Everything is resolved once per request / UI connection into an
//! [`AccessMap`] (one query), never per row.

use crate::app::AppState;
use crate::db::models::{GroupPermission, UserRow};
use crate::db::{self, Db};
use crate::error::{ApiError, ApiResult};
use protocol::ui::DevicePermission;
use std::collections::{HashMap, HashSet};

/// Effective permission of one user on every device they can reach.
#[derive(Debug, Clone)]
pub struct AccessMap {
    admin: bool,
    perms: HashMap<String, DevicePermission>,
}

/// Highest permission over a device's groups; `None` when the user has no grant at all.
pub fn resolve(admin: bool, grants: &[GroupPermission]) -> Option<DevicePermission> {
    if admin {
        return Some(DevicePermission::Manage);
    }
    grants
        .iter()
        .copied()
        .max()
        .map(GroupPermission::as_device_permission)
}

impl AccessMap {
    pub fn admin() -> Self {
        Self {
            admin: true,
            perms: HashMap::new(),
        }
    }

    /// Build from raw `(device_id, permission)` grant rows.
    pub fn from_grants(
        admin: bool,
        grants: impl IntoIterator<Item = (String, GroupPermission)>,
    ) -> Self {
        let mut by_device: HashMap<String, Vec<GroupPermission>> = HashMap::new();
        for (device_id, permission) in grants {
            by_device.entry(device_id).or_default().push(permission);
        }
        let perms = by_device
            .into_iter()
            .filter_map(|(id, ps)| resolve(false, &ps).map(|p| (id, p)))
            .collect();
        Self { admin, perms }
    }

    /// One query for the user's grants; admins skip the query entirely.
    pub async fn load(db: &Db, user: &UserRow) -> sqlx::Result<Self> {
        if user.is_admin() {
            return Ok(Self::admin());
        }
        let rows = db::groups::device_grants_for_user(db, &user.id).await?;
        Ok(Self::from_grants(
            false,
            rows.into_iter()
                .filter_map(|r| GroupPermission::parse(&r.permission).map(|p| (r.device_id, p))),
        ))
    }

    pub fn is_admin(&self) -> bool {
        self.admin
    }

    /// Effective permission on a device, `None` when it must stay invisible.
    pub fn permission(&self, device_id: &str) -> Option<DevicePermission> {
        if self.admin {
            Some(DevicePermission::Manage)
        } else {
            self.perms.get(device_id).copied()
        }
    }

    pub fn can_see(&self, device_id: &str) -> bool {
        self.permission(device_id).is_some()
    }

    pub fn can_connect(&self, device_id: &str) -> bool {
        matches!(
            self.permission(device_id),
            Some(DevicePermission::Connect | DevicePermission::Manage)
        )
    }

    pub fn can_manage(&self, device_id: &str) -> bool {
        matches!(self.permission(device_id), Some(DevicePermission::Manage))
    }

    /// Device ids the user may see; `None` means "all" (admins).
    pub fn visible_device_ids(&self) -> Option<HashSet<String>> {
        if self.admin {
            None
        } else {
            Some(self.perms.keys().cloned().collect())
        }
    }
}

// ── request helpers ───────────────────────────────────────────────────────────

/// Load the caller's access map (one query).
pub async fn for_user(state: &AppState, user: &UserRow) -> ApiResult<AccessMap> {
    Ok(AccessMap::load(&state.db, user).await?)
}

/// The device must be visible to the caller, otherwise it does not exist for them (404).
pub fn require_visible(access: &AccessMap, device_id: &str) -> ApiResult<DevicePermission> {
    access
        .permission(device_id)
        .ok_or_else(|| ApiError::not_found("device"))
}

/// Visible **and** at least `connect` (403 when only `view`).
pub fn require_connect(access: &AccessMap, device_id: &str) -> ApiResult<DevicePermission> {
    let perm = require_visible(access, device_id)?;
    if access.can_connect(device_id) {
        Ok(perm)
    } else {
        Err(ApiError::forbidden())
    }
}

/// Visible **and** `manage` (admins).
pub fn require_manage(access: &AccessMap, device_id: &str) -> ApiResult<DevicePermission> {
    let perm = require_visible(access, device_id)?;
    if access.can_manage(device_id) {
        Ok(perm)
    } else {
        Err(ApiError::forbidden())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admin_manages_everything() {
        let m = AccessMap::admin();
        assert!(m.is_admin());
        assert_eq!(m.permission("dev_x"), Some(DevicePermission::Manage));
        assert!(m.can_manage("anything"));
        assert!(m.visible_device_ids().is_none());
        assert_eq!(resolve(true, &[]), Some(DevicePermission::Manage));
    }

    #[test]
    fn operator_without_grants_sees_nothing() {
        let m = AccessMap::from_grants(false, Vec::<(String, GroupPermission)>::new());
        assert_eq!(m.permission("dev_a"), None);
        assert!(!m.can_see("dev_a"));
        assert_eq!(m.visible_device_ids(), Some(HashSet::new()));
        assert_eq!(resolve(false, &[]), None);
    }

    #[test]
    fn strongest_grant_wins_across_groups() {
        // dev_a is in two groups: one granted view, one connect.
        let m = AccessMap::from_grants(
            false,
            vec![
                ("dev_a".to_string(), GroupPermission::View),
                ("dev_a".to_string(), GroupPermission::Connect),
                ("dev_b".to_string(), GroupPermission::View),
            ],
        );
        assert_eq!(m.permission("dev_a"), Some(DevicePermission::Connect));
        assert!(m.can_connect("dev_a"));
        assert!(!m.can_manage("dev_a"));
        assert_eq!(m.permission("dev_b"), Some(DevicePermission::View));
        assert!(m.can_see("dev_b"));
        assert!(!m.can_connect("dev_b"));
        // ungrouped / ungranted device
        assert_eq!(m.permission("dev_c"), None);
        let visible = m.visible_device_ids().unwrap();
        assert_eq!(visible.len(), 2);
        assert!(visible.contains("dev_a") && visible.contains("dev_b"));
    }

    #[test]
    fn request_helpers_map_to_status_codes() {
        let m = AccessMap::from_grants(false, vec![("dev_v".to_string(), GroupPermission::View)]);
        assert!(require_visible(&m, "dev_v").is_ok());
        assert_eq!(require_visible(&m, "dev_x").unwrap_err().status, 404);
        assert_eq!(require_connect(&m, "dev_v").unwrap_err().status, 403);
        assert_eq!(require_connect(&m, "dev_x").unwrap_err().status, 404);
        assert_eq!(require_manage(&m, "dev_v").unwrap_err().status, 403);
        assert!(require_manage(&AccessMap::admin(), "dev_v").is_ok());
    }
}
