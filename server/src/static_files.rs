//! Embedded single-page application (`../web/dist`) with SPA fallback.

use axum::body::Body;
use axum::extract::Request;
use axum::http::{header, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use rust_embed::Embed;

#[derive(Embed)]
#[folder = "../web/dist"]
struct Assets;

/// Serve a file from the embedded bundle; unknown paths fall back to `index.html`
/// so client-side routing works on refresh.
pub async fn serve(uri: Uri, req: Request) -> Response {
    if req.method() != axum::http::Method::GET && req.method() != axum::http::Method::HEAD {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    let path = uri.path().trim_start_matches('/');
    if path.starts_with("api/") || path.starts_with("ws/") {
        return StatusCode::NOT_FOUND.into_response();
    }
    let candidate = if path.is_empty() { "index.html" } else { path };
    match Assets::get(candidate) {
        Some(file) => file_response(candidate, file, is_hashed_asset(candidate)),
        None => match Assets::get("index.html") {
            Some(index) => file_response("index.html", index, false),
            None => (StatusCode::NOT_FOUND, "web UI not built").into_response(),
        },
    }
}

fn file_response(path: &str, file: rust_embed::EmbeddedFile, immutable: bool) -> Response {
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    let cache = if immutable {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    let mut resp = Response::new(Body::from(file.data.into_owned()));
    let headers = resp.headers_mut();
    if let Ok(v) = HeaderValue::from_str(mime.as_ref()) {
        headers.insert(header::CONTENT_TYPE, v);
    }
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    resp
}

/// Vite emits `assets/<name>-<hash>.<ext>`; those may be cached forever.
fn is_hashed_asset(path: &str) -> bool {
    path.starts_with("assets/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashed_assets_detection() {
        assert!(is_hashed_asset("assets/index-abc123.js"));
        assert!(!is_hashed_asset("index.html"));
    }
}
