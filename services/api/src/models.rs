use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

// === Database row types (what SQLx returns) ===

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct User {
    pub id: Uuid,
    pub wallet: String,
    pub role: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Device {
    pub id: Uuid,
    pub owner_id: Uuid,
    pub router_id: String,
    pub device_pubkey: Option<String>,
    pub name: Option<String>,
    pub region: Option<String>,
    pub status: String,
    pub service_score: f32,
    pub quality_tier: String,
    pub registered_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Telemetry {
    pub id: Uuid,
    pub device_id: Uuid,
    pub sequence_num: i64,
    pub latency_ms: Option<f32>,
    pub packet_loss_pct: Option<f32>,
    pub download_mbps: Option<f32>,
    pub upload_mbps: Option<f32>,
    pub availability: bool,
    pub nonce: String,
    pub signature: Option<String>,
    pub recorded_at: DateTime<Utc>,
}

// === Request/response DTOs (what the API accepts/returns) ===

#[derive(Debug, Deserialize)]
pub struct CreateDeviceRequest {
    pub router_id: String,
    pub name: Option<String>,
    pub region: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SubmitTelemetryRequest {
    pub device_id: Uuid,
    pub sequence_num: i64,
    pub latency_ms: Option<f32>,
    pub packet_loss_pct: Option<f32>,
    pub download_mbps: Option<f32>,
    pub upload_mbps: Option<f32>,
    pub availability: bool,
    pub nonce: String,
    pub signature: Option<String>,
}

// === Device enrollment ===

#[derive(Debug, Serialize)]
pub struct EnrollmentStartResponse {
    pub enrollment_id: uuid::Uuid,
    pub challenge: String,
}

#[derive(Debug, Deserialize)]
pub struct EnrollmentCompleteRequest {
    pub enrollment_id: uuid::Uuid,
    pub device_pubkey: String,
    pub signature: String,
}
