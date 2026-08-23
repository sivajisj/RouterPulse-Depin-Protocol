-- 'bronze' was being used as both a real (scored, deficient) tier AND the
-- column's default for devices that have never been scored at all — those
-- are not the same thing. Introduce an explicit 'unscored' sentinel as the
-- true default, distinct from the five tiers the scorer actually computes.

-- Backfill: a device is "never scored" if it's still sitting on the exact
-- default pair (service_score = 0.0, quality_tier = 'bronze') written at
-- creation time — the scorer never legitimately writes exactly 0.0 (even a
-- fully offline/violating device's weighted score lands above zero), so
-- this pair uniquely identifies untouched rows.
UPDATE devices
SET quality_tier = 'unscored'
WHERE quality_tier = 'bronze' AND service_score = 0.0;

ALTER TABLE devices ALTER COLUMN quality_tier SET DEFAULT 'unscored';

ALTER TABLE devices ADD CONSTRAINT devices_quality_tier_check
    CHECK (quality_tier IN ('platinum', 'gold', 'silver', 'bronze', 'suspended', 'unscored'));
