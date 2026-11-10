use crate::{App, db};
use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{Request, State},
    http::{HeaderMap, HeaderValue},
    response::Response,
};
use serde_json::{Value, json};
use std::{collections::HashMap, sync::Arc, time::Duration};
pub mod admin;
pub mod auth;
pub mod cron;
#[cfg(test)]
mod database_tests;
pub mod feeds;
pub mod keys;
pub mod recovery;
pub mod report;
pub mod submit;
#[cfg(test)]
mod tests;

pub struct Context {
    pub headers: HeaderMap,
    pub path: String,
    pub query: HashMap<String, String>,
    pub method: String,
    pub body: Vec<u8>,
    pub params: HashMap<String, String>,
}
impl Context {
    pub fn json(&self) -> Option<Value> {
        serde_json::from_slice(&self.body).ok()
    }
    pub fn header(&self, key: &str) -> &str {
        self.headers
            .get(key)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
    }
    pub fn ip(&self) -> String {
        let forwarded = self
            .header("x-forwarded-for")
            .split(',')
            .next()
            .unwrap_or("")
            .trim();
        let real = self.header("x-real-ip").trim();
        let ip = if !forwarded.is_empty() {
            forwarded
        } else if !real.is_empty() {
            real
        } else {
            "unknown"
        };
        ip.chars().take(64).collect()
    }
    pub fn ua(&self) -> String {
        self.header("user-agent").chars().take(256).collect()
    }
    pub fn cookie(&self, name: &str) -> &str {
        self.header("cookie")
            .split(';')
            .filter_map(|p| p.trim().split_once('='))
            .find(|(k, _)| *k == name)
            .map(|(_, v)| v)
            .unwrap_or("")
    }
    pub fn origin(&self, app: &App) -> String {
        if !app.config.public_url.is_empty() {
            return app.config.public_url.trim_end_matches('/').to_owned();
        }
        let scheme = if self.header("x-forwarded-proto") == "https" {
            "https"
        } else {
            "http"
        };
        format!("{scheme}://{}", self.header("host"))
    }
}
pub fn string(v: &Value, k: &str) -> String {
    js_string(&v[k])
}
pub fn js_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        _ => v.to_string(),
    }
}
pub fn integer(v: &Value, k: &str) -> i32 {
    v[k].as_i64().unwrap_or(0) as i32
}
pub fn boolean(v: &Value, k: &str) -> bool {
    v[k].as_bool().unwrap_or(false)
}
pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
pub fn empty(status: u16) -> Response {
    Response::builder()
        .status(status)
        .body(Body::empty())
        .unwrap()
}
pub fn json_response(status: u16, value: Value) -> Response {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_vec(&value).unwrap()))
        .unwrap()
}
pub fn error(status: u16, code: &str) -> Response {
    json_response(status, json!({"error":code}))
}
pub fn detail(status: u16, code: &str, message: &str) -> Response {
    json_response(status, json!({"error":code,"detail":message}))
}
pub fn with_headers(mut res: Response, headers: &[(&str, &str)]) -> Response {
    for (k, v) in headers {
        if let (Ok(k), Ok(v)) = (
            axum::http::HeaderName::from_bytes(k.as_bytes()),
            HeaderValue::from_str(v),
        ) {
            if k == "set-cookie" {
                res.headers_mut().append(k, v);
            } else {
                res.headers_mut().insert(k, v);
            }
        }
    }
    res
}
pub fn private(res: Response) -> Response {
    with_headers(res, &[("cache-control", "private, no-store")])
}
pub fn redirect(location: &str, status: u16) -> Response {
    with_headers(empty(status), &[("location", location)])
}
pub fn too_many(seconds: u64, scope: &str) -> Response {
    private(with_headers(
        json_response(
            429,
            json!({"error":"rate_limited","detail":format!("Too many {scope} requests. Retry shortly.")}),
        ),
        &[("retry-after", &seconds.to_string())],
    ))
}
pub fn number(v: &Value) -> f64 {
    match v {
        Value::Null => 0.,
        Value::Bool(b) => {
            if *b {
                1.
            } else {
                0.
            }
        }
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => {
            let s = s.trim();
            if s.is_empty() {
                0.
            } else if let Some(s) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
                u64::from_str_radix(s, 16)
                    .map(|n| n as f64)
                    .unwrap_or(f64::NAN)
            } else if let Some(s) = s.strip_prefix("0b").or_else(|| s.strip_prefix("0B")) {
                u64::from_str_radix(s, 2)
                    .map(|n| n as f64)
                    .unwrap_or(f64::NAN)
            } else if let Some(s) = s.strip_prefix("0o").or_else(|| s.strip_prefix("0O")) {
                u64::from_str_radix(s, 8)
                    .map(|n| n as f64)
                    .unwrap_or(f64::NAN)
            } else {
                s.parse().unwrap_or(f64::NAN)
            }
        }
        Value::Array(a) => number(&Value::String(
            a.iter().map(js_string).collect::<Vec<_>>().join(","),
        )),
        _ => f64::NAN,
    }
}

