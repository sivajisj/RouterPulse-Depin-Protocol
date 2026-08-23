use axum::{
    middleware as axum_mw,
    routing::{get, post},
    Router,
};
use crate::handlers;
use crate::middleware::require_auth;
use crate::AppState;

pub fn build_router(state: AppState) -> Router {
    let public = Router::new()
        .route("/v1/auth/challenge", post(handlers::auth::challenge))
        .route("/v1/auth/verify", post(handlers::auth::verify))
        .route("/v1/auth/logout", post(handlers::auth::logout))
        .route("/health", get(|| async { "ok" }));

    let protected = Router::new()
        .route("/v1/devices", get(handlers::devices::list_devices))
        .route("/v1/devices", post(handlers::devices::create_device))
        .route("/v1/devices/{id}", get(handlers::devices::get_device))
        .route("/v1/devices/{id}/enrollment", post(handlers::devices::start_enrollment))
        .route("/v1/devices/{id}/enrollment/complete", post(handlers::devices::complete_enrollment))
        .route("/v1/telemetry/heartbeat", post(handlers::telemetry::submit_heartbeat))
        .layer(axum_mw::from_fn(require_auth));

    Router::new()
        .merge(public)
        .merge(protected)
        .with_state(state)
}
