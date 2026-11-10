use super::*;
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};
#[tokio::test]
async fn cache_expiry_prefix_isolation_and_bounded_storage() {
    let cache = Cache::default();
    cache
        .put("snapshot:tidal", json!(1), Duration::from_millis(1))
        .await;
    cache
        .put("discovery:tidal", json!(2), Duration::from_secs(300))
        .await;
    cache
        .put("status", json!(3), Duration::from_secs(300))
        .await;
    assert_eq!(cache.get("snapshot:tidal").await, Some(json!(1)));
    tokio::time::sleep(Duration::from_millis(5)).await;
    assert_eq!(cache.get("snapshot:tidal").await, None);
    cache.invalidate("snapshot:").await;
    assert_eq!(cache.get("discovery:tidal").await, Some(json!(2)));
    assert_eq!(cache.get("status").await, Some(json!(3)));
    for i in 0..5001 {
        cache
            .put(
                &format!("bounded:{i}"),
                json!(true),
                Duration::from_secs(300),
            )
            .await;
    }
    assert!(cache.values.lock().await.len() <= 5000);
}
#[tokio::test]
async fn simultaneous_cache_misses_share_one_load() {
    let cache = Cache::default();
    let loads = Arc::new(AtomicUsize::new(0));
    let tasks = (0..12)
        .map(|_| {
            let cache = cache.clone();
            let loads = loads.clone();
            tokio::spawn(async move {
                let _guard = cache.flight("shared").await;
                if let Some(v) = cache.get("shared").await {
                    return v;
                }
                loads.fetch_add(1, Ordering::SeqCst);
                tokio::task::yield_now().await;
                cache
                    .put("shared", json!(42), Duration::from_secs(300))
                    .await;
                json!(42)
            })
        })
        .collect::<Vec<_>>();
    for task in tasks {
        assert_eq!(task.await.unwrap(), json!(42));
    }
    assert_eq!(loads.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn sliding_rate_window_and_bucket_bounds() {
    let rates = RateLimit::default();
    for _ in 0..3 {
        assert_eq!(
            rates.check("client-a", 3, Duration::from_millis(5)).await,
            None
        );
    }
    assert_eq!(
        rates.check("client-a", 3, Duration::from_millis(5)).await,
        Some(1)
    );
    assert_eq!(
        rates.check("client-b", 3, Duration::from_millis(5)).await,
        None
    );
    tokio::time::sleep(Duration::from_millis(10)).await;
    assert_eq!(
        rates.check("client-a", 3, Duration::from_millis(5)).await,
        None
    );
    for i in 0..10001 {
        rates
            .check(&format!("bucket:{i}"), 3, Duration::from_secs(300))
            .await;
    }
    assert!(rates.buckets.lock().await.len() <= 10000);
}
