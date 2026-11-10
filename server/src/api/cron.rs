use super::*;
use crate::{
    health::{sweep, sync},
    snapshot,
};

pub fn parse_int(raw: &str) -> Option<i64> {
    let s = raw.trim_start();
    let (negative, s) = if let Some(v) = s.strip_prefix('-') {
        (true, v)
    } else {
        (false, s.strip_prefix('+').unwrap_or(s))
    };
    let digits = s
        .chars()
        .take_while(char::is_ascii_digit)
        .collect::<String>();
    let n = digits.parse::<i64>().ok()?;
    Some(if negative { -n } else { n })
}
pub async fn route(app: &Arc<App>, ctx: &Context, route: &str) -> db::Result<Response> {
    if !auth::cron_token(app, ctx) {
        return Ok(error(401, "unauthorized"));
    }
    if route == "/api/cron/health" {
        let limit = ctx
            .query
            .get("batch")
            .map(|s| parse_int(s).filter(|n| *n > 0).unwrap_or(8).min(10) as usize);
        let mut summary = sweep::run_sweep(
            app,
            false,
            limit,
            ctx.query.get("cursor").map(String::as_str),
        )
        .await?;
        app.cache.invalidate("status").await;
        if summary["done"] == true {
            let _ = snapshot::write(app).await;
            app.cache.invalidate("snapshot:").await;
            app.cache.invalidate("discovery:").await;
        }
        summary["ok"] = json!(true);
        summary["ranAt"] = json!(now());
        return Ok(json_response(200, summary));
    }
    if route == "/api/cron/purge-dead" {
        let holder = crate::crypto::random_hex(16);
        let rows=app.db.rows("with claimed as(insert into job_locks(name,holder,expires_at) values('purge-dead',$1,now()+interval '5 minutes') on conflict(name) do update set holder=excluded.holder,expires_at=excluded.expires_at where job_locks.expires_at<=now() returning holder),accounts as(update account_entries e set removed=true where exists(select 1 from claimed) and removed=false and (status='dead' or disabled=true) and created_at<now()-interval '7 days' and not exists(select 1 from health_log h where h.entry_id=e.id and h.ok and h.premium and h.checked_at>now()-interval '7 days' and (h.detail is null or h.detail not like 'app report%')) returning id),instances as(update instance_entries e set removed=true where exists(select 1 from claimed) and removed=false and (status='dead' or disabled=true) and created_at<now()-interval '7 days' and not exists(select 1 from health_log h where h.entry_id=e.id and h.ok and h.premium and h.checked_at>now()-interval '7 days' and (h.detail is null or h.detail not like 'app report%')) returning id) select id,'account' as kind,true as claimed from accounts union all select id,'api',true from instances union all select null,null,exists(select 1 from claimed)",vec![holder.clone().into()]).await?;
        let locked = rows.last().is_some_and(|r| r["claimed"] == false);
        let entries = rows
            .iter()
            .filter(|r| !r["id"].is_null())
            .cloned()
            .collect::<Vec<_>>();
        let accounts = admin::ids(&entries, "account");
        let instances = admin::ids(&entries, "api");
        if !locked {
            let detail = json!({"removed":entries.len(),"graceDays":7,"source":"cron","accountIds":accounts,"instanceIds":instances});
            app.db.exec("with logged as(insert into audit_log(action,target,actor_label,detail,ip_address) values('entry.purge_dead','entries','cron',$1,$2)) delete from job_locks where name='purge-dead' and holder=$3",vec![detail.into(),ctx.ip().into(),holder.into()]).await?;
        }
        if !entries.is_empty() {
            snapshot::invalidate(app).await;
            if !instances.is_empty() {
                let _ = snapshot::write(app).await;
            }
        }
        let mut body = json!({"ok":true,"removed":entries.len(),"removedAccounts":accounts.len(),"removedInstances":instances.len(),"graceDays":7,"ranAt":now()});
        if locked {
            body["locked"] = json!(true);
        }
        return Ok(json_response(200, body));
    }
    if ctx.query.get("publish").is_some_and(|s| s == "1") {
        let _ = snapshot::write(app).await;
        snapshot::invalidate(app).await;
        return Ok(json_response(
            200,
            json!({"ok":true,"published":true,"ranAt":now()}),
        ));
    }
    if let Some(feed) = ctx.query.get("feed") {
        let (service, note, urls) = match feed.as_str() {
            "monochrome" => ("tidal", "monochrome", sync::fetch_monochrome(app).await?),
            "spotiflac-tidal" => (
                "tidal",
                "spotiflac",
                sync::TIDAL_SEEDS.iter().map(|s| s.to_string()).collect(),
            ),
            "spotiflac-qobuz" => (
                "qobuz",
                "spotiflac",
                sync::QOBUZ_SEEDS.iter().map(|s| s.to_string()).collect(),
            ),
            _ => {
                return Ok(json_response(
                    400,
                    json!({"error":"unknown feed","feeds":["monochrome","spotiflac-tidal","spotiflac-qobuz"]}),
                ));
            }
        };
        let limit = ctx
            .query
            .get("limit")
            .and_then(|s| parse_int(s))
            .unwrap_or(8)
            .clamp(1, 10) as usize;
        let mut body = sync::sync_urls(
            app,
            service,
            urls,
            note,
            ctx.query.get("after").map(String::as_str),
            Some(limit),
            limit,
        )
        .await?;
        body["ok"] = json!(true);
        body["feed"] = json!(feed);
        body["ranAt"] = json!(now());
        return Ok(json_response(200, body));
    }
    let monochrome = sync::monochrome(app, 12)
        .await
        .unwrap_or(json!({"error":"Instance sync unavailable."}));
    let spotiflac = sync::spotiflac(app, 12)
        .await
        .unwrap_or(json!({"error":"Instance sync unavailable."}));
    let ok = monochrome.get("error").is_none() || spotiflac.get("error").is_none();
    let _ = snapshot::write(app).await;
    snapshot::invalidate(app).await;
    Ok(json_response(
        if ok { 200 } else { 500 },
        json!({"ok":ok,"monochrome":monochrome,"spotiflac":spotiflac,"ranAt":now()}),
    ))
}
