//! One-line installer scripts with the enrollment token baked in.

use crate::app::AppState;
use crate::db;
use axum::extract::{Query, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;

const SH_TEMPLATE: &str = include_str!("install.sh.tmpl");
const PS1_TEMPLATE: &str = include_str!("install.ps1.tmpl");

#[derive(Deserialize)]
pub struct InstallQuery {
    #[serde(default)]
    pub token: Option<String>,
}

/// Why a token cannot be used for enrollment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenProblem {
    Missing,
    Unknown,
    Revoked,
    Expired,
    Exhausted,
}

impl TokenProblem {
    pub fn message(self) -> &'static str {
        match self {
            TokenProblem::Missing => "no enrollment token given (append ?token=… to the URL)",
            TokenProblem::Unknown => "unknown enrollment token",
            TokenProblem::Revoked => "this enrollment token has been revoked",
            TokenProblem::Expired => "this enrollment token has expired",
            TokenProblem::Exhausted => "this enrollment token has no uses left",
        }
    }
}

/// Validate an enrollment token against the database.
pub async fn validate_token(
    dbp: &db::Db,
    token: Option<&str>,
) -> Result<db::models::EnrollTokenRow, TokenProblem> {
    let token = token
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .ok_or(TokenProblem::Missing)?;
    let row = db::tokens::by_hash(dbp, &crate::ids::sha256_hex(token))
        .await
        .map_err(|e| {
            tracing::error!("token lookup failed: {e}");
            TokenProblem::Unknown
        })?
        .ok_or(TokenProblem::Unknown)?;
    if row.revoked {
        return Err(TokenProblem::Revoked);
    }
    if let Some(exp) = row.expires_at.as_deref().and_then(db::parse_ts) {
        if exp < chrono::Utc::now() {
            return Err(TokenProblem::Expired);
        }
    }
    if let Some(max) = row.max_uses {
        if row.uses >= max {
            return Err(TokenProblem::Exhausted);
        }
    }
    Ok(row)
}

fn render(template: &str, server_url: &str, token: &str, download_base: &str) -> String {
    template
        .replace("{{SERVER_URL}}", server_url)
        .replace("{{TOKEN}}", token)
        .replace("{{DOWNLOAD_BASE}}", download_base)
}

/// Tokens are base62 by construction; refuse anything else so they cannot break out
/// of the quoted shell / PowerShell strings.
fn is_safe_token(token: &str) -> bool {
    !token.is_empty() && token.bytes().all(|b| b.is_ascii_alphanumeric())
}

fn script_response(body: String, content_type: &'static str) -> Response {
    let mut resp = (StatusCode::OK, body).into_response();
    resp.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    resp.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    resp
}

pub async fn install_sh(State(state): State<AppState>, Query(q): Query<InstallQuery>) -> Response {
    let token = q.token.as_deref().map(str::trim).unwrap_or("");
    let body = match validate_token(&state.db, Some(token)).await {
        Ok(_) if is_safe_token(token) => render(
            SH_TEMPLATE,
            &state.config.public_url,
            token,
            &state.config.agent_download_base,
        ),
        Ok(_) => error_sh(TokenProblem::Unknown.message()),
        Err(problem) => error_sh(problem.message()),
    };
    script_response(body, "text/x-shellscript; charset=utf-8")
}

pub async fn install_ps1(State(state): State<AppState>, Query(q): Query<InstallQuery>) -> Response {
    let token = q.token.as_deref().map(str::trim).unwrap_or("");
    let body = match validate_token(&state.db, Some(token)).await {
        Ok(_) if is_safe_token(token) => render(
            PS1_TEMPLATE,
            &state.config.public_url,
            token,
            &state.config.agent_download_base,
        ),
        Ok(_) => error_ps1(TokenProblem::Unknown.message()),
        Err(problem) => error_ps1(problem.message()),
    };
    script_response(body, "text/plain; charset=utf-8")
}

fn error_sh(message: &str) -> String {
    format!(
        "#!/bin/sh\nprintf '\\033[1;31merror:\\033[0m %s\\n' \"remote-agent install: {}\" >&2\nexit 1\n",
        message.replace('"', "'")
    )
}

fn error_ps1(message: &str) -> String {
    format!(
        "Write-Host 'error: remote-agent install: {}' -ForegroundColor Red\nexit 1\n",
        message.replace('\'', "''")
    )
}

/// Ready-to-paste one-liners shown in the UI after creating a token.
pub fn one_liners(public_url: &str, token: &str) -> (String, String) {
    (
        format!("curl -fsSL \"{public_url}/install.sh?token={token}\" | sudo sh"),
        format!("irm \"{public_url}/install.ps1?token={token}\" | iex"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn templates_render_all_placeholders() {
        for t in [SH_TEMPLATE, PS1_TEMPLATE] {
            let out = render(t, "https://c.example", "abc123", "https://dl.example");
            assert!(!out.contains("{{"));
            assert!(out.contains("https://c.example"));
            assert!(out.contains("abc123"));
            assert!(out.contains("https://dl.example"));
        }
    }

    #[test]
    fn token_safety() {
        assert!(is_safe_token("abcDEF123"));
        assert!(!is_safe_token("abc\"; rm -rf /"));
        assert!(!is_safe_token(""));
    }

    #[test]
    fn error_scripts_exit_nonzero() {
        assert!(error_sh("bad").contains("exit 1"));
        assert!(error_ps1("it's bad").contains("it''s bad"));
    }
}
