use axum::{extract::State, Json};
use serde_json::{json, Value};

use crate::auth::Claims;
use crate::error::AppError;
use crate::models::{Device, SubmitTelemetryRequest};

/// Build the canonical string that gets signed. Field order matters —
/// changing it here without changing the agent breaks every signature.
fn canonical_message(body: &SubmitTelemetryRequest) -> String {
    format!(
        "{}:{}:{}:{}:{}:{}:{}:{}",
        body.device_id,
        body.sequence_num,
        body.latency_ms.unwrap_or(0.0),
        body.packet_loss_pct.unwrap_or(0.0),
        body.download_mbps.unwrap_or(0.0),
        body.upload_mbps.unwrap_or(0.0),
        body.availability,
        body.nonce,
    )
}

pub async fn submit_heartbeat(
    State(state): State<crate::AppState>,
    claims: Claims,
    Json(body): Json<SubmitTelemetryRequest>,
) -> Result<Json<Value>, AppError> {
    let user_id: uuid::Uuid = claims.user_id.parse()
        .map_err(|_| AppError::Internal("bad user_id in token".to_string()))?;

    // Fetch the full device row — we need device_pubkey to verify signatures
    let device = sqlx::query_as::<_, Device>(
        "SELECT * FROM devices WHERE id = $1 AND owner_id = $2 AND status = 'active'"
    )
    .bind(body.device_id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::BadRequest("device not found or not active".to_string()))?;

    // If the device completed enrollment, telemetry MUST be signed.
    // Unenrolled devices (Step 3's simulator, pre-Step-4) are still allowed
    // through unsigned — this is what lets the simulator keep working
    // while real enrolled devices get the stronger guarantee.
    if let Some(ref pubkey) = device.device_pubkey {
        let signature = body.signature.as_deref()
            .ok_or_else(|| AppError::Unauthorized("device is enrolled, signature required".to_string()))?;

        let message = canonical_message(&body);

        if !crate::auth::verify_signature(&message, signature, pubkey) {
            return Err(AppError::Unauthorized("telemetry signature invalid".to_string()));
        }
    }

    sqlx::query(
        "INSERT INTO telemetry
            (device_id, sequence_num, latency_ms, packet_loss_pct,
             download_mbps, upload_mbps, availability, nonce, signature)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)"
    )
    .bind(device.id)
    .bind(body.sequence_num)
    .bind(body.latency_ms)
    .bind(body.packet_loss_pct)
    .bind(body.download_mbps)
    .bind(body.upload_mbps)
    .bind(body.availability)
    .bind(&body.nonce)
    .bind(&body.signature)
    .execute(&state.db)
    .await
    .map_err(|e| match e {
        sqlx::Error::Database(ref db_err) if db_err.is_unique_violation() => {
            AppError::Conflict("duplicate nonce, possible replay".to_string())
        }
        other => AppError::Database(other),
    })?;

    Ok(Json(json!({ "ok": true, "device_id": device.id.to_string() })))
}
