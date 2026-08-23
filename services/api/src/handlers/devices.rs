use axum::{extract::{Path, State}, Json};
use uuid::Uuid;

use crate::auth::Claims;
use crate::error::AppError;
use crate::models::{CreateDeviceRequest, Device};

pub async fn list_devices(
    State(state): State<crate::AppState>,
    claims: Claims,
) -> Result<Json<Vec<Device>>, AppError> {
    let user_id: Uuid = claims.user_id.parse()
        .map_err(|_| AppError::Internal("bad user_id in token".to_string()))?;

    let devices = sqlx::query_as::<_, Device>(
        "SELECT * FROM devices WHERE owner_id = $1 ORDER BY registered_at DESC"
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(devices))
}

pub async fn create_device(
    State(state): State<crate::AppState>,
    claims: Claims,
    Json(body): Json<CreateDeviceRequest>,
) -> Result<Json<Device>, AppError> {
    let user_id: Uuid = claims.user_id.parse()
        .map_err(|_| AppError::Internal("bad user_id in token".to_string()))?;

    if body.router_id.is_empty() || body.router_id.len() > 64 {
        return Err(AppError::BadRequest("router_id must be 1-64 characters".to_string()));
    }

    let device = sqlx::query_as::<_, Device>(
        "INSERT INTO devices (owner_id, router_id, name, region, status)
         VALUES ($1, $2, $3, $4, 'active')
         RETURNING *"
    )
    .bind(user_id)
    .bind(&body.router_id)
    .bind(&body.name)
    .bind(&body.region)
    .fetch_one(&state.db)
    .await
    .map_err(|e| match e {
        sqlx::Error::Database(ref db_err) if db_err.is_unique_violation() => {
            AppError::Conflict(format!("router_id '{}' already exists", body.router_id))
        }
        other => AppError::Database(other),
    })?;

    Ok(Json(device))
}

pub async fn get_device(
    State(state): State<crate::AppState>,
    claims: Claims,
    Path(device_id): Path<Uuid>,
) -> Result<Json<Device>, AppError> {
    let user_id: Uuid = claims.user_id.parse()
        .map_err(|_| AppError::Internal("bad user_id in token".to_string()))?;

    let device = sqlx::query_as::<_, Device>(
        "SELECT * FROM devices WHERE id = $1 AND owner_id = $2"
    )
    .bind(device_id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;

    Ok(Json(device))
}

/// POST /v1/devices/:id/enrollment - start enrollment, returns a challenge
/// for the device to sign with its Ed25519 private key.
pub async fn start_enrollment(
    State(state): State<crate::AppState>,
    claims: Claims,
    Path(device_id): Path<Uuid>,
) -> Result<axum::Json<crate::models::EnrollmentStartResponse>, AppError> {
    let user_id: Uuid = claims.user_id.parse()
        .map_err(|_| AppError::Internal("bad user_id in token".to_string()))?;

    // Confirm the device exists and belongs to this operator
    let device = sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM devices WHERE id = $1 AND owner_id = $2"
    )
    .bind(device_id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;

    // Random challenge — the device signs this to prove key ownership.
    // Not a JWT, not reusable, single purpose: bind a pubkey to this device.
    let challenge = crate::auth::generate_nonce();

    let enrollment_id = sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO device_enrollments (device_id, challenge, status)
         VALUES ($1, $2, 'pending')
         RETURNING id"
    )
    .bind(device)
    .bind(&challenge)
    .fetch_one(&state.db)
    .await?;

    Ok(axum::Json(crate::models::EnrollmentStartResponse {
        enrollment_id,
        challenge,
    }))
}

/// POST /v1/devices/:id/enrollment/complete - the agent sends back its
/// public key and a signature over the challenge. If the signature
/// verifies, this pubkey becomes the device's permanent identity.
pub async fn complete_enrollment(
    State(state): State<crate::AppState>,
    claims: Claims,
    Path(device_id): Path<Uuid>,
    axum::Json(body): axum::Json<crate::models::EnrollmentCompleteRequest>,
) -> Result<axum::Json<serde_json::Value>, AppError> {
    let user_id: Uuid = claims.user_id.parse()
        .map_err(|_| AppError::Internal("bad user_id in token".to_string()))?;

    // Look up the pending enrollment and confirm ownership + freshness
    let row = sqlx::query_as::<_, (Uuid, String, String)>(
        "SELECT de.id, de.challenge, de.status
         FROM device_enrollments de
         JOIN devices d ON d.id = de.device_id
         WHERE de.id = $1 AND de.device_id = $2 AND d.owner_id = $3"
    )
    .bind(body.enrollment_id)
    .bind(device_id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::NotFound)?;

    let (enrollment_id, challenge, status) = row;

    if status != "pending" {
        return Err(AppError::Conflict("enrollment already completed or expired".to_string()));
    }

    // The actual proof of key ownership: verify the signature over the
    // challenge using the device's claimed public key.
    if !crate::auth::verify_signature(&challenge, &body.signature, &body.device_pubkey) {
        return Err(AppError::Unauthorized("challenge signature invalid".to_string()));
    }

    // Bind the verified public key to the device permanently
    sqlx::query(
        "UPDATE devices SET device_pubkey = $1, enrolled_at = now() WHERE id = $2"
    )
    .bind(&body.device_pubkey)
    .bind(device_id)
    .execute(&state.db)
    .await?;

    sqlx::query(
        "UPDATE device_enrollments SET status = 'completed', completed_at = now() WHERE id = $1"
    )
    .bind(enrollment_id)
    .execute(&state.db)
    .await?;

    Ok(axum::Json(serde_json::json!({ "ok": true, "device_id": device_id })))
}
