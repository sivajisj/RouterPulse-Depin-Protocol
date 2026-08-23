use axum::{extract::State, Json};
use serde::Serialize;

use crate::auth::Claims;
use crate::error::AppError;

#[derive(Debug, Serialize)]
pub struct TierDistribution {
    pub platinum: i64,
    pub gold: i64,
    pub silver: i64,
    pub bronze: i64,
    pub suspended: i64,
    /// Devices with no computed score yet (no telemetry, or telemetry too
    /// sparse/recent to score) — distinct from 'bronze', which means
    /// "scored and found deficient."
    pub unscored: i64,
}

#[derive(Debug, Serialize)]
pub struct NetworkOverview {
    pub total_devices: i64,
    /// A device counts as "online" if it has submitted telemetry in the
    /// last 5 minutes — the same freshness window the scorer uses.
    pub online_devices: i64,
    pub avg_service_score: f64,
    pub tier_distribution: TierDistribution,
}

pub async fn overview(
    State(state): State<crate::AppState>,
    _claims: Claims,
) -> Result<Json<NetworkOverview>, AppError> {
    let row = sqlx::query_as::<_, (i64, i64, Option<f64>, i64, i64, i64, i64, i64, i64)>(
        "SELECT
            count(*) AS total_devices,
            count(*) FILTER (
                WHERE d.id IN (
                    SELECT DISTINCT device_id FROM telemetry
                    WHERE recorded_at > now() - interval '5 minutes'
                )
            ) AS online_devices,
            -- Unscored devices sit at service_score = 0.0 by default, which
            -- would otherwise drag this average down for a network that's
            -- mostly healthy but partly unevaluated — exclude them.
            avg(d.service_score) FILTER (WHERE d.quality_tier != 'unscored')::float8 AS avg_service_score,
            count(*) FILTER (WHERE d.quality_tier = 'platinum') AS platinum,
            count(*) FILTER (WHERE d.quality_tier = 'gold') AS gold,
            count(*) FILTER (WHERE d.quality_tier = 'silver') AS silver,
            count(*) FILTER (WHERE d.quality_tier = 'bronze') AS bronze,
            count(*) FILTER (WHERE d.quality_tier = 'suspended') AS suspended,
            count(*) FILTER (WHERE d.quality_tier = 'unscored') AS unscored
         FROM devices d",
    )
    .fetch_one(&state.db)
    .await?;

    let (total_devices, online_devices, avg_service_score, platinum, gold, silver, bronze, suspended, unscored) = row;

    Ok(Json(NetworkOverview {
        total_devices,
        online_devices,
        avg_service_score: avg_service_score.unwrap_or(0.0),
        tier_distribution: TierDistribution {
            platinum,
            gold,
            silver,
            bronze,
            suspended,
            unscored,
        },
    }))
}
