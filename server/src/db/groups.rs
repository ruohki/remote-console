//! Device groups, memberships and per-user grants (RBAC).

use super::models::{GroupGrantRow, GroupPermission, GroupRow, UserGrantRow};
use super::{now, Db};
use protocol::ui::GroupRef;
use sqlx::Result;
use std::collections::HashMap;

const SELECT: &str = "SELECT g.id, g.name, g.description, g.created_at,
        (SELECT COUNT(*) FROM device_group_members m WHERE m.group_id = g.id) AS device_count
   FROM device_groups g";

pub async fn create(db: &Db, name: &str, description: &str) -> Result<GroupRow> {
    let id = crate::ids::group_id();
    sqlx::query(
        "INSERT INTO device_groups (id, name, description, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(name.trim())
    .bind(description.trim())
    .bind(now())
    .execute(db)
    .await?;
    by_id(db, &id).await?.ok_or(sqlx::Error::RowNotFound)
}

pub async fn by_id(db: &Db, id: &str) -> Result<Option<GroupRow>> {
    sqlx::query_as::<_, GroupRow>(&format!("{SELECT} WHERE g.id = ?"))
        .bind(id)
        .fetch_optional(db)
        .await
}

pub async fn by_name(db: &Db, name: &str) -> Result<Option<GroupRow>> {
    sqlx::query_as::<_, GroupRow>(&format!("{SELECT} WHERE g.name = ? COLLATE NOCASE"))
        .bind(name.trim())
        .fetch_optional(db)
        .await
}

pub async fn list(db: &Db) -> Result<Vec<GroupRow>> {
    sqlx::query_as::<_, GroupRow>(&format!("{SELECT} ORDER BY g.name COLLATE NOCASE ASC"))
        .fetch_all(db)
        .await
}

/// Groups the user holds any grant on.
pub async fn list_for_user(db: &Db, user_id: &str) -> Result<Vec<GroupRow>> {
    sqlx::query_as::<_, GroupRow>(&format!(
        "{SELECT} JOIN group_grants gr ON gr.group_id = g.id
         WHERE gr.user_id = ? ORDER BY g.name COLLATE NOCASE ASC"
    ))
    .bind(user_id)
    .fetch_all(db)
    .await
}

pub async fn update(
    db: &Db,
    id: &str,
    name: Option<&str>,
    description: Option<&str>,
) -> Result<Option<GroupRow>> {
    sqlx::query(
        "UPDATE device_groups SET name = COALESCE(?, name), description = COALESCE(?, description)
         WHERE id = ?",
    )
    .bind(name.map(str::trim))
    .bind(description.map(str::trim))
    .bind(id)
    .execute(db)
    .await?;
    by_id(db, id).await
}

pub async fn delete(db: &Db, id: &str) -> Result<bool> {
    let res = sqlx::query("DELETE FROM device_groups WHERE id = ?")
        .bind(id)
        .execute(db)
        .await?;
    Ok(res.rows_affected() > 0)
}

// ── membership ───────────────────────────────────────────────────────────────

/// Replace the members of a group. Unknown device ids are rejected by the caller.
pub async fn set_members(db: &Db, group_id: &str, device_ids: &[String]) -> Result<()> {
    let mut tx = db.begin().await?;
    sqlx::query("DELETE FROM device_group_members WHERE group_id = ?")
        .bind(group_id)
        .execute(&mut *tx)
        .await?;
    for device_id in device_ids {
        sqlx::query(
            "INSERT OR IGNORE INTO device_group_members (group_id, device_id) VALUES (?, ?)",
        )
        .bind(group_id)
        .bind(device_id)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await
}

/// Replace the groups of a device.
pub async fn set_device_groups(db: &Db, device_id: &str, group_ids: &[String]) -> Result<()> {
    let mut tx = db.begin().await?;
    sqlx::query("DELETE FROM device_group_members WHERE device_id = ?")
        .bind(device_id)
        .execute(&mut *tx)
        .await?;
    for group_id in group_ids {
        sqlx::query(
            "INSERT OR IGNORE INTO device_group_members (group_id, device_id) VALUES (?, ?)",
        )
        .bind(group_id)
        .bind(device_id)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await
}

pub async fn add_member(db: &Db, group_id: &str, device_id: &str) -> Result<()> {
    sqlx::query("INSERT OR IGNORE INTO device_group_members (group_id, device_id) VALUES (?, ?)")
        .bind(group_id)
        .bind(device_id)
        .execute(db)
        .await?;
    Ok(())
}

pub async fn member_device_ids(db: &Db, group_id: &str) -> Result<Vec<String>> {
    sqlx::query_scalar("SELECT device_id FROM device_group_members WHERE group_id = ?")
        .bind(group_id)
        .fetch_all(db)
        .await
}

/// How many of `ids` exist as devices (used to validate membership updates).
pub async fn count_existing_devices(db: &Db, ids: &[String]) -> Result<i64> {
    if ids.is_empty() {
        return Ok(0);
    }
    let placeholders = vec!["?"; ids.len()].join(",");
    let sql = format!("SELECT COUNT(*) FROM devices WHERE id IN ({placeholders})");
    let mut q = sqlx::query_scalar::<_, i64>(&sql);
    for id in ids {
        q = q.bind(id);
    }
    q.fetch_one(db).await
}

pub async fn count_existing_groups(db: &Db, ids: &[String]) -> Result<i64> {
    if ids.is_empty() {
        return Ok(0);
    }
    let placeholders = vec!["?"; ids.len()].join(",");
    let sql = format!("SELECT COUNT(*) FROM device_groups WHERE id IN ({placeholders})");
    let mut q = sqlx::query_scalar::<_, i64>(&sql);
    for id in ids {
        q = q.bind(id);
    }
    q.fetch_one(db).await
}

#[derive(Debug, Clone, sqlx::FromRow)]
struct MemberRef {
    device_id: String,
    id: String,
    name: String,
}

/// Groups of one device.
pub async fn groups_for_device(db: &Db, device_id: &str) -> Result<Vec<GroupRef>> {
    let rows = sqlx::query_as::<_, MemberRef>(
        "SELECT m.device_id, g.id, g.name FROM device_group_members m
         JOIN device_groups g ON g.id = m.group_id
         WHERE m.device_id = ? ORDER BY g.name COLLATE NOCASE",
    )
    .bind(device_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| GroupRef {
            id: r.id,
            name: r.name,
        })
        .collect())
}

/// Groups of every device (one query), keyed by device id.
pub async fn groups_for_all_devices(db: &Db) -> Result<HashMap<String, Vec<GroupRef>>> {
    let rows = sqlx::query_as::<_, MemberRef>(
        "SELECT m.device_id, g.id, g.name FROM device_group_members m
         JOIN device_groups g ON g.id = m.group_id ORDER BY g.name COLLATE NOCASE",
    )
    .fetch_all(db)
    .await?;
    let mut out: HashMap<String, Vec<GroupRef>> = HashMap::new();
    for r in rows {
        out.entry(r.device_id).or_default().push(GroupRef {
            id: r.id,
            name: r.name,
        });
    }
    Ok(out)
}

// ── grants ───────────────────────────────────────────────────────────────────

pub async fn grants(db: &Db, group_id: &str) -> Result<Vec<GroupGrantRow>> {
    sqlx::query_as::<_, GroupGrantRow>(
        "SELECT gr.user_id, u.name AS user_name, u.email AS user_email, gr.permission
         FROM group_grants gr JOIN users u ON u.id = gr.user_id
         WHERE gr.group_id = ? ORDER BY u.name COLLATE NOCASE",
    )
    .bind(group_id)
    .fetch_all(db)
    .await
}

/// Replace all grants of a group. New grants are `manual`; a grant that already exists keeps
/// its `source` (an SSO-managed grant stays under SSO control when an admin re-saves the list).
pub async fn set_grants(
    db: &Db,
    group_id: &str,
    grants: &[(String, GroupPermission)],
) -> Result<()> {
    let mut tx = db.begin().await?;
    let keep: Vec<&str> = grants.iter().map(|(u, _)| u.as_str()).collect();
    let placeholders = vec!["?"; keep.len().max(1)].join(",");
    let sql =
        format!("DELETE FROM group_grants WHERE group_id = ? AND user_id NOT IN ({placeholders})");
    let mut del = sqlx::query(&sql).bind(group_id);
    if keep.is_empty() {
        del = del.bind("");
    }
    for u in &keep {
        del = del.bind(*u);
    }
    del.execute(&mut *tx).await?;
    for (user_id, permission) in grants {
        sqlx::query(
            "INSERT INTO group_grants (group_id, user_id, permission, source) VALUES (?, ?, ?, 'manual')
             ON CONFLICT(group_id, user_id) DO UPDATE SET permission = excluded.permission",
        )
        .bind(group_id)
        .bind(user_id)
        .bind(permission.as_str())
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await
}

pub async fn count_existing_users(db: &Db, ids: &[String]) -> Result<i64> {
    if ids.is_empty() {
        return Ok(0);
    }
    let placeholders = vec!["?"; ids.len()].join(",");
    let sql = format!("SELECT COUNT(*) FROM users WHERE id IN ({placeholders})");
    let mut q = sqlx::query_scalar::<_, i64>(&sql);
    for id in ids {
        q = q.bind(id);
    }
    q.fetch_one(db).await
}

pub async fn grants_for_user(db: &Db, user_id: &str) -> Result<Vec<UserGrantRow>> {
    sqlx::query_as::<_, UserGrantRow>(
        "SELECT gr.group_id, g.name AS group_name, gr.permission
         FROM group_grants gr JOIN device_groups g ON g.id = gr.group_id
         WHERE gr.user_id = ? ORDER BY g.name COLLATE NOCASE",
    )
    .bind(user_id)
    .fetch_all(db)
    .await
}

/// Whether the user holds any grant on the group.
pub async fn user_has_grant(db: &Db, user_id: &str, group_id: &str) -> Result<bool> {
    let n: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM group_grants WHERE user_id = ? AND group_id = ?")
            .bind(user_id)
            .bind(group_id)
            .fetch_one(db)
            .await?;
    Ok(n > 0)
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct DeviceGrant {
    pub device_id: String,
    pub permission: String,
}

/// Every (device, permission) pair reachable by the user through its grants — one query.
pub async fn device_grants_for_user(db: &Db, user_id: &str) -> Result<Vec<DeviceGrant>> {
    sqlx::query_as::<_, DeviceGrant>(
        "SELECT m.device_id, gr.permission
         FROM group_grants gr JOIN device_group_members m ON m.group_id = gr.group_id
         WHERE gr.user_id = ?",
    )
    .bind(user_id)
    .fetch_all(db)
    .await
}
