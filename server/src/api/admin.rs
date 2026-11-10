use super::*;
use crate::{health::sweep, snapshot};

pub async fn route(app: &Arc<App>, ctx: &Context, route: &str) -> db::Result<Response> {
    let Some(actor) = auth::resolve_admin(app, ctx).await else {
        return Ok(error(401, "unauthorized"));
    };
    if route == "/api/admin/remove" && ctx.method == "GET" {
        let rows=app.db.rows("select id,service,'account' as kind,label,status,premium,disabled,removed,contributor,consecutive_failures,last_checked_at,detail,latency_ms,check_count,ok_count,created_at from account_entries union all select id,service,'api' as kind,label,status,premium,disabled,removed,contributor,consecutive_failures,last_checked_at,detail,latency_ms,check_count,ok_count,created_at from instance_entries order by id",vec![]).await?;
        return Ok(json_response(
            200,
            json!({"count":rows.len(),"entries":rows.iter().map(db::camel_row).collect::<Vec<_>>()}),
        ));
    }
    if route == "/api/admin/force-check" {
        let (sweep, monochrome) = tokio::try_join!(
            sweep::run_sweep(app, true, None, None),
            crate::health::sync::monochrome(app, 0)
        )?;
        keys::audit(app, ctx, &actor, "entry.force_check", "entries", json!({})).await;
        let _ = snapshot::write(app).await;
        snapshot::invalidate(app).await;
        return Ok(json_response(
            200,
            json!({"ok":true,"sweep":sweep,"monochrome":monochrome,"ranAt":now()}),
        ));
    }
    if route == "/api/admin/purge-dead" {
        let rows=app.db.rows("with accounts as(update account_entries set removed=true where status='dead' and removed=false returning id),instances as(update instance_entries set removed=true where status='dead' and removed=false returning id) select id,'account' as kind from accounts union all select id,'api' as kind from instances",vec![]).await?;
        if !rows.is_empty() {
            keys::audit(app,ctx,&actor,"entry.purge_dead","entries",json!({"removed":rows.len(),"accountIds":ids(&rows,"account"),"instanceIds":ids(&rows,"api")})).await;
            snapshot::invalidate(app).await;
        }
        return Ok(json_response(200, json!({"ok":true,"removed":rows.len()})));
    }
    let Some(body) = ctx.json() else {
        return Ok(error(400, "invalid body"));
    };
    let id = number(&body["id"]);
    if !id.is_finite()
        || route == "/api/admin/purge-entry" && (!body["id"].is_number() || id.fract() != 0.)
        || route == "/api/admin/check-entry" && !body["id"].is_number()
        || route == "/api/admin/remove" && id == 0.
    {
        return Ok(error(400, "id required"));
    }
    let id = id as i32;
    if route == "/api/admin/check-entry" {
        let result = match sweep::check_entry(app, id).await {
            Ok(Some(r)) => r,
            Ok(None) => return Ok(error(404, "not found")),
            Err(_) => {
                return Ok(error(
                    500,
                    if app.config.encryption_key.is_none() {
                        "POOL_ENCRYPTION_KEY is required to process account credentials"
                    } else {
                        "check failed"
                    },
                ));
            }
        };
        snapshot::invalidate(app).await;
        return Ok(json_response(200, json!({"ok":true,"result":result})));
    }
    if route == "/api/admin/remove" {
        let removed = body["action"] != "restore";
        app.db.exec("with accounts as(update account_entries set removed=$1 where id=$2) update instance_entries set removed=$1 where id=$2",vec![removed.into(),id.into()]).await?;
        keys::audit(
            app,
            ctx,
            &actor,
            "entry.remove",
            &format!("entry:{id}"),
            json!({"removed":removed}),
        )
        .await;
        snapshot::invalidate(app).await;
        return Ok(json_response(
            200,
            json!({"ok":true,"id":id,"removed":removed}),
        ));
    }
    let Some(entry) = sweep::find_entry(app, id).await? else {
        return Ok(error(404, "not found"));
    };
    if entry["removed"] != true {
        return Ok(error(
            409,
            "entry is not removed; remove it before purging its payload",
        ));
    }
    let mode = if body["mode"] == "row" {
        "row"
    } else {
        "payload"
    };
    let table = sweep::table(&string(&entry, "kind"));
    let sql = if mode == "row" {
        format!("delete from {table} where id=$1 and removed=true")
    } else {
        format!("update {table} set payload='{{}}'::jsonb where id=$1 and removed=true")
    };
    app.db.exec(&sql, vec![id.into()]).await?;
    keys::audit(
        app,
        ctx,
        &actor,
        "entry.purge",
        &format!("entry:{id}"),
        json!({"mode":mode}),
    )
    .await;
    snapshot::invalidate(app).await;
    let mut out = json!({"ok":true,"id":id,"mode":mode});
    out[if mode == "row" {
        "deleted"
    } else {
        "payloadCleared"
    }] = json!(true);
    Ok(json_response(200, out))
}
pub fn ids(rows: &[Value], kind: &str) -> Vec<Value> {
    rows.iter()
        .filter(|r| r["kind"] == kind)
        .map(|r| r["id"].clone())
        .collect()
}
