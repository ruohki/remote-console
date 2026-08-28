//! Device groups, memberships and grants (`API.md` → "Device groups & access control").

use crate::api::devices::summaries_for;
use crate::app::AppState;
use crate::auth::access::{self, AccessMap};
use crate::auth::{AdminUser, AuthUser};
use crate::db::models::{DeviceDetail, GroupGrant, GroupPermission, GroupPublic, UserGrant};
use crate::db::{self};
use crate::error::{ApiError, ApiResult};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use protocol::ui::DeviceSummary;
use serde::Deserialize;
use serde_json::json;

fn validate_name(name: &str) -> ApiResult<&str> {
    let n = name.trim();
    if n.is_empty() {
        return Err(ApiError::validation("name is required"));
    }
    if n.chars().count() > 80 {
        return Err(ApiError::validation("name must be at most 80 characters"));
    }
    Ok(n)
}

async fn ensure_name_free(state: &AppState, name: &str, except: Option<&str>) -> ApiResult<()> {
    if let Some(existing) = db::groups::by_name(&state.db, name).await? {
        if Some(existing.id.as_str()) != except {
            return Err(ApiError::conflict(
                "name_taken",
                "a group with this name already exists",
            ));
        }
    }
    Ok(())
}

/// `GET /api/groups` — admins: all groups; operators: the groups they are granted.
pub async fn list(
    State(state): State<AppState>,
    user: AuthUser,
) -> ApiResult<Json<Vec<GroupPublic>>> {
    let rows = if user.0.is_admin() {
        db::groups::list(&state.db).await?
    } else {
        db::groups::list_for_user(&state.db, &user.0.id).await?
    };
    Ok(Json(rows.iter().map(|g| g.public()).collect()))
}

#[derive(Deserialize)]
pub struct CreateBody {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
}

pub async fn create(
    State(state): State<AppState>,
    admin: AdminUser,
    Json(body): Json<CreateBody>,
) -> ApiResult<(StatusCode, Json<GroupPublic>)> {
    let name = validate_name(&body.name)?;
    ensure_name_free(&state, name, None).await?;
    let row =
        db::groups::create(&state.db, name, body.description.as_deref().unwrap_or("")).await?;
    db::audit::record(
        &state.db,
        Some(admin.actor()),
        "group.create",
        Some(&row.id),
        json!({ "name": row.name }),
    )
    .await?;
    Ok((StatusCode::CREATED, Json(row.public())))
}

#[derive(Deserialize, Default)]
pub struct UpdateBody {
    pub name: Option<String>,
    pub description: Option<String>,
}

pub async fn update(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(id): Path<String>,
    Json(body): Json<UpdateBody>,
) -> ApiResult<Json<GroupPublic>> {
    db::groups::by_id(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("group"))?;
    let name = match &body.name {
        Some(n) => {
            let n = validate_name(n)?;
            ensure_name_free(&state, n, Some(&id)).await?;
            Some(n)
        }
        None => None,
    };
    let row = db::groups::update(&state.db, &id, name, body.description.as_deref())
        .await?
        .ok_or_else(|| ApiError::not_found("group"))?;
    db::audit::record(
        &state.db,
        Some(admin.actor()),
        "group.update",
        Some(&id),
        json!({ "name": body.name, "description_changed": body.description.is_some() }),
    )
    .await?;
    // Group names show up in every member's `groups`; refresh the live rows.
    for device_id in db::groups::member_device_ids(&state.db, &id).await? {
        state.hub.broadcast_device(&device_id).await;
    }
    Ok(Json(row.public()))
}

pub async fn delete(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let row = db::groups::by_id(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("group"))?;
    let members = db::groups::member_device_ids(&state.db, &id).await?;
    db::groups::delete(&state.db, &id).await?;
    db::audit::record(
        &state.db,
        Some(admin.actor()),
        "group.delete",
        Some(&id),
        json!({ "name": row.name, "devices": members.len() }),
    )
    .await?;
    state.hub.refresh_access().await;
    for device_id in members {
        state.hub.broadcast_device(&device_id).await;
    }
    Ok(StatusCode::NO_CONTENT)
}

