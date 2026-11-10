use crate::{App, db, httpx::headers, pool};
use serde_json::Value;
use std::time::Duration;
pub fn blob_base(token: &str) -> Option<String> {
    let p: Vec<_> = token.split('_').collect();
    if p.len() < 5
        || p[..3] != ["vercel", "blob", "rw"]
        || p[3].is_empty()
        || !p[3].bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return None;
    }
    Some(format!(
        "https://{}.public.blob.vercel-storage.com/",
        p[3].to_lowercase()
    ))
}
pub fn valid_discovery(v: &Value) -> bool {
    ["streaming", "api"].iter().all(|k| {
        v[k].as_array()
            .is_some_and(|a| a.iter().all(Value::is_string))
    })
}
pub async fn read(app: &App) -> Option<Value> {
    let key = "snapshot:instances";
    if let Some(v) = app.cache.get(key).await {
        return (!v.is_null()).then_some(v);
    }
    let value = async {
        let base = blob_base(&app.config.blob_token)?;
        let r = app
            .outbound
            .get(
                &format!("{base}pool/instances.json"),
                headers(&[("cache-control", "no-cache"), ("x-api-version", "7")]),
            )
            .await
            .ok()?;
        if !r.ok() {
            return None;
        }
        let modified = r.headers.get("last-modified")?.to_str().ok()?;
        let date = chrono::DateTime::parse_from_rfc2822(modified).ok()?;
        if chrono::Utc::now().signed_duration_since(date).num_seconds() > 86400 {
            return None;
        }
        let v = r.json();
        v.is_object().then_some(v)
    }
    .await;
    app.cache
        .put(
            key,
            value.clone().unwrap_or(Value::Null),
            Duration::from_secs(300),
        )
        .await;
    value
}
pub async fn write(app: &App) -> db::Result<()> {
    if app.config.blob_token.is_empty() {
        return Ok(());
    }
    let data = pool::leases::discovery(app, None).await?;
    let auth = format!("Bearer {}", app.config.blob_token);
    let h = headers(&[
        ("authorization", &auth),
        ("x-api-version", "7"),
        ("x-content-type", "application/json"),
        ("x-add-random-suffix", "0"),
        ("x-allow-overwrite", "1"),
    ]);
    let r = app
        .outbound
        .send(
            reqwest::Method::PUT,
            "https://blob.vercel-storage.com/pool/instances.json",
            h,
            serde_json::to_vec(&data).map_err(|_| db::Error)?,
        )
        .await
        .map_err(|_| db::Error)?;
    if !r.ok() {
        return Err(db::Error);
    }
    app.cache.invalidate("snapshot:").await;
    Ok(())
}
pub async fn invalidate(app: &App) {
    for p in ["status", "discovery:", "snapshot:"] {
        app.cache.invalidate(p).await;
    }
}
