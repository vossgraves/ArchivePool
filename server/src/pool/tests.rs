use super::*;
use serde_json::json;
#[test]
fn fingerprints_match_typescript_vectors() {
    for (service, kind, p, expected) in [
        (
            "tidal",
            "api",
            json!({"baseUrl":"HTTPS://Example.com/Foo//"}),
            "53fb893fc19b7e5c5cbacd7b299ef11dacb4f7fc0790fdb6c713814f0eb41344",
        ),
        (
            "tidal",
            "api",
            json!({"baseUrl":""}),
            "defc41bd73910cb2af94de803b08e07364dcc94d5ae3d5366baa4ae603bbc34a",
        ),
        (
            "tidal",
            "account",
            json!({"token":"  tok123 "}),
            "1335de144f38bc29ac5e9b2b8492050f3e36ab94b8d6e4cd9d088d15f7591d55",
        ),
        (
            "qobuz",
            "account",
            json!({"username":"User@Example.com","password":"pw"}),
            "7aaa0bec306a3c7955b1716d907e0c6ace879f264dcd7bd7168576a30c43c20b",
        ),
        (
            "qobuz",
            "account",
            json!({"token":"qtok"}),
            "d71b5728b9ba64502ef423087f60e0be22d639bcd0c48fc93998c6c85cc9207a",
        ),
        (
            "deezer",
            "account",
            json!({"arl":"abcDEF123"}),
            "24aa1863519b5335c2dd1fcd30f47af67520aa92cac0133f73aa4c008780e0c7",
        ),
        (
            "amazon-music",
            "account",
            json!({"session":"  sess-xyz  "}),
            "b6e8a0491012f6b01600c2f1a0938fe7f582b8f244f085e851c37a1b55fbe87a",
        ),
        (
            "amazon-music",
            "api",
            json!({"baseUrl":"HTTPS://Inst.example.com/Foo//","bypassToken":"btok","turnstileJwt":"jwt"}),
            "50ada1eaca9c9d347a2f49cb5011ec595432b06bce8dbc1e801ad72de49f31fc",
        ),
        (
            "apple-music",
            "account",
            json!({"token":"0.abc"}),
            "9e5a2200f2ba6f2b095e18961608a96f2487c412866964a02148d281495d238a",
        ),
    ] {
        assert_eq!(fingerprint(service, kind, &p), expected);
    }
    assert_ne!(
        fingerprint(
            "tidal",
            "api",
            &json!({"baseUrl":"https://example.invalid"})
        ),
        fingerprint(
            "qobuz",
            "api",
            &json!({"baseUrl":"https://example.invalid"})
        )
    );
}
#[test]
fn normalization_labels_blocklist_and_categories() {
    assert_eq!(
        normalize_url(" HTTPS://Example.com/Foo//  "),
        "https://example.com/foo"
    );
    assert_eq!(CATEGORIES.len(), 9);
    for (url, blocked) in [
        ("https://triton.squid.wtf", true),
        ("https://Triton.Squid.WTF/", true),
        ("https://squid.wtf", false),
        ("https://notsquid.wtf.evil.example", false),
        ("not a url", false),
    ] {
        assert_eq!(blocked_instance(url), blocked);
    }
    for (service, kind, p, label) in [
        (
            "tidal",
            "api",
            json!({"baseUrl":"https://api.example.com:8443/path"}),
            "Tidal API · api.example.com:8443",
        ),
        ("qobuz", "api", json!({"baseUrl":"not-a-url"}), "Qobuz API"),
        (
            "deezer",
            "account",
            json!({"arl":"abcdef1234"}),
            "Deezer Account · ****1234",
        ),
        (
            "tidal",
            "account",
            json!({"username":"a"}),
            "Tidal Account · a",
        ),
        (
            "tidal",
            "account",
            json!({"username":"alice"}),
            "Tidal Account · al…",
        ),
        (
            "amazon-music",
            "account",
            json!({"session":"sess12345"}),
            "Amazon Music Account · ****2345",
        ),
        ("apple-music", "account", json!({}), "Apple Music Account"),
    ] {
        assert_eq!(mask_label(service, kind, &p), label);
    }
    assert!(SERVICES.iter().all(|s| is_service(s)));
    assert!(!is_service("spotify"));
}
