use serde::Serialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tokio::sync::{broadcast, Notify};

pub(crate) struct AppState {
    pub(crate) capture_tx: broadcast::Sender<Vec<u32>>,
    pub(crate) latest_capture_pids: Arc<Mutex<Vec<u32>>>,
    pub(crate) mic_vad_threshold: Arc<Mutex<f32>>,
    pub(crate) mic_sessions: Arc<MicSessionManager>,
    pub(crate) mic_boost: Arc<Mutex<f32>>,
    pub(crate) selected_mic_device_id: Arc<Mutex<Option<String>>>,
}

impl AppState {
    pub(crate) fn new() -> Self {
        let (capture_tx, _) = broadcast::channel::<Vec<u32>>(32);
        Self {
            capture_tx,
            latest_capture_pids: Arc::new(Mutex::new(Vec::new())),
            mic_vad_threshold: Arc::new(Mutex::new(20.0)),
            mic_sessions: Arc::new(MicSessionManager::new()),
            mic_boost: Arc::new(Mutex::new(5.0)),
            selected_mic_device_id: Arc::new(Mutex::new(None)),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum MicLifecycle {
    Starting,
    Running,
    Stopping,
    Stopped,
}

struct ActiveMicSession {
    generation: u64,
    cancel: Arc<AtomicBool>,
    done: Arc<AtomicBool>,
    completed: Arc<Notify>,
}

struct MicSessionInner {
    generation: u64,
    desired_enabled: bool,
    lifecycle: MicLifecycle,
    active: Option<ActiveMicSession>,
}

pub(crate) struct MicSessionLease {
    pub(crate) generation: u64,
    pub(crate) cancel: Arc<AtomicBool>,
}

pub(crate) struct MicSessionManager {
    inner: Mutex<MicSessionInner>,
}

impl MicSessionManager {
    pub(crate) fn new() -> Self {
        Self {
            inner: Mutex::new(MicSessionInner {
                generation: 0,
                desired_enabled: false,
                lifecycle: MicLifecycle::Stopped,
                active: None,
            }),
        }
    }

    pub(crate) fn request_enabled(&self, enable: bool) -> Result<u64, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "麦克风会话状态锁被污染".to_string())?;

        if enable
            && inner.desired_enabled
            && matches!(
                inner.lifecycle,
                MicLifecycle::Starting | MicLifecycle::Running
            )
        {
            return Ok(inner.generation);
        }

        inner.generation = inner.generation.saturating_add(1);
        inner.desired_enabled = enable;
        if let Some(active) = inner.active.as_ref() {
            active.cancel.store(true, Ordering::Release);
            inner.lifecycle = if enable {
                MicLifecycle::Starting
            } else {
                MicLifecycle::Stopping
            };
        } else {
            inner.lifecycle = if enable {
                MicLifecycle::Starting
            } else {
                MicLifecycle::Stopped
            };
        }
        Ok(inner.generation)
    }

    pub(crate) async fn begin_session(&self) -> Option<MicSessionLease> {
        loop {
            let wait_for = {
                let mut inner = self.inner.lock().ok()?;
                if !inner.desired_enabled {
                    inner.lifecycle = MicLifecycle::Stopped;
                    return None;
                }

                let target_generation = inner.generation;
                if let Some(active) = inner.active.as_ref() {
                    if active.generation == target_generation {
                        return None;
                    }
                    active.cancel.store(true, Ordering::Release);
                    Some((active.done.clone(), active.completed.clone()))
                } else {
                    let cancel = Arc::new(AtomicBool::new(false));
                    inner.active = Some(ActiveMicSession {
                        generation: target_generation,
                        cancel: cancel.clone(),
                        done: Arc::new(AtomicBool::new(false)),
                        completed: Arc::new(Notify::new()),
                    });
                    inner.lifecycle = MicLifecycle::Running;
                    return Some(MicSessionLease {
                        generation: target_generation,
                        cancel,
                    });
                }
            };

            if let Some((done, completed)) = wait_for {
                while !done.load(Ordering::Acquire) {
                    let notified = completed.notified();
                    if done.load(Ordering::Acquire) {
                        break;
                    }
                    notified.await;
                }
            }
        }
    }

    pub(crate) fn finish_session(&self, generation: u64) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        let Some(active) = inner.active.as_ref() else {
            return;
        };
        if active.generation != generation {
            return;
        }

        active.done.store(true, Ordering::Release);
        active.completed.notify_waiters();
        inner.active = None;
        inner.lifecycle = if inner.desired_enabled {
            MicLifecycle::Starting
        } else {
            MicLifecycle::Stopped
        };
    }

    pub(crate) fn should_report_error(&self, generation: u64) -> bool {
        self.inner
            .lock()
            .map(|inner| inner.desired_enabled && inner.generation == generation)
            .unwrap_or(false)
    }

    #[cfg(test)]
    pub(crate) fn snapshot(&self) -> (u64, bool, MicLifecycle, Option<u64>) {
        let inner = self.inner.lock().expect("session lock");
        (
            inner.generation,
            inner.desired_enabled,
            inner.lifecycle,
            inner.active.as_ref().map(|active| active.generation),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn generation_cancels_and_isolates_previous_session() {
        let manager = MicSessionManager::new();
        let first_generation = manager.request_enabled(true).expect("start first");
        let first = manager.begin_session().await.expect("first lease");

        manager.request_enabled(false).expect("stop first");
        let newest_generation = manager.request_enabled(true).expect("start newest");
        assert!(first.cancel.load(Ordering::Acquire));
        manager.finish_session(first_generation);

        let newest = manager.begin_session().await.expect("newest lease");
        assert_eq!(newest.generation, newest_generation);
        manager.finish_session(first_generation);
        let snapshot = manager.snapshot();
        assert_eq!(snapshot.0, newest_generation);
        assert_eq!(snapshot.2, MicLifecycle::Running);
        assert_eq!(snapshot.3, Some(newest_generation));
    }
}
