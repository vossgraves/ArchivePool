use std::env;

#[derive(Clone, Default)]
pub struct Config {
    pub database_url: String,
    pub admin_token_hash: String,
    pub admin_token: String,
    pub cron_secret: String,
    pub read_keys_enforced: bool,
    pub session_secret: String,
    pub encryption_key: Option<[u8; 32]>,
    pub client_key: Option<[u8; 32]>,
    pub blob_token: String,
    pub port: u16,
    pub db_max_conns: u32,
    pub github_client_id: String,
    pub github_client_secret: String,
    pub github_redirect_uri: String,
    pub public_url: String,
    pub web_login_disabled: bool,
}
impl Config {
    pub fn load() -> Self {
        let get = |k: &str| env::var(k).unwrap_or_default();
        Self {
            database_url: get("DATABASE_URL"),
            admin_token_hash: get("ADMIN_TOKEN_HASH").trim().to_owned(),
            admin_token: get("ADMIN_TOKEN"),
            cron_secret: get("CRON_SECRET"),
            read_keys_enforced: get("READ_KEYS_ENFORCED") == "true",
            session_secret: get("SESSION_SECRET").trim().to_owned(),
            encryption_key: crate::crypto::load_key(&get("POOL_ENCRYPTION_KEY")),
            client_key: crate::crypto::load_key(&get("POOL_CLIENT_KEY")),
            blob_token: get("BLOB_READ_WRITE_TOKEN"),
            port: get("PORT").parse().unwrap_or(8080),
            db_max_conns: get("DB_MAX_CONNS").parse::<u32>().unwrap_or(4).clamp(1, 32),
            github_client_id: get("GITHUB_CLIENT_ID"),
            github_client_secret: get("GITHUB_CLIENT_SECRET"),
            github_redirect_uri: get("GITHUB_REDIRECT_URI"),
            public_url: get("PUBLIC_URL"),
            web_login_disabled: get("WEB_LOGIN_DISABLED") == "true",
        }
    }
}
