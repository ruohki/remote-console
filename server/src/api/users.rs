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
    db::audit::record(
        &state.db,
        Some(admin.actor()),
        "user.update",
        Some(&id),
        json!({
            "name": body.name, "role": body.role, "disabled": body.disabled,
            "password_changed": password_hash.is_some()
        }),
    )
    .await?;
    Ok(Json(updated.public()))
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
