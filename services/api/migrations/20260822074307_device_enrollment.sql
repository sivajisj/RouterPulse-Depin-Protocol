-- Add migration script here
-- Track device enrollment challenges and completions
CREATE TABLE device_enrollments (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id   UUID NOT NULL REFERENCES devices(id),
    challenge   VARCHAR(128) NOT NULL,
    device_pubkey VARCHAR(64),
    status      VARCHAR(20) NOT NULL DEFAULT 'pending',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX idx_enrollments_device ON device_enrollments(device_id);

-- Allow devices table to track enrollment status
ALTER TABLE devices ADD COLUMN enrolled_at TIMESTAMPTZ;