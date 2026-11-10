use crate::{
    App,
    api::{boolean, integer, number, string},
    crypto,
    db::{self, Arg},
    httpx::{self, Response, headers},
    pool,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Utc};
use futures_util::{StreamExt, stream};
use reqwest::{Method, header::HeaderMap};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::Digest;
use std::{
    sync::{Arc, LazyLock},
    time::{Duration, Instant},
};
const TIDAL_UA: &str = "TIDAL/1000 (Linux; Android 10)";
pub const TIDAL_CLIENT_ID: &str = "fX2JxdmntZWK0ixT";
#[cfg(test)]
mod database_tests;
#[cfg(test)]
mod tests;
pub const TIDAL_CLIENT_SECRET: &str = "1Nn9AfDAjxrgJFJbKNWLeAyKGVGmINuXPPLHVXAvxAg=";
pub const QOBUZ_LOGIN_ID: &str = "712109809";
pub const QOBUZ_LOGIN_SECRET: &str = "589be88e4538daea11f509d29e4a23b1";
pub mod sync;
static HIRES: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(
        r#"hi_res|hires|lossless|flac|24bit|"quality"\s*:\s*"(lossless|hi_res|hi-res)"#,
    )
    .unwrap()
});
static QPREMIUM: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r#"lossless|hi-res|hires|studio|sublime|"format_id"\s*:\s*(6|7|27)"#).unwrap()
});
#[derive(Clone)]
pub struct Endpoints {
    pub tidal_token: String,
    pub tidal_sessions: String,
    pub tidal_users: String,
    pub tidal_device: String,
    pub qobuz_api: String,
    pub qobuz_play: String,
    pub qobuz_open: String,
    pub deezer: String,
    pub apple_home: String,
    pub apple_api: String,
    pub apple_playback: String,
    pub monochrome: String,
    pub github_token: String,
    pub github_user: String,
}
impl Default for Endpoints {
    fn default() -> Self {
        Self {
            tidal_token: "https://auth.tidal.com/v1/oauth2/token".into(),
            tidal_sessions: "https://api.tidal.com/v1/sessions".into(),
            tidal_users: "https://api.tidal.com/v1/users".into(),
            tidal_device: "https://auth.tidal.com/v1/oauth2/device_authorization".into(),
            qobuz_api: "https://www.qobuz.com/api.json/0.2".into(),
            qobuz_play: "https://play.qobuz.com".into(),
            qobuz_open: "https://open.qobuz.com".into(),
            deezer: "https://www.deezer.com/ajax/gw-light.php".into(),
            apple_home: "https://music.apple.com/".into(),
            apple_api: "https://amp-api.music.apple.com".into(),
            apple_playback: "https://play.itunes.apple.com/WebObjects/MZPlay.woa/wa/webPlayback"
                .into(),
            monochrome: "https://monochrome.st/instances.json".into(),
            github_token: "https://github.com/login/oauth/access_token".into(),
            github_user: "https://api.github.com/user".into(),
        }
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub ok: bool,
    pub premium: bool,
    pub status: String,
    pub latency_ms: i32,
    pub detail: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub skipped: bool,
    #[serde(skip)]
    pub payload: Option<Value>,
    #[serde(skip)]
    pub stored_payload: Option<Value>,
}
impl Check {
    pub fn new(ok: bool, premium: bool, ms: i32, detail: impl Into<String>) -> Self {
        Self {
            ok,
            premium,
            status: classify(ok, premium).into(),
            latency_ms: ms,
            detail: detail.into(),
            skipped: false,
            payload: None,
            stored_payload: None,
        }
    }
    pub fn dead(detail: impl Into<String>) -> Self {
        Self::new(false, false, 0, detail)
    }
    pub fn skip(detail: impl Into<String>) -> Self {
        let mut c = Self::dead(detail);
        c.status = "pending".into();
        c.skipped = true;
        c
    }
}
pub fn classify(ok: bool, premium: bool) -> &'static str {
    if !ok {
        "dead"
    } else if premium {
        "alive"
    } else {
        "preview"
    }
}
pub fn jwt_payload(token: &str) -> Option<Value> {
    let p = token.split('.').nth(1)?;
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(p.trim_end_matches('=')).ok()?).ok()
}
pub fn tidal_refresh_token(token: &str) -> bool {
    jwt_payload(token).is_some_and(|p| p["type"] == "o2_refresh")
}
pub fn tidal_access_expired(token: &str, now: i64) -> bool {
    jwt_payload(token)
        .and_then(|p| p["exp"].as_f64())
        .is_some_and(|exp| exp > 0. && exp <= (now + 300) as f64)
}
pub fn effective_refresh(p: &Value) -> String {
    let r = string(p, "refreshToken").trim().to_owned();
    if r.is_empty() {
        string(p, "token").trim().to_owned()
    } else {
        r
    }
}
pub fn stored_refresh_rotated(p: &Value, spent: &str) -> bool {
    let current = effective_refresh(p);
    !current.is_empty() && !crypto::secret_matches(&current, spent)
}
pub fn tidal_premium(body: &str) -> bool {
    let Ok(p) = serde_json::from_str::<Value>(body) else {
        return true;
    };
    if !p.is_object() {
        return true;
    }
    if let Some(p) = p["premiumAccess"].as_bool() {
        return p;
    }
    if p["subscription"]["type"]
        .as_str()
        .is_some_and(|s| s.eq_ignore_ascii_case("FREE"))
    {
        return false;
    }
    let quality = p["highestSoundQuality"]
        .as_str()
        .unwrap_or("")
        .to_ascii_uppercase();
    quality.is_empty() || quality == "LOSSLESS" || quality.starts_with("HI_RES")
}
pub fn manifest_presentation(p: &Value) -> Option<String> {
    let attr = if p["data"]["data"]["attributes"].is_object() {
        &p["data"]["data"]["attributes"]
    } else {
        &p["data"]["attributes"]
    };
    let track = attr["trackPresentation"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_owned();
    let asset = attr["assetPresentation"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_owned();
    if !track.is_empty() {
        Some(track)
    } else if !asset.is_empty() {
        Some(asset)
    } else {
        None
    }
}
fn join(base: &str, path: &str) -> String {
    if path.starts_with("http") {
        path.into()
    } else if path.is_empty() {
        base.trim_end_matches('/').into()
    } else {
        format!(
            "{}/{}",
            base.trim_end_matches('/'),
            path.trim_start_matches('/')
        )
    }
}
fn query_url(base: &str, path: &str, values: &[(&str, String)]) -> String {
    let mut url = url::Url::parse(&join(base, path)).unwrap();
    for (k, v) in values {
        url.query_pairs_mut().append_pair(k, v);
    }
    url.into()
}
async fn get(app: &App, url: &str, h: HeaderMap) -> Result<(Response, i32), Box<Check>> {
    let start = Instant::now();
    let r = app
        .outbound
        .get(url, h)
        .await
        .map_err(|e| Check::dead(e.to_string()))?;
    Ok((r, start.elapsed().as_millis() as i32))
}
fn token_headers(token: &str) -> HeaderMap {
    headers(&[
        ("authorization", &format!("Bearer {token}")),
        ("user-agent", TIDAL_UA),
    ])
}
pub async fn instance_check(app: &App, service: &str, p: &Value) -> Check {
    let base = string(p, "baseUrl").trim().trim_end_matches('/').to_owned();
    if base.is_empty() {
        return Check::dead("missing baseUrl");
    }
    if service == "tidal" {
        let id = string(p, "probeTrackId");
        let id = if id.trim().is_empty() {
            "155142501534011392"
        } else {
            id.trim()
        };
        let target = match url::Url::parse(&base) {
            Ok(_) => query_url(
                &base,
                "trackManifests/",
                &[
                    ("id", id.into()),
                    ("formats", "FLAC".into()),
                    ("adaptive", "false".into()),
                    ("manifestType", "MPEG_DASH".into()),
                    ("uriScheme", "HTTPS".into()),
                    ("usage", "PLAYBACK".into()),
                ],
            ),
            Err(_) => return Check::dead("fetch failed"),
        };
        let h = headers(&[
            ("accept", "application/json"),
            ("user-agent", "ArchiveTune-Android"),
        ]);
        let (r, mut ms) = match get(app, &target, h.clone()).await {
            Ok(v) => v,
            Err(c) => return *c,
        };
        if r.status == 429 {
            let mut c = Check::skip(format!("trackManifests HTTP 429 (rate limited, {id})"));
            c.latency_ms = ms;
            return c;
        }
        if r.ok() {
            let Some(presentation) = manifest_presentation(&r.json()) else {
                return Check::new(
                    false,
                    false,
                    ms,
                    format!("trackManifests answered without a manifest document ({id})"),
                );
            };
            return Check::new(
                true,
                !presentation.eq_ignore_ascii_case("PREVIEW"),
                ms,
                format!("trackManifests {presentation} ({id})"),
            );
        }
        if ![404, 405, 501].contains(&r.status) {
            return Check::new(
                false,
                false,
                ms,
                format!("trackManifests HTTP {}", r.status),
            );
        }
        let target = query_url(
            &base,
            "track/",
            &[("id", id.into()), ("quality", "LOSSLESS".into())],
        );
        let (r, m) = match get(app, &target, h).await {
            Ok(v) => v,
            Err(mut c) => {
                c.latency_ms = ms;
                return *c;
            }
        };
        ms += m;
        if r.status == 429 {
            let mut c = Check::skip(format!("track HTTP 429 (rate limited, {id})"));
            c.latency_ms = ms;
            return c;
        }
        if !r.ok() {
            return Check::new(false, false, ms, format!("track HTTP {}", r.status));
        }
        let p = r.json();
        let data = &p["data"];
        if string(data, "assetPresentation").is_empty() && string(data, "manifest").is_empty() {
            return Check::new(
                false,
                false,
                ms,
                format!("track answered without a data object ({id})"),
            );
        }
        if string(data, "assetPresentation").eq_ignore_ascii_case("PREVIEW") {
            return Check::new(true, false, ms, format!("track PREVIEW ({id})"));
        }
        if string(data, "manifest").trim().is_empty() {
            return Check::new(
                false,
                false,
                ms,
                format!("track answered but served no manifest ({id})"),
            );
        }
        return Check::new(true, true, ms, format!("track LOSSLESS ({id})"));
    }
    let special = ["amazon-music", "deezer"].contains(&service);
    let path = string(p, "healthPath");
    let target = join(
        &base,
        if special && path.trim().is_empty() {
            "/health"
        } else {
            path.trim()
        },
    );
    let (r, ms) = match get(app, &target, HeaderMap::new()).await {
        Ok(v) => v,
        Err(c) => return *c,
    };
    if (special && !r.ok()) || (!special && r.status >= 500) {
        return Check::new(false, false, ms, format!("HTTP {}", r.status));
    }
    if special {
        let parsed = r.json();
        if parsed.is_null() {
            return Check::new(false, false, ms, "health response is not JSON");
        }
        if service == "amazon-music" {
            if !parsed.is_object() || parsed["status"].is_null() {
                return Check::new(false, false, ms, "health response has no status");
            }
            let status = string(&parsed, "status").trim().to_owned();
            if status.is_empty() {
                return Check::new(false, false, ms, "health response has an empty status");
            }
            if [
                "error",
                "err",
                "fail",
                "failed",
                "failure",
                "down",
                "dead",
                "unhealthy",
                "unavailable",
                "offline",
                "disabled",
            ]
            .contains(&status.to_lowercase().as_str())
            {
                return Check::new(false, false, ms, format!("status: {status}"));
            }
        } else {
            if !parsed.is_object() {
                return Check::new(false, false, ms, "health response is not an object");
            }
            if parsed["ok"] == false {
                return Check::new(false, false, ms, "status: not ok");
            }
            if parsed["accounts"].is_object() {
                let a = &parsed["accounts"];
                if number(&a["total"]) > 0.
                    && number(&a["available"]) == 0.
                    && number(&a["cooling"]) == 0.
                {
                    return Check::new(false, false, ms, "no accounts available");
                }
            } else if !parsed["user"].is_object() && parsed["ok"] != true {
                return Check::new(false, false, ms, "health response has no status");
            }
        }
    }
    let mut premium = special && HIRES.is_match(&r.text().to_lowercase());
    let probe = string(p, "probeUrl");
    if !special || !probe.trim().is_empty() {
        let probe = if probe.trim().is_empty() {
            target
        } else {
            join(&base, probe.trim())
        };
        premium = get(app, &probe, HeaderMap::new())
            .await
            .is_ok_and(|(r, _)| HIRES.is_match(&r.text().to_lowercase()));
    }
    Check::new(true, premium, ms, format!("HTTP {}", r.status))
}

struct Refresh {
    payload: Option<Value>,
    stored: Option<Value>,
    detail: String,
    skip: bool,
}
impl Refresh {
    fn failure(detail: &str, skip: bool) -> Self {
        Self {
            payload: None,
            stored: None,
            detail: detail.into(),
            skip,
        }
    }
    fn check(self) -> Check {
        let mut c = if self.skip {
            Check::skip(self.detail)
        } else {
            Check::dead(self.detail)
        };
        c.payload = self.payload;
        c.stored_payload = self.stored;
        c
    }
}
struct Gate {
    claim: Option<String>,
    payload: Value,
    stored: Option<Value>,
    backoff: Option<i32>,
    serve: bool,
}
async fn refresh_row(app: &App, fp: &str) -> db::Result<Option<Value>> {
    app.db.one("select payload,refresh_in_flight_until,refresh_cooldown_until,refresh_backoff_ms from account_entries where fingerprint=$1 limit 1",vec![fp.into()]).await
}
fn live(value: &Value) -> bool {
    value
        .as_str()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .is_some_and(|d| d > Utc::now())
}
async fn gate(app: &App, fp: &str, p: &Value, global: bool) -> Result<Gate, Box<Refresh>> {
    if fp.is_empty() {
        return Ok(Gate {
            claim: None,
            payload: p.clone(),
            stored: None,
            backoff: None,
            serve: false,
        });
    }
    let row = refresh_row(app, fp)
        .await
        .map_err(|_| Refresh::failure("refresh unavailable", true))?;
    let Some(row) = row else {
        return Ok(Gate {
            claim: None,
            payload: p.clone(),
            stored: None,
            backoff: None,
            serve: false,
        });
    };
    if live(&row["refresh_cooldown_until"]) {
        return Err(Refresh::failure("refresh cooling", true).into());
    }
    if global {
        let active = app
            .db
            .one(
                "select value from pool_state where key='tidal_refresh_abuse' limit 1",
                vec![],
            )
            .await
            .ok()
            .flatten()
            .is_some_and(|r| {
                r["value"]["global_until"]
                    .as_f64()
                    .is_some_and(|v| v > Utc::now().timestamp() as f64)
                    || live(&r["value"]["globalUntil"])
            });
        if active {
            return Err(Refresh::failure("shared Tidal refresh backoff", true).into());
        }
    }
    let row=app.db.one("update account_entries set refresh_in_flight_until=now()+interval '60 seconds' where fingerprint=$1 and (refresh_in_flight_until is null or refresh_in_flight_until<now()) and (refresh_cooldown_until is null or refresh_cooldown_until<=now()) returning refresh_in_flight_until::text as claim,payload,refresh_backoff_ms",vec![fp.into()]).await.map_err(|_|Refresh::failure("refresh unavailable",true))?;
    if let Some(row) = row {
        return Ok(Gate {
            claim: Some(string(&row, "claim")),
            payload: crypto::decrypt(&row["payload"], app.config.encryption_key.as_ref()),
            stored: Some(row["payload"].clone()),
            backoff: row["refresh_backoff_ms"].as_i64().map(|v| v as i32),
            serve: false,
        });
    }
    for _ in 0..3 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let Some(row) = refresh_row(app, fp).await.ok().flatten() else {
            return Err(Refresh::failure("entry removed mid-refresh", true).into());
        };
        if live(&row["refresh_in_flight_until"]) {
            continue;
        }
        let plain = crypto::decrypt(&row["payload"], app.config.encryption_key.as_ref());
        let fresh = string(&plain, "token");
        if !fresh.is_empty() && !crypto::secret_matches(&fresh, &string(p, "token")) {
            return Ok(Gate {
                claim: None,
                payload: plain,
                stored: Some(row["payload"].clone()),
                backoff: None,
                serve: true,
            });
        }
        return Err(Refresh::failure(
            if live(&row["refresh_cooldown_until"]) {
                "refresh cooling"
            } else {
                "refresh attempted by another instance"
            },
            true,
        )
        .into());
    }
    Err(Refresh::failure("refresh claim held elsewhere", true).into())
}
async fn finish(
    app: &App,
    fp: &str,
    claim: Option<&str>,
    payload: Option<&Value>,
    next_fp: Option<&str>,
    cooldown: Option<DateTime<Utc>>,
    backoff: Option<i32>,
) -> Option<Value> {
    if fp.is_empty() {
        return None;
    }
    let stored =
        payload.and_then(|p| crypto::encrypt_at_rest(p, app.config.encryption_key.as_ref()).ok());
    let sql = "update account_entries set refresh_in_flight_until=null,payload=coalesce($1,payload),fingerprint=coalesce($2,fingerprint),refresh_cooldown_until=case when $1 is not null then null else coalesce($3,refresh_cooldown_until) end,refresh_backoff_ms=case when $1 is not null then null else coalesce($4,refresh_backoff_ms) end where fingerprint=$5 and ($6::text is null or refresh_in_flight_until=$6::timestamptz) returning payload";
    let args = vec![
        stored
            .clone()
            .map(Arg::Json)
            .unwrap_or(Arg::Json(Value::Null)),
        next_fp.map(str::to_owned).into(),
        cooldown.into(),
        backoff.into(),
        fp.into(),
        claim.map(str::to_owned).into(),
    ];
    // SQL NULL keeps a failed refresh from replacing the stored credential with JSON null.
    let mut args = args;
    if stored.is_none() {
        args[0] = Arg::NullJson;
    }
    app.db
        .one(sql, args)
        .await
        .ok()
        .flatten()
        .and_then(|row| stored.map(|_| row["payload"].clone()))
}
pub fn next_abuse_backoff(previous: Option<i32>) -> i32 {
    previous
        .filter(|n| *n > 0)
        .map(|n| n.saturating_mul(2).min(21600000))
        .unwrap_or(900000)
}
async fn record_abuse(app: &App) {
    let _=app.db.exec("insert into pool_state(key,value) values('tidal_refresh_abuse',jsonb_build_object('hits',1,'window_start',extract(epoch from now()),'global_until',0)) on conflict(key) do update set value=jsonb_build_object('hits',case when extract(epoch from now())-coalesce((pool_state.value->>'window_start')::float,0)>60 then 1 else coalesce((pool_state.value->>'hits')::int,0)+1 end,'window_start',case when extract(epoch from now())-coalesce((pool_state.value->>'window_start')::float,0)>60 then extract(epoch from now()) else coalesce((pool_state.value->>'window_start')::float,extract(epoch from now())) end,'global_until',case when (case when extract(epoch from now())-coalesce((pool_state.value->>'window_start')::float,0)>60 then 1 else coalesce((pool_state.value->>'hits')::int,0)+1 end)>=5 then extract(epoch from now())+120 else coalesce((pool_state.value->>'global_until')::float,0) end),updated_at=now()",vec![]).await;
}
async fn refresh_tidal(app: &App, fp: &str, p: &Value) -> Refresh {
    let g = match gate(app, fp, p, true).await {
        Ok(g) => g,
        Err(r) => return *r,
    };
    if g.serve {
        return Refresh {
            payload: Some(g.payload),
            stored: g.stored,
            detail: "served after another check's refresh".into(),
            skip: false,
        };
    }
    let refresh = effective_refresh(&g.payload);
    if refresh.is_empty() {
        finish(app, fp, g.claim.as_deref(), None, None, None, None).await;
        return Refresh::failure("no refresh token", false);
    }
    for scope in ["r_usr+w_usr+w_sub", "r_usr+w_usr"] {
        let res = app
            .outbound
            .form(
                &app.endpoints.tidal_token,
                headers(&[("user-agent", TIDAL_UA)]),
                &[
                    ("client_id", TIDAL_CLIENT_ID.into()),
                    ("client_secret", TIDAL_CLIENT_SECRET.into()),
                    ("refresh_token", refresh.clone()),
                    ("grant_type", "refresh_token".into()),
                    ("scope", scope.into()),
                ],
            )
            .await;
        let r = match res {
            Ok(r) => r,
            Err(_) => {
                finish(
                    app,
                    fp,
                    g.claim.as_deref(),
                    None,
                    None,
                    Some(Utc::now() + chrono::Duration::seconds(120)),
                    None,
                )
                .await;
                return Refresh::failure("refresh threw", true);
            }
        };
        let body = r.json();
        if r.ok() {
            let token = string(&body, "access_token");
            if token.is_empty() {
                finish(app, fp, g.claim.as_deref(), None, None, None, None).await;
                return Refresh::failure("refresh returned no access token", false);
            }
            let mut next = g.payload.clone();
            next["token"] = json!(token);
            let rotated = string(&body, "refresh_token");
            next["refreshToken"] = json!(if rotated.is_empty() { refresh } else { rotated });
            let stored = finish(app, fp, g.claim.as_deref(), Some(&next), None, None, None).await;
            if g.claim.is_some() && stored.is_none() {
                return Refresh::failure("credential changed during refresh", true);
            }
            return Refresh {
                payload: Some(next),
                stored,
                detail: "refreshed".into(),
                skip: false,
            };
        }
        let code = string(&body, "error");
        let abuse = format!("{} {}", code, string(&body, "error_description"))
            .to_lowercase()
            .contains("abuse");
        if r.status == 429 || abuse {
            let backoff = next_abuse_backoff(g.backoff);
            let until = Utc::now() + chrono::Duration::milliseconds(backoff as i64);
            finish(
                app,
                fp,
                g.claim.as_deref(),
                None,
                None,
                Some(until),
                Some(backoff),
            )
            .await;
            record_abuse(app).await;
            return Refresh::failure(
                &format!(
                    "refresh rate-limited, cooling until {}",
                    until.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
                ),
                true,
            );
        }
        if r.status >= 500 {
            finish(
                app,
                fp,
                g.claim.as_deref(),
                None,
                None,
                Some(Utc::now() + chrono::Duration::seconds(120)),
                None,
            )
            .await;
            return Refresh::failure(&format!("refresh transient (HTTP {})", r.status), true);
        }
        if code != "invalid_scope" {
            let rotated = if code == "invalid_grant" && !fp.is_empty() {
                refresh_row(app, fp)
                    .await
                    .ok()
                    .flatten()
                    .is_some_and(|row| {
                        stored_refresh_rotated(
                            &crypto::decrypt(&row["payload"], app.config.encryption_key.as_ref()),
                            &refresh,
                        )
                    })
            } else {
                false
            };
            finish(app, fp, g.claim.as_deref(), None, None, None, None).await;
            if rotated {
                return Refresh::failure("credential rotated during refresh", true);
            }
            return Refresh::failure(
                if code == "invalid_grant" {
                    "refresh rejected: invalid_grant"
                } else if code == "invalid_client" {
                    "refresh client retired by Tidal"
                } else {
                    "refresh rejected"
                },
                false,
            );
        }
    }
    finish(app, fp, g.claim.as_deref(), None, None, None, None).await;
    Refresh::failure("refresh failed", false)
}
pub async fn fresh_tidal(app: &App, fp: &str, p: &Value) -> Option<Value> {
    let token = string(p, "token").trim().to_owned();
    if token.is_empty() {
        return None;
    }
    if tidal_refresh_token(&token) || !tidal_access_expired(&token, Utc::now().timestamp()) {
        return Some(p.clone());
    }
    refresh_tidal(app, fp, p).await.payload
}
async fn tidal_account(app: &App, p: &Value, fp: &str) -> Check {
    let mut current = p.clone();
    let mut token = string(p, "token").trim().to_owned();
    let mut stored = None;
    let mut early_refreshed = false;
    if token.is_empty() {
        return Check::dead("missing token");
    }
    if tidal_refresh_token(&token) || tidal_access_expired(&token, Utc::now().timestamp()) {
        let r = refresh_tidal(app, fp, &current).await;
        let Some(next) = r.payload else {
            return r.check();
        };
        token = string(&next, "token");
        current = next;
        stored = r.stored;
        early_refreshed = true;
    }
    let (mut res, mut ms) =
        match get(app, &app.endpoints.tidal_sessions, token_headers(&token)).await {
            Ok(v) => v,
            Err(mut c) => {
                c.stored_payload = stored;
                return *c;
            }
        };
    if res.status == 401 {
        let r = refresh_tidal(app, fp, &current).await;
        let Some(next) = r.payload else {
            let mut c = r.check();
            c.stored_payload = stored;
            if early_refreshed {
                c.skipped = false;
                c.status = "dead".into();
                c.detail = "token rejected".into();
            }
            return c;
        };
        token = string(&next, "token");
        current = next;
        stored = r.stored;
        let retry = get(app, &app.endpoints.tidal_sessions, token_headers(&token)).await;
        match retry {
            Ok((r, m)) => {
                res = r;
                ms = m;
            }
            Err(mut c) => {
                c.stored_payload = stored;
                return *c;
            }
        }
    }
    let mut result = if [401, 403].contains(&res.status) {
        Check::new(false, false, ms, "token rejected")
    } else if !res.ok() {
        Check::new(false, false, ms, format!("HTTP {}", res.status))
    } else {
        let session = res.json();
        let mut premium = true;
        if session["userId"].as_i64().is_some_and(|n| n != 0)
            && !string(&session, "countryCode").is_empty()
        {
            let url = query_url(
                &app.endpoints.tidal_users,
                &format!("{}/subscription", session["userId"]),
                &[("countryCode", string(&session, "countryCode"))],
            );
            if let Ok((r, _)) = get(app, &url, token_headers(&token)).await
                && r.ok()
            {
                premium = tidal_premium(&r.text());
            }
        }
        Check::new(true, premium, ms, "session ok")
    };
    result.payload = Some(current);
    result.stored_payload = stored;
    result
}
#[derive(Clone)]
pub struct QobuzLogin {
    pub token: String,
    pub user_id: String,
    pub country: String,
    pub username: String,
}
pub async fn qobuz_login(
    app: &App,
    username: &str,
    password: &str,
    app_id: &str,
) -> Result<QobuzLogin, String> {
    let r = app
        .outbound
        .form(
            &join(&app.endpoints.qobuz_api, "user/login"),
            headers(&[("x-app-id", app_id), ("user-agent", httpx::BROWSER_UA)]),
            &[
                ("username", username.into()),
                ("email", username.into()),
                ("password", password.into()),
                ("app_id", app_id.into()),
            ],
        )
        .await
        .map_err(|e| e.to_string())?;
    if [400, 401].contains(&r.status) {
        return Err("Incorrect email or password.".into());
    }
    if !r.ok() {
        return Err(format!("Qobuz login failed: HTTP {}", r.status));
    }
    let p = r.json();
    let token = string(&p, "user_auth_token");
    if token.is_empty() {
        return Err("Login rejected: no token returned".into());
    }
    Ok(QobuzLogin {
        token,
        user_id: string(&p["user"], "id"),
        country: string(&p["user"], "country_code"),
        username: p["user"]["login"].as_str().unwrap_or(username).to_owned(),
    })
}
pub async fn scrape_qobuz(app: &App, app_id: &str) -> String {
    let origin = if app_id == QOBUZ_LOGIN_ID {
        &app.endpoints.qobuz_open
    } else {
        &app.endpoints.qobuz_play
    };
    let page = if app_id == QOBUZ_LOGIN_ID {
        join(origin, "/")
    } else {
        join(origin, "login")
    };
    let Ok((res, _)) = get(app, &page, headers(&[("user-agent", httpx::BROWSER_UA)])).await else {
        return String::new();
    };
    if !res.ok() {
        return String::new();
    }
    let scripts = regex::Regex::new(r#"(?i)<script[^>]+src="([^"]+\.js[^"]*)"[^>]*>"#).unwrap();
    let secret =
        regex::Regex::new(r#"(?i)(?:app_secret|secret|seed)\s*[:=]\s*"([a-f0-9]{32})""#).unwrap();
    for m in scripts.captures_iter(&res.text()).take(6) {
        let url = join(origin, &m[1]);
        if let Ok((res, _)) = get(app, &url, headers(&[("user-agent", httpx::BROWSER_UA)])).await
            && res.ok()
            && let Some(c) = secret.captures(&res.text())
        {
            return c[1].to_owned();
        }
    }
    String::new()
}
pub async fn qobuz_secret(
    app: &App,
    app_id: &str,
    secret: &str,
    token: &str,
) -> (bool, String, i32) {
    let ts = Utc::now().timestamp().to_string();
    let sig = hex::encode(md5::Md5::digest(format!(
        "trackgetFileUrlformat_id5intentstreamtrack_id5966783{ts}{secret}"
    )));
    let url = query_url(
        &app.endpoints.qobuz_api,
        "track/getFileUrl",
        &[
            ("request_ts", ts),
            ("request_sig", sig),
            ("track_id", "5966783".into()),
            ("format_id", "5".into()),
            ("intent", "stream".into()),
            ("app_id", app_id.into()),
            ("user_auth_token", token.into()),
        ],
    );
    match get(
        app,
        &url,
        headers(&[
            ("x-app-id", app_id),
            ("x-user-auth-token", token),
            ("user-agent", httpx::BROWSER_UA),
        ]),
    )
    .await
    {
        Ok((r, ms)) => {
            let t = r.text().to_lowercase();
            let valid =
                !t.contains("invalid request signature") && !t.contains("invalidrequestsignature");
            (
                valid,
                if valid {
                    "secret ok"
                } else {
                    "invalid app_secret"
                }
                .into(),
                ms,
            )
        }
        Err(c) => (false, c.detail, 0),
    }
}
async fn renew_qobuz(app: &App, fp: &str, p: &Value) -> Refresh {
    if fp.is_empty() {
        return Refresh::failure("no fingerprint to update", false);
    }
    let g = match gate(app, fp, p, false).await {
        Ok(g) => g,
        Err(r) => return *r,
    };
    if g.serve {
        return Refresh {
            payload: Some(g.payload),
            stored: g.stored,
            detail: "renewed by another check".into(),
            skip: false,
        };
    }
    let email = string(&g.payload, "username").trim().to_owned();
    let password = string(&g.payload, "password").trim().to_owned();
    if email.is_empty() || password.is_empty() {
        finish(app, fp, g.claim.as_deref(), None, None, None, None).await;
        return Refresh::failure(
            "token dead, no stored email/password — auto-renewal impossible, re-add the account",
            false,
        );
    }
    let stored_id = string(&g.payload, "appId").trim().to_owned();
    let mut login = None;
    let mut failure = String::new();
    let mut rejected = true;
    let mut seen = std::collections::HashSet::new();
    for id in [stored_id, QOBUZ_LOGIN_ID.into()] {
        if id.is_empty() || !seen.insert(id.clone()) {
            continue;
        }
        match qobuz_login(app, &email, &password, &id).await {
            Ok(r) => {
                login = Some(r);
                break;
            }
            Err(e) => {
                if !e.to_lowercase().contains("incorrect") && !e.to_lowercase().contains("rejected")
                {
                    rejected = false;
                }
                failure = e;
            }
        }
    }
    let Some(login) = login else {
        finish(app, fp, g.claim.as_deref(), None, None, None, None).await;
        return Refresh::failure(&format!("re-login failed: {failure}"), !rejected);
    };
    let mut next = g.payload;
    next["token"] = json!(login.token);
    if !login.country.is_empty() {
        next["countryCode"] = json!(login.country);
    }
    let next_fp = pool::fingerprint("qobuz", "account", &next);
    let stored = finish(
        app,
        fp,
        g.claim.as_deref(),
        Some(&next),
        Some(&next_fp),
        None,
        None,
    )
    .await;
    Refresh {
        payload: Some(next),
        stored,
        detail: "re-logged in".into(),
        skip: false,
    }
}
async fn qobuz_account(app: &App, p: &Value, fp: &str) -> Check {
    let mut token = string(p, "token").trim().to_owned();
    let id = string(p, "appId").trim().to_owned();
    let secret = string(p, "appSecret").trim().to_owned();
    if token.is_empty() || id.is_empty() || secret.is_empty() {
        return Check::dead("missing token/appId/appSecret");
    }
    let url = |token: &str| {
        query_url(
            &app.endpoints.qobuz_api,
            "user/get",
            &[("app_id", id.clone()), ("user_auth_token", token.into())],
        )
    };
    let h = |token: &str| {
        headers(&[
            ("x-app-id", &id),
            ("x-user-auth-token", token),
            ("user-agent", httpx::BROWSER_UA),
        ])
    };
    let (mut r, mut ms) = match get(app, &url(&token), h(&token)).await {
        Ok(v) => v,
        Err(c) => return *c,
    };
    let mut current = p.clone();
    let mut stored = None;
    if [401, 403].contains(&r.status) {
        let fresh = renew_qobuz(app, fp, p).await;
        let Some(next) = fresh.payload else {
            return fresh.check();
        };
        token = string(&next, "token");
        current = next;
        stored = fresh.stored;
        match get(app, &url(&token), h(&token)).await {
            Ok((res, m)) => {
                r = res;
                ms += m;
            }
            Err(mut c) => {
                c.stored_payload = stored;
                return *c;
            }
        }
    }
    let mut c = if !r.ok() {
        Check::new(false, false, ms, format!("HTTP {}", r.status))
    } else {
        let text = r.text().to_lowercase();
        if !text.contains("\"id\"") && !text.contains("credential") {
            Check::new(false, false, ms, "invalid user")
        } else {
            let premium = QPREMIUM.is_match(&text);
            let (ok, detail, secret_ms) = qobuz_secret(app, &id, &secret, &token).await;
            if ok {
                Check::new(true, premium, ms + secret_ms, "user + secret ok")
            } else {
                let fresh = scrape_qobuz(app, &id).await;
                let healed = !fresh.is_empty()
                    && !crypto::secret_matches(&fresh, &secret)
                    && qobuz_secret(app, &id, &fresh, &token).await.0;
                if healed {
                    if let Ok(rows) = app
                        .db
                        .rows(
                            "select id,payload from account_entries where service='qobuz'",
                            vec![],
                        )
                        .await
                    {
                        for row in rows {
                            let mut plain = crypto::decrypt(
                                &row["payload"],
                                app.config.encryption_key.as_ref(),
                            );
                            if string(&plain, "appId").trim() == id
                                && crypto::secret_matches(
                                    string(&plain, "appSecret").trim(),
                                    &secret,
                                )
                            {
                                plain["appSecret"] = json!(fresh);
                                if let Ok(encrypted) = crypto::encrypt_at_rest(
                                    &plain,
                                    app.config.encryption_key.as_ref(),
                                ) {
                                    let changed=app.db.exec("update account_entries set payload=$1 where id=$2 and payload=$3",vec![encrypted.clone().into(),integer(&row,"id").into(),row["payload"].clone().into()]).await.unwrap_or(0);
                                    if changed > 0
                                        && crypto::secret_matches(&string(&plain, "token"), &token)
                                    {
                                        current = plain;
                                        stored = Some(encrypted);
                                    }
                                }
                            }
                        }
                    }
                    let (ok, _, m) = qobuz_secret(app, &id, &fresh, &token).await;
                    Check::new(
                        ok,
                        premium,
                        ms + secret_ms + m,
                        if ok {
                            "user ok, app_secret rotated and re-verified"
                        } else {
                            "invalid app_secret"
                        },
                    )
                } else {
                    Check::new(false, premium, ms + secret_ms, detail)
                }
            }
        }
    };
    c.payload = Some(current);
    c.stored_payload = stored;
    c
}
async fn deezer_account(app: &App, p: &Value, fp: &str) -> Check {
    let arl = string(p, "arl").trim().to_owned();
    if arl.is_empty() {
        return Check::dead("missing arl");
    }
    let user_url =
        |base: &str| format!("{base}?method=deezer.getUserData&input=3&api_version=1.0&api_token=");
    let (r, ms) = match get(
        app,
        &user_url(&app.endpoints.deezer),
        headers(&[
            ("cookie", &format!("arl={arl}")),
            ("user-agent", httpx::BROWSER_UA),
        ]),
    )
    .await
    {
        Ok(v) => v,
        Err(c) => return *c,
    };
    if !r.ok() {
        return Check::new(false, false, ms, format!("HTTP {}", r.status));
    }
    let body = r.json();
    let user = &body["results"]["USER"];
    if number(&user["USER_ID"]) == 0. || user["USER_ID"].is_null() {
        return Check::new(false, false, ms, "arl rejected");
    }
    let opt = &user["OPTIONS"];
    if string(opt, "license_token").trim().is_empty() {
        return Check::new(false, false, ms, "no license_token");
    }
    let premium = truthy(&opt["web_sound_quality"]["lossless"]) || truthy(&opt["web_hq"]);
    let session = if premium {
        "session ok (lossless)"
    } else {
        "session ok (lossy only)"
    };
    let claim = if fp.is_empty() {
        None
    } else {
        app.db.one("update account_entries set refresh_in_flight_until=now()+interval '60 seconds' where fingerprint=$1 and (refresh_in_flight_until is null or refresh_in_flight_until<now()) and (refresh_cooldown_until is null or refresh_cooldown_until<=now()) returning refresh_in_flight_until::text as claim,payload",vec![fp.into()]).await.ok().flatten()
    };
    if !fp.is_empty() && claim.is_none() {
        return Check::new(
            true,
            premium,
            ms,
            format!("{session} (rotation in flight elsewhere)"),
        );
    }
    let current = claim
        .as_ref()
        .map(|r| crypto::decrypt(&r["payload"], app.config.encryption_key.as_ref()))
        .unwrap_or_else(|| p.clone());
    let stamp = claim.as_ref().map(|r| string(r, "claim"));
    let result = async {
        let r = app
            .outbound
            .get(
                &user_url(&app.endpoints.deezer),
                headers(&[
                    ("cookie", &format!("arl={}", string(&current, "arl"))),
                    ("user-agent", httpx::BROWSER_UA),
                ]),
            )
            .await
            .map_err(|_| "rotation error: fetch failed".to_owned())?;
        if !r.ok() {
            return Err(format!("getUserData HTTP {}", r.status));
        }
        let b = r.json();
        let sid = string(&b["results"], "SESSION_ID");
        let form = string(&b["results"], "checkForm");
        if sid.is_empty() || form.is_empty() {
            return Err("no session to rotate from".into());
        }
        let url = query_url(
            &app.endpoints.deezer,
            "",
            &[
                ("method", "user.getArl".into()),
                ("input", "3".into()),
                ("api_version", "1.0".into()),
                ("api_token", form),
            ],
        );
        let r = app
            .outbound
            .get(
                &url,
                headers(&[
                    ("cookie", &format!("sid={sid}")),
                    ("user-agent", httpx::BROWSER_UA),
                ]),
            )
            .await
            .map_err(|_| "rotation error: fetch failed".to_owned())?;
        if !r.ok() {
            return Err(format!("getArl HTTP {}", r.status));
        }
        let rotated = string(&r.json(), "results");
        if rotated.is_empty() || crypto::secret_matches(&rotated, &arl) {
            return Err("rotation returned nothing new".into());
        }
        let mut next = current.clone();
        next["arl"] = json!(rotated);
        let stored = finish(app, fp, stamp.as_deref(), Some(&next), None, None, None).await;
        Ok::<_, String>((next, stored))
    }
    .await;
    finish(app, fp, stamp.as_deref(), None, None, None, None).await;
    match result {
        Ok((next, stored)) => {
            let mut c = Check::new(true, premium, ms, format!("{session}, arl rotated"));
            c.payload = Some(next);
            c.stored_payload = stored;
            c
        }
        Err(detail) => Check::new(true, premium, ms, format!("{session} ({detail})")),
    }
}
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::String(s) => !s.is_empty(),
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.),
        _ => true,
    }
}
pub fn amazon_account(p: &Value) -> Check {
    let s = string(p, "session");
    let s = s.trim();
    if s.is_empty() {
        return Check::dead("missing session artifact");
    }
    if s.encode_utf16().count() < 16 {
        return Check::dead("session artifact looks truncated");
    }
    let mut c = Check::new(
        true,
        p["premium"] == true,
        0,
        "unverified (shape only) — Amazon's API has no public probe; the app reports failures",
    );
    c.status = "alive".into();
    c
}
async fn apple_dev_token(app: &App) -> String {
    let key = "apple:dev-token";
    let _guard = app.cache.flight(key).await;
    let old = app
        .cache
        .get(key)
        .await
        .and_then(|p| p.as_str().map(str::to_owned));
    if let Some(t) = old.as_ref()
        && jwt_payload(t)
            .and_then(|p| p["exp"].as_i64())
            .is_some_and(|exp| exp - 60 > Utc::now().timestamp())
    {
        return t.clone();
    }
    let token = async {
        let (r, _) = get(
            app,
            &app.endpoints.apple_home,
            headers(&[("user-agent", httpx::BROWSER_UA)]),
        )
        .await
        .ok()?;
        if !r.ok() {
            return None;
        }
        let re = regex::Regex::new(r#"assets/index-[^"']+\.js"#).unwrap();
        let html = r.text();
        let bundle = re.find(&html)?.as_str();
        let url = join(&app.endpoints.apple_home, bundle);
        let (r, _) = get(app, &url, headers(&[("user-agent", httpx::BROWSER_UA)]))
            .await
            .ok()?;
        if !r.ok() {
            return None;
        }
        let re =
            regex::Regex::new(r"eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}")
                .unwrap();
        for m in re.find_iter(&r.text()) {
            let t = m.as_str();
            if let Some(p) = jwt_payload(t)
                && p["iss"] == "AMPWebPlay"
                && p["exp"]
                    .as_i64()
                    .is_some_and(|exp| exp - 60 > Utc::now().timestamp())
            {
                return Some(t.to_owned());
            }
        }
        None
    }
    .await;
    if let Some(token) = token {
        app.cache
            .put(key, json!(token), Duration::from_secs(86400))
            .await;
        token
    } else {
        old.unwrap_or_default()
    }
}
pub fn apple_subscription(p: &Value) -> (Option<bool>, String) {
    let s = &p["meta"]["subscription"];
    let active = s["active"].as_bool();
    if active.is_none() {
        return (None, "no subscription info in response".into());
    }
    let sf = string(s, "storefront");
    let mut detail = if sf.is_empty() {
        "storefront unknown".into()
    } else {
        format!("storefront {sf}")
    };
    if active == Some(false) {
        detail.push_str(" (no active subscription)");
    }
    (active, detail)
}
async fn apple_account(app: &App, p: &Value) -> Check {
    let token = string(p, "token").trim().to_owned();
    if !token.starts_with("0.") {
        return Check::dead("missing or invalid media-user-token");
    }
    let dev = apple_dev_token(app).await;
    if dev.is_empty() {
        let mut c = Check::dead("no dev token available");
        c.status = "pending".into();
        return c;
    }
    let auth = format!("Bearer {dev}");
    let h = headers(&[
        ("authorization", &auth),
        ("media-user-token", &token),
        ("cookie", &format!("media-user-token={token}")),
        ("origin", "https://music.apple.com"),
        ("referer", "https://music.apple.com/"),
        ("user-agent", httpx::BROWSER_UA),
    ]);
    let (r, ms) = match get(
        app,
        &join(&app.endpoints.apple_api, "v1/me/account?meta=subscription"),
        h.clone(),
    )
    .await
    {
        Ok(v) => v,
        Err(mut c) => {
            c.status = "pending".into();
            c.detail = format!("probe error: {}", c.detail);
            return *c;
        }
    };
    if !r.ok() {
        return Check::new(false, false, ms, format!("HTTP {}", r.status));
    }
    let (active, detail) = apple_subscription(&r.json());
    let Some(active) = active else {
        let mut c = Check::new(false, false, ms, detail);
        c.status = "pending".into();
        return c;
    };
    if !active {
        return Check::new(true, false, ms, detail);
    }
    for id in ["1499378108", "6792884101"] {
        let mut h = h.clone();
        h.remove("cookie");
        h.insert(
            "content-type",
            reqwest::header::HeaderValue::from_static("application/json; charset=utf-8"),
        );
        let start = Instant::now();
        let r = match app
            .outbound
            .send(
                Method::POST,
                &app.endpoints.apple_playback,
                h,
                serde_json::to_vec(&json!({"salableAdamId":id,"language":"en-us"})).unwrap(),
            )
            .await
        {
            Ok(r) => r,
            Err(e) => {
                let mut c = Check::dead(format!("probe error: {e}"));
                c.status = "pending".into();
                return c;
            }
        };
        let m = start.elapsed().as_millis() as i32;
        if !r.ok() {
            if r.status >= 500 || r.status == 429 {
                continue;
            }
            return Check::new(false, false, m, format!("webPlayback HTTP {}", r.status));
        }
        let b = r.json();
        let assets = b["songList"][0]["assets"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let ctrp = assets
            .iter()
            .filter(|a| string(a, "flavor").contains("ctrp") && truthy(&a["URL"]))
            .collect::<Vec<_>>();
        if !ctrp.is_empty() {
            let max = ctrp
                .iter()
                .map(|a| {
                    string(a, "flavor")
                        .chars()
                        .rev()
                        .take_while(|c| c.is_ascii_digit())
                        .collect::<Vec<_>>()
                        .into_iter()
                        .rev()
                        .collect::<String>()
                        .parse::<i32>()
                        .unwrap_or(0)
                })
                .max()
                .unwrap_or(0);
            let premium = max >= 321;
            return Check::new(
                true,
                premium,
                ms + m,
                format!(
                    "{detail}, playback ok{} (ctrp {max} kbps)",
                    if premium { "" } else { " but lossy only" }
                ),
            );
        }
        let message = string(&b, "customerMessage").to_lowercase();
        if string(&b, "failureType") == "2002"
            || message.contains("session has ended")
            || message.contains("sign in again")
        {
            return Check::new(false, false, m, "webPlayback: session ended");
        }
    }
    Check::new(
        true,
        true,
        ms,
        format!("{detail}, webPlayback inconclusive (no probe track available)"),
    )
}
pub async fn run_check(app: &App, service: &str, kind: &str, p: &Value, fp: &str) -> Check {
    if kind == "api" {
        return instance_check(app, service, p).await;
    }
    match service {
        "tidal" => tidal_account(app, p, fp).await,
        "qobuz" => qobuz_account(app, p, fp).await,
        "deezer" => deezer_account(app, p, fp).await,
        "apple-music" => apple_account(app, p).await,
        _ => amazon_account(p),
    }
}
pub mod sweep;
