use super::*;
use crate::{pool::leases, test_support::Mock};
use axum::{body::Body, response::Response};
use std::sync::atomic::{AtomicUsize, Ordering};

async fn add(app: &App, p: &Value, fp: &str) -> i32 {
    let row=app.db.one("insert into account_entries(service,label,payload,fingerprint,status,premium) values('tidal','Tidal Account',$1,$2,'alive',true) returning id",vec![crypto::encrypt_at_rest(p,app.config.encryption_key.as_ref()).unwrap().into(),fp.into()]).await.unwrap().unwrap();
    integer(&row, "id")
}
#[tokio::test]
async fn database_health_lease_and_renewal_regressions() {
    let initial = Mock::fixed(500, "{}").await;
    let Some(mut app) = initial.database_app().await else {
        eprintln!("database regression tests skipped: set local TEST_DATABASE_URL");
        return;
    };
    app.db.exec("truncate account_entries,instance_entries,api_keys,users,health_log,job_locks,pool_state restart identity cascade",vec![]).await.unwrap();
    let expired = format!(
        "e30.{}.signature",
        URL_SAFE_NO_PAD.encode(br#"{"exp":100}"#)
    );
    let p = json!({"token":expired,"refreshToken":"spent","countryCode":"US","password":"private"});

    let limited = Mock::fixed(429, r#"{"error":"abuse_detected"}"#).await;
    app.endpoints = limited.app().endpoints;
    let id = add(&app, &p, "cooldown").await;
    assert!(fresh_tidal(&app, "cooldown", &p).await.is_none());
    assert!(fresh_tidal(&app, "cooldown", &p).await.is_none());
    assert_eq!(limited.requests.lock().unwrap().len(), 1);
    let row = sweep::find_entry(&app, id).await.unwrap().unwrap();
    assert_eq!(row["refresh_backoff_ms"], 900000);
    assert_eq!(
        crypto::decrypt(&row["payload"], app.config.encryption_key.as_ref()),
        p
    );
    let verdict = sweep::check_and_persist(&app, &row).await.unwrap();
    assert_eq!(verdict["skipped"], true);
    assert_eq!(
        sweep::find_entry(&app, id).await.unwrap().unwrap()["check_count"],
        0
    );

    app.db
        .exec("update account_entries set removed=true", vec![])
        .await
        .unwrap();
    let fresh = Mock::fixed(
        200,
        r#"{"access_token":"fresh-access","refresh_token":"fresh-refresh"}"#,
    )
    .await;
    app.endpoints = fresh.app().endpoints;
    let id = add(&app, &p, "rotation").await;
    let served = leases::accounts(&app, None, Some("tidal"), None)
        .await
        .unwrap();
    let decrypted = crypto::decrypt(&served["tidal"][0], app.config.client_key.as_ref());
    assert_eq!(decrypted["token"], "fresh-access");
    assert_eq!(decrypted["refreshToken"], "fresh-refresh");
    assert!(decrypted.get("password").is_none());
    let row = sweep::find_entry(&app, id).await.unwrap().unwrap();
    assert_eq!(
        crypto::decrypt(&row["payload"], app.config.encryption_key.as_ref())["refreshToken"],
        "fresh-refresh"
    );
    assert!(!row["last_leased_at"].is_null());

    let stale = row.clone();
    let rotated = crypto::encrypt_at_rest(
        &json!({"token":"concurrent-access","refreshToken":"concurrent-refresh"}),
        app.config.encryption_key.as_ref(),
    )
    .unwrap();
    app.db
        .exec(
            "update account_entries set payload=$1 where id=$2",
            vec![rotated.clone().into(), id.into()],
        )
        .await
        .unwrap();
    let result = sweep::check_and_persist(&app, &stale).await.unwrap();
    assert_eq!(result["skipped"], true);
    let after = sweep::find_entry(&app, id).await.unwrap().unwrap();
    assert_eq!(after["payload"], rotated);
    assert_eq!(after["check_count"], 0);

    let mut plaintext = after.clone();
    plaintext["payload"] = json!({"token":"old-plaintext","refreshToken":"spent"});
    assert_eq!(
        sweep::check_and_persist(&app, &plaintext).await.unwrap()["skipped"],
        true
    );
    assert_eq!(
        sweep::find_entry(&app, id).await.unwrap().unwrap()["payload"],
        rotated
    );

    let spent = Arc::new(std::sync::Mutex::new(Vec::new()));
    let spent_tokens = spent.clone();
    let calls = Arc::new(AtomicUsize::new(0));
    let n = calls.clone();
    let rejected = Mock::new(move |r| {
        let (s, b) = if r.path == "/token" {
            let count = n.fetch_add(1, Ordering::SeqCst);
            let form = url::form_urlencoded::parse(&r.body)
                .into_owned()
                .collect::<std::collections::HashMap<_, _>>();
            spent_tokens
                .lock()
                .unwrap()
                .push(form["refresh_token"].clone());
            (
                200,
                format!(
                    r#"{{"access_token":"access-{count}","refresh_token":"refresh-{}"}}"#,
                    count + 2
                ),
            )
        } else {
            assert_eq!(r.path, "/sessions");
            (401, "{}".into())
        };
        Response::builder().status(s).body(Body::from(b)).unwrap()
    })
    .await;
    app.endpoints = rejected.app().endpoints;
    let mut renewal_payload = p.clone();
    renewal_payload["refreshToken"] = json!("refresh-1");
    let id = add(&app, &renewal_payload, "reject-after-renewal").await;
    let result = sweep::check_entry(&app, id).await.unwrap().unwrap();
    assert_eq!(result["status"], "dead");
    assert_ne!(result["skipped"], true);
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert_eq!(*spent.lock().unwrap(), vec!["refresh-1", "refresh-2"]);
    let row = sweep::find_entry(&app, id).await.unwrap().unwrap();
    assert_eq!(row["status"], "dead");
    assert_eq!(row["check_count"], 1);

    let n = Arc::new(AtomicUsize::new(0));
    let count = n.clone();
    let invalid = Mock::new(move |r| {
        let (s, b) = if r.path == "/token" && count.fetch_add(1, Ordering::SeqCst) == 0 {
            (200, r#"{"access_token":"fresh","refresh_token":"rotated"}"#)
        } else if r.path == "/token" {
            (400, r#"{"error":"invalid_grant"}"#)
        } else {
            (401, "{}")
        };
        Response::builder().status(s).body(Body::from(b)).unwrap()
    })
    .await;
    app.endpoints = invalid.app().endpoints;
    let id = add(&app, &p, "invalid-after-renewal").await;
    let result = sweep::check_entry(&app, id).await.unwrap().unwrap();
    assert_eq!(result["status"], "dead");
    assert_ne!(result["skipped"], true);
    assert_eq!(
        sweep::find_entry(&app, id).await.unwrap().unwrap()["check_count"],
        1
    );

    let holder = app
        .db
        .claim_job("exclusive-test", 60)
        .await
        .unwrap()
        .unwrap();
    assert!(
        app.db
            .claim_job("exclusive-test", 60)
            .await
            .unwrap()
            .is_none()
    );
    app.db.release_job("exclusive-test", "wrong-owner").await;
    assert!(
        app.db
            .claim_job("exclusive-test", 60)
            .await
            .unwrap()
            .is_none()
    );
    app.db.release_job("exclusive-test", &holder).await;
    assert!(
        app.db
            .claim_job("exclusive-test", 60)
            .await
            .unwrap()
            .is_some()
    );
    let row=app.db.one("insert into account_entries(service,label,payload,fingerprint,status,premium) values('tidal','Race',$1,'verdict-race','alive',true) returning id",vec![crypto::encrypt_at_rest(&json!({"token":"old-access","refreshToken":"spent"}),app.config.encryption_key.as_ref()).unwrap().into()]).await.unwrap().unwrap();
    let id = integer(&row, "id");
    let db = app.db.clone();
    let replacement = crypto::encrypt_at_rest(
        &json!({"token":"new-access","refreshToken":"rotated"}),
        app.config.encryption_key.as_ref(),
    )
    .unwrap();
    let replaced = replacement.clone();
    let racing = Mock::new_async(move |r| {
        let db = db.clone();
        let replaced = replaced.clone();
        async move {
            assert_eq!(r.path, "/sessions");
            db.exec(
                "update account_entries set payload=$1 where id=$2",
                vec![replaced.into(), id.into()],
            )
            .await
            .unwrap();
            Response::builder()
                .status(403)
                .body(Body::from("{}"))
                .unwrap()
        }
    })
    .await;
    app.endpoints = racing.app().endpoints;
    assert_eq!(
        sweep::check_entry(&app, id).await.unwrap().unwrap()["skipped"],
        true
    );
    let row = sweep::find_entry(&app, id).await.unwrap().unwrap();
    assert_eq!(row["payload"], replacement);
    assert_eq!(row["status"], "alive");
    assert_eq!(row["check_count"], 0);
    app.db
        .exec("update account_entries set removed=true", vec![])
        .await
        .unwrap();
    let plaintext = json!({"session":"0123456789abcdef","premium":true});
    let row=app.db.one("insert into account_entries(service,label,payload,fingerprint) values('amazon-music','Amazon Account',$1,'plain-migration') returning id",vec![plaintext.clone().into()]).await.unwrap().unwrap();
    let id = integer(&row, "id");
    app.db.take_statements();
    sweep::check_entry(&app, id).await.unwrap();
    assert!(
        app.db
            .take_statements()
            .iter()
            .any(|sql| sql.contains("set payload=$1 where id=$2 and payload=$3"))
    );
    let migrated = sweep::find_entry(&app, id).await.unwrap().unwrap()["payload"].clone();
    assert_eq!(
        crypto::decrypt(&migrated, app.config.encryption_key.as_ref()),
        plaintext
    );
    app.db.take_statements();
    sweep::check_entry(&app, id).await.unwrap();
    assert!(
        !app.db
            .take_statements()
            .iter()
            .any(|sql| sql.contains("set payload=$1"))
    );
    app.db
        .exec(
            "update account_entries set payload=$1 where id=$2",
            vec![plaintext.into(), id.into()],
        )
        .await
        .unwrap();
    app.db.take_statements();
    let shared = Arc::new(app.clone());
    sweep::run_sweep(&shared, true, None, None).await.unwrap();
    assert!(
        app.db
            .take_statements()
            .iter()
            .any(|sql| sql.contains("set payload=$1 where id=$2 and payload=$3"))
    );
    let instance = Mock::fixed(200, "lossless").await;
    app.endpoints = instance.app().endpoints;
    let plain_url = json!({"baseUrl":instance.url});
    let row=app.db.one("insert into instance_entries(service,label,payload,fingerprint) values('qobuz','Instance',$1,'no-credential-migration') returning id",vec![plain_url.clone().into()]).await.unwrap().unwrap();
    let id = integer(&row, "id");
    app.db.take_statements();
    sweep::check_entry(&app, id).await.unwrap();
    assert!(
        !app.db
            .take_statements()
            .iter()
            .any(|sql| sql.contains("set payload=$1"))
    );
    assert_eq!(
        sweep::find_entry(&app, id).await.unwrap().unwrap()["payload"],
        plain_url
    );
    app.db.close().await;
}
