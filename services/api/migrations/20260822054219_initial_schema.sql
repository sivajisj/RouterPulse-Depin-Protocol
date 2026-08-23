-- Users: the human operator behind a wallet
CREATE TABLE users (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet      VARCHAR(44) UNIQUE NOT NULL,
    role        VARCHAR(20) NOT NULL DEFAULT 'operator',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Devices: each physical router registered by an operator
CREATE TABLE devices (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id        UUID NOT NULL REFERENCES users(id),
    router_id       VARCHAR(64) UNIQUE NOT NULL,
    device_pubkey   VARCHAR(64),
    name            VARCHAR(128),
    region          VARCHAR(64),
    status          VARCHAR(20) NOT NULL DEFAULT 'pending',
    service_score   REAL NOT NULL DEFAULT 0.0,
    quality_tier    VARCHAR(20) NOT NULL DEFAULT 'bronze',
    registered_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_devices_owner ON devices(owner_id);
CREATE INDEX idx_devices_status ON devices(status);

-- Telemetry: raw heartbeat/metric samples from devices
CREATE TABLE telemetry (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id       UUID NOT NULL REFERENCES devices(id),
    sequence_num    BIGINT NOT NULL,
    latency_ms      REAL,
    packet_loss_pct REAL,
    download_mbps   REAL,
    upload_mbps     REAL,
    availability    BOOLEAN NOT NULL DEFAULT true,
    nonce           VARCHAR(64) NOT NULL,
    signature       VARCHAR(128),
    recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_telemetry_device ON telemetry(device_id, recorded_at DESC);

-- Anti-replay: reject duplicate nonces per device
CREATE UNIQUE INDEX idx_telemetry_nonce ON telemetry(device_id, nonce);

-- Sessions: tracks active JWT sessions for logout/revocation
CREATE TABLE sessions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id),
    token_hash  VARCHAR(64) NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
