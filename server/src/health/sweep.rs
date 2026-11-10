use super::*;
pub fn table(kind: &str) -> &'static str {
    if kind == "account" {
        "account_entries"
    } else {
        "instance_entries"
    }
}
pub async fn find_entry(app: &App, id: i32) -> db::Result<Option<Value>> {
    app.db.one("select to_jsonb(a)||jsonb_build_object('kind','account') as entry from account_entries a where id=$1 union all select to_jsonb(i)||jsonb_build_object('kind','api') as entry from instance_entries i where id=$1 limit 1",vec![id.into()]).await.map(|r|r.map(|r|r["entry"].clone()))
}
pub async fn check_entry(app: &App, id: i32) -> db::Result<Option<Value>> {
    let Some(entry) = find_entry(app, id).await? else {
        return Ok(None);
    };
    check_and_persist(app, &entry).await.map(Some)
}
pub async fn check_and_persist(app: &App, entry: &Value) -> db::Result<Value> {
    let kind = string(entry, "kind");
    let id = integer(entry, "id");
    let table = table(&kind);
    if kind == "account" && app.config.encryption_key.is_none() {
        return Err(db::Error);
    }
    let mut expected = entry["payload"].clone();
    let plain = crypto::decrypt(&expected, app.config.encryption_key.as_ref());
    if crypto::has_sensitive(&expected, true) {
        let encrypted = crypto::encrypt_at_rest(&expected, app.config.encryption_key.as_ref())?;
        let changed = app
            .db
            .exec(
                &format!("update {table} set payload=$1 where id=$2 and payload=$3"),
                vec![encrypted.clone().into(), id.into(), expected.clone().into()],
            )
            .await?;
        if changed == 0 {
            return Ok(skipped_entry(entry, "credential changed during check"));
        }
        expected = encrypted;
    }
    let result = run_check(
        app,
        &string(entry, "service"),
        &kind,
        &plain,
        &string(entry, "fingerprint"),
    )
    .await;
    if result.skipped {
        return Ok(skipped_entry(entry, &result.detail));
    }
    if let Some(stored) = &result.stored_payload {
        expected = stored.clone();
    }
    let sql = format!(
        "with updated as (update {table} set status=$1,premium=$2,detail=$3,latency_ms=$4,consecutive_failures=case when $5 then 0 else consecutive_failures+1 end,disabled=case when $5 then not $2 else disabled or consecutive_failures+1>=5 end,check_count=check_count+1,ok_count=ok_count+case when $5 then 1 else 0 end,last_checked_at=now(),last_ok_at=case when $5 then now() else last_ok_at end where id=$6 and payload=$7 and removed=false returning consecutive_failures,disabled),logged as (insert into health_log(entry_id,ok,premium,latency_ms,detail) select $6,$5,$2,$4,$3 from updated) select * from updated"
    );
    let row = app
        .db
        .one(
            &sql,
            vec![
                result.status.clone().into(),
                result.premium.into(),
                result.detail.clone().into(),
                result.latency_ms.into(),
                result.ok.into(),
                id.into(),
                expected.into(),
            ],
        )
        .await?;
    let Some(row) = row else {
        return Ok(skipped_entry(entry, "credential changed during check"));
    };
    Ok(
        json!({"id":id,"ok":result.ok,"status":result.status,"premium":result.premium,"detail":result.detail,"latencyMs":result.latency_ms,"consecutiveFailures":row["consecutive_failures"],"disabled":row["disabled"]}),
    )
}
fn skipped_entry(entry: &Value, detail: &str) -> Value {
    json!({"id":entry["id"],"ok":false,"status":"pending","premium":false,"detail":detail,"latencyMs":0,"consecutiveFailures":entry["consecutive_failures"],"disabled":entry["disabled"],"skipped":true})
}
fn cursor_key(entry: &Value) -> (i32, i64, i32) {
    (
        if entry["status"] == "pending" { 1 } else { 0 },
        entry["last_checked_at"]
            .as_str()
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .map(|t| t.timestamp_millis())
            .unwrap_or(0),
        integer(entry, "id"),
    )
}
fn after_cursor(key: (i32, i64, i32), cursor: (i32, i64, i32)) -> bool {
    key.0 < cursor.0
        || key.0 == cursor.0 && (key.1 > cursor.1 || key.1 == cursor.1 && key.2 > cursor.2)
}
pub async fn run_sweep(
    app: &Arc<App>,
    force: bool,
    limit: Option<usize>,
    cursor: Option<&str>,
) -> db::Result<Value> {
    let holder = crypto::random_hex(16);
    let sql = "with claimed as (insert into job_locks(name,holder,expires_at) values('health-sweep',$1,now()+interval '20 minutes') on conflict(name) do update set holder=excluded.holder,expires_at=excluded.expires_at where job_locks.expires_at<=now() returning holder),entries as(select to_jsonb(a)||jsonb_build_object('kind','account') as entry from account_entries a where removed=false union all select to_jsonb(i)||jsonb_build_object('kind','api') as entry from instance_entries i where removed=false) select entry,exists(select 1 from claimed) as claimed from entries where exists(select 1 from claimed) union all select null,exists(select 1 from claimed) where not exists(select 1 from entries) or not exists(select 1 from claimed)";
    let rows = app.db.rows(sql, vec![holder.clone().into()]).await?;
    if rows.first().is_some_and(|r| r["claimed"] == false) {
        return Ok(
            json!({"checked":0,"skipped":0,"fresh":0,"starved":0,"disabled":0,"reenabled":0,"attempted":0,"remaining":0,"done":true,"cursor":null,"budgetExhausted":false,"locked":true}),
        );
    }
    let result = async {
        let entries = rows.into_iter().filter_map(|r| r["entry"].as_object().map(|_| r["entry"].clone())).collect::<Vec<_>>();
        if entries.iter().any(|r| r["kind"] == "account") && app.config.encryption_key.is_none() {
            return Err(db::Error);
        }
        let now = Utc::now().timestamp_millis();
        let mut stale = entries.iter().filter(|e| {
            let k = cursor_key(e);
            force || k.0 == 1 || k.1 == 0 || now - k.1 > 18_000_000
        }).cloned().collect::<Vec<_>>();
        let fresh = entries.len() - stale.len();
        stale.sort_by_key(|e| { let k = cursor_key(e); (-k.0, k.1, k.2) });
        let parsed = cursor.and_then(|s| {
            let p = s.split(':').collect::<Vec<_>>();
            if p.len() != 3 || !p.iter().all(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())) { return None; }
            let k = (p[0].parse().ok()?, p[1].parse().ok()?, p[2].parse().ok()?);
            [0, 1].contains(&k.0).then_some(k)
        });
        if let Some(cursor) = parsed { stale.retain(|e| after_cursor(cursor_key(e), cursor)); }
        let queue_len = stale.len();
        let cap = limit.map(|n| n.saturating_mul(2).min(12)).unwrap_or(queue_len);
        let workers = if limit.is_some() { 3 } else { 6 };
        let mut checked = 0;
        let mut disabled = 0;
        let mut reenabled = 0;
        let mut attempted = 0;
        let mut next_cursor = cursor.unwrap_or("1:0:0").to_owned();
        let mut queue = stale.iter().cloned();
        let mut active = futures_util::stream::FuturesUnordered::new();
        let check = |entry: Value| async move {
            let result = check_and_persist(app, &entry).await;
            (entry, result)
        };
        loop {
            while active.len() < workers && attempted < cap && limit.is_none_or(|n| checked + active.len() < n) {
                let Some(entry) = queue.next() else { break; };
                active.push(check(entry));
                attempted += 1;
            }
            let Some((entry, result)) = active.next().await else { break; };
            let result = result?;
            if result["skipped"] != true {
                checked += 1;
                if !boolean(&entry, "disabled") && result["disabled"] == true { disabled += 1; }
                if boolean(&entry, "disabled") && result["disabled"] == false { reenabled += 1; }
            }
        }
        if attempted > 0 { let k = cursor_key(&stale[attempted - 1]); next_cursor = format!("{}:{}:{}", k.0, k.1, k.2); }
        let remaining = queue_len - attempted;
        let skipped = entries.len() - checked - remaining;
        Ok(json!({"checked":checked,"skipped":skipped,"fresh":fresh,"starved":0,"disabled":disabled,"reenabled":reenabled,"attempted":attempted,"remaining":remaining,"done":remaining==0,"cursor":limit.map(|_|next_cursor),"budgetExhausted":false}))
    }.await;
    let _=app.db.exec("with pruned as (delete from health_log where checked_at<now()-interval '30 days') delete from job_locks where name='health-sweep' and holder=$1",vec![holder.into()]).await;
    result
}
pub async fn ingest(
    app: &App,
    service: &str,
    kind: &str,
    p: &Value,
    contributor: Option<String>,
    expires: Option<DateTime<Utc>>,
) -> db::Result<Value> {
    app.db.ensure().await?;
    if kind == "account" && app.config.encryption_key.is_none() {
        return Err(db::Error);
    }
    let fp = pool::fingerprint(service, kind, p);
    let result = run_check(app, service, kind, p, &fp).await;
    if result.skipped {
        return Ok(
            json!({"ok":false,"saved":false,"status":result.status,"premium":result.premium,"detail":format!("could not be verified — not a verdict ({}); try again shortly",result.detail),"skipped":true}),
        );
    }
    if !result.ok || !result.premium {
        return Ok(
            json!({"ok":result.ok,"saved":false,"status":result.status,"premium":result.premium,"detail":format!("rejected — {} ({})",if result.ok{"working but no premium/lossless entitlement"}else{"live check failed"},result.detail)}),
        );
    }
    let next = result.payload.as_ref().unwrap_or(p);
    let stored = crypto::encrypt_at_rest(next, app.config.encryption_key.as_ref())?;
    let table = table(kind);
    let label = pool::mask_label(service, kind, p);
    let sql = format!(
        "insert into {table}(service,label,payload,fingerprint,status,premium,detail,latency_ms,check_count,ok_count,consecutive_failures,last_checked_at,last_ok_at,removed,disabled,contributor,expires_at) values($1,$2,$3,$4,$5,$6,$7,$8,1,1,0,now(),now(),false,false,$9,$10) on conflict(fingerprint) do update set payload=excluded.payload,label=excluded.label,status=excluded.status,premium=excluded.premium,detail=excluded.detail,latency_ms=excluded.latency_ms,check_count={table}.check_count+1,ok_count={table}.ok_count+1,consecutive_failures=0,last_checked_at=excluded.last_checked_at,last_ok_at=excluded.last_ok_at,removed=false,disabled=false,contributor=coalesce({table}.contributor,excluded.contributor),expires_at=excluded.expires_at"
    );
    app.db
        .exec(
            &sql,
            vec![
                service.into(),
                label.into(),
                stored.into(),
                fp.into(),
                result.status.clone().into(),
                result.premium.into(),
                result.detail.clone().into(),
                result.latency_ms.into(),
                contributor.into(),
                expires.into(),
            ],
        )
        .await?;
    Ok(
        json!({"ok":result.ok,"saved":true,"status":result.status,"premium":result.premium,"detail":result.detail}),
    )
}
pub fn describe_save_error(database_url: &str, message: &str) -> String {
    let m = message.to_lowercase();
    if database_url.is_empty() {
        return "The server has no DATABASE_URL set. Add your database connection string in the host's environment variables.".into();
    }
    if ["account_entries", "instance_entries", "source_entries"]
        .iter()
        .any(|t| m.contains(t) && m.contains("does not exist"))
    {
        return "The database has no tables yet. Run scripts/schema.sql against it once, then try again.".into();
    }
    if m.contains("no unique or exclusion constraint") || m.contains("on conflict") {
        return "The database schema is out of date (missing the fingerprint unique constraint). Re-run scripts/schema.sql.".into();
    }
    if [
        "econnrefused",
        "timeout",
        "terminating connection",
        "connect",
    ]
    .iter()
    .any(|s| m.contains(s))
    {
        return "Could not reach the database. Check that DATABASE_URL is correct and the database is reachable from the host.".into();
    }
    "Could not save to the database. Check the server logs for the underlying error.".into()
}