/// `GET /api/groups/:id/devices` — admins, or operators granted on the group.
pub async fn devices(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Vec<DeviceSummary>>> {
    db::groups::by_id(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("group"))?;
    if !user.0.is_admin() && !db::groups::user_has_grant(&state.db, &user.0.id, &id).await? {
        return Err(ApiError::not_found("group"));
    }
    let access = access::for_user(&state, &user.0).await?;
    let ids = db::groups::member_device_ids(&state.db, &id).await?;
    let mut rows = Vec::with_capacity(ids.len());
    for device_id in &ids {
        if let Some(row) = db::devices::by_id(&state.db, device_id).await? {
            rows.push(row);
        }
    }
    rows.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(Json(summaries_for(&state, &access, &rows).await?))
}

#[derive(Deserialize)]
pub struct MembersBody {
    pub device_ids: Vec<String>,
}

/// `PUT /api/groups/:id/devices` — replace the membership.
pub async fn set_members(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(id): Path<String>,
    Json(body): Json<MembersBody>,
) -> ApiResult<StatusCode> {
    db::groups::by_id(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("group"))?;
    let mut device_ids = body.device_ids;
    device_ids.sort();
    device_ids.dedup();
    if db::groups::count_existing_devices(&state.db, &device_ids).await? != device_ids.len() as i64
    {
        return Err(ApiError::validation("one or more device ids do not exist"));
    }
    let before = db::groups::member_device_ids(&state.db, &id).await?;
    db::groups::set_members(&state.db, &id, &device_ids).await?;
    db::audit::record(
        &state.db,
        Some(admin.actor()),
        "group.members",
        Some(&id),
        json!({ "device_ids": device_ids }),
    )
    .await?;
    state.hub.refresh_access().await;
    let mut affected = before;
    affected.extend(device_ids);
    affected.sort();
    affected.dedup();
    for device_id in affected {
        state.hub.broadcast_device(&device_id).await;
    }
    Ok(StatusCode::NO_CONTENT)
}

/// `GET /api/groups/:id/grants`
pub async fn grants(
    State(state): State<AppState>,
    _admin: AdminUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Vec<GroupGrant>>> {
    db::groups::by_id(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("group"))?;
    let rows = db::groups::grants(&state.db, &id).await?;
    Ok(Json(rows.iter().map(|g| g.public()).collect()))
}

#[derive(Deserialize)]
pub struct GrantEntry {
    pub user_id: String,
    pub permission: GroupPermission,
}

#[derive(Deserialize)]
pub struct GrantsBody {
    pub grants: Vec<GrantEntry>,
}

/// `PUT /api/groups/:id/grants` — replace all grants of the group.
pub async fn set_grants(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(id): Path<String>,
    Json(body): Json<GrantsBody>,
) -> ApiResult<Json<Vec<GroupGrant>>> {
    db::groups::by_id(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("group"))?;
    // Last entry per user wins; keep deterministic order for the audit row.
    let mut merged: Vec<(String, GroupPermission)> = Vec::new();
    for g in body.grants {
        match merged.iter_mut().find(|(u, _)| *u == g.user_id) {
            Some(existing) => existing.1 = g.permission,
            None => merged.push((g.user_id, g.permission)),
        }
    }
    let user_ids: Vec<String> = merged.iter().map(|(u, _)| u.clone()).collect();
    if db::groups::count_existing_users(&state.db, &user_ids).await? != user_ids.len() as i64 {
        return Err(ApiError::validation("one or more user ids do not exist"));
    }
    db::groups::set_grants(&state.db, &id, &merged).await?;
    db::audit::record(
        &state.db,
        Some(admin.actor()),
        "group.grants",
        Some(&id),
        json!({ "grants": merged.iter().map(|(u, p)| json!({ "user_id": u, "permission": p })).collect::<Vec<_>>() }),
    )
    .await?;
    state.hub.refresh_access().await;
    let rows = db::groups::grants(&state.db, &id).await?;
    Ok(Json(rows.iter().map(|g| g.public()).collect()))
}

#[derive(Deserialize)]
pub struct DeviceGroupsBody {
    pub group_ids: Vec<String>,
}

/// `PUT /api/devices/:id/groups` — replace the groups of a device (admin).
pub async fn set_device_groups(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(id): Path<String>,
    Json(body): Json<DeviceGroupsBody>,
) -> ApiResult<Json<DeviceDetail>> {
    db::devices::by_id(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("device"))?;
    let mut group_ids = body.group_ids;
    group_ids.sort();
    group_ids.dedup();
    if db::groups::count_existing_groups(&state.db, &group_ids).await? != group_ids.len() as i64 {
        return Err(ApiError::validation("one or more group ids do not exist"));
    }
    db::groups::set_device_groups(&state.db, &id, &group_ids).await?;
    db::audit::record(
        &state.db,
        Some(admin.actor()),
        "device.groups",
        Some(&id),
        json!({ "group_ids": group_ids }),
    )
    .await?;
    state.hub.refresh_access().await;
    state.hub.broadcast_device(&id).await;
    let access = AccessMap::admin();
    Ok(Json(
        crate::api::devices::load_detail(&state, &id, &access).await?,
    ))
}

/// `GET /api/users/:id/grants`
pub async fn user_grants(
    State(state): State<AppState>,
    _admin: AdminUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Vec<UserGrant>>> {
    db::users::by_id(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("user"))?;
    let rows = db::groups::grants_for_user(&state.db, &id).await?;
    Ok(Json(rows.iter().map(|g| g.public()).collect()))
}
