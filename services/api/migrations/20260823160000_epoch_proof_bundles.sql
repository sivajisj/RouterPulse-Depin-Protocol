-- Proof-of-Service scoring runs: one row per scorer pass ("epoch"),
-- capturing the full scoring input/output as a hashed, (optionally)
-- IPFS-pinned bundle for later independent verification.
CREATE TABLE epoch_proof_bundles (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Rolling counter for now; real epoch lifecycle (fixed-duration,
    -- on-chain anchored epochs) lands in a later step.
    epoch_number    BIGSERIAL,
    bundle_json     JSONB NOT NULL,
    bundle_hash     VARCHAR(64) NOT NULL,
    ipfs_cid        TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_epoch_bundles_created ON epoch_proof_bundles(created_at DESC);
