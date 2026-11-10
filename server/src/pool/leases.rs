use super::SERVICES;
use crate::{
    App,
    api::{integer, string},
    crypto, db, health,
};
use futures_util::{StreamExt, stream};
use serde_json::{Map, Value, json};
use std::collections::HashMap;
pub const SERVABLE: &str = "removed=false and disabled=false and status in ('alive','preview') and (expires_at is null or expires_at>now())";
pub fn leased(
    app: &App,
    row: &Value,
    override_payload: Option<&Value>,
    client_key: Option<&[u8; 32]>,
) -> db::Result<Value> {
    let mut p = override_payload
        .cloned()
        .unwrap_or_else(|| crypto::decrypt(&row["payload"], app.config.encryption_key.as_ref()));
    if let Some(o) = p.as_object_mut() {
        o.remove("password");
    }
    let p = crypto::encrypt(&p, client_key.or(app.config.client_key.as_ref()))?;
    let mut out = json!({"id":row["id"],"premium":row["premium"],"status":row["status"],"latencyMs":row["latency_ms"],"lastCheckedAt":row["last_checked_at"]});
    if let (Some(out), Some(p)) = (out.as_object_mut(), p.as_object()) {
        for (k, v) in p {
            out.insert(k.clone(), v.clone());
        }
    }
    Ok(out)
}
pub async fn stamp(app: &App, table: &str, ids: &[i32], key_id: Option<i32>) {
    if ids.is_empty() {
        return;
    }
    let table = if table == "account_entries" {
        "account_entries"
    } else {
        "instance_entries"
    };
    let sql = if table == "account_entries" && key_id.is_some() {
        format!(
            "with stamped as(update {table} t set last_leased_at=now()+(v.ordinality-1)*interval '1 millisecond' from unnest($1::int[]) with ordinality as v(id,ordinality) where t.id=v.id returning t.id,t.service) insert into api_key_leases(key_id,entry_id,service,leased_at) select $2,id,service,now() from stamped on conflict(key_id,entry_id) do update set service=excluded.service,leased_at=excluded.leased_at"
        )
    } else {
        format!(
            "update {table} t set last_leased_at=now()+(v.ordinality-1)*interval '1 millisecond' from unnest($1::int[]) with ordinality as v(id,ordinality) where t.id=v.id"
        )
    };
    let mut args = vec![ids.to_vec().into()];
    if table == "account_entries" && key_id.is_some() {
        args.push(key_id.into());
    }
    let _ = app.db.exec(&sql, args).await;
}
pub async fn accounts(
    app: &App,
    key: Option<i32>,
    scope: Option<&str>,
    client: Option<&[u8; 32]>,
) -> db::Result<Value> {
    let sql = "with ranked as (select a.id,a.service,a.fingerprint,a.premium,a.status,a.latency_ms,a.last_checked_at,a.payload,row_number() over(partition by a.service order by (l.key_id is not null) desc,a.premium desc,a.last_leased_at asc nulls first,a.id asc) as rank from account_entries a left join api_key_leases l on l.entry_id=a.id and l.key_id=$1 and l.leased_at>now()-interval '72 hours' where a.removed=false and a.disabled=false and a.status in ('alive','preview') and (a.expires_at is null or a.expires_at>now()) and ($2::text is null or a.service=$2)) select * from ranked where rank<=case when service='tidal' then 6 else 3 end order by service,rank";
    let rows = app
        .db
        .rows(sql, vec![key.into(), scope.map(str::to_owned).into()])
        .await?;
    let tidal = rows
        .iter()
        .filter(|r| r["service"] == "tidal")
        .cloned()
        .collect::<Vec<_>>();
    let outcomes = stream::iter(tidal.into_iter().map(|row| async move {
        let p = crypto::decrypt(&row["payload"], app.config.encryption_key.as_ref());
        let fresh = health::fresh_tidal(app, &string(&row, "fingerprint"), &p).await;
        (integer(&row, "id"), fresh)
    }))
    .buffer_unordered(3)
    .collect::<Vec<_>>()
    .await;
    let fresh = outcomes.into_iter().collect::<HashMap<_, _>>();
    let mut out = Map::new();
    let mut ids = vec![];
    for service in SERVICES {
        let mut group = vec![];
        for row in rows.iter().filter(|r| r["service"] == *service) {
            if group.len() == 3 {
                break;
            }
            let id = integer(row, "id");
            let payload = if *service == "tidal" {
                let Some(Some(p)) = fresh.get(&id) else {
                    continue;
                };
                Some(p)
            } else {
                None
            };
            group.push(leased(app, row, payload, client)?);
            ids.push(id);
        }
        out.insert((*service).into(), json!(group));
    }
    stamp(app, "account_entries", &ids, key).await;
    Ok(Value::Object(out))
}
pub async fn instances(
    app: &App,
    scope: Option<&str>,
    client: Option<&[u8; 32]>,
) -> db::Result<Value> {
    let sql = format!(
        "with ranked as(select *,row_number() over(partition by service order by premium desc,last_leased_at asc nulls first,id asc) as rank from instance_entries where {SERVABLE} and ($1::text is null or service=$1)) select * from ranked where rank<=10 order by service,rank"
    );
    let rows = app
        .db
        .rows(&sql, vec![scope.map(str::to_owned).into()])
        .await?;
    let mut out = Map::new();
    let mut ids = vec![];
    for s in SERVICES {
        let mut group = vec![];
        for row in rows.iter().filter(|r| r["service"] == *s) {
            group.push(leased(app, row, None, client)?);
            ids.push(integer(row, "id"));
        }
        out.insert((*s).into(), json!(group));
    }
    stamp(app, "instance_entries", &ids, None).await;
    Ok(Value::Object(out))
}
pub async fn replacement(
    app: &App,
    service: &str,
    key: i32,
    exclude: i32,
    client: Option<&[u8; 32]>,
) -> db::Result<Option<Value>> {
    let sql = format!(
        "select * from account_entries a where {SERVABLE} and service=$1 and id<>$2 and not exists(select 1 from api_key_leases l where l.key_id=$3 and l.entry_id=a.id and l.leased_at>now()-interval '72 hours') order by premium desc,last_leased_at asc nulls first,id asc limit 1"
    );
    let row = app
        .db
        .one(&sql, vec![service.into(), exclude.into(), key.into()])
        .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    stamp(app, "account_entries", &[integer(&row, "id")], Some(key)).await;
    leased(app, &row, None, client).map(Some)
}
pub async fn discovery(app: &App, service: Option<&str>) -> db::Result<Value> {
    let sql = format!(
        "select service,payload from instance_entries where {SERVABLE} and ($1::text is null or service=$1) order by premium desc,last_checked_at desc"
    );
    let rows = app
        .db
        .rows(&sql, vec![service.map(str::to_owned).into()])
        .await?;
    let mut all = Map::new();
    for s in SERVICES {
        let mut urls = vec![];
        let mut seen = std::collections::HashSet::new();
        for row in rows.iter().filter(|r| r["service"] == *s) {
            let url = string(&row["payload"], "baseUrl").trim().to_owned();
            if !url.is_empty() && seen.insert(url.clone()) {
                urls.push(url);
            }
        }
        all.insert((*s).into(), json!({"streaming":urls,"api":urls}));
    }
    Ok(if let Some(service) = service {
        all.remove(service)
            .unwrap_or(json!({"streaming":[],"api":[]}))
    } else {
        Value::Object(all)
    })
}
