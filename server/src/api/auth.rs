use super::*;
use crate::{crypto, db::Arg};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Identity {
    pub ok: bool,
    pub id: Option<i32>,
    pub scope: Option<String>,
}
#[derive(Clone)]
pub struct Actor {
    pub user_id: Option<i32>,
    pub label: String,
}
pub fn bearer(ctx: &Context) -> Option<&str> {
    ctx.header("authorization")
        .strip_prefix("Bearer ")
        .map(str::trim)
        .filter(|s| !s.is_empty())
}
pub fn read_key(ctx: &Context) -> Option<&str> {
    if let Some(s) = ctx.header("authorization").strip_prefix("Bearer ") {
        return Some(s.trim()).filter(|s| !s.is_empty());
    }
    Some(ctx.header("x-api-key").trim()).filter(|s| !s.is_empty())
}
pub fn admin_token(app: &App, ctx: &Context) -> bool {
    let Some(candidate) = bearer(ctx) else {
        return false;
    };
    let hash = app.config.admin_token_hash.trim();
    if !hash.is_empty() {
        return hex::decode(hash)
            .ok()
            .filter(|h| h.len() == 32)
            .is_some_and(|h| {
                use subtle::ConstantTimeEq;
                bool::from(crypto::sha256(candidate).as_slice().ct_eq(&h))
            });
    }
    !app.config.admin_token.is_empty() && crypto::secret_matches(candidate, &app.config.admin_token)
}
pub fn cron_token(app: &App, ctx: &Context) -> bool {
    bearer(ctx).is_some_and(|c| {
        !app.config.cron_secret.is_empty() && crypto::secret_matches(c, &app.config.cron_secret)
    }) || admin_token(app, ctx)
}
pub async fn session(app: &App, ctx: &Context) -> db::Result<Option<Value>> {
    let Some(id) = crypto::verify_session(
        ctx.cookie("atp_session"),
        chrono::Utc::now().timestamp_millis(),
        &app.config.session_secret,
    ) else {
        return Ok(None);
    };
    let row=app.db.one("select id,username,role,disabled,claimed_by,github_id,github_login from users where id=$1 limit 1",vec![Arg::Big(id)]).await?;
    Ok(row.filter(|r| !boolean(r, "disabled") && r["claimed_by"].is_null()))
}
pub async fn resolve_admin(app: &App, ctx: &Context) -> Option<Actor> {
    if admin_token(app, ctx) {
        return Some(Actor {
            user_id: None,
            label: "admin-token".to_owned(),
        });
    }
    let row = session(app, ctx).await.ok()??;
    if string(&row, "role") != "admin" {
        return None;
    }
    Some(Actor {
        user_id: Some(integer(&row, "id")),
        label: string(&row, "username"),
    })
}
pub async fn identify(
    app: &Arc<App>,
    ctx: &Context,
    always: bool,
    discovery: bool,
) -> db::Result<Identity> {
    let enforced = always || app.config.read_keys_enforced;
    let Some(candidate) = read_key(ctx) else {
        return Ok(Identity {
            ok: !enforced,
            ..Identity::default()
        });
    };
    let hash = hex::encode(crypto::sha256(candidate));
    let memo = format!("key-id:{hash}");
    if discovery && let Some(v) = app.cache.get(&memo).await {
        return serde_json::from_value(v).map_err(|_| db::Error);
    }
    let row=app.db.one("select id,key_hash,revoked,service from api_keys where key_hash=$1 and deleted=false limit 1",vec![hash.clone().into()]).await?;
    let identity = if let Some(row) = row
        .filter(|r| !boolean(r, "revoked") && crypto::secret_matches(&string(r, "key_hash"), &hash))
    {
        let id = integer(&row, "id");
        let scope = string(&row, "service");
        if enforced && !discovery {
            let key = format!("usage:{id}");
            let _guard = app.cache.flight(&key).await;
            if app.cache.get(&key).await.is_none() {
                app.cache
                    .put(&key, json!(true), Duration::from_secs(60))
                    .await;
                let db = app.db.clone();
                tokio::spawn(async move {
                    let _=db.exec("update api_keys set use_count=use_count+1,last_used_at=now() where id=$1",vec![id.into()]).await;
                });
            }
        }
        Identity {
            ok: true,
            id: Some(id),
            scope: crate::pool::is_service(&scope).then_some(scope),
        }
    } else {
        Identity {
            ok: !enforced,
            ..Identity::default()
        }
    };
    if discovery {
        app.cache
            .put(
                &memo,
                serde_json::to_value(&identity).map_err(|_| db::Error)?,
                Duration::from_secs(300),
            )
            .await;
    }
    Ok(identity)
}
pub fn set_session(app: &App, ctx: &Context, id: i32, mut res: Response) -> db::Result<Response> {
    let token = crypto::session_token(
        id as i64,
        chrono::Utc::now().timestamp_millis(),
        &app.config.session_secret,
    )?;
    let secure = if ctx.origin(app).starts_with("https:") {
        "; Secure"
    } else {
        ""
    };
    res.headers_mut().append(
        "set-cookie",
        HeaderValue::from_str(&format!(
            "atp_session={token}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax{secure}"
        ))
        .map_err(|_| db::Error)?,
    );
    Ok(res)
}
pub fn valid_credentials(username: &str, password: &str) -> Option<&'static str> {
    if !(3..=24).contains(&username.len())
        || !username
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
    {
        Some("Username must be 3-24 characters: lowercase letters, digits, underscores.")
    } else if !(8..=128).contains(&password.encode_utf16().count()) {
        Some("Password must be 8-128 characters.")
    } else {
        None
    }
}
pub async fn password_route(app: &Arc<App>, ctx: &Context, route: &str) -> db::Result<Response> {
    if route.ends_with("/logout") {
        return Ok(with_headers(
            json_response(200, json!({"ok":true})),
            &[("set-cookie", "atp_session=; Path=/; Max-Age=0; HttpOnly")],
        ));
    }
    if route.ends_with("/me") {
        let user = session(app, ctx).await?;
        return Ok(private(match user {
            Some(user) => json_response(200, json!({"username":user["username"]})),
            None => error(401, "unauthorized"),
        }));
    }
    let signup = route.ends_with("/signup");
    if app.config.web_login_disabled {
        return Ok(private(detail(
            503,
            "web_login_unavailable",
            if signup {
                "Password sign-up is unavailable on this deployment — use Sign in with GitHub instead (/api/auth/github/start), which also covers legacy username claims."
            } else {
                "Password sign-in is unavailable on this deployment — use Sign in with GitHub instead (/api/auth/github/start), or bearer read keys programmatically."
            },
        )));
    }
    let Some(body) = ctx.json() else {
        return Ok(error(400, "invalid_body"));
    };
    let username = string(&body, "username").trim().to_lowercase();
    let password = string(&body, "password");
    if signup && let Some(problem) = valid_credentials(&username, &password) {
        return Ok(detail(400, "invalid_input", problem));
    }
    if !signup {
        if username.is_empty() || password.is_empty() {
            return Ok(error(400, "invalid_input"));
        }
        for (key, limit) in [
            (format!("login-acct:{}:{username}", ctx.ip()), 10),
            (format!("login-ip:{}", ctx.ip()), 30),
        ] {
            if let Some(s) = app.rates.check(&key, limit, Duration::from_secs(600)).await {
                return Ok(too_many(s, "login"));
            }
        }
    }
    let user = app
        .db
        .one(
            "select id,username,password_hash,disabled from users where username=$1 limit 1",
            vec![username.clone().into()],
        )
        .await?;
    if signup {
        if user.is_some() {
            return Ok(detail(
                409,
                "username_taken",
                "That username is already registered.",
            ));
        }
        if !ctx.ip().is_empty() && !ctx.ua().is_empty() {
            let n=app.db.one("select count(*)::int as n from users where created_ip=$1 and created_ua=$2 and created_at>=now()-interval '24 hours'",vec![ctx.ip().into(),ctx.ua().into()]).await?.unwrap();
            if integer(&n, "n") >= 5 {
                return Ok(private(with_headers(
                    detail(
                        429,
                        "rate_limited",
                        "Too many accounts from this device/network. Try again later.",
                    ),
                    &[("retry-after", "86400")],
                )));
            }
        }
        let hash = tokio::task::spawn_blocking(move || crypto::hash_password(&password))
            .await
            .map_err(|_| db::Error)??;
        let row=app.db.one("insert into users(username,password_hash,created_ip,created_ua,last_login_ip,last_login_ua) values($1,$2,$3,$4,$3,$4) returning id,username",vec![username.into(),hash.into(),ctx.ip().into(),ctx.ua().into()]).await?.ok_or(db::Error)?;
        return set_session(
            app,
            ctx,
            integer(&row, "id"),
            json_response(200, json!({"username":row["username"]})),
        );
    }
    let Some(user) = user.filter(|r| !boolean(r, "disabled")) else {
        return Ok(error(401, "invalid_credentials"));
    };
    let hash = string(&user, "password_hash");
    let valid = tokio::task::spawn_blocking(move || crypto::verify_password(&password, &hash))
        .await
        .map_err(|_| db::Error)?;
    if !valid {
        return Ok(error(401, "invalid_credentials"));
    }
    let db = app.db.clone();
    let id = integer(&user, "id");
    let ip = ctx.ip();
    let ua = ctx.ua();
    tokio::spawn(async move {
        let _ = db
            .exec(
                "update users set last_login_ip=$1,last_login_ua=$2 where id=$3",
                vec![ip.into(), ua.into(), id.into()],
            )
            .await;
    });
    set_session(
        app,
        ctx,
        id,
        json_response(200, json!({"username":user["username"]})),
    )
}
pub fn github_names(login: &str) -> Vec<String> {
    let mut base = String::new();
    for c in login.to_ascii_lowercase().chars() {
        let c = if c == '-' { '_' } else { c };
        if (c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
            && !(c == '_' && base.ends_with('_'))
        {
            base.push(c);
        }
    }
    let base = base.trim_matches('_').chars().take(24).collect::<String>();
    let stem = if base.is_empty() { "user" } else { &base };
    let mut out = vec![];
    if valid_credentials(stem, "password1").is_none() {
        out.push(stem.to_owned());
    }
    out.push(format!("gh_{stem}").chars().take(24).collect());
    for n in 2..=9 {
        let c = format!("{stem}_{n}").chars().take(24).collect::<String>();
        if valid_credentials(&c, "password1").is_none() {
            out.push(c);
        }
    }
    out
}
pub fn oauth_cookie(state: &str, verifier: &str, secret: &str, now: i64) -> db::Result<String> {
    let body = format!("gh-oauth-v1.{state}.{verifier}.{}", now + 600000);
    Ok(format!("{body}.{}", crypto::sign(&body, secret)?))
}
pub fn read_oauth_cookie(value: &str, secret: &str, now: i64) -> Option<(String, String)> {
    let p: Vec<_> = value.split('.').collect();
    if p.len() != 5
        || p[0] != "gh-oauth-v1"
        || p[1..3].iter().any(|s| {
            !(16..=64).contains(&s.len())
                || !s
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        })
        || !(10..=15).contains(&p[3].len())
        || !p[3].bytes().all(|b| b.is_ascii_digit())
        || p[3].parse::<i64>().ok()? <= now
        || !crypto::verify_signature(&p[..4].join("."), p[4], secret)
    {
        return None;
    }
    Some((p[1].to_owned(), p[2].to_owned()))
}
pub async fn github_route(app: &Arc<App>, ctx: &Context, route: &str) -> db::Result<Response> {
    let origin = ctx.origin(app);
    let configured = !app.config.github_client_id.is_empty()
        && !app.config.github_client_secret.is_empty()
        && !app.config.session_secret.is_empty();
    if route.ends_with("/start") {
        if !configured {
            return Ok(detail(
                503,
                "github_auth_unconfigured",
                "GitHub sign-in is not configured on this deployment.",
            ));
        }
        let state = crypto::random_url(24);
        let verifier = crypto::random_url(32);
        let cookie = oauth_cookie(
            &state,
            &verifier,
            &app.config.session_secret,
            chrono::Utc::now().timestamp_millis(),
        )?;
        let redirect_uri = if app.config.github_redirect_uri.is_empty() {
            format!("{origin}/api/auth/github/callback")
        } else {
            app.config.github_redirect_uri.clone()
        };
        let mut url = url::Url::parse("https://github.com/login/oauth/authorize").unwrap();
        url.query_pairs_mut()
            .append_pair("client_id", &app.config.github_client_id)
            .append_pair("redirect_uri", &redirect_uri)
            .append_pair("scope", "read:user")
            .append_pair("state", &state)
            .append_pair(
                "code_challenge",
                &URL_SAFE_NO_PAD.encode(crypto::sha256(&verifier)),
            )
            .append_pair("code_challenge_method", "S256");
        let cookie = format!(
            "atp_gh_oauth={cookie}; Path=/; Max-Age=600; HttpOnly; SameSite=Lax{}",
            if origin.starts_with("https:") {
                "; Secure"
            } else {
                ""
            }
        );
        return Ok(with_headers(
            redirect(url.as_str(), 307),
            &[("set-cookie", &cookie)],
        ));
    }
    let fail = |code: &str| redirect(&format!("{origin}/login?error={code}"), 307);
    if !configured {
        return Ok(fail("github_unconfigured"));
    }
    let Some(code) = ctx.query.get("code").filter(|s| !s.is_empty()) else {
        return Ok(fail("github_state"));
    };
    let Some(state) = ctx.query.get("state") else {
        return Ok(fail("github_state"));
    };
    let Some((signed, verifier)) = read_oauth_cookie(
        ctx.cookie("atp_gh_oauth"),
        &app.config.session_secret,
        chrono::Utc::now().timestamp_millis(),
    ) else {
        return Ok(fail("github_state"));
    };
    if !crypto::secret_matches(&signed, state) {
        return Ok(fail("github_state"));
    }
    let redirect_uri = if app.config.github_redirect_uri.is_empty() {
        format!("{origin}/api/auth/github/callback")
    } else {
        app.config.github_redirect_uri.clone()
    };
    let response = app
        .outbound
        .form(
            "https://github.com/login/oauth/access_token",
            crate::httpx::headers(&[("accept", "application/json")]),
            &[
                ("client_id", app.config.github_client_id.clone()),
                ("client_secret", app.config.github_client_secret.clone()),
                ("code", code.clone()),
                ("redirect_uri", redirect_uri),
                ("code_verifier", verifier),
            ],
        )
        .await;
    let Ok(res) = response else {
        return Ok(fail("github_exchange"));
    };
    let token = string(&res.json(), "access_token");
    if !res.ok() || token.is_empty() {
        return Ok(fail("github_exchange"));
    }
    let Ok(res) = app
        .outbound
        .get(
            "https://api.github.com/user",
            crate::httpx::headers(&[
                ("authorization", &format!("Bearer {token}")),
                ("accept", "application/vnd.github+json"),
            ]),
        )
        .await
    else {
        return Ok(fail("github_exchange"));
    };
    let identity = res.json();
    let Some(github_id) = identity["id"].as_i64().filter(|id| *id > 0) else {
        return Ok(fail("github_exchange"));
    };
    let login = string(&identity, "login");
    let result=async {
        let existing=app.db.one("select id,username,disabled from users where github_id=$1 limit 1",vec![github_id.into()]).await?;
        if let Some(r)=existing{return Ok::<_,db::Error>(Some(r));}
        let mut names=github_names(&login);let mut id=github_id as u64;let mut digits=Vec::new();while id>0{let n=(id%36)as u8;digits.push(if n<10{b'0'+n}else{b'a'+n-10});id/=36;}digits.reverse();names.push(format!("github_{}",String::from_utf8(digits).unwrap_or_default()));
        for name in names{let created=app.db.one("insert into users(username,password_hash,github_id,github_login,created_ip,created_ua,last_login_ip,last_login_ua) values($1,'github',$2,$3,$4,$5,$4,$5) on conflict do nothing returning id,username,disabled",vec![name.into(),github_id.into(),login.clone().into(),ctx.ip().chars().take(64).collect::<String>().into(),ctx.ua().into()]).await?;if created.is_some(){return Ok(created);}let winner=app.db.one("select id,username,disabled from users where github_id=$1 limit 1",vec![github_id.into()]).await?;if winner.is_some(){return Ok(winner);}}
        Err(db::Error)
    }.await;
    let user = match result {
        Ok(Some(r)) if !boolean(&r, "disabled") => r,
        Ok(Some(_)) => return Ok(fail("account_disabled")),
        _ => return Ok(fail("internal")),
    };
    Ok(with_headers(
        set_session(
            app,
            ctx,
            integer(&user, "id"),
            redirect(&format!("{origin}/dashboard"), 307),
        )?,
        &[("set-cookie", "atp_gh_oauth=; Path=/; Max-Age=0; HttpOnly")],
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn context(auth: &str) -> Context {
        Context {
            headers: crate::httpx::headers(&[("authorization", auth)]),
            path: String::new(),
            query: HashMap::new(),
            method: String::new(),
            body: vec![],
            params: HashMap::new(),
        }
    }
    fn app() -> App {
        App::new(crate::config::Config::default()).unwrap()
    }
    #[test]
    fn admin_hash_preferred_and_malformed_fails_closed() {
        let mut a = app();
        a.config.admin_token = "fallback".into();
        a.config.admin_token_hash = format!(
            "  {}  ",
            hex::encode(crypto::sha256("secret")).to_uppercase()
        );
        assert!(admin_token(&a, &context("Bearer secret")));
        assert!(!admin_token(&a, &context("Bearer fallback")));
        for hash in ["zz", "abcd", "not-hex"] {
            a.config.admin_token_hash = hash.into();
            assert!(!admin_token(&a, &context("Bearer fallback")));
        }
        a.config.admin_token_hash.clear();
        assert!(admin_token(&a, &context("Bearer fallback")));
        assert!(!admin_token(&a, &context("fallback")));
        a.config.cron_secret = "cron".into();
        assert!(cron_token(&a, &context("Bearer cron")));
        assert!(cron_token(&a, &context("Bearer fallback")));
        assert!(!cron_token(&a, &context("Bearer wrong")));
    }
    #[test]
    fn credential_rules() {
        for (u, p, ok) in [
            ("alice", "password1", true),
            ("a_b_9", "password1", true),
            ("al", "password1", false),
            ("Alice", "password1", false),
            ("alice", "short", false),
        ] {
            assert_eq!(valid_credentials(u, p).is_none(), ok);
        }
        assert!(valid_credentials("alice", &"x".repeat(128)).is_none());
        assert!(valid_credentials("alice", &"x".repeat(129)).is_some());
    }
    #[test]
    fn oauth_cookie_is_signed_tagged_canonical_and_expiring() {
        let state = "abcdefghijklmnop";
        let verifier = "abcdefghijklmnopabcdefghijklmnop";
        let token = oauth_cookie(state, verifier, "secret", 1_800_000_000_000).unwrap();
        assert_eq!(
            read_oauth_cookie(&token, "secret", 1_800_000_000_000),
            Some((state.into(), verifier.into()))
        );
        assert!(read_oauth_cookie(&token, "wrong", 1_800_000_000_000).is_none());
        assert!(read_oauth_cookie(&token, "secret", 1_800_000_600_000).is_none());
        assert!(
            read_oauth_cookie(&token.replace("gh-oauth-v1", "gh-pending-v1"), "secret", 0)
                .is_none()
        );
        assert!(read_oauth_cookie(&token.replace(state, "bad!"), "secret", 0).is_none());
    }
    #[test]
    fn github_username_candidates() {
        assert_eq!(&github_names("Octo-Cat")[..2], &["octo_cat", "gh_octo_cat"]);
        for login in ["a", "-", "é", "012", "_---a---_"] {
            for name in github_names(login) {
                assert!(valid_credentials(&name, "password1").is_none());
            }
        }
    }
}
