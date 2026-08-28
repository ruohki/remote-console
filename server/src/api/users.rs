//! User management (admin only).

use crate::app::AppState;
use crate::auth::{self, AdminUser};
use crate::db::{
    self,
    models::{Role, UserPublic},
    users::UserUpdate,
};
use crate::error::{ApiError, ApiResult};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::json;

pub async fn list(
    State(state): State<AppState>,
    _admin: AdminUser,
) -> ApiResult<Json<Vec<UserPublic>>> {
    let users = db::users::list(&state.db).await?;
    Ok(Json(users.iter().map(|u| u.public()).collect()))
}

#[derive(Deserialize)]
pub struct CreateBody {
    pub email: String,
    pub name: String,
    pub password: String,
    pub role: Role,
}

pub async fn create(
    State(state): State<AppState>,
    admin: AdminUser,
    Json(body): Json<CreateBody>,
) -> ApiResult<(StatusCode, Json<UserPublic>)> {
    auth::validate_email(&body.email)?;
    auth::validate_password(&body.password)?;
    if body.name.trim().is_empty() {
        return Err(ApiError::validation("name is required"));
    }
    if db::users::by_email(&state.db, &body.email).await?.is_some() {
        return Err(ApiError::conflict(
            "email_taken",
            "a user with this email already exists",
        ));
    }
    let hash = auth::hash_password(&body.password)?;
    let user = db::users::create(&state.db, &body.email, &body.name, &hash, body.role).await?;
    db::audit::record(
        &state.db,
        Some(admin.actor()),
        "user.create",
        Some(&user.id),
        json!({ "email": user.email, "role": user.role }),
    )
    .await?;
    Ok((StatusCode::CREATED, Json(user.public())))
}

#[derive(Deserialize, Default)]
pub struct UpdateBody {
    pub name: Option<String>,
    pub role: Option<Role>,
    pub password: Option<String>,
    pub disabled: Option<bool>,
    /// Emergency account that may still use a password when `LOCAL_LOGIN=0`.
    pub break_glass: Option<bool>,
}

pub async fn update(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(id): Path<String>,
    Json(body): Json<UpdateBody>,
) -> ApiResult<Json<UserPublic>> {
    let existing = db::users::by_id(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("user"))?;

    let losing_admin = existing.is_admin()
        && (body.role.is_some_and(|r| r != Role::Admin) || body.disabled == Some(true));
    if losing_admin && db::users::count_active_admins(&state.db).await? <= 1 {
        return Err(ApiError::conflict(
            "last_admin",
            "cannot demote or disable the last administrator",
        ));
    }
    if let Some(name) = &body.name {
        if name.trim().is_empty() {
            return Err(ApiError::validation("name must not be empty"));
        }
    }
    let password_hash = match &body.password {
        Some(p) => {
            auth::validate_password(p)?;
            Some(auth::hash_password(p)?)
        }
        None => None,
    };
    // Losing the last break-glass admin would lock everyone out once LOCAL_LOGIN=0.
    let losing_break_glass = existing.break_glass
        && (body.break_glass == Some(false)
            || body.disabled == Some(true)
            || body.role.is_some_and(|r| r != Role::Admin));
    if !state.config.local_login
        && losing_break_glass
        && db::users::count_break_glass_admins(&state.db).await? <= 1
    {
        return Err(ApiError::conflict(
            "last_break_glass",
            "LOCAL_LOGIN=0 requires at least one enabled break-glass administrator",
        ));
    }
    if let Some(bg) = body.break_glass {
        db::users::set_break_glass(&state.db, &id, bg).await?;
    }
    let updated = db::users::update(
        &state.db,
        &id,
        UserUpdate {
            name: body.name.as_deref(),
            role: body.role,
            password_hash: password_hash.as_deref(),
            disabled: body.disabled,
        },
    )
    .await?
    .ok_or_else(|| ApiError::not_found("user"))?;

    if body.disabled == Some(true) || password_hash.is_some() {
        db::users::delete_login_sessions_for_user(&state.db, &id).await?;
    }
    if body.role.is_some() || body.disabled.is_some() {
        state.hub.refresh_access().await;
    }
    db::audit::record(
        &state.db,
        Some(admin.actor()),
        "user.update",
        Some(&id),
        json!({
            "name": body.name, "role": body.role, "disabled": body.disabled,
            "break_glass": body.break_glass,
            "password_changed": password_hash.is_some()
        }),
    )
    .await?;
    Ok(Json(updated.public()))
}

