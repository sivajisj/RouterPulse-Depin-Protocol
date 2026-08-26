//! Pure economic math — no Solana types, no account access, fully
//! unit-testable without a validator. Every function here is a total
//! function of its inputs, which is what makes the tier boundaries and
//! rounding behaviour cheap to test exhaustively.

use crate::constants::BASIS_POINTS_DIVISOR;

/// What an epoch's measured uptime earns and costs.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub struct PerformanceTier {
    /// Multiplier applied to the base reward, in basis points.
    pub reward_multiplier_bps: u16,
    /// Fraction of staked collateral slashed, in basis points.
    pub slash_bps: u16,
}

/// Maps epoch uptime to reward multiplier and slash penalty.
///
/// The curve is deliberately convex: the drop from 99% to 90% costs
/// a quarter of the reward, but falling under 70% earns nothing at all
/// *and* slashes 10% of stake. Marginal downtime should be survivable;
/// sustained downtime should be expensive, otherwise an operator with
/// cheap hardware is better off running it badly than not at all.
pub fn performance_tier(uptime_bps: u16) -> PerformanceTier {
    match uptime_bps {
        9_900..=u16::MAX => PerformanceTier { reward_multiplier_bps: 10_000, slash_bps: 0 },
        9_500..=9_899    => PerformanceTier { reward_multiplier_bps: 9_000,  slash_bps: 0 },
        9_000..=9_499    => PerformanceTier { reward_multiplier_bps: 7_500,  slash_bps: 100 },
        8_000..=8_999    => PerformanceTier { reward_multiplier_bps: 5_000,  slash_bps: 500 },
        7_000..=7_999    => PerformanceTier { reward_multiplier_bps: 2_500,  slash_bps: 800 },
        _                => PerformanceTier { reward_multiplier_bps: 0,      slash_bps: 1_000 },
    }
}

/// Applies a basis-point rate to an amount, multiplying before dividing
/// so precision isn't lost to integer truncation.
///
/// The intermediate product is computed in `u128`: `amount * bps` can
/// exceed `u64::MAX` long before the *result* would, so doing this in
/// `u64` would spuriously fail for large amounts even at a 100%
/// multiplier. Only the final quotient is narrowed back, and that
/// narrowing is checked — a rate above 10_000 (>100%) can still
/// legitimately overflow, and returns `None` rather than wrapping.
pub fn apply_bps(amount: u64, bps: u16) -> Option<u64> {
    let product = (amount as u128).checked_mul(bps as u128)?;
    let scaled = product / (BASIS_POINTS_DIVISOR as u128);
    u64::try_from(scaled).ok()
}

/// Emission budget for an epoch, decaying geometrically per "year" of
/// epochs: each year issues `decay_bps` (e.g. 8000 = 80%) of the
/// previous year's per-epoch rate.
///
/// Iterative rather than using `pow`, because the intermediate values
/// must stay checked — and the loop is bounded by `year`, which is
/// itself bounded by how long the protocol has been alive.
pub fn epoch_emission(
    initial_emission_per_epoch: u64,
    epoch_number: u64,
    epochs_per_year: u64,
    decay_bps: u16,
) -> Option<u64> {
    if epochs_per_year == 0 {
        return Some(initial_emission_per_epoch);
    }
    let year = epoch_number / epochs_per_year;

    let mut emission = initial_emission_per_epoch;
    for _ in 0..year {
        emission = apply_bps(emission, decay_bps)?;
        if emission == 0 {
            break;
        }
    }
    Some(emission)
}

