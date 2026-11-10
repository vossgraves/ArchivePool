use super::*;
use crate::{
    crypto, health, pool,
    test_support::{Mock, response_json},
};
use tower::ServiceExt;

async fn call(
    app: &Arc<App>,
    method: &str,
    path: &str,
    body: Value,
    cookie: &str,
    token: &str,
) -> Response {
    let mut req = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json")
        .header("user-agent", "local-regression")
        .header("x-forwarded-for", "192.0.2.25");
    if !cookie.is_empty() {
        req = req.header("cookie", cookie);
    }
    if !token.is_empty() {
        req = req
            .header("authorization", format!("Bearer {token}"))
            .header("x-pool-client", "v2");
    }
    router(app.clone())
        .oneshot(
            req.body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap()
}
#[tokio::test]
async fn database_routes_keys_reports_moderation_recovery_and_sync() {
    let mock = Mock::fixed(200, "lossless").await;
    let Some(mut app) = mock.database_app().await else {
        eprintln!("database route tests skipped: set local TEST_DATABASE_URL");
        return;
    };
    app.config.admin_token = "local-admin".into();
    app.config.cron_secret = "local-cron".into();
    let app = Arc::new(app);
    let signup = call(
        &app,
        "POST",
        "/api/auth/signup",
        json!({"username":"listener","password":"long-test-password"}),
        "",
        "",
    )
    .await;
    assert_eq!(signup.status().as_u16(), 200);
    let cookie = signup.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    assert!(
        signup.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .contains("HttpOnly; SameSite=Lax")
    );
    assert_eq!(response_json(signup).await, json!({"username":"listener"}));
    assert_eq!(
        response_json(call(&app, "GET", "/api/auth/me", json!({}), &cookie, "").await).await,
        json!({"username":"listener"})
    );
    let req=call(&app,"POST","/api/keys",json!({"subject":"client app","reason":"Regression read key request","requestedService":"amazon-music"}),&cookie,"").await;
    assert_eq!(req.status().as_u16(), 200);
    let request = response_json(req).await;
    let request_id = integer(&request, "id");
    let approve = call(
        &app,
        "POST",
        &format!("/api/admin/requests/{request_id}"),
        json!({"action":"approve"}),
        "",
        "local-admin",
    )
    .await;
    assert_eq!(approve.status().as_u16(), 200);
    let key = call(
        &app,
        "POST",
        &format!("/api/requests/{request_id}/claim"),
        json!({}),
        &cookie,
        "",
    )
    .await;
    assert_eq!(key.status().as_u16(), 200);
    let key = response_json(key).await;
    let read = string(&key, "key");
    let key_id = integer(&key, "id");
    assert!(read.starts_with("atp_"));
    let again = call(
        &app,
        "POST",
        &format!("/api/requests/{request_id}/claim"),
        json!({}),
        &cookie,
        "",
    )
    .await;
    assert_eq!(again.status().as_u16(), 400);
    assert_eq!(response_json(again).await["error"], "already_claimed");
    let p = json!({"session":"0123456789abcdef","premium":true,"password":"never-delivered"});
    for i in 0..7 {
        let mut p = p.clone();
        p["session"] = json!(format!("0123456789abcdef-{i}"));
        health::sweep::ingest(&app, "amazon-music", "account", &p, None, None)
            .await
            .unwrap();
    }
    app.db.take_statements();
    let feed = call(&app, "GET", "/api/accounts", json!({}), "", &read).await;
    assert_eq!(feed.status().as_u16(), 200);
    assert_eq!(feed.headers()["cache-control"], "private, no-store");
    assert_eq!(feed.headers()["access-control-allow-origin"], "*");
    let feed = response_json(feed).await;
    assert_eq!(feed["version"], 2);
    assert_eq!(
        feed["amazon-music"]["accounts"].as_array().unwrap().len(),
        3
    );
    assert_eq!(feed["tidal"]["accounts"], json!([]));
    let first = feed["amazon-music"]["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| integer(r, "id"))
        .collect::<Vec<_>>();
    for p in feed["amazon-music"]["accounts"].as_array().unwrap() {
        assert!(p.get("password").is_none());
        assert!(p["session"].as_str().unwrap().starts_with("enc:1:"));
        assert!(
            crypto::decrypt(p, Some(&crypto::derive_client_key(&read)))["session"]
                .as_str()
                .unwrap()
                .starts_with("0123456789abcdef")
        );
    }
    assert!(app.db.take_statements().len() <= 4);
    let second =
        response_json(call(&app, "GET", "/api/accounts", json!({}), "", &read).await).await;
    assert_eq!(
        first,
        second["amazon-music"]["accounts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| integer(r, "id"))
            .collect::<Vec<_>>()
    );
    let report = call(
        &app,
        "POST",
        "/api/report",
        json!({"id":first[0],"report":"dead","service":"tidal"}),
        "",
        &read,
    )
    .await;
    assert_eq!(report.status().as_u16(), 200);
    let report = response_json(report).await;
    assert_eq!(report["encryption"], "read-key");
    assert_eq!(
        report["replacement"]["amazon-music"]["accounts"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        health::sweep::find_entry(&app, first[0])
            .await
            .unwrap()
            .unwrap()["status"],
        "alive"
    );
    let ignored = response_json(
        call(
            &app,
            "POST",
            "/api/report",
            json!({"id":first[1],"report":"not_premium"}),
            "",
            &read,
        )
        .await,
    )
    .await;
    assert_eq!(ignored["ignored"], "not_premium");
    assert!(mock.requests.lock().unwrap().is_empty());
    app.db
        .exec(
            "update account_entries set status='dead',last_checked_at=now() where id=$1",
            vec![first[0].into()],
        )
        .await
        .unwrap();
    for _ in 0..3 {
        assert_eq!(
            call(
                &app,
                "POST",
                "/api/report",
                json!({"id":first[0],"report":"dead"}),
                "",
                ""
            )
            .await
            .status()
            .as_u16(),
            200
        );
    }
    let parked = health::sweep::find_entry(&app, first[0])
        .await
        .unwrap()
        .unwrap();
    assert_eq!(parked["status"], "pending");
    assert_eq!(parked["disabled"], true);
    assert_eq!(parked["consecutive_failures"], 3);
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/admin/purge-entry",
            json!({"id":first[0]}),
            "",
            "local-admin"
        )
        .await
        .status()
        .as_u16(),
        409
    );
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/admin/remove",
            json!({"id":first[0]}),
            "",
            "local-admin"
        )
        .await
        .status()
        .as_u16(),
        200
    );
    assert_eq!(
        call(
            &app,
            "POST",
            "/api/admin/purge-entry",
            json!({"id":first[0]}),
            "",
            "local-admin"
        )
        .await
        .status()
        .as_u16(),
        200
    );
    assert_eq!(
        health::sweep::find_entry(&app, first[0])
            .await
            .unwrap()
            .unwrap()["payload"],
        json!({})
    );
    let admin = response_json(
        call(
            &app,
            "GET",
            "/api/admin/remove",
            json!({}),
            "",
            "local-admin",
        )
        .await,
    )
    .await;
    assert!(!admin.to_string().contains("never-delivered"));
    assert!(
        admin["entries"]
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r.get("payload").is_none())
    );
    let legacy = app
        .db
        .one(
            "insert into users(username,password_hash) values('legacy','github') returning id",
            vec![],
        )
        .await
        .unwrap()
        .unwrap();
    let legacy_id = integer(&legacy, "id");
    let owner = app
        .db
        .one("select id from users where username='listener'", vec![])
        .await
        .unwrap()
        .unwrap();
    let owner = integer(&owner, "id");
    let proof = "atp_legacy-proof-local";
    let proof_hash = hex::encode(crypto::sha256(proof));
    app.db.exec("insert into api_keys(name,key_hash,prefix,user_id) values('legacy',$1,'atp_legacy',$2)",vec![proof_hash.clone().into(),legacy_id.into()]).await.unwrap();
    let moved = call(
        &app,
        "POST",
        "/api/auth/claim-legacy",
        json!({"username":"legacy","apiKey":proof}),
        &cookie,
        "",
    )
    .await;
    assert_eq!(moved.status().as_u16(), 200);
    assert_eq!(response_json(moved).await["transferred"]["keys"], 1);
    assert_eq!(
        app.db
            .one(
                "select user_id from api_keys where key_hash=$1",
                vec![proof_hash.into()]
            )
            .await
            .unwrap()
            .unwrap()["user_id"],
        owner
    );
    assert_eq!(
        app.db
            .one(
                "select claimed_by,disabled from users where id=$1",
                vec![legacy_id.into()]
            )
            .await
            .unwrap()
            .unwrap(),
        json!({"claimed_by":owner,"disabled":true})
    );
    let legacy2 = app
        .db
        .one(
            "insert into users(username,password_hash) values('legacy2','github') returning id",
            vec![],
        )
        .await
        .unwrap()
        .unwrap();
    let legacy2 = integer(&legacy2, "id");
    let (hash, _, _) = keys::generate_key();
    let hash = hex::encode(crypto::sha256(hash));
    app.db.exec("insert into api_keys(name,key_hash,prefix,user_id,revoked) values('revoked',$1,'atp_revoked',$2,true)",vec![hash.clone().into(),legacy2.into()]).await.unwrap();
    assert_eq!(
        recovery::transfer(&app, owner, legacy2, &hash)
            .await
            .unwrap()["error"],
        "proof_revoked"
    );
    let claim=app.db.one("insert into github_claims(github_id,github_login,username) values(12345,'ghlistener','legacy2') returning id",vec![]).await.unwrap().unwrap();
    let claim_id = integer(&claim, "id");
    let approved = call(
        &app,
        "POST",
        &format!("/api/admin/claims/{claim_id}"),
        json!({"action":"approve"}),
        "",
        "local-admin",
    )
    .await;
    assert_eq!(approved.status().as_u16(), 200);
    assert_eq!(response_json(approved).await["username"], "legacy2");
    let p = json!({"session":"plaintext-session-1234","premium":true});
    let row=app.db.one("insert into account_entries(service,label,payload,fingerprint) values('amazon-music','Plain',$1,'route-migration') returning id",vec![p.clone().into()]).await.unwrap().unwrap();
    let id = integer(&row, "id");
    app.db.take_statements();
    let check = call(
        &app,
        "POST",
        "/api/admin/check-entry",
        json!({"id":id}),
        "",
        "local-admin",
    )
    .await;
    assert_eq!(check.status().as_u16(), 200);
    assert!(
        app.db
            .take_statements()
            .iter()
            .any(|s| s.contains("set payload=$1 where id=$2 and payload=$3"))
    );
    assert_eq!(
        crypto::decrypt(
            &health::sweep::find_entry(&app, id).await.unwrap().unwrap()["payload"],
            app.config.encryption_key.as_ref()
        ),
        p
    );
    let urls = vec![
        mock.url.clone(),
        format!("{}/", mock.url),
        format!("{}/preview", mock.url),
    ];
    let sync = health::sync::sync_urls(&app, "qobuz", urls, "fixture", None, Some(1), 1)
        .await
        .unwrap();
    assert_eq!(sync["fetched"], 2);
    assert_eq!(sync["added"], 1);
    assert_eq!(sync["batch"]["done"], false);
    let cursor = sync["batch"]["nextAfter"].as_str().unwrap();
    let sync = health::sync::sync_urls(
        &app,
        "qobuz",
        vec![mock.url.clone(), format!("{}/preview", mock.url)],
        "fixture",
        Some(cursor),
        Some(1),
        1,
    )
    .await
    .unwrap();
    assert_eq!(sync["batch"]["done"], true);
    assert_eq!(sync["added"], 1);
    let discovery = call(&app, "GET", "/api/discovery/qobuz", json!({}), "", "").await;
    assert_eq!(discovery.status().as_u16(), 200);
    let etag = discovery.headers()["etag"].clone();
    assert_eq!(
        response_json(discovery).await["api"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let conditional = router(app.clone())
        .oneshot(
            Request::builder()
                .uri("/api/instances/qobuz")
                .header("if-none-match", etag)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(conditional.status().as_u16(), 304);
    assert_eq!(
        call(
            &app,
            "GET",
            "/api/cron/monochrome?feed=missing",
            json!({}),
            "",
            "local-cron"
        )
        .await
        .status()
        .as_u16(),
        400
    );
    app.db.exec("update account_entries set removed=false,status='dead',disabled=true,created_at=now()-interval '8 days' where id=$1;",vec![first[0].into()]).await.unwrap();
    app.db
        .exec(
            "delete from health_log where entry_id=$1 and detail not like 'app report%'",
            vec![first[0].into()],
        )
        .await
        .unwrap();
    let purge = call(
        &app,
        "GET",
        "/api/cron/purge-dead",
        json!({}),
        "",
        "local-cron",
    )
    .await;
    assert_eq!(purge.status().as_u16(), 200);
    assert!(integer(&response_json(purge).await, "removed") >= 1);
    let revoke = call(
        &app,
        "PATCH",
        "/api/admin/keys",
        json!({"id":key_id,"revoked":true}),
        "",
        "local-admin",
    )
    .await;
    assert_eq!(revoke.status().as_u16(), 200);
    assert_eq!(
        call(&app, "GET", "/api/accounts", json!({}), "", &read)
            .await
            .status()
            .as_u16(),
        401
    );
    let audit = response_json(
        call(
            &app,
            "GET",
            "/api/admin/audit?limit=",
            json!({}),
            "",
            "local-admin",
        )
        .await,
    )
    .await;
    assert_eq!(audit["entries"].as_array().unwrap().len(), 1);
    assert!(!audit.to_string().contains(&read));
    assert!(pool::is_service("amazon-music"));
    app.db.close().await;
}
#[tokio::test]
async fn database_github_and_qobuz_signin_use_local_upstreams() {
    let mock=Mock::new(|r|{let body=match r.path.as_str(){"/github/token"=>r#"{"access_token":"local-github-token"}"#,"/github/user"=>{assert_eq!(r.headers["authorization"],"Bearer local-github-token");r#"{"id":24680,"login":"local-listener"}"#},"/qobuz/user/login"=>r#"{"user_auth_token":"local-qobuz-token","user":{"id":10,"login":"listener@example.invalid","country_code":"US"}}"#,"/qobuz/user/get"=>r#"{"id":10,"credential":"studio"}"#,"/qobuz/track/getFileUrl"=>"{}","/"=>"<html></html>",_=>panic!("unexpected local upstream")};Response::builder().status(200).body(Body::from(body)).unwrap()}).await;
    let Some(mut app) = mock.database_app().await else {
        return;
    };
    app.config.public_url = "http://localhost".into();
    app.config.github_client_id = "local-id".into();
    app.config.github_client_secret = "local-secret".into();
    let app = Arc::new(app);
    let start = call(&app, "GET", "/api/auth/github/start", json!({}), "", "").await;
    assert_eq!(start.status().as_u16(), 307);
    let location = url::Url::parse(start.headers()["location"].to_str().unwrap()).unwrap();
    let state = location
        .query_pairs()
        .find(|(k, _)| k == "state")
        .unwrap()
        .1
        .into_owned();
    let oauth = start.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let bad = call(
        &app,
        "GET",
        "/api/auth/github/callback?code=local-code&state=wrong",
        json!({}),
        &oauth,
        "",
    )
    .await;
    assert!(
        bad.headers()["location"]
            .to_str()
            .unwrap()
            .ends_with("error=github_state")
    );
    assert!(mock.requests.lock().unwrap().is_empty());
    let callback = call(
        &app,
        "GET",
        &format!("/api/auth/github/callback?code=local-code&state={state}"),
        json!({}),
        &oauth,
        "",
    )
    .await;
    assert_eq!(callback.status().as_u16(), 307);
    assert_eq!(callback.headers()["location"], "http://localhost/dashboard");
    let cookies = callback
        .headers()
        .get_all("set-cookie")
        .iter()
        .map(|v| v.to_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    assert_eq!(cookies.len(), 2);
    let cookie = cookies
        .iter()
        .find(|s| s.starts_with("atp_session="))
        .unwrap()
        .split(';')
        .next()
        .unwrap();
    assert!(cookies.iter().any(|s| s.starts_with("atp_gh_oauth=;")));
    let login = call(
        &app,
        "POST",
        "/api/qobuz/login",
        json!({"username":"listener@example.invalid","password":"local-private-password"}),
        cookie,
        "",
    )
    .await;
    assert_eq!(login.status().as_u16(), 200);
    let response = response_json(login).await;
    assert_eq!(response["saved"], true);
    assert!(!response.to_string().contains("local-private-password"));
    let row = app
        .db
        .one(
            "select payload,contributor from account_entries where service='qobuz'",
            vec![],
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        crypto::decrypt(&row["payload"], app.config.encryption_key.as_ref())["password"],
        "local-private-password"
    );
    assert_eq!(row["contributor"], "local_listener");
    app.db.close().await;
}
