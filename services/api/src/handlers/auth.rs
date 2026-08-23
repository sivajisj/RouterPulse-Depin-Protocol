use axum::{extract::State, Json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::auth as auth_service;
use crate::error::AppError;

#[derive(Deserialize)]
pub struct ChallengeRequest {
    pub wallet_address: String,
}

#[derive(Serialize)]
pub struct ChallengeResponse {
    pub nonce: String,
    pub message: String,
}

#[derive(Deserialize)]
pub struct VerifyRequest {
    pub wallet_address: String,
    pub nonce: String,
    pub signature: String,
}

pub async fn challenge(
    State(state): State<crate::AppState>,
    Json(body): Json<ChallengeRequest>,
) -> Result<Json<ChallengeResponse>, AppError> {
    if body.wallet_address.len() < 32 || body.wallet_address.len() > 44 {
        return Err(AppError::BadRequest("invalid wallet address".to_string()));
    }

    let nonce = auth_service::generate_nonce();
    let message = auth_service::build_challenge_message(&body.wallet_address, &nonce);

    let redis_key = format!("challenge:{}", body.wallet_address);
    let mut conn = state.redis.get_multiplexed_async_connection().await
        .map_err(|e| AppError::Internal(format!("redis: {}", e)))?;

    redis::cmd("SETEX")
        .arg(&redis_key)
        .arg(120)
        .arg(&nonce)
        .query_async::<()>(&mut conn)
        .await
        .map_err(|e| AppError::Internal(format!("redis: {}", e)))?;

    Ok(Json(ChallengeResponse { nonce, message }))
}

pub async fn verify(
    State(state): State<crate::AppState>,
    Json(body): Json<VerifyRequest>,
) -> Result<Json<Value>, AppError> {
    let redis_key = format!("challenge:{}", body.wallet_address);
    let mut conn = state.redis.get_multiplexed_async_connection().await
        .map_err(|e| AppError::Internal(format!("redis: {}", e)))?;

    let stored_nonce: Option<String> = redis::cmd("GETDEL")
        .arg(&redis_key)
        .query_async(&mut conn)
        .await
        .map_err(|e| AppError::Internal(format!("redis: {}", e)))?;

    let stored_nonce = stored_nonce
        .ok_or_else(|| AppError::Unauthorized("challenge expired or already used".to_string()))?;

    if stored_nonce != body.nonce {
        return Err(AppError::Unauthorized("nonce mismatch".to_string()));
    }

    let expected_message = auth_service::build_challenge_message(&body.wallet_address, &body.nonce);

    if !auth_service::verify_signature(&expected_message, &body.signature, &body.wallet_address) {
        return Err(AppError::Unauthorized("signature verification failed".to_string()));
    }

    let user = sqlx::query_as::<_, crate::models::User>(
        "INSERT INTO users (wallet) VALUES ($1)
         ON CONFLICT (wallet) DO UPDATE SET updated_at = now()
         RETURNING *"
    )
    .bind(&body.wallet_address)
    .fetch_one(&state.db)
    .await?;

    let token = auth_service::issue_token(
        &user.wallet,
        user.id,
        &user.role,
        &state.config.session_secret,
    )
    .map_err(|e| AppError::Internal(format!("jwt: {}", e)))?;

    Ok(Json(json!({
        "ok": true,
        "token": token,
        "wallet_address": user.wallet,
        "role": user.role,
    })))
}

pub async fn logout() -> Json<Value> {
    Json(json!({ "ok": true }))
}