/// Amount vested by `now` under a cliff + linear schedule.
///
/// Nothing before the cliff; everything at/after `start + duration`;
/// linear in between. Note the cliff is a *step* — at the cliff instant
/// the schedule jumps to whatever linear vesting has accrued since
/// `start`, it does not restart from zero.
pub fn vested_amount(
    total_amount: u64,
    start_time: i64,
    cliff_duration: i64,
    vesting_duration: i64,
    now: i64,
) -> u64 {
    if now < start_time.saturating_add(cliff_duration) {
        return 0;
    }
    if vesting_duration <= 0 || now >= start_time.saturating_add(vesting_duration) {
        return total_amount;
    }

    let elapsed = (now - start_time).max(0) as u128;
    let duration = vesting_duration as u128;

    // Multiply before divide; u128 keeps the product from overflowing
    // even at u64::MAX totals.
    (((total_amount as u128) * elapsed) / duration) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tier_boundaries_are_inclusive_at_the_bottom_of_each_band() {
        assert_eq!(performance_tier(10_000).reward_multiplier_bps, 10_000);
        assert_eq!(performance_tier(9_900).reward_multiplier_bps, 10_000);
        assert_eq!(performance_tier(9_899).reward_multiplier_bps, 9_000);
        assert_eq!(performance_tier(9_500).reward_multiplier_bps, 9_000);
        assert_eq!(performance_tier(9_499).reward_multiplier_bps, 7_500);
        assert_eq!(performance_tier(9_000).reward_multiplier_bps, 7_500);
        assert_eq!(performance_tier(8_999).reward_multiplier_bps, 5_000);
        assert_eq!(performance_tier(8_000).reward_multiplier_bps, 5_000);
        assert_eq!(performance_tier(7_999).reward_multiplier_bps, 2_500);
        assert_eq!(performance_tier(7_000).reward_multiplier_bps, 2_500);
        assert_eq!(performance_tier(6_999).reward_multiplier_bps, 0);
        assert_eq!(performance_tier(0).reward_multiplier_bps, 0);
    }

    #[test]
    fn good_uptime_is_never_slashed_and_bad_uptime_always_is() {
        assert_eq!(performance_tier(10_000).slash_bps, 0);
        assert_eq!(performance_tier(9_500).slash_bps, 0);
        assert!(performance_tier(9_000).slash_bps > 0);
        assert!(performance_tier(5_000).slash_bps > performance_tier(9_000).slash_bps);
        assert_eq!(performance_tier(0).slash_bps, 1_000);
    }

    #[test]
    fn apply_bps_computes_percentages() {
        assert_eq!(apply_bps(1_000, 10_000), Some(1_000));
        assert_eq!(apply_bps(1_000, 5_000), Some(500));
        assert_eq!(apply_bps(1_000, 100), Some(10));
        assert_eq!(apply_bps(1_000, 0), Some(0));
    }

    #[test]
    fn apply_bps_truncates_rather_than_rounding_up() {
        // 999 * 1 / 10000 = 0.0999 -> 0. Rewards must never round in
        // the claimer's favour.
        assert_eq!(apply_bps(999, 1), Some(0));
    }

    #[test]
    fn apply_bps_does_not_spuriously_overflow_at_max_amount() {
        // A 100% multiplier must be an identity even at u64::MAX — this
        // is exactly the case a u64 intermediate product gets wrong.
        assert_eq!(apply_bps(u64::MAX, 10_000), Some(u64::MAX));
        assert_eq!(apply_bps(u64::MAX, 5_000), Some(u64::MAX / 2));
        // Above 100% at max amount genuinely cannot fit — must be None,
        // never a wrapped value.
        assert_eq!(apply_bps(u64::MAX, 10_001), None);
    }

    #[test]
    fn emission_decays_once_per_year_of_epochs() {
        let initial = 1_000_000u64;
        let per_year = 100u64;
        let decay = 8_000u16; // 80% of previous year

        assert_eq!(epoch_emission(initial, 0, per_year, decay), Some(1_000_000));
        assert_eq!(epoch_emission(initial, 99, per_year, decay), Some(1_000_000));
        assert_eq!(epoch_emission(initial, 100, per_year, decay), Some(800_000));
        assert_eq!(epoch_emission(initial, 250, per_year, decay), Some(640_000));
        assert_eq!(epoch_emission(initial, 300, per_year, decay), Some(512_000));
    }

    #[test]
    fn emission_is_flat_when_epochs_per_year_is_zero() {
        assert_eq!(epoch_emission(500, 9_999, 0, 8_000), Some(500));
    }

    #[test]
    fn nothing_vests_before_the_cliff() {
        // start=1000, cliff=100, duration=1000
        assert_eq!(vested_amount(10_000, 1_000, 100, 1_000, 1_000), 0);
        assert_eq!(vested_amount(10_000, 1_000, 100, 1_000, 1_099), 0);
    }

    #[test]
    fn cliff_releases_linear_accrual_since_start_as_a_step() {
        // At the cliff (t=1100, 100s into a 1000s schedule) 10% has accrued.
        assert_eq!(vested_amount(10_000, 1_000, 100, 1_000, 1_100), 1_000);
    }

    #[test]
    fn vesting_is_linear_between_cliff_and_end() {
        assert_eq!(vested_amount(10_000, 1_000, 100, 1_000, 1_500), 5_000);
        assert_eq!(vested_amount(10_000, 1_000, 100, 1_000, 1_750), 7_500);
    }

    #[test]
    fn everything_vests_at_and_after_the_end() {
        assert_eq!(vested_amount(10_000, 1_000, 100, 1_000, 2_000), 10_000);
        assert_eq!(vested_amount(10_000, 1_000, 100, 1_000, 99_999), 10_000);
    }

    #[test]
    fn zero_duration_vests_immediately_once_past_the_cliff() {
        assert_eq!(vested_amount(10_000, 1_000, 0, 0, 1_000), 10_000);
    }

    #[test]
    fn vesting_never_exceeds_total_even_at_max_amount() {
        assert_eq!(vested_amount(u64::MAX, 0, 0, 1_000, 500), u64::MAX / 2);
        assert_eq!(vested_amount(u64::MAX, 0, 0, 1_000, 1_000), u64::MAX);
    }
}
