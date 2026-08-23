use sqlx::postgres::PgPoolOptions;

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();

    let database_url = std::env::var("DATABASE_URL").expect("DATABASE_URL must be set");
    let secret = std::env::var("SESSION_SECRET").expect("SESSION_SECRET must be set");

    let db = PgPoolOptions::new()
        .max_connections(1)
        .connect(&database_url)
        .await
        .expect("failed to connect to postgres");

    let wallet = "DevTestWallet1111111111111111111111111111111";

    let row: (uuid::Uuid, String) = sqlx::query_as(
        "INSERT INTO users (wallet, role) VALUES ($1, 'operator')
         ON CONFLICT (wallet) DO UPDATE SET updated_at = now()
         RETURNING id, role"
    )
    .bind(wallet)
    .fetch_one(&db)
    .await
    .expect("failed to upsert user");

    let token = routerpulse_api::auth::issue_token(wallet, row.0, &row.1, &secret)
        .expect("failed to issue token");

    println!("\n=== Dev Token ===");
    println!("Wallet:  {}", wallet);
    println!("User ID: {}", row.0);
    println!("Role:    {}", row.1);
    println!("Token:   {}", token);
    println!("\nUsage:");
    println!("export TOKEN={}", token);
}
