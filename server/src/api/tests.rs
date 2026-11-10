use super::*;
use crate::{
    config::Config,
    test_support::{Mock, response_json},
};
use tower::ServiceExt;

#[test]
fn every_typescript_route_method_is_implemented() {
    fn visit(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                visit(&path, out);
            } else if path.file_name().unwrap() == "route.ts" {
                out.push(path);
            }
        }
    }
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let api = root.join("app/api");
    let mut files = vec![];
    visit(&api, &mut files);
    let exports = regex::Regex::new(
        r"export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b",
    )
    .unwrap();
    assert!(!files.is_empty());
    let mut methods = 0;
    for file in files {
        let suffix = file
            .parent()
            .unwrap()
            .strip_prefix(&api)
            .unwrap()
            .to_str()
            .unwrap();
        let path = format!("/api/{suffix}").replace('[', "{").replace(']', "}");
        for method in exports.captures_iter(&std::fs::read_to_string(&file).unwrap()) {
            assert!(
                ROUTES.contains(&(&method[1], path.as_str())),
                "missing {} {path}",
                &method[1]
            );
            methods += 1;
        }
    }
    assert!(methods >= 37);
}
#[tokio::test]
async fn router_fallbacks_headers_auth_and_limits() {
    let mock = Mock::fixed(500, "{}").await;
    let mut app = mock.app();
    app.config.client_key = None;
    let router = router(Arc::new(app));
    for (method, path, status) in [
        ("GET", "/api/missing", 404),
        ("DELETE", "/api/status", 405),
        ("GET", "/api/keys/?delete=1", 308),
        ("GET", "/api/accounts", 503),
        ("GET", "/api/instances/bogus", 404),
    ] {
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), status);
        if status == 308 {
            assert_eq!(response.headers()["location"], "/api/keys?delete=1");
        }
        if [404, 405].contains(&status) && !path.contains("instances") {
            assert!(
                to_bytes(response.into_body(), 1024)
                    .await
                    .unwrap()
                    .is_empty()
            );
        } else if path.contains("instances") {
            assert_eq!(
                response_json(response).await,
                json!({"streaming":[],"api":[],"error":"unknown service"})
            );
        }
    }
    for &(method, path) in ROUTES {
        let path = path.replace("{id}", "1").replace("{service}", "tidal");
        let r = router
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_ne!(r.status().as_u16(), 501);
    }
    for path in [
        "/api/cron/health",
        "/api/cron/monochrome",
        "/api/cron/purge-dead",
        "/api/admin/check-entry",
    ] {
        let method = if path.starts_with("/api/admin") {
            "POST"
        } else {
            "GET"
        };
        let r = router
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(r.status().as_u16(), 401);
        assert_eq!(response_json(r).await, json!({"error":"unauthorized"}));
    }
    let r = router
        .clone()
        .oneshot(
            Request::builder()
                .method("HEAD")
                .uri("/api/auth/me")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(r.status().as_u16(), 401);
    assert_eq!(r.headers()["cache-control"], "private, no-store");
    assert!(to_bytes(r.into_body(), 1024).await.unwrap().is_empty());
    let r = router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/auth/login")
                .body(Body::from(vec![0; 1024 * 1024 + 1]))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(r.status().as_u16(), 413);
    let r = too_many(42, "feed");
    assert_eq!(r.headers()["retry-after"], "42");
    assert_eq!(r.headers()["cache-control"], "private, no-store");
    assert_eq!(
        response_json(r).await,
        json!({"error":"rate_limited","detail":"Too many feed requests. Retry shortly."})
    );
    assert!(
        mock.requests
            .lock()
            .unwrap()
            .iter()
            .all(|r| r.path.starts_with('/'))
    );
}
#[test]
fn numbers_paths_and_json_match_javascript() {
    for (v, n) in [
        (json!(null), 0.),
        (json!(true), 1.),
        (json!(false), 0.),
        (json!("12"), 12.),
        (json!(""), 0.),
        (json!(" 7 "), 7.),
        (json!("0x10"), 16.),
        (json!(12.7), 12.7),
    ] {
        assert_eq!(number(&v), n);
    }
    for v in [json!("abc"), json!("12abc"), json!({})] {
        assert!(!number(&v).is_finite());
    }
    assert_eq!(
        match_path("/api/requests/{id}/claim", "/api/requests/17/claim").unwrap()["id"],
        "17"
    );
    assert!(match_path("/api/requests/{id}/claim", "/api/requests/17/claim/extra").is_none());
    assert_eq!(
        serde_json::to_string(&json!({"ok":true,"deleted":true})).unwrap(),
        r#"{"ok":true,"deleted":true}"#
    );
    assert_eq!(
        serde_json::to_string(&json!({"detail":"keys & tokens <hidden>"})).unwrap(),
        r#"{"detail":"keys & tokens <hidden>"}"#
    );
    let app = App::new(Config::default());
    assert!(app.is_ok());
}
#[test]
fn feed_etags_match_typescript_and_conditional_requests() {
    assert_eq!(feeds::etag("{}"), "W/\"5465b825b8287d02-2\"");
    assert_eq!(feeds::etag("😀"), "W/\"cb31c4b88e7ecf29-2\"");
    assert!(feeds::not_modified("\"x\", W/\"tag\"", "W/\"tag\""));
    assert!(feeds::not_modified("*", "anything"));
    assert!(!feeds::not_modified("\"other\"", "\"tag\""));
}
#[test]
fn submissions_keep_amazon_auth_and_validate_artifacts() {
    let form = HashMap::from([
        ("baseUrl".into(), "https://example.invalid".into()),
        ("bypassToken".into(), " bypass ".into()),
        ("turnstileJwt".into(), "jwt".into()),
        ("turnstileJwtExpiresAt".into(), "123".into()),
        ("premium".into(), "true".into()),
    ]);
    let p = submit::build_payload("amazon-music", "api", &form);
    assert_eq!(p["bypassToken"], "bypass");
    assert_eq!(p["turnstileJwt"], "jwt");
    assert!(!p.as_object().unwrap().contains_key("premium"));
    assert!(submit::validate("amazon-music", "account", &json!({"session":"short"})).is_some());
    assert!(
        submit::validate(
            "amazon-music",
            "account",
            &json!({"session":"0123456789abcdef"})
        )
        .is_none()
    );
    assert!(submit::validate("deezer", "account", &json!({"arl":"g".repeat(192)})).is_some());
    assert!(submit::validate("deezer", "account", &json!({"arl":"a".repeat(192)})).is_none());
}
