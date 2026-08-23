use crate::state::Router;

// result of a single uptime calculation
pub struct UptimeResult {
    pub new_score:     u8,
    pub was_on_time:   bool,
    pub missed_count:  u64,  // 1 if late, 0 if on time
}

// core scoring logic , pure function, no Solana dependencies
// takes current score, time elapsed, and allowed interval
// returns new score and whether heartbeat was on time
pub fn calculate(
    current_score: u8,
    elapsed:       i64,
    interval:      i64,
) -> UptimeResult {

    let was_on_time = elapsed <= interval;

    let new_score = if was_on_time {
        // on time: +1 point, hard cap at 100
        current_score
            .saturating_add(1)
            .min(Router::MAX_SCORE)
    } else {
        // late: -10 points, floor at 0
        current_score
            .saturating_sub(10)
    };

    let missed_count = if was_on_time { 0 } else { 1 };

    UptimeResult {
        new_score,
        was_on_time,
        missed_count,
    }
}

// check if router should be suspended based on current score
pub fn should_suspend(score: u8) -> bool {
    score <= Router::SUSPENSION_THRESHOLD
}

// calculate uptime percentage from heartbeat history
pub fn uptime_percentage(
    heartbeat_count:  u64,
    missed_heartbeats: u64,
) -> u64 {
    if heartbeat_count == 0 {
        return 0;
    }

    let successful = heartbeat_count.saturating_sub(missed_heartbeats);

    // returns 0-100 as a percentage
    // multiply by 100 then divide to avoid float
    successful
        .saturating_mul(100)
        .checked_div(heartbeat_count)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    // on time heartbeat increases score by 1
    #[test]
    fn test_on_time_increases_score() {
        let result = calculate(80, 200, 300);
        assert!(result.was_on_time);
        assert_eq!(result.new_score, 81);
        assert_eq!(result.missed_count, 0);
    }

    // late heartbeat decreases score by 10
    #[test]
    fn test_late_decreases_score() {
        let result = calculate(80, 400, 300);
        assert!(!result.was_on_time);
        assert_eq!(result.new_score, 70);
        assert_eq!(result.missed_count, 1);
    }

    // score never exceeds 100
    #[test]
    fn test_score_caps_at_100() {
        let result = calculate(100, 100, 300);
        assert_eq!(result.new_score, 100);
    }

    // score never goes below 0
    #[test]
    fn test_score_floors_at_0() {
        let result = calculate(5, 400, 300);
        assert_eq!(result.new_score, 0);
    }

    // exactly at interval boundary = on time
    #[test]
    fn test_exactly_at_interval_is_on_time() {
        let result = calculate(90, 300, 300);
        assert!(result.was_on_time);
        assert_eq!(result.new_score, 91);
    }

    // one second over = late
    #[test]
    fn test_one_second_over_is_late() {
        let result = calculate(90, 301, 300);
        assert!(!result.was_on_time);
        assert_eq!(result.new_score, 80);
    }

    // suspension check
    #[test]
    fn test_should_suspend_at_threshold() {
        assert!(should_suspend(20));
        assert!(should_suspend(10));
        assert!(should_suspend(0));
        assert!(!should_suspend(21));
        assert!(!should_suspend(100));
    }

    // uptime percentage with no missed heartbeats
    #[test]
    fn test_uptime_percentage_perfect() {
        let pct = uptime_percentage(100, 0);
        assert_eq!(pct, 100);
    }

    // uptime percentage with some misses
    #[test]
    fn test_uptime_percentage_partial() {
        let pct = uptime_percentage(100, 25);
        assert_eq!(pct, 75);
    }

    // uptime percentage with zero heartbeats
    #[test]
    fn test_uptime_percentage_zero_count() {
        let pct = uptime_percentage(0, 0);
        assert_eq!(pct, 0);
    }

    // score recovery takes time
    #[test]
    fn test_recovery_is_slow() {
        let mut score = 50u8;

        // simulate 10 on-time heartbeats
        for _ in 0..10 {
            let result = calculate(score, 100, 300);
            score = result.new_score;
        }

        // should recover by exactly 10 points
        assert_eq!(score, 60);
    }

    // one miss wipes out 10 recoveries
    #[test]
    fn test_one_miss_wipes_ten_recoveries() {
        let mut score = 50u8;

        // 10 on-time heartbeats → score = 60
        for _ in 0..10 {
            let r = calculate(score, 100, 300);
            score = r.new_score;
        }
        assert_eq!(score, 60);

        // one miss → back to 50
        let r = calculate(score, 400, 300);
        score = r.new_score;
        assert_eq!(score, 50);
    }
}