use serde::Serialize;
use std::collections::VecDeque;
use std::sync::{
    atomic::{AtomicU64, AtomicUsize, Ordering},
    Mutex,
};
use tokio::sync::Notify;

pub(crate) struct AudioFrame {
    pub(crate) seq: u64,
    pub(crate) captured_at_micros: u64,
    pub(crate) payload: Vec<u8>,
    pub(crate) silent: bool,
    pub(crate) discontinuity: bool,
}

#[derive(Default)]
pub(crate) struct AudioMetrics {
    pub(crate) captured_frames: AtomicU64,
    pub(crate) sent_frames: AtomicU64,
    pub(crate) queue_high_water: AtomicUsize,
    pub(crate) queue_overloads: AtomicU64,
    pub(crate) dropped_frames: AtomicU64,
    pub(crate) discontinuities: AtomicU64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AudioMetricsSnapshot {
    pub(crate) generation: u64,
    pub(crate) captured_frames: u64,
    pub(crate) sent_frames: u64,
    pub(crate) queue_high_water: usize,
    pub(crate) queue_overloads: u64,
    pub(crate) dropped_frames: u64,
    pub(crate) discontinuities: u64,
}

impl AudioMetrics {
    pub(crate) fn snapshot(&self, generation: u64) -> AudioMetricsSnapshot {
        AudioMetricsSnapshot {
            generation,
            captured_frames: self.captured_frames.load(Ordering::Relaxed),
            sent_frames: self.sent_frames.load(Ordering::Relaxed),
            queue_high_water: self.queue_high_water.load(Ordering::Relaxed),
            queue_overloads: self.queue_overloads.load(Ordering::Relaxed),
            dropped_frames: self.dropped_frames.load(Ordering::Relaxed),
            discontinuities: self.discontinuities.load(Ordering::Relaxed),
        }
    }
}

struct AudioFrameQueueInner {
    frames: VecDeque<AudioFrame>,
    closed: bool,
}

pub(crate) struct AudioFrameQueue {
    capacity: usize,
    inner: Mutex<AudioFrameQueueInner>,
    available: Notify,
}

impl AudioFrameQueue {
    pub(crate) fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(2),
            inner: Mutex::new(AudioFrameQueueInner {
                frames: VecDeque::new(),
                closed: false,
            }),
            available: Notify::new(),
        }
    }

    pub(crate) fn push(&self, mut frame: AudioFrame, metrics: &AudioMetrics) -> bool {
        let Ok(mut inner) = self.inner.lock() else {
            return false;
        };
        if inner.closed {
            return false;
        }

        if inner.frames.len() >= self.capacity {
            let remove_index = inner
                .frames
                .iter()
                .position(|candidate| candidate.silent)
                .unwrap_or(0);
            inner.frames.remove(remove_index);
            frame.discontinuity = true;
            metrics.queue_overloads.fetch_add(1, Ordering::Relaxed);
            metrics.dropped_frames.fetch_add(1, Ordering::Relaxed);
            metrics.discontinuities.fetch_add(1, Ordering::Relaxed);
        }

        inner.frames.push_back(frame);
        metrics
            .queue_high_water
            .fetch_max(inner.frames.len(), Ordering::Relaxed);
        drop(inner);
        self.available.notify_one();
        true
    }

    pub(crate) async fn pop(&self) -> Option<AudioFrame> {
        loop {
            let notified = self.available.notified();
            {
                let mut inner = self.inner.lock().ok()?;
                if let Some(frame) = inner.frames.pop_front() {
                    return Some(frame);
                }
                if inner.closed {
                    return None;
                }
            }
            notified.await;
        }
    }

    pub(crate) fn close(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.closed = true;
        }
        self.available.notify_waiters();
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.inner
            .lock()
            .map(|inner| inner.frames.len())
            .unwrap_or(0)
    }
}
