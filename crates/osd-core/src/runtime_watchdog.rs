//! Supervises the OpenCode sidecar and restarts it when it stops answering.
//!
//! The managed worker runs OpenCode as a child process. A wedged sidecar keeps
//! its listening socket but stops making progress: every HTTP request hangs,
//! the worker container stays healthy, and the platform can only report the
//! workspace as unresponsive until someone restarts it. Replacing the whole
//! worker takes tens of seconds; restarting just this child takes a few, and
//! keeps the container, generation, and workspace data untouched.
//!
//! This module holds the decision logic (pure and unit-tested) and a thin
//! thread that probes `/global/health` and calls `runtime::restart_runtime`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use crate::env::Env;
use crate::runtime;

/// Timing for the sidecar watchdog. All durations are milliseconds.
#[derive(Clone, Copy, Debug)]
pub struct Config {
    /// Let a freshly spawned sidecar boot before counting failures.
    pub startup_grace_ms: u64,
    /// Delay between probe attempts.
    pub probe_interval_ms: u64,
    /// A probe that does not answer within this budget counts as a failure.
    pub probe_timeout_ms: u64,
    /// Consecutive failed probes needed before the sidecar is restarted.
    pub failures_before_restart: u32,
    /// Do not restart twice within this window.
    pub cooldown_ms: u64,
    /// Maximum automatic restarts inside `window_ms`.
    pub max_restarts: u32,
    /// Sliding window for `max_restarts`.
    pub window_ms: u64,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            startup_grace_ms: 15_000,
            probe_interval_ms: 1_000,
            probe_timeout_ms: 1_000,
            failures_before_restart: 3,
            cooldown_ms: 30_000,
            max_restarts: 3,
            window_ms: 300_000,
        }
    }
}

/// What the supervisor should do after one probe.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    /// Nothing to do; keep probing.
    None,
    /// The sidecar is unresponsive; restart it.
    Restart,
    /// Restart budget is exhausted for the current window.
    BudgetExhausted,
}

/// Pure restart-decision state. The caller feeds one probe result at a time.
pub struct State {
    config: Config,
    grace_until_ms: u64,
    failures: u32,
    restarts: Vec<u64>,
}

impl State {
    pub fn new(config: Config, started_at_ms: u64) -> Self {
        Self {
            config,
            grace_until_ms: started_at_ms.saturating_add(config.startup_grace_ms),
            failures: 0,
            restarts: Vec::new(),
        }
    }

    /// Record a probe result and decide what to do. `now_ms` is a monotonic
    /// millisecond clock owned by the caller (tests use a fake clock).
    pub fn observe(&mut self, healthy: bool, now_ms: u64) -> Action {
        if healthy {
            self.failures = 0;
            return Action::None;
        }
        if now_ms < self.grace_until_ms {
            return Action::None;
        }
        self.failures = self.failures.saturating_add(1);
        if self.failures < self.config.failures_before_restart {
            return Action::None;
        }
        self.restarts
            .retain(|at| now_ms.saturating_sub(*at) < self.config.window_ms);
        if self.restarts.len() as u32 >= self.config.max_restarts {
            return Action::BudgetExhausted;
        }
        if let Some(last) = self.restarts.last() {
            if now_ms.saturating_sub(*last) < self.config.cooldown_ms {
                return Action::None;
            }
        }
        self.restarts.push(now_ms);
        self.failures = 0;
        self.grace_until_ms = now_ms.saturating_add(self.config.startup_grace_ms);
        Action::Restart
    }
}

/// Milliseconds since the Unix epoch, matching the sidecar's lifecycle stamps.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Handle that stops the supervisor when the server shuts down.
pub struct Handle {
    stop: Arc<AtomicBool>,
    join: Option<thread::JoinHandle<()>>,
}

impl Handle {
    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Start probing the sidecar. The caller must hold the returned handle for as
/// long as the server runs; dropping it stops the supervisor.
pub fn spawn(env: Env) -> Handle {
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = stop.clone();
    let join = thread::spawn(move || run(env, thread_stop));
    Handle { stop, join: Some(join) }
}

fn run(env: Env, stop: Arc<AtomicBool>) {
    let config = Config::default();
    let mut state = State::new(config, now_ms());
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_millis(config.probe_timeout_ms))
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            crate::debug_log::append(&env, &format!("[runtime-watchdog] client unavailable: {error}"));
            return;
        }
    };
    let mut budget_logged = false;
    while !stop.load(Ordering::Relaxed) {
        let healthy = probe(&env, &client);
        match state.observe(healthy, now_ms()) {
            Action::None => {}
            Action::Restart => {
                budget_logged = false;
                crate::debug_log::append(&env, "[runtime-watchdog] sidecar unresponsive; restarting");
                match runtime::restart_runtime(&env) {
                    Ok(url) => crate::debug_log::append(
                        &env,
                        &format!("[runtime-watchdog] sidecar restarted on {url}"),
                    ),
                    Err(error) => crate::debug_log::append(
                        &env,
                        &format!("[runtime-watchdog] restart failed: {error}"),
                    ),
                }
            }
            Action::BudgetExhausted => {
                if !budget_logged {
                    budget_logged = true;
                    crate::debug_log::append(
                        &env,
                        "[runtime-watchdog] restart budget exhausted; waiting",
                    );
                }
            }
        }
        thread::sleep(Duration::from_millis(config.probe_interval_ms));
    }
}

