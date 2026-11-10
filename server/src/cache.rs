use serde_json::Value;
use std::{
    collections::{HashMap, VecDeque},
    sync::Arc,
    time::Duration,
};
use tokio::{
    sync::{Mutex, OwnedMutexGuard},
    time::Instant,
};
#[derive(Clone, Default)]
pub struct Cache {
    values: Arc<Mutex<HashMap<String, (Instant, Value)>>>,
    locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
}
impl Cache {
    pub async fn get(&self, key: &str) -> Option<Value> {
        let mut m = self.values.lock().await;
        match m.get(key) {
            Some((at, v)) if Instant::now() < *at => Some(v.clone()),
            _ => {
                m.remove(key);
                None
            }
        }
    }
    pub async fn put(&self, key: &str, value: Value, ttl: Duration) {
        let mut m = self.values.lock().await;
        if m.len() >= 5000 {
            m.retain(|_, (at, _)| *at > Instant::now());
            if m.len() >= 5000 {
                m.clear();
            }
        }
        m.insert(key.to_owned(), (Instant::now() + ttl, value));
    }
    pub async fn invalidate(&self, prefix: &str) {
        self.values
            .lock()
            .await
            .retain(|k, _| !k.starts_with(prefix));
    }
    pub async fn flight(&self, key: &str) -> OwnedMutexGuard<()> {
        let lock = {
            let mut m = self.locks.lock().await;
            m.retain(|_, v| Arc::strong_count(v) > 1);
            m.entry(key.to_owned()).or_default().clone()
        };
        lock.lock_owned().await
    }
}
#[derive(Clone, Default)]
pub struct RateLimit {
    buckets: Arc<Mutex<HashMap<String, VecDeque<Instant>>>>,
}
#[cfg(test)]
mod tests;
impl RateLimit {
    pub async fn check(&self, key: &str, limit: usize, window: Duration) -> Option<u64> {
        let now = Instant::now();
        let mut m = self.buckets.lock().await;
        if m.len() >= 10000 && !m.contains_key(key) {
            m.retain(|_, v| {
                v.back()
                    .is_some_and(|at| now.duration_since(*at) < Duration::from_secs(86400))
            });
            if m.len() >= 10000 {
                return Some(window.as_secs().max(1));
            }
        }
        let hits = m.entry(key.to_owned()).or_default();
        while hits
            .front()
            .is_some_and(|at| now.duration_since(*at) >= window)
        {
            hits.pop_front();
        }
        if hits.len() >= limit {
            Some(
                (window
                    .saturating_sub(now.duration_since(*hits.front().unwrap()))
                    .as_millis() as u64)
                    .div_ceil(1000)
                    .max(1),
            )
        } else {
            hits.push_back(now);
            None
        }
    }
}
