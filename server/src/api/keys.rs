use super::*;
use crate::{
    api::auth::{self, Actor},
    crypto,
    db::{camel_row, query, rows},
};
pub fn generate_key() -> (String, String, String) {
    let key = format!("atp_{}", crypto::random_hex(24));
    let hash = hex::encode(crypto::sha256(&key));
    let prefix = key[..10].to_owned();
    (key, hash, prefix)
}
fn trim(v: &Value, k: &str, n: usize) -> String {
    string(v, k).trim().chars().take(n).collect()
}
pub async fn audit(
    app: &App,
    ctx: &Context,
    actor: &Actor,
    action: &str,
    target: &str,
    detail: Value,
) {
    let _=app.db.exec("insert into audit_log(action,target,actor_user_id,actor_label,detail,ip_address) values($1,$2,$3,$4,$5,$6)",vec![action.into(),target.into(),actor.user_id.into(),actor.label.clone().into(),detail.into(),ctx.ip().into()]).await;
}
pub async fn user_route(app: &Arc<App>, ctx: &Context, route: &str) -> db::Result<Response> {
    let Some(user) = auth::session(app, ctx).await? else {
        return Ok(error(401, "unauthorized"));
    };
    let user_id = integer(&user, "id");
    if route == "/api/keys" && ctx.method == "GET" {
        let keys=app.db.rows("select id,name,reason,prefix,revoked,use_count,last_used_at,created_at from api_keys where user_id=$1 and deleted=false order by created_at desc",vec![user_id.into()]);
        let requests=app.db.rows("select id,subject,reason,status,ip_address,user_agent,resulting_key_id,review_note,created_at,reviewed_at from api_key_requests where user_id=$1 order by created_at desc",vec![user_id.into()]);
        let (keys, requests) = tokio::join!(keys, requests);
        return Ok(match (keys, requests) {
            (Ok(k), Ok(r)) => private(json_response(
                200,
                json!({"keys":k.iter().map(camel_row).collect::<Vec<_>>(),"requests":r.iter().map(camel_row).collect::<Vec<_>>()}),
            )),
            _ => detail(
                500,
                "internal_error",
                "Could not load your keys. Please try again shortly.",
            ),
        });
    }
    if route == "/api/keys" {
        let body = ctx.json().unwrap_or(json!({}));
        let subject = if body["subject"].is_null() {
            trim(&body, "name", 64)
        } else {
            trim(&body, "subject", 64)
        };
        let reason = trim(&body, "reason", 500);
        if subject.is_empty() {
            return Ok(detail(400, "invalid_input", "Subject is required."));
        }
        if reason.chars().count() < 10 {
            return Ok(detail(
                400,
                "invalid_input",
                "Reason must be at least 10 characters.",
            ));
        }
        if !ctx.ip().is_empty() && !ctx.ua().is_empty() {
            let recent=app.db.one("select count(*)::int as n from api_key_requests where ip_address=$1 and user_agent=$2 and created_at>now()-interval '30 days' and status<>'rejected'",vec![ctx.ip().into(),ctx.ua().into()]).await?.ok_or(db::Error)?;
            if integer(&recent, "n") >= 1 {
                return Ok(private(with_headers(
                    detail(
                        429,
                        "rate_limited",
                        "One request per device/network. You already have a pending or recent request.",
                    ),
                    &[("retry-after", "86400")],
                )));
            }
        }
        let n=app.db.one("select count(*)::int as n from api_keys where user_id=$1 and deleted=false and revoked=false",vec![user_id.into()]).await;
        let Ok(Some(n)) = n else {
            return Ok(detail(
                500,
                "internal_error",
                "Could not save the request. Please try again shortly.",
            ));
        };
        if integer(&n, "n") >= 10 {
            return Ok(detail(
                409,
                "key_limit",
                "At most 10 active keys per account.",
            ));
        }
        let service = trim(&body, "requestedService", 32);
        let nullable = |k, n| {
            let s = trim(&body, k, n);
            (!s.is_empty()).then_some(s)
        };
        let row=app.db.one("insert into api_key_requests(user_id,subject,reason,ip_address,user_agent,requested_service,discord_id,telegram_id,contact_note) values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id",vec![user_id.into(),subject.into(),reason.into(),ctx.ip().into(),ctx.ua().into(),crate::pool::is_service(&service).then_some(service).into(),nullable("discordId",64).into(),nullable("telegramId",64).into(),nullable("contactNote",500).into()]).await;
        return Ok(match row {
            Ok(Some(r)) => private(json_response(200, json!({"id":r["id"],"status":"pending"}))),
            _ => detail(
                500,
                "internal_error",
                "Could not save the request. Please try again shortly.",
            ),
        });
    }
    let Some(id) = ctx.params.get("id").and_then(|s| crypto::parse_int(s)) else {
        return Ok(error(400, "invalid_id"));
    };
    if route == "/api/keys/{id}" {
        let delete = ctx.query.get("delete").is_some_and(|s| s == "1");
        let revoked = !ctx.query.get("undo").is_some_and(|s| s == "1");
        let changed = if delete {
            app.db
                .exec(
                    "delete from api_keys where id=$1 and user_id=$2",
                    vec![id.into(), user_id.into()],
                )
                .await
        } else {
            app.db
                .exec(
                    "update api_keys set revoked=$1 where id=$2 and user_id=$3",
                    vec![revoked.into(), id.into(), user_id.into()],
                )
                .await
        };
        return Ok(match changed {
            Ok(0) => error(404, "not_found"),
            Ok(_) => json_response(
                200,
                if delete {
                    json!({"ok":true,"deleted":true})
                } else {
                    json!({"ok":true,"revoked":revoked})
                },
            ),
            Err(_) => detail(
                500,
                "internal_error",
                "Could not change that key. Try again shortly.",
            ),
        });
    }
    let result = claim_key(app, user_id, id).await;
    Ok(match result {
        Ok(Claim::Created(r)) => private(json_response(200, r)),
        Ok(Claim::Denied(code)) => detail(
            if code == "key_limit" { 409 } else { 400 },
            code,
            match code {
                "not_found" => "That request does not exist.",
                "not_approved" => "That request has not been approved yet.",
                "already_claimed" => {
                    "You already revealed the key for this request. Create a new request for another key."
                }
                _ => "You have reached the active-key limit for your account. Revoke a key first.",
            },
        ),
        Err(_) => detail(
            500,
            "internal_error",
            "Could not issue your key. Please try again shortly.",
        ),
    })
}
pub enum Claim {
    Created(Value),
    Denied(&'static str),
}
pub async fn claim_key(app: &App, user_id: i32, id: i64) -> db::Result<Claim> {
    app.db.ensure().await?;
    let mut tx = app.db.pool()?.begin().await?;
    rows(
        &mut *tx,
        "select id from users where id=$1 limit 1 for update",
        vec![user_id.into()],
    )
    .await?;
    let requests=rows(&mut *tx,"select subject,reason,status,resulting_key_id,requested_service from api_key_requests where id=$1 and user_id=$2 limit 1 for update",vec![id.into(),user_id.into()]).await?;
    let Some(req) = requests.first() else {
        return Ok(Claim::Denied("not_found"));
    };
    if req["status"] != "approved" {
        return Ok(Claim::Denied("not_approved"));
    }
    if !req["resulting_key_id"].is_null() {
        return Ok(Claim::Denied("already_claimed"));
    }
    let counts=rows(&mut *tx,"select count(*)::int as n from api_keys where user_id=$1 and revoked=false and deleted=false",vec![user_id.into()]).await?;
    if integer(&counts[0], "n") >= 10 {
        return Ok(Claim::Denied("key_limit"));
    }
    let (key, hash, prefix) = generate_key();
    let created=rows(&mut *tx,"insert into api_keys(name,key_hash,prefix,user_id,reason,service) values($1,$2,$3,$4,$5,$6) returning id",vec![string(req,"subject").into(),hash.into(),prefix.clone().into(),user_id.into(),string(req,"reason").into(),req["requested_service"].as_str().map(str::to_owned).into()]).await?;
    let key_id = integer(&created[0], "id");
    query(
        "update api_key_requests set resulting_key_id=$1 where id=$2",
        vec![key_id.into(), id.into()],
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Claim::Created(
        json!({"ok":true,"id":key_id,"key":key,"prefix":prefix}),
    ))
}
pub async fn admin_route(app: &Arc<App>, ctx: &Context, route: &str) -> db::Result<Response> {
    let Some(actor) = auth::resolve_admin(app, ctx).await else {
        return Ok(error(401, "unauthorized"));
    };
    if route == "/api/admin/keys/{id}" {
        let Some(id) = ctx.params.get("id").and_then(|s| crypto::parse_int(s)) else {
            return Ok(error(400, "invalid_id"));
        };
        let gone = app
            .db
            .exec("delete from api_keys where id=$1", vec![id.into()])
            .await?;
        if gone == 0 {
            return Ok(error(404, "not_found"));
        }
        audit(
            app,
            ctx,
            &actor,
            "key.delete",
            &format!("key:{id}"),
            json!({}),
        )
        .await;
        return Ok(json_response(200, json!({"ok":true,"id":id})));
    }
    if route == "/api/admin/keys/custom" {
        let body = ctx.json().unwrap_or(json!({}));
        let name = trim(&body, "name", 64);
        let name = if name.is_empty() {
            "restored".to_owned()
        } else {
            name
        };
        let value = trim(&body, "value", 1024 * 1024);
        if !value
            .strip_prefix("atp_")
            .is_some_and(|s| s.len() >= 24 && s.bytes().all(|c| c.is_ascii_alphanumeric()))
        {
            return Ok(detail(
                400,
                "invalid_value",
                "Key must start with 'atp_' followed by at least 24 alphanumeric characters.",
            ));
        }
        let hash = hex::encode(crypto::sha256(&value));
        let row=app.db.one("insert into api_keys(name,key_hash,prefix) values($1,$2,$3) on conflict(key_hash) do nothing returning id,prefix",vec![name.into(),hash.into(),value.chars().take(10).collect::<String>().into()]).await?;
        return Ok(match row {
            Some(r) => json_response(200, r),
            None => detail(409, "exists", "A key with this value already exists."),
        });
    }
    if route == "/api/admin/keys" {
        if ctx.method == "GET" {
            let keys=app.db.rows("select k.id,k.name,k.reason,k.prefix,k.revoked,k.deleted,k.use_count,k.last_used_at,k.created_at,u.username as owner from api_keys k left join users u on u.id=k.user_id order by k.created_at desc",vec![]).await?;
            return Ok(json_response(
                200,
                json!({"keys":keys.iter().map(camel_row).collect::<Vec<_>>()}),
            ));
        }
        let Some(body) = ctx.json() else {
            return Ok(error(400, "invalid body"));
        };
        if ctx.method == "PATCH" {
            let id = number(&body["id"]);
            if !id.is_finite() || id == 0. {
                return Ok(error(400, "id required"));
            }
            let revoked = body["revoked"] != false;
            app.db
                .exec(
                    "update api_keys set revoked=$1 where id=$2",
                    vec![revoked.into(), (id as i64).into()],
                )
                .await?;
            audit(
                app,
                ctx,
                &actor,
                if revoked { "key.revoke" } else { "key.restore" },
                &format!("key:{id}"),
                json!({}),
            )
            .await;
            return Ok(json_response(
                200,
                json!({"ok":true,"id":body["id"],"revoked":revoked}),
            ));
        }
        let name = string(&body, "name").trim().to_owned();
        if name.is_empty() {
            return Ok(error(400, "name required"));
        }
        let (key, hash, prefix) = generate_key();
        let row = app
            .db
            .one(
                "insert into api_keys(name,key_hash,prefix) values($1,$2,$3) returning id",
                vec![name.clone().into(), hash.into(), prefix.clone().into()],
            )
            .await?
            .ok_or(db::Error)?;
        let id = integer(&row, "id");
        audit(
            app,
            ctx,
            &actor,
            "key.create",
            &format!("key:{id}"),
            json!({"name":name,"prefix":prefix}),
        )
        .await;
        return Ok(json_response(
            200,
            json!({"ok":true,"id":id,"key":key,"prefix":prefix}),
        ));
    }
    if route == "/api/admin/users" {
        if ctx.method == "GET" {
            let r=app.db.rows("select id,username,role,disabled,created_at,last_login_ip from users order by created_at desc",vec![]).await?;
            return Ok(json_response(
                200,
                json!({"users":r.iter().map(camel_row).collect::<Vec<_>>()}),
            ));
        }
        let Some(body) = ctx.json() else {
            return Ok(error(400, "invalid_body"));
        };
        let n = if body.get("userId").is_none() {
            f64::NAN
        } else {
            number(&body["userId"])
        };
        if !n.is_finite() {
            return Ok(error(400, "userId_required"));
        }
        let role = string(&body, "role");
        if !["admin", "user"].contains(&role.as_str()) {
            return Ok(error(400, "invalid_role"));
        }
        if role == "user" && actor.user_id == Some(n as i32) {
            return Ok(error(400, "cannot_demote_self"));
        }
        let row = app
            .db
            .one(
                "update users set role=$1 where id=$2 returning id,username",
                vec![role.clone().into(), (n as i64).into()],
            )
            .await?;
        let Some(row) = row else {
            return Ok(error(404, "not_found"));
        };
        audit(
            app,
            ctx,
            &actor,
            "user.role_change",
            &format!("user:{n}"),
            json!({"username":row["username"],"role":role}),
        )
        .await;
        return Ok(json_response(
            200,
            json!({"ok":true,"userId":n as i64,"role":role,"username":row["username"]}),
        ));
    }
    if route == "/api/admin/audit" {
        let n = ctx
            .query
            .get("limit")
            .map(|s| number(&json!(s)))
            .unwrap_or(200.);
        let n = if n.is_finite() {
            n.clamp(1., 500.) as i32
        } else {
            200
        };
        let rows=app.db.rows("select id,action,target,actor_user_id,actor_label,detail,ip_address,created_at from audit_log order by created_at desc limit $1",vec![n.into()]).await?;
        return Ok(json_response(
            200,
            json!({"entries":rows.iter().map(camel_row).collect::<Vec<_>>()}),
        ));
    }
    if route == "/api/admin/requests" {
        let r=app.db.rows("select r.id,r.subject,r.reason,r.status,r.ip_address,r.user_agent,r.requested_service,r.discord_id,r.telegram_id,r.contact_note,r.created_at,r.reviewed_at,r.review_note,u.username from api_key_requests r left join users u on u.id=r.user_id order by r.created_at desc",vec![]).await;
        return Ok(private(match r {
            Ok(r) => json_response(200, json!(r.iter().map(camel_row).collect::<Vec<_>>())),
            Err(_) => detail(500, "internal_error", "Could not load requests."),
        }));
    }
    if route == "/api/admin/requests/{id}" {
        let Some(id) = ctx.params.get("id").and_then(|s| crypto::parse_int(s)) else {
            return Ok(error(400, "invalid_id"));
        };
        let body = ctx.json().unwrap_or(json!({}));
        let action = string(&body, "action");
        let note = trim(&body, "note", 500);
        if action == "reject" && note.chars().count() < 10 {
            return Ok(detail(
                400,
                "note_required",
                "Rejection reason must be at least 10 characters.",
            ));
        }
        if !["approve", "reject"].contains(&action.as_str()) {
            return Ok(error(400, "invalid_action"));
        }
        let status = if action == "approve" {
            "approved"
        } else {
            "rejected"
        };
        let r=app.db.one("update api_key_requests set status=$1,reviewed_at=now(),reviewed_by=$2,review_note=case when $1='rejected' then $3 else review_note end where id=$4 and status='pending' returning subject",vec![status.into(),actor.user_id.into(),note.clone().into(),id.into()]).await;
        let row = match r {
            Ok(Some(r)) => r,
            Ok(None) => return Ok(error(404, "not_found_or_not_pending")),
            Err(_) => {
                return Ok(detail(
                    500,
                    "internal_error",
                    "Could not record that decision. Check the database.",
                ));
            }
        };
        audit(
            app,
            ctx,
            &actor,
            &format!("request.{action}"),
            &format!("request:{id}"),
            if action == "approve" {
                json!({"subject":row["subject"]})
            } else {
                json!({"note":note})
            },
        )
        .await;
        return Ok(json_response(
            200,
            if action == "approve" {
                json!({"ok":true,"status":status,"subject":row["subject"]})
            } else {
                json!({"ok":true,"status":status})
            },
        ));
    }
    Ok(empty(404))
}
