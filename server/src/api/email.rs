//! Outgoing email configuration (admin): SMTP settings with a sealed password and a
//! "send test message" endpoint that works with unsaved values.

use crate::app::AppState;
use crate::auth::AdminUser;
use crate::db::{self, settings};
use crate::error::{ApiError, ApiResult};
use crate::mail::{self, templates, Recipient, SmtpConfigInput, SmtpConfigPublic};
use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::json;

/// Audit payload: the public view plus a belt-and-braces strip of any password key.
fn audit_config(cfg: &SmtpConfigPublic) -> serde_json::Value {
    let mut v = serde_json::to_value(cfg).unwrap_or_default();
    if let Some(obj) = v.as_object_mut() {
        obj.remove("password");
        obj.remove("password_enc");
    }
    v
}

pub async fn config_get(
    State(state): State<AppState>,
    _admin: AdminUser,
) -> ApiResult<Json<SmtpConfigPublic>> {
    let cfg = mail::load(&state.db).await?;
    Ok(Json(cfg.public()))
}

pub async fn config_put(
    State(state): State<AppState>,
    admin: AdminUser,
    Json(input): Json<SmtpConfigInput>,
) -> ApiResult<Json<SmtpConfigPublic>> {
    let existing = mail::load(&state.db).await?;
    let cfg = mail::merge_input(&state.config, &existing, input)?;
    mail::store(&state.db, &cfg).await?;
    let public = cfg.public();
    db::audit::record(
        &state.db,
        Some(admin.actor()),
        "email.config",
        None,
        audit_config(&public),
    )
    .await?;
    Ok(Json(public))
}

#[derive(Deserialize, Default)]
pub struct TestBody {
    /// Unsaved values merged over the stored configuration.
    #[serde(default)]
    pub config: Option<SmtpConfigInput>,
    /// Recipient; defaults to the calling admin's address.
    #[serde(default)]
    pub to: Option<String>,
}

/// Send a branded test message; `400 smtp_failed` with the relay's error when it fails.
pub async fn test(
    State(state): State<AppState>,
    admin: AdminUser,
    body: Option<Json<TestBody>>,
) -> ApiResult<Json<serde_json::Value>> {
    let body = body.map(|Json(b)| b).unwrap_or_default();
    let existing = mail::load(&state.db).await?;
    let cfg = match body.config {
        Some(input) => mail::merge_input(&state.config, &existing, input)?,
        None => existing,
    };
    if cfg.host.is_empty() {
        return Err(ApiError::validation("host is not configured"));
    }
    if cfg.from_address.is_empty() {
        return Err(ApiError::validation("from_address is not configured"));
    }
    // The stored `enabled` flag should not stop an admin from testing before switching on.
    let cfg = mail::SmtpConfig {
        enabled: true,
        ..cfg
    };
    let to = match body.to.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        Some(t) => {
            crate::auth::validate_email(t)?;
            t.to_string()
        }
        None => admin.0.email.clone(),
    };
    let branding = settings::branding(&state.db).await?;
    let message = templates::test_message(&branding, &state.config.public_url, &admin.0.email)
        .to(Recipient::new(&to, None));
    state.mailer.send_with(&cfg, message).await.map_err(|e| {
        tracing::warn!("test email failed: {e:#}");
        ApiError::new(StatusCode::BAD_REQUEST, "smtp_failed", format!("{e:#}"))
    })?;
    db::audit::record_lossy(
        &state.db,
        Some(admin.actor()),
        "email.test",
        None,
        json!({ "to": to, "host": cfg.host, "port": cfg.port }),
    )
    .await;
    Ok(Json(
        json!({ "ok": true, "detail": format!("Sent to {to}") }),
    ))
}
