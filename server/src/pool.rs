use crate::{api::string, crypto};
use serde_json::Value;
pub const SERVICES: &[&str] = &["tidal", "qobuz", "deezer", "apple-music", "amazon-music"];
pub const CATEGORIES: &[(&str, &str, &str)] = &[
    ("tidal", "api", "Tidal API"),
    ("tidal", "account", "Tidal Account"),
    ("qobuz", "api", "Qobuz API"),
    ("qobuz", "account", "Qobuz Account"),
    ("deezer", "api", "Deezer API"),
    ("deezer", "account", "Deezer Account"),
    ("apple-music", "account", "Apple Music Account"),
    ("amazon-music", "api", "Amazon Music API"),
    ("amazon-music", "account", "Amazon Music Account"),
];
pub fn is_service(s: &str) -> bool {
    SERVICES.contains(&s)
}
pub fn normalize_url(s: &str) -> String {
    s.trim().trim_end_matches('/').to_lowercase()
}
pub fn blocked_instance(s: &str) -> bool {
    url::Url::parse(s)
        .ok()
        .and_then(|u| {
            u.host_str()
                .map(|h| h.to_lowercase().ends_with(".squid.wtf"))
        })
        .unwrap_or(false)
}
pub fn fingerprint(service: &str, kind: &str, payload: &Value) -> String {
    let basis = if kind == "api" {
        normalize_url(&string(payload, "baseUrl"))
    } else if service == "deezer" {
        string(payload, "arl").trim().to_owned()
    } else if service == "amazon-music" {
        string(payload, "session").trim().to_owned()
    } else {
        let token = string(payload, "token").trim().to_owned();
        if !token.is_empty() {
            token
        } else {
            format!(
                "{}:{}",
                string(payload, "username").trim().to_lowercase(),
                string(payload, "password").trim()
            )
        }
    };
    hex::encode(crypto::sha256(format!("{service}|{kind}|{basis}")))
}
pub fn mask_label(service: &str, kind: &str, p: &Value) -> String {
    let svc = match service {
        "tidal" => "Tidal",
        "qobuz" => "Qobuz",
        "deezer" => "Deezer",
        "apple-music" => "Apple Music",
        _ => "Amazon Music",
    };
    if kind == "api" {
        return match url::Url::parse(&string(p, "baseUrl")) {
            Ok(u) if u.host_str().is_some() => format!(
                "{svc} API · {}{}",
                u.host_str().unwrap(),
                u.port().map(|p| format!(":{p}")).unwrap_or_default()
            ),
            _ => format!("{svc} API"),
        };
    }
    let tail = |s: &str| {
        s.chars()
            .rev()
            .take(4)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<String>()
    };
    if service == "deezer" {
        let arl = string(p, "arl");
        return if arl.is_empty() {
            format!("{svc} Account")
        } else {
            format!("{svc} Account · ****{}", tail(arl.trim()))
        };
    }
    let user = string(p, "username");
    if !user.trim().is_empty() {
        let n = user.trim().chars().count();
        return format!(
            "{svc} Account · {}{}",
            user.trim()
                .chars()
                .take(if n <= 2 { 1 } else { 2 })
                .collect::<String>(),
            if n > 2 { "…" } else { "" }
        );
    }
    for field in ["token", "session"] {
        let token = string(p, field);
        if !token.trim().is_empty() {
            return format!("{svc} Account · ****{}", tail(token.trim()));
        }
    }
    format!("{svc} Account")
}
pub mod leases;
pub mod status;
#[cfg(test)]
mod tests;
