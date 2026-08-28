//! REST API (`/api/*`). Paths and bodies follow `API.md`.

pub mod agent;
pub mod audit;
pub mod auth;
pub mod branding;
pub mod devices;
pub mod enroll;
pub mod groups;
pub mod info;
pub mod sessions;
pub mod tokens;
pub mod users;

use crate::app::AppState;
use axum::routing::{get, post};
use axum::Router;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/setup", get(auth::setup_status).post(auth::setup))
        .route("/auth/login", post(auth::login))
        .route("/auth/logout", post(auth::logout))
        .route("/auth/me", get(auth::me))
        .route("/info", get(info::info))
        .route("/branding", get(branding::get).put(branding::put))
        .route("/agent/downloads", get(agent::downloads))
        .route("/agent/download/{platform}", get(agent::download))
        .route("/users", get(users::list).post(users::create))
        .route(
            "/users/{id}",
            axum::routing::patch(users::update).delete(users::delete),
        )
        .route("/users/{id}/grants", get(groups::user_grants))
        .route("/groups", get(groups::list).post(groups::create))
        .route(
            "/groups/{id}",
            axum::routing::patch(groups::update).delete(groups::delete),
        )
        .route(
            "/groups/{id}/devices",
            get(groups::devices).put(groups::set_members),
        )
        .route(
            "/groups/{id}/grants",
            get(groups::grants).put(groups::set_grants),
        )
        .route("/enroll-tokens", get(tokens::list).post(tokens::create))
        .route("/enroll-tokens/{id}", axum::routing::delete(tokens::revoke))
        .route("/enroll", post(enroll::enroll))
        .route("/devices", get(devices::list))
        .route(
            "/devices/{id}",
            get(devices::get_one)
                .patch(devices::update)
                .delete(devices::delete),
        )
        .route(
            "/devices/{id}/config",
            axum::routing::patch(devices::update_config),
        )
        .route(
            "/devices/{id}/groups",
            axum::routing::put(groups::set_device_groups),
        )
        .route("/devices/{id}/sessions", get(devices::sessions))
        .route("/sessions", get(sessions::list))
        .route("/sessions/{id}/end", post(sessions::end))
        .route("/sessions/{id}/events", get(sessions::events))
        .route("/audit", get(audit::list))
        .fallback(|| async { crate::error::ApiError::not_found("endpoint") })
}