/// Clear every second factor of a user; they re-enrol at the next login (under policy).
pub async fn reset_two_factor(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let existing = db::users::by_id(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("user"))?;
    db::users::set_totp(&state.db, &id, None, false).await?;
    db::auth::delete_recovery_codes(&state.db, &id).await?;
    db::auth::delete_passkeys_for_user(&state.db, &id).await?;
    db::users::delete_login_sessions_for_user(&state.db, &id).await?;
    db::audit::record(
        &state.db,
        Some(admin.actor()),
        "user.2fa_reset",
        Some(&id),
        json!({ "email": existing.email, "had_totp": existing.totp_enabled, "passkeys": existing.passkeys }),
    )
    .await?;
    db::audit::record(
        &state.db,
        Some(admin.actor()),
        "2fa.reset",
        Some(&id),
        json!({ "email": existing.email }),
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn passkeys(
    State(state): State<AppState>,
    _admin: AdminUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Vec<db::auth::PasskeyPublic>>> {
    db::users::by_id(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("user"))?;
    let rows = db::auth::passkeys_for_user(&state.db, &id).await?;
    Ok(Json(rows.iter().map(|r| r.public()).collect()))
}

#[derive(Deserialize)]
pub struct RenamePasskeyBody {
    pub name: String,
}

pub async fn rename_passkey(
    State(state): State<AppState>,
    admin: AdminUser,
    Path((id, pid)): Path<(String, String)>,
    Json(body): Json<RenamePasskeyBody>,
) -> ApiResult<Json<db::auth::PasskeyPublic>> {
    let row = db::auth::passkey_by_id(&state.db, &pid)
        .await?
        .filter(|p| p.user_id == id)
        .ok_or_else(|| ApiError::not_found("passkey"))?;
    let name = body.name.trim();
    if name.is_empty() || name.chars().count() > 60 {
        return Err(ApiError::validation("name must be 1–60 characters"));
    }
    db::auth::rename_passkey(&state.db, &row.id, name).await?;
    db::audit::record(
        &state.db,
        Some(admin.actor()),
        "user.update",
        Some(&id),
        json!({ "passkey": row.id, "passkey_name": name }),
    )
    .await?;
    let row = db::auth::passkey_by_id(&state.db, &pid)
        .await?
        .ok_or_else(|| ApiError::not_found("passkey"))?;
    Ok(Json(row.public()))
}

pub async fn delete_passkey(
    State(state): State<AppState>,
    admin: AdminUser,
    Path((id, pid)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let row = db::auth::passkey_by_id(&state.db, &pid)
        .await?
        .filter(|p| p.user_id == id)
        .ok_or_else(|| ApiError::not_found("passkey"))?;
    db::auth::delete_passkey(&state.db, &row.id).await?;
    db::audit::record(
        &state.db,
        Some(admin.actor()),
        "passkey.remove",
        Some(&id),
        json!({ "passkey": row.id, "name": row.name, "by_admin": true }),
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn delete(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    if admin.0.id == id {
        return Err(ApiError::conflict(
            "self_delete",
            "you cannot delete your own account",
        ));
    }
    let existing = db::users::by_id(&state.db, &id)
        .await?
        .ok_or_else(|| ApiError::not_found("user"))?;
    if existing.is_admin()
        && !existing.disabled
        && db::users::count_active_admins(&state.db).await? <= 1
    {
        return Err(ApiError::conflict(
            "last_admin",
            "cannot delete the last administrator",
        ));
    }
    db::users::delete(&state.db, &id).await?;
    state.hub.refresh_access().await;
    db::audit::record(
        &state.db,
        Some(admin.actor()),
        "user.delete",
        Some(&id),
        json!({ "email": existing.email }),
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}
