use super::*;
use crate::{crypto, health::sweep, pool, snapshot};
fn fresh(row: &Value) -> bool {
    row["last_checked_at"]
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .is_some_and(|d| chrono::Utc::now().signed_duration_since(d).num_seconds() < 900)
}
fn verdict(row: &Value) -> Value {
    let ok = ["alive", "preview"].contains(&string(row, "status").as_str());
    json!({"ok":ok,"premium":row["premium"]})
}
pub async fn route(app: &Arc<App>, ctx: &Context) -> db::Result<Response> {
    let identity = auth::identify(app, ctx, false, false).await?;
    if !identity.ok {
        return Ok(private(error(401, "unauthorized")));
    }
    let presented = auth::read_key(ctx);
    let hash = presented.map(|s| hex::encode(crypto::sha256(s)));
    let mut buckets = vec![format!("report-ip:{}", ctx.ip())];
    if let Some(hash) = &hash {
        buckets.push(format!("report-key:{}:{}", &hash[..16], ctx.ip()));
    }
    for bucket in buckets {
        if let Some(s) = app.rates.check(&bucket, 20, Duration::from_secs(300)).await {
            return Ok(too_many(s, "report"));
        }
    }
    let Some(body) = ctx.json() else {
        return Ok(error(400, "invalid body"));
    };
    let report = string(&body, "report");
    if !["dead", "not_premium"].contains(&report.as_str()) {
        return Ok(error(400, "unknown report type"));
    }
    let id = number(&body["id"]);
    let fingerprint = string(&body, "fingerprint").trim().to_owned();
    if (id == 0. || !id.is_finite()) && fingerprint.is_empty() {
        return Ok(error(400, "id or fingerprint required"));
    }
    let kind = string(&body, "kind");
    let row=app.db.one("with started as(select now() as report_started_at),entries as(select to_jsonb(a)||jsonb_build_object('kind','account','last_ok_text',a.last_ok_at::text) as entry from account_entries a where (($1::int is not null and id=$1) or ($1::int is null and fingerprint=$2 and $3!='api')) union all select to_jsonb(i)||jsonb_build_object('kind','api','last_ok_text',i.last_ok_at::text) as entry from instance_entries i where (($1::int is not null and id=$1) or ($1::int is null and fingerprint=$2 and $3!='account'))) select entry,report_started_at::text from entries,started limit 1",vec![if id.is_finite()&&id!=0.{Some(id as i32)}else{None}.into(),fingerprint.into(),kind.into()]).await?;
    let Some(row) = row else {
        return Ok(error(404, "unknown entry"));
    };
    let entry = &row["entry"];
    let id = integer(entry, "id");
    let table = sweep::table(&string(entry, "kind"));
    let mut live = Some(verdict(entry));
    let mut probed = false;
    let mut last_ok = entry["last_ok_text"].as_str().map(str::to_owned);
    if !fresh(entry) {
        let claimed=app.db.one(&format!("update {table} set verify_lease_until=now()+interval '120 seconds' where id=$1 and (verify_lease_until is null or verify_lease_until<now()) returning id"),vec![id.into()]).await?;
        let latest=app.db.one(&format!("select status,premium,last_checked_at,last_ok_at::text as last_ok_text from {table} where id=$1"),vec![id.into()]).await?;
        if let Some(latest) = &latest {
            live = Some(verdict(latest));
            last_ok = latest["last_ok_text"].as_str().map(str::to_owned);
        }
        if claimed.is_some() && !latest.as_ref().is_some_and(fresh) {
            probed = true;
            live = tokio::time::timeout(Duration::from_secs(45), sweep::check_entry(app, id))
                .await
                .ok()
                .and_then(Result::ok)
                .flatten();
        }
    }
    if report == "dead" {
        if live.as_ref().is_none_or(|v| v["ok"] != true)
            && !live.as_ref().is_some_and(|v| v["skipped"] == true)
        {
            let counts = !probed || live.is_none();
            app.db.exec(&format!("update {table} set status='pending',consecutive_failures=consecutive_failures+$1,disabled=disabled or consecutive_failures+$1>=3,check_count=check_count+$2 where id=$3 and last_ok_at is not distinct from $4::timestamptz and (last_ok_at is null or last_ok_at<$5::timestamptz)"),vec![(if counts{1}else{0}).into(),(if live.is_none(){1}else{0}).into(),id.into(),last_ok.into(),string(&row,"report_started_at").into()]).await?;
        }
    } else if live
        .as_ref()
        .is_none_or(|v| v["ok"] != true || v["premium"] == true)
    {
        let why = match &live {
            None => "live check unavailable",
            Some(v) if v["skipped"] == true => "live check inconclusive",
            Some(v) if v["ok"] != true => "live check failed",
            _ => "live check still premium",
        };
        app.db
            .exec(
                "insert into health_log(entry_id,ok,premium,detail) values($1,true,true,$2)",
                vec![
                    id.into(),
                    format!("app report: not_premium (rejected — {why})").into(),
                ],
            )
            .await?;
        return Ok(private(json_response(
            200,
            json!({"ok":true,"id":id,"ignored":"not_premium"}),
        )));
    }
    app.db
        .exec(
            "insert into health_log(entry_id,ok,premium,detail) values($1,$2,$3,$4)",
            vec![
                id.into(),
                (report != "dead").into(),
                (report != "not_premium").into(),
                format!("app report: {report}").into(),
            ],
        )
        .await?;
    let mut replacement = Value::Null;
    let mut encryption = "client-key";
    if entry["kind"] == "account"
        && let Some(key) = identity.id
        && pool::is_service(&string(entry, "service"))
    {
        let released = app
            .db
            .exec(
                "delete from api_key_leases where key_id=$1 and entry_id=$2",
                vec![key.into(), id.into()],
            )
            .await?
            > 0;
        if released {
            let v2 = ctx
                .header("x-pool-client")
                .trim()
                .eq_ignore_ascii_case("v2");
            encryption = if v2 { "read-key" } else { "client-key" };
            if let Some(read) = presented
                && (v2 || app.config.client_key.is_some())
            {
                let service = string(entry, "service");
                let bucket = format!(
                    "report-replacement-key:{}:{service}",
                    &hash.as_ref().unwrap()[..16]
                );
                if app
                    .rates
                    .check(&bucket, 3, Duration::from_secs(3600))
                    .await
                    .is_none()
                {
                    let client = v2.then(|| crypto::derive_client_key(read));
                    if let Some(p) =
                        pool::leases::replacement(app, &service, key, id, client.as_ref()).await?
                    {
                        replacement = json!({service:{"accounts":[p]}});
                    }
                }
            }
        }
    }
    snapshot::invalidate(app).await;
    Ok(private(json_response(
        200,
        json!({"ok":true,"id":id,"encrypted":true,"encryption":encryption,"replacement":replacement}),
    )))
}