pub const ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/accounts"),
    ("GET", "/api/sources"),
    ("GET", "/api/status"),
    ("GET", "/api/instances/{service}"),
    ("GET", "/api/discovery/tidal"),
    ("GET", "/api/discovery/qobuz"),
    ("POST", "/api/report"),
    ("GET", "/api/cron/health"),
    ("GET", "/api/cron/monochrome"),
    ("GET", "/api/cron/purge-dead"),
    ("POST", "/api/auth/login"),
    ("POST", "/api/auth/signup"),
    ("POST", "/api/auth/logout"),
    ("GET", "/api/auth/me"),
    ("GET", "/api/auth/github/start"),
    ("GET", "/api/auth/github/callback"),
    ("POST", "/api/auth/claim-legacy"),
    ("GET", "/api/keys"),
    ("POST", "/api/keys"),
    ("DELETE", "/api/keys/{id}"),
    ("POST", "/api/requests/{id}/claim"),
    ("GET", "/api/admin/keys"),
    ("POST", "/api/admin/keys"),
    ("PATCH", "/api/admin/keys"),
    ("DELETE", "/api/admin/keys/{id}"),
    ("POST", "/api/admin/keys/custom"),
    ("GET", "/api/admin/requests"),
    ("POST", "/api/admin/requests/{id}"),
    ("GET", "/api/admin/users"),
    ("PATCH", "/api/admin/users"),
    ("GET", "/api/admin/audit"),
    ("GET", "/api/admin/remove"),
    ("POST", "/api/admin/remove"),
    ("POST", "/api/admin/purge-dead"),
    ("POST", "/api/admin/purge-entry"),
    ("POST", "/api/admin/check-entry"),
    ("POST", "/api/admin/force-check"),
    ("GET", "/api/admin/claims"),
    ("POST", "/api/admin/claims/{id}"),
    ("POST", "/api/tidal/device/start"),
    ("POST", "/api/tidal/device/poll"),
    ("POST", "/api/qobuz/login"),
    ("POST", "/api/submit"),
];
pub fn match_path(pattern: &str, path: &str) -> Option<HashMap<String, String>> {
    let a: Vec<_> = pattern.trim_matches('/').split('/').collect();
    let b: Vec<_> = path.trim_matches('/').split('/').collect();
    if a.len() != b.len() {
        return None;
    }
    let mut out = HashMap::new();
    for (a, b) in a.iter().zip(b) {
        if a.starts_with('{') && a.ends_with('}') && !b.is_empty() {
            out.insert(a[1..a.len() - 1].to_owned(), b.to_owned());
        } else if *a != b {
            return None;
        }
    }
    Some(out)
}
pub fn router(app: Arc<App>) -> Router {
    Router::new().fallback(handle).with_state(app)
}
async fn handle(State(app): State<Arc<App>>, req: Request) -> Response {
    let path = req.uri().path().to_owned();
    if path != "/" && path.ends_with('/') {
        let mut target = path.trim_end_matches('/').to_owned();
        if let Some(q) = req.uri().query() {
            target.push('?');
            target.push_str(q);
        }
        return redirect(&target, 308);
    }
    let head = req.method() == "HEAD";
    let method = if head {
        "GET".to_owned()
    } else {
        req.method().to_string()
    };
    let matched = ROUTES
        .iter()
        .filter_map(|(m, p)| match_path(p, &path).map(|params| (*m, *p, params)))
        .collect::<Vec<_>>();
    let Some((_, route, params)) = matched.iter().find(|(m, _, _)| *m == method) else {
        return empty(if matched.is_empty() { 404 } else { 405 });
    };
    let route = *route;
    let params = params.clone();
    let query = url::form_urlencoded::parse(req.uri().query().unwrap_or("").as_bytes())
        .into_owned()
        .collect();
    let headers = req.headers().clone();
    let body = match tokio::time::timeout(
        Duration::from_secs(15),
        to_bytes(req.into_body(), 1024 * 1024),
    )
    .await
    {
        Ok(Ok(b)) => b.to_vec(),
        Ok(Err(_)) => return error(413, "body_too_large"),
        Err(_) => return error(408, "request_timeout"),
    };
    let ctx = Context {
        headers,
        path,
        query,
        method,
        body,
        params,
    };
    let timeout = if route.starts_with("/api/cron/") || route == "/api/admin/force-check" {
        300
    } else {
        60
    };
    let mut response =
        match tokio::time::timeout(Duration::from_secs(timeout), dispatch(&app, &ctx, route)).await
        {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => empty(500),
            Err(_) => error(504, "request_timeout"),
        };
    if head {
        *response.body_mut() = Body::empty();
    }
    response
}
async fn dispatch(app: &Arc<App>, ctx: &Context, route: &str) -> db::Result<Response> {
    match route {
        "/api/auth/login" | "/api/auth/signup" | "/api/auth/logout" | "/api/auth/me" => {
            auth::password_route(app, ctx, route).await
        }
        "/api/auth/github/start" | "/api/auth/github/callback" => {
            auth::github_route(app, ctx, route).await
        }
        "/api/keys" | "/api/keys/{id}" | "/api/requests/{id}/claim" => {
            keys::user_route(app, ctx, route).await
        }
        "/api/admin/keys"
        | "/api/admin/keys/{id}"
        | "/api/admin/keys/custom"
        | "/api/admin/requests"
        | "/api/admin/requests/{id}"
        | "/api/admin/users"
        | "/api/admin/audit" => keys::admin_route(app, ctx, route).await,
        "/api/accounts"
        | "/api/sources"
        | "/api/status"
        | "/api/instances/{service}"
        | "/api/discovery/tidal"
        | "/api/discovery/qobuz" => feeds::route(app, ctx, route).await,
        "/api/submit" => submit::route(app, ctx).await,
        "/api/tidal/device/start" | "/api/tidal/device/poll" | "/api/qobuz/login" => {
            submit::credentials(app, ctx, route).await
        }
        "/api/report" => report::route(app, ctx).await,
        "/api/auth/claim-legacy" | "/api/admin/claims" | "/api/admin/claims/{id}" => {
            recovery::route(app, ctx, route).await
        }
        "/api/cron/health" | "/api/cron/monochrome" | "/api/cron/purge-dead" => {
            cron::route(app, ctx, route).await
        }
        _ => admin::route(app, ctx, route).await,
    }
}
