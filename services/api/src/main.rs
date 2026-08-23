use routerpulse_api::{config, routes, AppState};
use sqlx::postgres::PgPoolOptions;
use tokio::net::TcpListener;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();

    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .init();

    let config = config::Config::from_env();

    let db = PgPoolOptions::new()
        .max_connections(10)
        .connect(&config.database_url)
        .await
        .expect("failed to connect to postgres");

    tracing::info!("connected to postgres");

    let redis = redis::Client::open(config.redis_url.clone())
        .expect("invalid redis url");

    tracing::info!("connected to redis");

    let state = AppState {
        db,
        redis,
        config: config.clone(),
    };

    let app = routes::build_router(state.clone())
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        )
        .layer(TraceLayer::new_for_http())
        .layer(axum::Extension(state.config.session_secret.clone()));

    let addr = format!("{}:{}", config.host, config.port);
    tracing::info!("listening on {}", addr);

    let listener = TcpListener::bind(&addr).await.expect("failed to bind");
    axum::serve(listener, app).await.expect("server error");
}
