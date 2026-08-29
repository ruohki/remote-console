//! REST API (`/api/*`). Paths and bodies follow `API.md`.

pub mod agent;
pub mod audit;
pub mod auth;
pub mod branding;
pub mod devices;
pub mod email;
pub mod enroll;
pub mod groups;
pub mod info;
pub mod sessions;
pub mod sso;
pub mod tokens;
pub mod users;

use crate::app::AppState;
use axum::routing::{delete, get, patch, post};
use axum::Router;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/setup", get(auth::setup_status).post(auth::setup))
        .route("/auth/login", post(auth::login))
        .route("/auth/logout", post(auth::logout))
        .route("/auth/me", get(auth::me))
        .route("/auth/providers", get(auth::providers))
        // password reset (local accounts, needs SMTP)
        .route("/auth/password/forgot", post(auth::password_forgot))
        .route("/auth/password/reset", post(auth::password_reset))
        // second factor
        .route("/auth/2fa/verify", post(auth::two_factor_verify))
        .route("/auth/2fa/email/start", post(auth::two_factor_email_start))
        .route(
            "/auth/2fa/email/enable",
            post(auth::two_factor_email_enable),
        )
        .route(
            "/auth/2fa/email/disable",
            post(auth::two_factor_email_disable),
        )
        .route("/auth/2fa/email/send", post(auth::two_factor_email_send))
        .route("/auth/2fa/setup", post(auth::two_factor_setup))
        .route("/auth/2fa/enable", post(auth::two_factor_enable))
        .route(
            "/auth/2fa/recovery-codes",
            post(auth::two_factor_recovery_codes),
        )
        .route("/auth/2fa/disable", post(auth::two_factor_disable))
        .route(
            "/auth/2fa/passkey/start",
            post(auth::two_factor_passkey_start),
        )
        .route(
            "/auth/2fa/passkey/finish",
            post(auth::two_factor_passkey_finish),
        )
        // passkeys
        .route(
            "/auth/passkeys/register/start",
            post(auth::passkey_register_start),
        )
        .route(
            "/auth/passkeys/register/finish",
            post(auth::passkey_register_finish),
        )
        .route(
            "/auth/passkeys/login/start",
            post(auth::passkey_login_start),
        )
        .route(
            "/auth/passkeys/login/finish",
            post(auth::passkey_login_finish),
        )
        .route("/auth/passkeys", get(auth::passkeys_list))
        .route(
            "/auth/passkeys/{id}",
            patch(auth::passkey_rename).delete(auth::passkey_delete),
        )
        // OIDC
        .route("/auth/oidc/start", get(sso::oidc_start))
        .route("/auth/oidc/callback", get(sso::oidc_callback))
        .route(
            "/auth/oidc/config",
            get(sso::oidc_config_get).put(sso::oidc_config_put),
        )
        .route("/auth/oidc/test", post(sso::oidc_test))
        .route("/auth/oidc/test-mapping", post(sso::oidc_test_mapping))
        // SAML
        .route("/auth/saml/metadata", get(sso::saml_metadata))
        .route("/auth/saml/start", get(sso::saml_start))
        .route("/auth/saml/acs", post(sso::saml_acs))
        .route(
            "/auth/saml/config",
            get(sso::saml_config_get).put(sso::saml_config_put),
        )
        .route("/auth/saml/test", post(sso::saml_test))
        .route("/auth/saml/test-mapping", post(sso::saml_test_mapping))
        // LDAP
        .route("/auth/ldap/login", post(sso::ldap_login))
        .route(
            "/auth/ldap/config",
            get(sso::ldap_config_get).put(sso::ldap_config_put),
        )
        .route("/auth/ldap/test", post(sso::ldap_test))
        .route("/auth/ldap/test-mapping", post(sso::ldap_test_mapping))
        // outgoing email (admin)
        .route(
            "/email/config",
            get(email::config_get).put(email::config_put),
        )
        .route("/email/test", post(email::test))
        // user security admin
        .route("/users/{id}/2fa/reset", post(users::reset_two_factor))
        .route("/users/{id}/passkeys", get(users::passkeys))
        .route(
            "/users/{id}/passkeys/{pid}",
            patch(users::rename_passkey).delete(users::delete_passkey),
        )
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
        .route("/enroll-tokens/{id}", delete(tokens::revoke))
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
