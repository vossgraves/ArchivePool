use super::*;
use crate::{
    crypto,
    pool::{self, leases},
    snapshot,
};
pub fn etag(body: &str) -> String {
    let mut a = 0x811c9dc5u32;
    let mut b = 0x01000193u32;
    let codes = body.encode_utf16().collect::<Vec<_>>();
    for (i, code) in codes.iter().enumerate() {
        a = (a ^ (*code as u32)).wrapping_mul(0x01000193);
        b = (b ^ (*code as u32).wrapping_add(i as u32)).wrapping_mul(0x85ebca6b);
    }
    format!("W/\"{a:x}{b:x}-{:x}\"", codes.len())
}
pub fn not_modified(value: &str, etag: &str) -> bool {
    let norm = |s: &str| {
        s.trim()
            .strip_prefix("W/")
            .unwrap_or(s.trim())
            .trim_matches('"')
            .to_owned()
    };
    value.trim() == "*" || value.split(',').any(|s| norm(s) == norm(etag))
}
fn feed_response(
    ctx: &Context,
    value: Value,
    control: &str,
    cacheable: bool,
    status: bool,
) -> Response {
    let body = serde_json::to_string(&value).unwrap();
    let etag = etag(&body);
    let modified = cacheable && not_modified(ctx.header("if-none-match"), &etag);
    let res = if modified {
        empty(304)
    } else {
        Response::builder()
            .status(200)
            .body(Body::from(body))
            .unwrap()
    };
    let mut h = vec![
        ("cache-control", control),
        ("access-control-allow-origin", "*"),
        ("etag", etag.as_str()),
    ];
    if !modified || status {
        h.push(("content-type", "application/json; charset=utf-8"));
    }
    with_headers(res, &h)
}
pub async fn route(app: &Arc<App>, ctx: &Context, route: &str) -> db::Result<Response> {
    if route == "/api/status" {
        let _flight = app.cache.flight("status:body").await;
        if let Some(payload) = app.cache.get("status:body").await {
            return Ok(feed_response(
                ctx,
                payload,
                "public, s-maxage=300, stale-while-revalidate=3600",
                true,
                true,
            ));
        }
        match pool::status::payload(app).await {
            Ok(payload) => {
                app.cache
                    .put("status:body", payload.clone(), Duration::from_secs(300))
                    .await;
                return Ok(feed_response(
                    ctx,
                    payload,
                    "public, s-maxage=300, stale-while-revalidate=3600",
                    true,
                    true,
                ));
            }
            Err(_) => {
                return Ok(with_headers(
                    detail(
                        503,
                        "database_unavailable",
                        "Database operation unavailable.",
                    ),
                    &[
                        ("cache-control", "no-store"),
                        ("retry-after", "60"),
                        ("access-control-allow-origin", "*"),
                    ],
                ));
            }
        }
    }
    let credentials = route == "/api/accounts" || route == "/api/sources";
    let service = if route.ends_with("/tidal") {
        "tidal"
    } else if route.ends_with("/qobuz") {
        "qobuz"
    } else {
        ctx.params.get("service").map(String::as_str).unwrap_or("")
    };
    if !credentials && !pool::is_service(service) {
        return Ok(json_response(
            404,
            json!({"streaming":[],"api":[],"error":"unknown service"}),
        ));
    }
    if let Some(s) = app
        .rates
        .check(
            &format!("feed-ip:{}", ctx.ip()),
            120,
            Duration::from_secs(60),
        )
        .await
    {
        return Ok(if credentials {
            too_many(s, "feed")
        } else {
            private(with_headers(
                json_response(429, json!({"streaming":[],"api":[]})),
                &[("retry-after", &s.to_string())],
            ))
        });
    }
    let v2 = ctx
        .header("x-pool-client")
        .trim()
        .eq_ignore_ascii_case("v2");
    if credentials && !v2 && app.config.client_key.is_none() {
        return Ok(private(detail(
            503,
            "security_not_configured",
            "Credential delivery is unavailable.",
        )));
    }
    let identity = match auth::identify(app, ctx, credentials, !credentials).await {
        Ok(i) => i,
        Err(_) if !credentials => auth::Identity::default(),
        Err(e) => return Err(e),
    };
    if !identity.ok || !credentials && identity.scope.as_deref().is_some_and(|s| s != service) {
        return Ok(if credentials {
            private(detail(
                401,
                "unauthorized",
                "A valid API key is required to read the source pool. Create an account and request one on the site.",
            ))
        } else {
            private(json_response(401, json!({"streaming":[],"api":[]})))
        });
    }
    if !credentials {
        let key = format!("discovery:{service}");
        let _guard = app.cache.flight(&key).await;
        let cached = app.cache.get(&key).await;
        let data = if cached.is_some() {
            cached
        } else if let Some(snapshot) = snapshot::read(app)
            .await
            .filter(|s| snapshot::valid_discovery(&s[service]))
        {
            Some(snapshot[service].clone())
        } else {
            leases::discovery(app, Some(service)).await.ok()
        };
        let cacheable = data.is_some();
        if let Some(data) = &data {
            app.cache
                .put(&key, data.clone(), Duration::from_secs(300))
                .await;
        }
        let control = if !cacheable {
            "private, no-store"
        } else if app.config.read_keys_enforced {
            "private, max-age=300, stale-while-revalidate=3600"
        } else {
            "public, s-maxage=300, stale-while-revalidate=3600"
        };
        return Ok(feed_response(
            ctx,
            data.unwrap_or(json!({"streaming":[],"api":[]})),
            control,
            cacheable,
            false,
        ));
    }
    let read = auth::read_key(ctx).unwrap_or("");
    let hash = hex::encode(crypto::sha256(read));
    let id = &hash[..16];
    if let Some(s) = app
        .rates
        .check(
            &format!("feed-key:{id}:{}", ctx.ip()),
            60,
            Duration::from_secs(300),
        )
        .await
    {
        return Ok(too_many(s, "feed"));
    }
    if app.config.key_fleet_limit > 0
        && let Some(s) = app
            .rates
            .check(
                &format!("feed-key-total:{id}"),
                app.config.key_fleet_limit,
                Duration::from_secs(300),
            )
            .await
    {
        return Ok(too_many(s, "feed"));
    }
    let client_key = v2.then(|| crypto::derive_client_key(read));
    let accounts = leases::accounts(
        app,
        identity.id,
        identity.scope.as_deref(),
        client_key.as_ref(),
    )
    .await?;
    let combined = route == "/api/sources";
    let mut body = json!({"version":if combined{1}else{2},"generatedAt":now(),"encrypted":true,"encryption":if v2{"read-key"}else{"client-key"}});
    if combined {
        body["accountsFeed"] = json!("/api/accounts");
        body["instancesFeed"] = json!("/api/instances/{service}");
        let apis = leases::instances(app, identity.scope.as_deref(), client_key.as_ref()).await?;
        for s in pool::SERVICES {
            body[*s] = json!({"apis":apis[*s],"accounts":accounts[*s]});
        }
    } else {
        for s in pool::SERVICES {
            body[*s] = json!({"accounts":accounts[*s]});
        }
    }
    Ok(private(with_headers(
        json_response(200, body),
        &[("access-control-allow-origin", "*")],
    )))
}
