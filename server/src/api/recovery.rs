use super::*;
use crate::{
    crypto,
    db::{query, rows},
};
use sqlx::{Postgres, Transaction};

async fn lock_users(
    tx: &mut Transaction<'_, Postgres>,
    first: i32,
    second: i32,
) -> db::Result<Vec<Value>> {
    rows(&mut **tx,"select id,disabled,claimed_by,github_id from users where id=any($1) order by id for update",vec![vec![first,second].into()]).await
}
pub async fn transfer(app: &App, claimer: i32, target: i32, key_hash: &str) -> db::Result<Value> {
    if claimer == target {
        return Ok(json!({"ok":false,"error":"same_account"}));
    }
    app.db.ensure().await?;
    let mut tx = app.db.pool()?.begin().await?;
    let users = lock_users(&mut tx, claimer, target).await?;
    let Some(me) = users.iter().find(|r| r["id"] == claimer) else {
        return Ok(json!({"ok":false,"error":"claimer_gone"}));
    };
    if me["disabled"] == true || !me["claimed_by"].is_null() {
        return Ok(json!({"ok":false,"error":"claimer_not_live"}));
    }
    let proof=rows(&mut *tx,"select user_id,revoked,deleted,key_hash from api_keys where key_hash=$1 limit 1 for update",vec![key_hash.into()]).await?;
    if proof.first().is_none_or(|r| {
        r["user_id"] != target
            || r["deleted"] == true
            || !crypto::secret_matches(&string(r, "key_hash"), key_hash)
    }) {
        return Ok(json!({"ok":false,"error":"proof_failed"}));
    }
    if proof[0]["revoked"] == true {
        return Ok(json!({"ok":false,"error":"proof_revoked"}));
    }
    let moved = move_rows(&mut tx, claimer, target).await?;
    if moved["ok"] == true {
        tx.commit().await?;
    }
    Ok(moved)
}
async fn move_rows(
    tx: &mut Transaction<'_, Postgres>,
    claimer: i32,
    target: i32,
) -> db::Result<Value> {
    let marker=query("update users set claimed_by=$1,disabled=true where id=$2 and claimed_by is null and github_id is null and disabled=false and id<>$1",vec![claimer.into(),target.into()]).execute(&mut **tx).await?.rows_affected();
    if marker == 0 {
        return Ok(json!({"ok":false,"error":"not_claimable"}));
    }
    let keys = query(
        "update api_keys set user_id=$1 where user_id=$2",
        vec![claimer.into(), target.into()],
    )
    .execute(&mut **tx)
    .await?
    .rows_affected();
    let requests = query(
        "update api_key_requests set user_id=$1 where user_id=$2",
        vec![claimer.into(), target.into()],
    )
    .execute(&mut **tx)
    .await?
    .rows_affected();
    Ok(json!({"ok":true,"keys":keys,"requests":requests}))
}
async fn limit(app: &App, bucket: &str, max: i32) -> db::Result<Option<u64>> {
    let row=app.db.one("insert into rate_limit_buckets(bucket,window_start,n) values($1,now(),1) on conflict(bucket) do update set window_start=case when rate_limit_buckets.window_start<now()-interval '10 minutes' then now() else rate_limit_buckets.window_start end,n=case when rate_limit_buckets.window_start<now()-interval '10 minutes' then 1 else rate_limit_buckets.n+1 end returning n,greatest(1,ceil(extract(epoch from window_start+interval '10 minutes'-now())))::int as retry",vec![bucket.into()]).await?.ok_or(db::Error)?;
    Ok((integer(&row, "n") > max).then(|| integer(&row, "retry") as u64))
}
async fn pending(app: &App, me: &Value, username: &str, note: &str) -> db::Result<Option<Value>> {
    let Some(github) = me["github_id"].as_i64() else {
        return Ok(None);
    };
    app.db.one("insert into github_claims(github_id,github_login,username,review_note) values($1,$2,$3,$4) returning id",vec![github.into(),string(me,"github_login").into(),username.into(),note.into()]).await
}
fn review_unavailable() -> Response {
    private(detail(
        400,
        "proof_required",
        "A claim without an API key needs admin review, which is only available to GitHub-linked accounts. Paste one of that account's API keys to recover it instantly.",
    ))
}
async fn claim(app: &Arc<App>, ctx: &Context) -> db::Result<Response> {
    let Some(me) = auth::session(app, ctx).await? else {
        return Ok(private(error(401, "unauthorized")));
    };
    let user = integer(&me, "id");
    for (bucket, max) in [
        (format!("legacy-claim:ip:{}", ctx.ip()), 20),
        (format!("legacy-claim:user:{user}"), 10),
    ] {
        match limit(app, &bucket, max).await {
            Ok(Some(s)) => return Ok(too_many(s, "legacy-claim")),
            Err(_) => return Ok(too_many(600, "legacy-claim")),
            _ => {}
        }
    }
    let Some(body) = ctx.json() else {
        return Ok(private(error(400, "invalid_body")));
    };
    let username = string(&body, "username").trim().to_lowercase();
    if !(3..=24).contains(&username.len())
        || !username
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
    {
        return Ok(private(detail(
            400,
            "invalid_input",
            "Usernames are 3-24 characters: lowercase letters, digits, underscores.",
        )));
    }
    match limit(app, &format!("legacy-claim:name:{username}"), 5).await {
        Ok(Some(s)) => return Ok(too_many(s, "legacy-claim")),
        Err(_) => return Ok(too_many(600, "legacy-claim")),
        _ => {}
    }
    let Some(target) = app
        .db
        .one(
            "select id,disabled,claimed_by,github_id from users where username=$1 limit 1",
            vec![username.clone().into()],
        )
        .await?
        .filter(|r| r["id"] != user)
    else {
        return Ok(private(detail(
            404,
            "not_found",
            "That legacy username is not registered.",
        )));
    };
    if target["disabled"] == true {
        return Ok(private(error(403, "account_disabled")));
    }
    if !target["claimed_by"].is_null() || !target["github_id"].is_null() {
        return Ok(private(detail(
            409,
            "already_claimed",
            "That account is already linked to a sign-in.",
        )));
    }
    let key = string(&body, "apiKey").trim().to_owned();
    if !key.is_empty() {
        let hash = hex::encode(crypto::sha256(&key));
        let target_id = integer(&target, "id");
        let proof=app.db.one("select revoked,key_hash from api_keys where user_id=$1 and key_hash=$2 and deleted=false limit 1",vec![target_id.into(),hash.clone().into()]).await?;
        if proof
            .as_ref()
            .is_none_or(|r| !crypto::secret_matches(&string(r, "key_hash"), &hash))
        {
            return Ok(private(detail(
                403,
                "claim_proof_failed",
                "That key is not one of this account's existing API keys.",
            )));
        }
        let moved = if proof.as_ref().is_some_and(|r| r["revoked"] == true) {
            json!({"ok":false,"error":"proof_revoked"})
        } else {
            transfer(app, user, target_id, &hash).await?
        };
        if moved["ok"] == true {
            let keys = integer(&moved, "keys");
            return Ok(private(json_response(
                200,
                json!({"ok":true,"status":"claimed","transferred":{"keys":keys,"requests":moved["requests"]},"detail":format!("Recovered @{username}: {keys} key{} moved to your account and keep working unchanged.",if keys==1{""}else{"s"})}),
            )));
        }
        let code = string(&moved, "error");
        if code == "proof_revoked" {
            let Some(claim) = pending(
                app,
                &me,
                &username,
                "claimant presented a revoked key — needs manual review",
            )
            .await?
            else {
                return Ok(review_unavailable());
            };
            return Ok(private(json_response(
                200,
                json!({"ok":true,"status":"claim_pending","claimId":claim["id"],"detail":"That key is revoked, so the claim needs admin review instead."}),
            )));
        }
        if code == "proof_failed" {
            return Ok(private(detail(
                403,
                "claim_proof_failed",
                "That key is not one of this account's existing API keys.",
            )));
        }
        if ["claimer_not_live", "claimer_gone"].contains(&code.as_str()) {
            return Ok(private(error(403, "account_disabled")));
        }
        return Ok(private(detail(
            409,
            &code,
            "That account was just claimed elsewhere — it is no longer claimable.",
        )));
    }
    let Some(claim) = pending(app, &me, &username, "").await? else {
        return Ok(review_unavailable());
    };
    Ok(private(json_response(
        200,
        json!({"ok":true,"status":"claim_pending","claimId":claim["id"],"detail":"Claim filed for admin review."}),
    )))
}
pub async fn approve(app: &App, id: i32, reviewer: Option<i32>) -> db::Result<Option<Value>> {
    app.db.ensure().await?;
    let mut tx = app.db.pool()?.begin().await?;
    let claim = rows(
        &mut *tx,
        "select * from github_claims where id=$1 and status='pending' limit 1",
        vec![id.into()],
    )
    .await?;
    let Some(claim) = claim.first() else {
        return Ok(None);
    };
    let github = claim["github_id"].as_i64().ok_or(db::Error)?;
    let mut claimer = rows(
        &mut *tx,
        "select id from users where github_id=$1 limit 1",
        vec![github.into()],
    )
    .await?
    .into_iter()
    .next();
    if claimer.is_none() {
        let mut names = auth::github_names(&string(claim, "github_login"));
        names.push(format!("github_{}", base36(github.unsigned_abs())));
        for name in names {
            claimer=rows(&mut *tx,"insert into users(username,password_hash,github_id,github_login) values($1,'github',$2,$3) on conflict do nothing returning id",vec![name.into(),github.into(),string(claim,"github_login").into()]).await?.into_iter().next();
            if claimer.is_none() {
                claimer = rows(
                    &mut *tx,
                    "select id from users where github_id=$1 limit 1",
                    vec![github.into()],
                )
                .await?
                .into_iter()
                .next();
            }
            if claimer.is_some() {
                break;
            }
        }
    }
    let Some(claimer) = claimer else {
        return Ok(Some(json!({"error":"claimer_gone"})));
    };
    let claimer = integer(&claimer, "id");
    let target = rows(
        &mut *tx,
        "select id from users where username=$1 limit 1",
        vec![string(claim, "username").into()],
    )
    .await?;
    let Some(target) = target.first() else {
        return Ok(Some(json!({"error":"user_gone"})));
    };
    let target = integer(target, "id");
    if target == claimer {
        return Ok(Some(json!({"error":"not_claimable"})));
    }
    let users = lock_users(&mut tx, claimer, target).await?;
    if users
        .iter()
        .find(|r| r["id"] == claimer)
        .is_none_or(|r| r["disabled"] == true || !r["claimed_by"].is_null())
    {
        return Ok(Some(json!({"error":"claimer_gone"})));
    }
    // Lock the decision after the user rows, in the same order as key/request ownership changes.
    let live = rows(
        &mut *tx,
        "select id from github_claims where id=$1 and status='pending' for update",
        vec![id.into()],
    )
    .await?;
    if live.is_empty() {
        return Ok(None);
    }
    let moved = move_rows(&mut tx, claimer, target).await?;
    if moved["ok"] != true {
        return Ok(Some(json!({"error":moved["error"]})));
    }
    query(
        "update github_claims set status='approved',reviewed_at=now(),reviewed_by=$2 where id=$1",
        vec![id.into(), reviewer.into()],
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Some(json!({"username":claim["username"]})))
}
fn base36(mut n: u64) -> String {
    let mut out = Vec::new();
    loop {
        out.push(b"0123456789abcdefghijklmnopqrstuvwxyz"[(n % 36) as usize] as char);
        n /= 36;
        if n == 0 {
            break;
        }
    }
    out.iter().rev().collect()
}
pub async fn route(app: &Arc<App>, ctx: &Context, route: &str) -> db::Result<Response> {
    if route == "/api/auth/claim-legacy" {
        return Ok(claim(app, ctx)
            .await
            .unwrap_or_else(|_| private(error(500, "internal_error"))));
    }
    let Some(actor) = auth::resolve_admin(app, ctx).await else {
        return Ok(error(401, "unauthorized"));
    };
    if route == "/api/admin/claims" {
        let claims=app.db.rows("select * from github_claims where status='pending' order by created_at desc limit 200",vec![]).await?;
        return Ok(json_response(
            200,
            json!({"claims":claims.iter().map(db::camel_row).collect::<Vec<_>>()}),
        ));
    }
    let Some(id) = ctx.params.get("id").and_then(|s| cron::parse_int(s)) else {
        return Ok(error(400, "invalid_id"));
    };
    let id = id as i32;
    let body = ctx.json().unwrap_or(json!({}));
    let note = string(&body, "note")
        .trim()
        .chars()
        .take(500)
        .collect::<String>();
    if body["action"] == "approve" {
        let Some(result) = approve(app, id, actor.user_id).await? else {
            return Ok(error(404, "not_found_or_not_pending"));
        };
        if let Some(code) = result["error"].as_str() {
            return Ok(error(409, code));
        }
        keys::audit(
            app,
            ctx,
            &actor,
            "claim.approve",
            &format!("claim:{id}"),
            json!({"username":result["username"]}),
        )
        .await;
        return Ok(json_response(
            200,
            json!({"ok":true,"status":"approved","username":result["username"]}),
        ));
    }
    if body["action"] == "reject" {
        if note.encode_utf16().count() < 10 {
            return Ok(detail(
                400,
                "note_required",
                "Rejection reason must be at least 10 characters.",
            ));
        }
        if app.db.exec("update github_claims set status='rejected',review_note=$1,reviewed_at=now(),reviewed_by=$2 where id=$3 and status='pending'",vec![note.clone().into(),actor.user_id.into(),id.into()]).await?==0{return Ok(error(404,"not_found_or_not_pending"));}
        keys::audit(
            app,
            ctx,
            &actor,
            "claim.reject",
            &format!("claim:{id}"),
            json!({"note":note}),
        )
        .await;
        return Ok(json_response(200, json!({"ok":true,"status":"rejected"})));
    }
    Ok(error(400, "invalid_action"))
}
