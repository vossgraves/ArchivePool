use super::*;
use crate::{
    health::{self, sweep},
    pool,
};
use chrono::{DateTime, Utc};
pub fn build_payload(service: &str, kind: &str, form: &HashMap<String, String>) -> Value {
    let get = |k: &str| form.get(k).map(|s| s.trim()).unwrap_or("");
    let mut p = json!({});
    let required: &[&str] = if kind == "api" {
        &["baseUrl"]
    } else {
        match service {
            "tidal" | "apple-music" => &["token"],
            "deezer" => &["arl"],
            "amazon-music" => &["session"],
            _ => &["token", "appId", "appSecret"],
        }
    };
    for k in required {
        p[*k] = json!(get(k));
    }
    let optional: &[&str] = if kind == "api" {
        &["healthPath", "probeUrl"]
    } else {
        match service {
            "tidal" => &["refreshToken", "countryCode"],
            "deezer" => &["masterSecret"],
            "qobuz" => &["username"],
            _ => &[],
        }
    };
    for k in optional.iter().chain(std::iter::once(&"note")) {
        if !get(k).is_empty() {
            p[*k] = json!(get(k));
        }
    }
    if service == "amazon-music" {
        for k in ["bypassToken", "turnstileJwt", "turnstileJwtExpiresAt"] {
            if !get(k).is_empty() {
                p[k] = json!(get(k));
            }
        }
        if kind == "account" {
            p["premium"] = json!(
                form.get("premium")
                    .is_some_and(|s| s == "on" || s == "true")
            );
        }
    }
    p
}
pub fn validate(service: &str, kind: &str, p: &Value) -> Option<&'static str> {
    if kind == "api" {
        return match url::Url::parse(&string(p, "baseUrl")) {
            Ok(u) if ["http", "https"].contains(&u.scheme()) => None,
            Ok(_) => Some("Base URL must be http(s)."),
            Err(_) => Some("Enter a valid base URL (including https://)."),
        };
    }
    match service {
        "deezer" => {
            let arl = string(p, "arl");
            if arl.is_empty() {
                Some("Deezer submissions need an ARL cookie value.")
            } else if arl.len() < 180 || !arl.bytes().all(|b| b.is_ascii_hexdigit()) {
                Some("That doesn't look like an ARL — expected a long hexadecimal string.")
            } else {
                None
            }
        }
        "apple-music" => {
            let token = string(p, "token");
            if token.is_empty() {
                Some("Apple Music submissions need a Media-User-Token.")
            } else if !token.starts_with("0.") {
                Some("That doesn't look like a Media-User-Token — it should start with \"0.\".")
            } else {
                None
            }
        }
        "amazon-music" => {
            let s = string(p, "session");
            if s.is_empty() {
                Some("Amazon Music submissions need the account session artifact.")
            } else if s.encode_utf16().count() < 16 {
                Some("That session value looks truncated — paste the whole thing.")
            } else {
                None
            }
        }
        _ => {
            if string(p, "token").is_empty() {
                Some("A token is required for account submissions.")
            } else if service == "qobuz" && string(p, "appId").is_empty() {
                Some("Qobuz submissions need an app_id.")
            } else if service == "qobuz" && string(p, "appSecret").is_empty() {
                Some("Qobuz submissions need an app_secret (required to sign stream URLs).")
            } else {
                None
            }
        }
    }
}
pub fn expiry(raw: &str, now: DateTime<Utc>) -> Result<Option<DateTime<Utc>>, &'static str> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(None);
    }
    let r = if raw.len() == 10 && raw.as_bytes()[4] == b'-' && raw.as_bytes()[7] == b'-' {
        DateTime::parse_from_rfc3339(&format!("{raw}T23:59:59Z"))
    } else {
        DateTime::parse_from_rfc3339(raw)
    }
    .map_err(|_| "Enter the expiry as YYYY-MM-DD, or leave it blank.")?
    .with_timezone(&Utc);
    if r <= now {
        return Err("That expiry date has already passed.");
    }
    Ok(Some(r))
}
async fn form(ctx: &Context) -> HashMap<String, String> {
    if ctx
        .header("content-type")
        .starts_with("multipart/form-data")
    {
        use axum::extract::{FromRequest, Multipart};
        let mut request = Request::new(Body::from(ctx.body.clone()));
        *request.headers_mut() = ctx.headers.clone();
        let mut out = HashMap::new();
        if let Ok(mut multipart) = Multipart::from_request(request, &()).await {
            while let Ok(Some(field)) = multipart.next_field().await {
                let name = field.name().map(str::to_owned);
                if let (Some(name), Ok(value)) = (name, field.text().await) {
                    out.entry(name).or_insert(value);
                }
            }
        }
        out
    } else {
        let mut out = HashMap::new();
        for (k, v) in url::form_urlencoded::parse(&ctx.body) {
            out.entry(k.into_owned()).or_insert_with(|| v.into_owned());
        }
        out
    }
}
pub async fn route(app: &Arc<App>, ctx: &Context) -> db::Result<Response> {
    let form = form(ctx).await;
    let service = form.get("service").map(String::as_str).unwrap_or("");
    let kind = form.get("kind").map(String::as_str).unwrap_or("");
    if !pool::is_service(service) || !["api", "account"].contains(&kind) {
        return Ok(json_response(
            200,
            json!({"ok":false,"message":"Pick a valid service and type."}),
        ));
    }
    let p = build_payload(service, kind, &form);
    if let Some(message) = validate(service, kind, &p) {
        return Ok(json_response(200, json!({"ok":false,"message":message})));
    }
    let expires = match expiry(
        form.get("expiresAt").map(String::as_str).unwrap_or(""),
        Utc::now(),
    ) {
        Ok(r) => r,
        Err(message) => return Ok(json_response(200, json!({"ok":false,"message":message}))),
    };
    let contributor = if form.get("credit").is_some_and(|s| s == "on") {
        auth::session(app, ctx)
            .await?
            .map(|r| string(&r, "username"))
    } else {
        None
    };
    let result = sweep::ingest(app, service, kind, &p, contributor.clone(), expires).await;
    let r = match result {
        Ok(r) => r,
        Err(_) => {
            return Ok(json_response(
                200,
                json!({"ok":false,"message":sweep::describe_save_error(&app.config.database_url,"Database operation unavailable.")}),
            ));
        }
    };
    let saved = r["saved"] == true;
    let mut out = json!({"ok":saved,"status":r["status"],"premium":r["premium"],"message":if saved{if let Some(name)=&contributor{format!("Verified as working and premium — added to the pool, credited to @{name}. Thank you!")}else{"Verified as working and premium — added to the pool. Thank you!".into()}}else if r["ok"]==true{"Not added: this source works but has no premium/lossless entitlement. The pool only accepts premium sources.".into()}else{format!("Not added: the live check failed ({}). Only working, premium sources are accepted.",string(&r,"detail"))}});
    if saved {
        out["creditedTo"] = json!(contributor);
    }
    Ok(json_response(200, out))
}
pub async fn credentials(app: &Arc<App>, ctx: &Context, route: &str) -> db::Result<Response> {
    if route == "/api/tidal/device/start" {
        let res = app
            .outbound
            .form(
                &app.endpoints.tidal_device,
                crate::httpx::headers(&[("user-agent", "TIDAL/1000 (Linux; Android 10)")]),
                &[
                    ("client_id", health::TIDAL_CLIENT_ID.into()),
                    ("scope", "r_usr+w_usr+w_sub".into()),
                ],
            )
            .await;
        return Ok(match res {
            Ok(r) if r.ok() => {
                let p = r.json();
                json_response(
                    200,
                    json!({"deviceCode":p["deviceCode"],"userCode":p["userCode"],"verificationUri":p["verificationUri"],"verificationUriComplete":p["verificationUriComplete"],"expiresIn":p["expiresIn"],"interval":p["interval"]}),
                )
            }
            Ok(r) => detail(
                502,
                "start_failed",
                &format!("device_authorization failed: HTTP {}", r.status),
            ),
            Err(e) => detail(502, "start_failed", &e.to_string()),
        });
    }
    let body = ctx.json().unwrap_or(json!({}));
    let (service, payload) = if route == "/api/tidal/device/poll" {
        let code = string(&body, "deviceCode").trim().to_owned();
        if code.is_empty() {
            return Ok(error(400, "missing_device_code"));
        }
        let res = app
            .outbound
            .form(
                &app.endpoints.tidal_token,
                crate::httpx::headers(&[("user-agent", "TIDAL/1000 (Linux; Android 10)")]),
                &[
                    ("client_id", health::TIDAL_CLIENT_ID.into()),
                    ("client_secret", health::TIDAL_CLIENT_SECRET.into()),
                    ("device_code", code),
                    (
                        "grant_type",
                        "urn:ietf:params:oauth:grant-type:device_code".into(),
                    ),
                    ("scope", "r_usr+w_usr+w_sub".into()),
                ],
            )
            .await;
        let r = match res {
            Ok(r) => r,
            Err(e) => {
                return Ok(json_response(
                    502,
                    json!({"state":"error","detail":e.to_string()}),
                ));
            }
        };
        let p = r.json();
        if !r.ok() {
            let code = string(&p, "error");
            let state = match code.as_str() {
                "authorization_pending" => "pending",
                "slow_down" => "slow_down",
                "expired_token" | "expired" => "expired",
                _ => "error",
            };
            let mut out = json!({"state":state});
            if state == "error" {
                out["detail"] = json!(match code.as_str() {
                    "access_denied" => "access_denied".to_owned(),
                    _ => format!("HTTP {}", r.status),
                });
            }
            return Ok(json_response(200, out));
        }
        let mut payload = json!({"token":p["access_token"],"note":"Added via Tidal sign-in"});
        for (out, path) in [
            ("refreshToken", &p["refresh_token"]),
            ("countryCode", &p["user"]["countryCode"]),
        ] {
            if let Some(s) = path.as_str().filter(|s| !s.is_empty()) {
                payload[out] = json!(s);
            }
        }
        ("tidal", payload)
    } else {
        let username = string(&body, "username").trim().to_owned();
        let password = string(&body, "password").trim().to_owned();
        if username.is_empty() || password.is_empty() {
            return Ok(detail(
                400,
                "missing_credentials",
                "Email and password are required.",
            ));
        }
        let login =
            match health::qobuz_login(app, &username, &password, health::QOBUZ_LOGIN_ID).await {
                Ok(r) => r,
                Err(e) => return Ok(detail(401, "login_failed", &e)),
            };
        let scrape = health::scrape_qobuz(app, health::QOBUZ_LOGIN_ID).await;
        let secret = if scrape.is_empty() {
            health::QOBUZ_LOGIN_SECRET
        } else {
            &scrape
        };
        if !health::qobuz_secret(app, health::QOBUZ_LOGIN_ID, secret, &login.token)
            .await
            .0
        {
            let mut out = json!({"state":"needs_secret","userAuthToken":login.token,"appId":health::QOBUZ_LOGIN_ID,"userId":login.user_id,"detail":"Signed in, but could not scrape app_secret from bundle. Please paste it manually."});
            if !login.country.is_empty() {
                out["countryCode"] = json!(login.country);
            }
            return Ok(json_response(200, out));
        }
        let mut payload = json!({"token":login.token,"appId":health::QOBUZ_LOGIN_ID,"appSecret":secret,"note":"Added via Qobuz sign-in"});
        if !login.username.is_empty() {
            payload["username"] = json!(login.username);
        }
        if !login.country.is_empty() {
            payload["countryCode"] = json!(login.country);
        }
        ("qobuz", payload)
    };
    match sweep::ingest(app, service, "account", &payload, None, None).await {
        Ok(r) => Ok(json_response(
            200,
            json!({"state":"authorized","saved":r["saved"],"ok":r["ok"],"status":r["status"],"premium":r["premium"],"detail":r["detail"]}),
        )),
        Err(_) => Ok(json_response(
            500,
            json!({"state":"authorized","saved":false,"detail":sweep::describe_save_error(&app.config.database_url,"Database operation unavailable.")}),
        )),
    }
}
