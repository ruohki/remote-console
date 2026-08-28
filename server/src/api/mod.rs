//! REST API (`/api/*`). Paths and bodies follow `API.md`.

pub mod audit;
pub mod auth;
pub mod devices;
pub mod enroll;
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
        .route("/users", get(users::list).post(users::create))
        .route(
            "/users/{id}",
            axum::routing::patch(users::update).delete(users::delete),
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
        .route("/devices/{id}/sessions", get(devices::sessions))
        .route("/sessions", get(sessions::list))
        .route("/sessions/{id}/end", post(sessions::end))
        .route("/audit", get(audit::list))
        .fallback(|| async { crate::error::ApiError::not_found("endpoint") })
}
