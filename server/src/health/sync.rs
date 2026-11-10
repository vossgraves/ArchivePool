use super::*;

use crate::snapshot;

use std::collections::{BTreeSet, HashMap};

pub const TIDAL_SEEDS: &[&str] = &[
    "https://triton.squid.wtf",
    "https://wolf.qqdl.site",
    "https://maus.qqdl.site",
    "https://vogel.qqdl.site",
    "https://katze.qqdl.site",
    "https://hund.qqdl.site",
    "https://tidal.kinoplus.online",
    "https://tidal-api.binimum.org",
    "https://hifi-one.spotisaver.net",
    "https://hifi-two.spotisaver.net",
];

pub const QOBUZ_SEEDS: &[&str] = &[
    "https://dab.yeet.su",
    "https://dabmusic.xyz",
    "https://jumo-dl.pages.dev",
    "https://spotisaver.net",
    "https://squid.wtf",
];

pub fn monochrome_urls(body: &Value) -> Vec<String> {
    ["api", "streaming"]
        .iter()
        .flat_map(|k| body[*k].as_array().into_iter().flatten())
        .filter_map(|v| v.as_str().or_else(|| v["url"].as_str()))
        .map(pool::normalize_url)
        .filter(|s| s.starts_with("http"))
        .collect()
}
pub async fn fetch_monochrome(app: &App) -> db::Result<Vec<String>> {
    let r = app
        .outbound
        .get(&app.endpoints.monochrome, HeaderMap::new())
        .await
        .map_err(|_| db::Error)?;

    if !r.ok() {
        return Err(db::Error);
    }
    let mut urls = monochrome_urls(&r.json());

    urls.extend([
        "https://tracks.monochrome.st".into(),
        "https://api.monochrome.tf".into(),
    ]);

    Ok(urls)
}
pub async fn monochrome(app: &Arc<App>, details: usize) -> db::Result<Value> {
    sync_urls(
        app,
        "tidal",
        fetch_monochrome(app).await?,
        "monochrome",
        None,
        None,
        details,
    )
    .await
}
pub async fn spotiflac(app: &Arc<App>, details: usize) -> db::Result<Value> {
    let (tidal, qobuz) = tokio::try_join!(
        sync_urls(
            app,
            "tidal",
            TIDAL_SEEDS.iter().map(|s| s.to_string()).collect(),
            "spotiflac",
            None,
            None,
            details
        ),
        sync_urls(
            app,
            "qobuz",
            QOBUZ_SEEDS.iter().map(|s| s.to_string()).collect(),
            "spotiflac",
            None,
            None,
            details
        )
    )?;

    Ok(json!({"tidal":tidal,"qobuz":qobuz}))
}
pub async fn sync_urls(
    app: &Arc<App>,
    service: &str,
    urls: Vec<String>,
    note: &str,
    after: Option<&str>,
    limit: Option<usize>,
    details: usize,
) -> db::Result<Value> {
    let all = urls
        .iter()
        .map(|s| pool::normalize_url(s))
        .filter(|s| s.starts_with("http") && !pool::blocked_instance(s))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();

    let from = if limit.is_some() {
        after
            .map(|a| all.partition_point(|u| u.as_str() <= a))
            .unwrap_or(0)
    } else {
        0
    };

    let work = all
        .iter()
        .skip(from)
        .take(limit.unwrap_or(all.len()).max(1))
        .cloned()
        .collect::<Vec<_>>();

    let mut out = json!({"fetched":all.len(),"skipped":0,"checked":0,"added":0,"updated":0,"failed":0,"rejected":0,"deferred":0});

    if details > 0 {
        out["results"] = json!([]);
    }
    if limit.is_some() {
        out["batch"] = json!({"total":all.len(),"after":after,"nextAfter":work.last().map(String::as_str).or(after),"done":from+work.len()>=all.len(),"budgetExhausted":false});
    }
    if work.is_empty() {
        return Ok(out);
    }
    let name = format!("instance-sync:{service}:{note}");

    let holder = crypto::random_hex(16);

    let existing=app.db.rows("with claimed as(insert into job_locks(name,holder,expires_at) values($1,$2,now()+interval '20 minutes') on conflict(name) do update set holder=excluded.holder,expires_at=excluded.expires_at where job_locks.expires_at<=now() returning holder) select to_jsonb(i) as entry,exists(select 1 from claimed) as claimed from instance_entries i where service=$3 and exists(select 1 from claimed) union all select null,exists(select 1 from claimed) where not exists(select 1 from instance_entries where service=$3) or not exists(select 1 from claimed)",vec![name.clone().into(),holder.clone().into(),service.into()]).await?;

    if existing.first().is_some_and(|r| r["claimed"] == false) {
        out["locked"] = json!(true);

        if limit.is_some() {
            out["batch"]["nextAfter"] = json!(after);

            out["batch"]["done"] = json!(false);
        }
        return Ok(out);
    }
    let map = existing
        .iter()
        .filter_map(|r| {
            r["entry"]
                .as_object()
                .map(|_| (string(&r["entry"], "fingerprint"), r["entry"].clone()))
        })
        .collect::<HashMap<_, _>>();

    let results = stream::iter(work.into_iter().map(|url| check_candidate(app, service, url, note, &map)))
        .buffer_unordered(5).collect::<Vec<_>>().await;
    app.db.release_job(&name, &holder).await;
    snapshot::invalidate(app).await;
    for result in results {
        let (category, updated, detail) = result?;
        out[category] = json!(out[category].as_u64().unwrap() + 1);
        if !["skipped", "deferred"].contains(&category) { out["checked"] = json!(out["checked"].as_u64().unwrap() + 1); }
        if updated { out["updated"] = json!(out["updated"].as_u64().unwrap() + 1); }
        if details > 0 && let Some(detail) = detail && out["results"].as_array().unwrap().len() < details {
            out["results"].as_array_mut().unwrap().push(detail);
        }
    }
    Ok(out)
}
async fn check_candidate(app: &App, service: &str, url: String, note: &str, map: &HashMap<String, Value>) -> db::Result<(&'static str, bool, Option<Value>)> {
    let payload = if note.is_empty() { json!({"baseUrl":url}) } else { json!({"baseUrl":url,"note":note}) };
    let fp = pool::fingerprint(service, "api", &payload);
    let existing = map.get(&fp);
    if existing.is_some_and(|e| e["removed"] == false && e["disabled"] == false && ["alive", "preview"].contains(&string(e,"status").as_str()) && e["last_checked_at"].as_str().and_then(|s| DateTime::parse_from_rfc3339(s).ok()).is_some_and(|d| Utc::now().signed_duration_since(d).num_seconds() < 21600)) {
        return Ok(("skipped", false, None));
    }
    let check = instance_check(app, service, &payload).await;
    let detail = json!({"url":url,"status":check.status,"ok":check.ok,"premium":check.premium,"detail":check.detail});
    if check.skipped { return Ok(("deferred", false, Some(detail))); }
    let existing_live = existing.is_some_and(|e| e["removed"] == false);
    if !check.ok || !check.premium {
        if existing_live {
            let message = if check.ok { format!("reachable but not premium ({})", check.detail) } else { check.detail };
            app.db.exec("update instance_entries set status=$1,premium=$2,detail=$3,latency_ms=$4,consecutive_failures=consecutive_failures+case when $5 then 0 else 1 end,check_count=check_count+1,last_checked_at=now(),disabled=case when $5 then true else disabled end where fingerprint=$6",
                vec![check.status.into(),check.premium.into(),message.into(),check.latency_ms.into(),check.ok.into(),fp.into()]).await?;
        }
        return Ok((if check.ok { "rejected" } else { "failed" }, existing_live, Some(detail)));
    }
    let stored = crypto::encrypt_at_rest(&payload, app.config.encryption_key.as_ref())?;
    app.db.exec("insert into instance_entries(service,label,payload,fingerprint,status,premium,detail,latency_ms,check_count,ok_count,last_checked_at,last_ok_at) values($1,$2,$3,$4,$5,true,$6,$7,1,1,now(),now()) on conflict(fingerprint) do update set status=excluded.status,premium=true,detail=excluded.detail,latency_ms=excluded.latency_ms,consecutive_failures=0,disabled=false,removed=false,check_count=instance_entries.check_count+1,ok_count=instance_entries.ok_count+1,last_checked_at=now(),last_ok_at=now()",
        vec![service.into(),pool::mask_label(service,"api",&payload).into(),stored.into(),fp.into(),check.status.into(),check.detail.into(),check.latency_ms.into()]).await?;
    Ok((if existing.is_some() { "updated" } else { "added" }, false, Some(detail)))
}
