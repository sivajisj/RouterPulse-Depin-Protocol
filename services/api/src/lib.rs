pub mod auth;
pub mod config;
pub mod error;
pub mod handlers;
pub mod middleware;
pub mod models;
pub mod routes;

#[derive(Clone)]
pub struct AppState {
    pub db: sqlx::PgPool,
    pub redis: redis::Client,
    pub config: config::Config,
}
