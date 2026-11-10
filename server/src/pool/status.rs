use super::CATEGORIES;
use crate::{
    App,
    api::{boolean, integer, string},
    db,
};
use chrono::{DateTime, Datelike, Utc};
use serde_json::{Value, json};
use std::collections::HashMap;
pub async fn history_rows(app: &App) -> db::Result<Vec<Value>> {
    app.db.rows("with entries as(select id,service,'account' as kind from account_entries where removed=false union all select id,service,'api' as kind from instance_entries where removed=false) select e.service,e.kind,to_char(date_trunc('day',h.checked_at at time zone 'utc'),'YYYY-MM-DD') as day,count(*)::int as checks,count(*) filter(where h.ok)::int as ok from health_log h join entries e on e.id=h.entry_id where h.checked_at>=now()-interval '14 days' and (h.detail is null or h.detail not like 'app report%') group by 1,2,3",vec![]).await
}
pub fn history(rows: &[Value]) -> Value {
    let points = |service: Option<&str>, kind: Option<&str>| {
        let mut buckets = HashMap::<String, (i32, i32)>::new();
        for row in rows.iter().filter(|r| {
            service.is_none_or(|s| r["service"] == s) && kind.is_none_or(|k| r["kind"] == k)
        }) {
            let b = buckets.entry(string(row, "day")).or_default();
            b.0 += integer(row, "checks");
            b.1 += integer(row, "ok");
        }
        let today = Utc::now().date_naive();
        (0..14).map(|i|{let date=today-chrono::Duration::days(13-i);let day=date.format("%Y-%m-%d").to_string();let (checks,ok)=buckets.get(&day).copied().unwrap_or_default();json!({"day":day,"label":format!("{} {}",date.day(),date.format("%b")),"partial":i==13,"checks":checks,"ok":ok,"pct":if checks>0{Some((ok as f64/checks as f64*1000.).round()/10.)}else{None}})}).collect::<Vec<_>>()
    };
    json!({"days":14,"overall":points(None,None),"categories":CATEGORIES.iter().map(|(s,k,_)|json!({"service":s,"kind":k,"points":points(Some(s),Some(k))})).collect::<Vec<_>>()})
}
pub fn categories(rows: &[Value], history: &[Value]) -> Value {
    json!(CATEGORIES.iter().map(|(service,kind,label)|{let items=rows.iter().filter(|r|r["service"]==*service&&r["kind"]==*kind).collect::<Vec<_>>();let alive=items.iter().filter(|r|!boolean(r,"disabled")&&["alive","preview"].contains(&string(r,"status").as_str())).count();let premium=items.iter().filter(|r|!boolean(r,"disabled")&&r["status"]=="alive"&&r["premium"]==true).count();let dead=items.iter().filter(|r|r["status"]=="dead").count();let pending=items.iter().filter(|r|r["status"]=="pending").count();let mut checks=0;let mut ok=0;for r in history.iter().filter(|r|r["service"]==*service&&r["kind"]==*kind){checks+=integer(r,"checks");ok+=integer(r,"ok");}
        let latest=items.iter().filter_map(|r|r["last_checked_at"].as_str()).filter_map(|s|DateTime::parse_from_rfc3339(s).ok()).max_by_key(|d|d.format("%a %b %d %Y %H:%M:%S GMT+0000 (Coordinated Universal Time)").to_string()).map(|d|d.to_rfc3339_opts(chrono::SecondsFormat::Millis,true));
        json!({"service":service,"kind":kind,"label":label,"total":items.len(),"alive":alive,"premium":premium,"dead":dead,"pending":pending,"uptimePct":if checks>0{Some((ok as f64/checks as f64*1000.).round()/10.)}else{None},"lastCheckedAt":latest,"health":if items.is_empty(){"unknown"}else if premium>0&&alive>0{"operational"}else if alive>0{"degraded"}else{"down"}})
    }).collect::<Vec<_>>())
}
pub async fn payload(app: &App) -> db::Result<Value> {
    let rows=app.db.rows("select service,status,premium,disabled,last_checked_at,'account' as kind from account_entries where removed=false union all select service,status,premium,disabled,last_checked_at,'api' as kind from instance_entries where removed=false",vec![]).await?;
    let history = history_rows(app).await.unwrap_or_default();
    let categories = categories(&rows, &history);
    Ok(
        json!({"generatedAt":crate::api::now(),"categories":categories,"history":self::history(&history)}),
    )
}