/// One liveness probe. `None` from `sidecar_url` means the runtime is between
/// spawns; that is not a failure, so it is reported healthy to avoid racing a
/// deliberate restart.
fn probe(env: &Env, client: &reqwest::blocking::Client) -> bool {
    let Some(base) = runtime::sidecar_url(env.runtime()) else { return true };
    let url = format!("{base}/global/health");
    match client
        .get(url)
        .basic_auth("opencode", Some(runtime::server_password()))
        .send()
    {
        Ok(response) => response.status().is_success(),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::{Action, Config, State};

    fn config() -> Config {
        Config {
            startup_grace_ms: 15_000,
            probe_interval_ms: 1_000,
            probe_timeout_ms: 1_000,
            failures_before_restart: 3,
            cooldown_ms: 30_000,
            max_restarts: 3,
            window_ms: 300_000,
        }
    }

    #[test]
    fn failures_inside_startup_grace_do_not_restart() {
        let mut state = State::new(config(), 0);
        assert_eq!(state.observe(false, 1_000), Action::None);
        assert_eq!(state.observe(false, 14_999), Action::None);
    }

    #[test]
    fn three_consecutive_failures_after_startup_restart_the_runtime() {
        let mut state = State::new(config(), 0);
        assert_eq!(state.observe(true, 16_000), Action::None);
        assert_eq!(state.observe(false, 17_000), Action::None);
        assert_eq!(state.observe(false, 18_000), Action::None);
        assert_eq!(state.observe(false, 19_000), Action::Restart);
    }

    #[test]
    fn a_healthy_probe_resets_the_failure_count() {
        let mut state = State::new(config(), 0);
        assert_eq!(state.observe(false, 16_000), Action::None);
        assert_eq!(state.observe(false, 17_000), Action::None);
        assert_eq!(state.observe(true, 18_000), Action::None);
        assert_eq!(state.observe(false, 19_000), Action::None);
        assert_eq!(state.observe(false, 20_000), Action::None);
        assert_eq!(state.observe(false, 21_000), Action::Restart);
    }

    #[test]
    fn cooldown_blocks_a_second_restart_too_soon_after_the_first() {
        let mut config = config();
        config.startup_grace_ms = 0;
        let mut state = State::new(config, 0);
        assert_eq!(state.observe(false, 1_000), Action::None);
        assert_eq!(state.observe(false, 2_000), Action::None);
        assert_eq!(state.observe(false, 3_000), Action::Restart);
        assert_eq!(state.observe(false, 4_000), Action::None);
        assert_eq!(state.observe(false, 5_000), Action::None);
        assert_eq!(state.observe(false, 6_000), Action::None);
        assert_eq!(state.observe(false, 32_999), Action::None);
        assert_eq!(state.observe(false, 33_000), Action::Restart);
    }

    #[test]
    fn restart_budget_stops_a_restart_storm() {
        let mut config = config();
        config.startup_grace_ms = 0;
        config.cooldown_ms = 0;
        config.max_restarts = 2;
        let mut state = State::new(config, 0);
        assert_eq!(state.observe(false, 1_000), Action::None);
        assert_eq!(state.observe(false, 2_000), Action::None);
        assert_eq!(state.observe(false, 3_000), Action::Restart);
        assert_eq!(state.observe(false, 4_000), Action::None);
        assert_eq!(state.observe(false, 5_000), Action::None);
        assert_eq!(state.observe(false, 6_000), Action::Restart);
        assert_eq!(state.observe(false, 7_000), Action::None);
        assert_eq!(state.observe(false, 8_000), Action::None);
        assert_eq!(state.observe(false, 9_000), Action::BudgetExhausted);
    }

    #[test]
    fn a_restart_grants_a_fresh_startup_grace() {
        let mut config = config();
        config.cooldown_ms = 0;
        let mut state = State::new(config, 0);
        assert_eq!(state.observe(false, 15_000), Action::None);
        assert_eq!(state.observe(false, 16_000), Action::None);
        assert_eq!(state.observe(false, 17_000), Action::Restart);
        assert_eq!(state.observe(false, 18_000), Action::None);
        assert_eq!(state.observe(false, 31_999), Action::None);
        assert_eq!(state.observe(false, 32_000), Action::None);
        assert_eq!(state.observe(false, 33_000), Action::None);
        assert_eq!(state.observe(false, 34_000), Action::Restart);
    }
}
