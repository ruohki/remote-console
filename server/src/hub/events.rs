//! Per-session rate limiting of agent-reported session events.

use std::time::{Duration, Instant};

/// Fixed-window limiter: at most `per_second` events in any one-second window.
#[derive(Debug)]
pub struct EventLimiter {
    per_second: u32,
    window_start: Instant,
    count: u32,
    last_used: Instant,
}

impl EventLimiter {
    pub fn new(per_second: u32) -> Self {
        Self::new_at(per_second, Instant::now())
    }

    fn new_at(per_second: u32, now: Instant) -> Self {
        Self {
            per_second: per_second.max(1),
            window_start: now,
            count: 0,
            last_used: now,
        }
    }

    /// Record one event; `false` when it exceeds the budget of the current window.
    pub fn allow(&mut self) -> bool {
        self.allow_at(Instant::now())
    }

    fn allow_at(&mut self, now: Instant) -> bool {
        self.last_used = now;
        if now.duration_since(self.window_start) >= Duration::from_secs(1) {
            self.window_start = now;
            self.count = 0;
        }
        if self.count >= self.per_second {
            return false;
        }
        self.count += 1;
        true
    }

    /// Time since the last `allow` call (used to purge idle limiters).
    pub fn idle_for(&self) -> Duration {
        self.last_used.elapsed()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_per_window_and_resets() {
        let start = Instant::now();
        let mut l = EventLimiter::new_at(3, start);
        assert!(l.allow_at(start));
        assert!(l.allow_at(start + Duration::from_millis(100)));
        assert!(l.allow_at(start + Duration::from_millis(200)));
        assert!(!l.allow_at(start + Duration::from_millis(300)));
        assert!(!l.allow_at(start + Duration::from_millis(999)));
        // new window
        assert!(l.allow_at(start + Duration::from_millis(1000)));
        assert!(l.allow_at(start + Duration::from_millis(1500)));
        assert!(l.allow_at(start + Duration::from_millis(1600)));
        assert!(!l.allow_at(start + Duration::from_millis(1700)));
    }

    #[test]
    fn zero_budget_is_clamped_to_one() {
        let mut l = EventLimiter::new(0);
        assert!(l.allow());
        assert!(!l.allow());
    }
}
