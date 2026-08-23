use axum::{
    extract::Request,
    http::header,
    middleware::Next,
    response::Response,
};
use crate::auth;
use crate::error::AppError;

/// Axum middleware that extracts and validates the JWT.
/// Protected routes get Claims injected via request extensions.
pub async fn require_auth(mut req: Request, next: Next) -> Result<Response, AppError> {
    let secret = req
        .extensions()
        .get::<String>()
        .cloned()
        .ok_or_else(|| AppError::Internal("missing session secret".to_string()))?;

    let token = extract_token(&req);
    let token = token.ok_or_else(|| AppError::Unauthorized("missing token".to_string()))?;

    let claims = auth::verify_token(&token, &secret)
        .map_err(|_| AppError::Unauthorized("invalid or expired token".to_string()))?;

    // Inject claims so handlers can access the authenticated user
    req.extensions_mut().insert(claims);

    Ok(next.run(req).await)
}

/// Try cookie first (browser), then Authorization header (API clients).
fn extract_token(req: &Request) -> Option<String> {
    // 1. Check cookie
    if let Some(cookie_header) = req.headers().get(header::COOKIE) {
        if let Ok(cookies) = cookie_header.to_str() {
            for cookie in cookies.split(';') {
                let cookie = cookie.trim();
                if let Some(token) = cookie.strip_prefix("routerpulse_session=") {
                    if !token.is_empty() {
                        return Some(token.to_string());
                    }
                }
            }
        }
    }

    // 2. Check Authorization: Bearer <token>
    if let Some(auth_header) = req.headers().get(header::AUTHORIZATION) {
        if let Ok(value) = auth_header.to_str() {
            if let Some(token) = value.strip_prefix("Bearer ") {
                return Some(token.to_string());
            }
        }
    }

    None
}
