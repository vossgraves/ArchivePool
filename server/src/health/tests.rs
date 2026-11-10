use super::*;
use crate::test_support::Mock;
use axum::{body::Body, response::Response};

#[test]
fn parsed_tidal_premium_decodes_fields_independently() {
    for (body, expected) in [
        (
            r#"{"premiumAccess":"yes","subscription":{"type":"FREE"}}"#,
            false,
        ),
        (
            r#"{"premiumAccess":false,"highestSoundQuality":123}"#,
            false,
        ),
        (
            r#"{"subscription":{"type":7},"highestSoundQuality":"HIGH"}"#,
            false,
        ),
        (
            r#"{"premiumAccess":"x","highestSoundQuality":"LOSSLESS"}"#,
            true,
        ),
        (
            r#"{"premiumAccess":false,"highestSoundQuality":"HI_RES_LOSSLESS"}"#,
            false,
        ),
        (
            r#"{"premiumAccess":true,"subscription":{"type":"FREE"}}"#,
            true,
        ),
        (
            r#"{"subscription":{"type":"free"},"highestSoundQuality":"LOSSLESS"}"#,
            false,
        ),
        (
            r#"{"highestSoundQuality":"HIGH","note":"premium hi-res"}"#,
            false,
        ),
        (r#"{"highestSoundQuality":"LOSSLESS"}"#, true),
        (
            r#"{"premiumAccess":"false","subscription":{"type":"FREE"}}"#,
            false,
        ),
        (
            r#"{"premiumAccess":true,"subscription":5,"highestSoundQuality":false}"#,
            true,
        ),
        (
            r#"{"premiumAccess":null,"subscription":[],"highestSoundQuality":"HIGH"}"#,
            false,
        ),
        (r#"{"highestSoundQuality":123}"#, true),
        (
            r#"{"premiumAccess":false,"subscription":{"type":123}}"#,
            false,
        ),
        ("not json", true),
        ("{}", true),
        ("[]", true),
    ] {
        assert_eq!(tidal_premium(body), expected, "{body}");
    }
}
#[test]
fn expiry_refresh_rotation_and_backoff() {
    let jwt = |v| {
        format!(
            "e30.{}.signature",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&v).unwrap())
        )
    };
    assert!(tidal_refresh_token(&jwt(json!({"type":"o2_refresh"}))));
    for (exp, expected) in [(0, false), (100, true), (400, true), (401, false)] {
        assert_eq!(
            tidal_access_expired(&jwt(json!({"exp":exp})), 100),
            expected
        );
    }
    assert!(!tidal_access_expired("opaque", 100));
    for (p, rotated) in [
        (
            json!({"token":"other-access","refreshToken":"spent"}),
            false,
        ),
        (json!({"token":"other","refreshToken":"new"}), true),
        (json!({"token":"spent"}), false),
        (json!({"token":"new"}), true),
        (json!({"token":"","refreshToken":"  "}), false),
    ] {
        assert_eq!(stored_refresh_rotated(&p, "spent"), rotated);
    }
    assert_eq!(next_abuse_backoff(None), 900000);
    assert_eq!(next_abuse_backoff(Some(300000)), 600000);
    assert_eq!(next_abuse_backoff(Some(i32::MAX)), 21600000);
}
#[test]
fn amazon_shape_and_apple_subscription() {
    for (p, ok, premium) in [
        (json!({}), false, false),
        (json!({"session":"short"}), false, false),
        (json!({"session":"0123456789abcdef"}), true, false),
        (
            json!({"session":"0123456789abcdef","premium":true}),
            true,
            true,
        ),
        (
            json!({"session":"0123456789abcdef","premium":"true"}),
            true,
            false,
        ),
    ] {
        let c = amazon_account(&p);
        assert_eq!((c.ok, c.premium), (ok, premium));
    }
    for (p, expected) in [
        (json!({"meta":{"subscription":{"active":true}}}), Some(true)),
        (
            json!({"meta":{"subscription":{"active":false}}}),
            Some(false),
        ),
        (json!({"data":[{"id":"us"}]}), None),
        (json!({"meta":{"subscription":{}}}), None),
    ] {
        assert_eq!(apple_subscription(&p).0, expected);
    }
}
#[tokio::test]
async fn tidal_instance_dialects_and_rate_limits() {
    for (manifest_status, manifest, track_status, track, status, skipped, count) in [
        (
            200,
            r#"{"data":{"data":{"attributes":{"trackPresentation":"FULL"}}}}"#,
            200,
            "{}",
            "alive",
            false,
            1,
        ),
        (
            200,
            r#"{"data":{"attributes":{"assetPresentation":"FULL"}}}"#,
            200,
            "{}",
            "alive",
            false,
            1,
        ),
        (
            200,
            r#"{"data":{"attributes":{"assetPresentation":"PREVIEW"}}}"#,
            200,
            "{}",
            "preview",
            false,
            1,
        ),
        (200, r#"{"version":"3.5"}"#, 200, "{}", "dead", false, 1),
        (429, "{}", 200, "{}", "pending", true, 1),
        (
            404,
            "{}",
            200,
            r#"{"data":{"manifest":"encoded","assetPresentation":"LOSSLESS"}}"#,
            "alive",
            false,
            2,
        ),
        (
            405,
            "{}",
            200,
            r#"{"data":{"assetPresentation":"PREVIEW"}}"#,
            "preview",
            false,
            2,
        ),
        (
            501,
            "{}",
            200,
            r#"{"data":{"manifest":"","assetPresentation":"LOSSLESS"}}"#,
            "dead",
            false,
            2,
        ),
        (404, "{}", 429, "{}", "pending", true, 2),
        (
            500,
            "{}",
            200,
            r#"{"data":{"manifest":"encoded"}}"#,
            "dead",
            false,
            1,
        ),
    ] {
        let mock = Mock::new(move |r| {
            let (s, b) = if r.path == "/trackManifests/" {
                (manifest_status, manifest)
            } else {
                assert_eq!(r.path, "/track/");
                (track_status, track)
            };
            Response::builder().status(s).body(Body::from(b)).unwrap()
        })
        .await;
        let c = instance_check(&mock.app(), "tidal", &json!({"baseUrl":mock.url})).await;
        assert_eq!((c.status.as_str(), c.skipped), (status, skipped));
        let requests = mock.requests.lock().unwrap();
        assert_eq!(requests.len(), count);
        for r in requests.iter() {
            assert_eq!(r.headers["user-agent"], "ArchiveTune-Android");
            assert!(r.query.contains("id=155142501534011392"));
        }
        assert!(requests[0].query.contains("formats=FLAC"));
    }
}
#[tokio::test]
async fn full_probe_body_is_not_truncated() {
    let body = format!(
        r#"{{"status":"ok","padding":"{}","quality":"lossless"}}"#,
        "x".repeat(1024 * 1024)
    );
    let mock = Mock::fixed(200, body).await;
    let c = instance_check(&mock.app(), "amazon-music", &json!({"baseUrl":mock.url})).await;
    assert!(c.ok && c.premium);
}
#[tokio::test]
async fn dedicated_amazon_and_deezer_health() {
    for (service, body, status) in [
        (
            "amazon-music",
            r#"{"status":"ok","quality":"lossless"}"#,
            "alive",
        ),
        ("amazon-music", r#"{"status":"UNHEALTHY"}"#, "dead"),
        ("amazon-music", "123", "dead"),
        ("amazon-music", "not json", "dead"),
        ("amazon-music", r#"{"status":"ok"}"#, "preview"),
        ("deezer", r#"{"ok":false,"defaultFormat":"FLAC"}"#, "dead"),
        (
            "deezer",
            r#"{"ok":true,"accounts":{"total":2,"available":0,"cooling":0},"defaultFormat":"FLAC"}"#,
            "dead",
        ),
        (
            "deezer",
            r#"{"ok":true,"accounts":{"total":2,"available":0,"cooling":1},"defaultFormat":"FLAC"}"#,
            "alive",
        ),
    ] {
        let mock = Mock::fixed(200, body).await;
        let c = run_check(
            &mock.app(),
            service,
            "api",
            &json!({"baseUrl":mock.url}),
            "",
        )
        .await;
        assert_eq!(c.status, status, "{body}");
        assert_eq!(mock.requests.lock().unwrap()[0].path, "/health");
    }
}
#[tokio::test]
async fn refresh_keeps_or_rotates_full_payload() {
    for rotated in [true, false] {
        let body = if rotated {
            r#"{"access_token":"fresh-access","refresh_token":"fresh-refresh"}"#
        } else {
            r#"{"access_token":"fresh-access"}"#
        };
        let mock = Mock::fixed(200, body).await;
        let p = json!({"token":"old","refreshToken":"spent","countryCode":"US"});
        let r = refresh_tidal(&mock.app(), "", &p).await;
        let p = r.payload.unwrap();
        assert_eq!(p["token"], "fresh-access");
        assert_eq!(
            p["refreshToken"],
            if rotated { "fresh-refresh" } else { "spent" }
        );
        assert_eq!(p["countryCode"], "US");
    }
}
#[tokio::test]
async fn early_renewal_then_rejected_session_has_a_dead_verdict() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let n = Arc::new(AtomicUsize::new(0));
    let count = n.clone();
    let mock = Mock::new(move |r| {
        let (s, b) = if r.path == "/token" && count.fetch_add(1, Ordering::SeqCst) == 0 {
            (200, r#"{"access_token":"fresh","refresh_token":"rotated"}"#)
        } else if r.path == "/token" {
            (429, r#"{"error":"abuse_detected"}"#)
        } else {
            (401, "{}")
        };
        Response::builder().status(s).body(Body::from(b)).unwrap()
    })
    .await;
    let expired = format!("e30.{}.signature", URL_SAFE_NO_PAD.encode(br#"{"exp":1}"#));
    let result = tidal_account(
        &mock.app(),
        &json!({"token":expired,"refreshToken":"spent"}),
        "",
    )
    .await;
    assert!(!result.skipped);
    assert!(!result.ok);
    assert_eq!(result.status, "dead");
}
#[tokio::test]
async fn apple_checks_entitlement_and_playable_flavors() {
    let dev = format!(
        "eyJhbGciOiJFUzI1NiJ9.{}.signature123456",
        URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&json!({"iss":"AMPWebPlay","exp":Utc::now().timestamp()+3600}))
                .unwrap()
        )
    );
    for (active, body, status) in [
        (
            true,
            r#"{"songList":[{"assets":[{"flavor":"28:ctrp256","URL":"https://example.invalid/stream"}]}]}"#,
            "preview",
        ),
        (
            true,
            r#"{"songList":[{"assets":[{"flavor":"28:ctrp1411","URL":"https://example.invalid/stream"}]}]}"#,
            "alive",
        ),
        (
            true,
            r#"{"failureType":2002,"customerMessage":"session has ended"}"#,
            "dead",
        ),
        (false, "{}", "preview"),
    ] {
        let token = dev.clone();
        let mock = Mock::new(move |r| {
            let body = match r.path.as_str() {
                "/" => "<script src=\"assets/index-test.js\"></script>".to_owned(),
                "/assets/index-test.js" => token.clone(),
                "/v1/me/account" => format!(
                    r#"{{"meta":{{"subscription":{{"active":{active},"storefront":"us"}}}}}}"#
                ),
                "/playback" => {
                    assert_eq!(r.headers["media-user-token"], "0.local-token");
                    let p: Value = serde_json::from_slice(&r.body).unwrap();
                    assert!(p["salableAdamId"].is_string());
                    body.to_owned()
                }
                _ => panic!("unexpected local probe"),
            };
            Response::builder()
                .status(200)
                .body(Body::from(body))
                .unwrap()
        })
        .await;
        assert_eq!(
            apple_account(&mock.app(), &json!({"token":"0.local-token"}))
                .await
                .status,
            status
        );
    }
}
