use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use chrono::{Duration, Utc};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use rand::Rng;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::AppError;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Claims {
    pub sub: String,
    pub user_id: String,
    pub role: String,
    pub exp: i64,
    pub iat: i64,
}

/// This tells Axum: "when a handler asks for Claims, pull it from
/// request extensions (where the auth middleware inserted it)."
impl<S: Send + Sync> FromRequestParts<S> for Claims {
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        parts
            .extensions
            .get::<Claims>()
            .cloned()
            .ok_or_else(|| AppError::Unauthorized("missing auth".to_string()))
    }
}

const SESSION_TTL_HOURS: i64 = 12;

pub fn issue_token(
    wallet: &str,
    user_id: Uuid,
    role: &str,
    secret: &str,
) -> Result<String, jsonwebtoken::errors::Error> {
    let now = Utc::now();
    let claims = Claims {
        sub: wallet.to_string(),
        user_id: user_id.to_string(),
        role: role.to_string(),
        iat: now.timestamp(),
        exp: (now + Duration::hours(SESSION_TTL_HOURS)).timestamp(),
    };
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
}

pub fn verify_token(token: &str, secret: &str) -> Result<Claims, jsonwebtoken::errors::Error> {
    let token_data = decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &Validation::default(),
    )?;
    Ok(token_data.claims)
}

pub fn generate_nonce() -> String {
    let bytes: [u8; 32] = rand::thread_rng().gen();
    hex::encode(bytes)
}

pub fn build_challenge_message(wallet: &str, nonce: &str) -> String {
    format!(
        "RouterPulse wants you to sign in.\n\
         Wallet: {}\n\
         Nonce: {}\n\
         This request will not trigger a blockchain transaction or cost any fees.",
        wallet, nonce
    )
}

pub fn verify_signature(message: &str, signature_b58: &str, pubkey_b58: &str) -> bool {
    use ed25519_dalek::{Signature, VerifyingKey, Verifier};

    let Ok(sig_bytes) = bs58::decode(signature_b58).into_vec() else {
        return false;
    };
    let Ok(key_bytes) = bs58::decode(pubkey_b58).into_vec() else {
        return false;
    };
    let Ok(sig) = Signature::from_slice(&sig_bytes) else {
        return false;
    };
    let Ok(key_arr): Result<[u8; 32], _> = key_bytes.try_into() else {
        return false;
    };
    let Ok(verifying_key) = VerifyingKey::from_bytes(&key_arr) else {
        return false;
    };

    verifying_key.verify(message.as_bytes(), &sig).is_ok()
}
