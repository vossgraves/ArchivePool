#![forbid(unsafe_code)]
pub mod api;
pub mod cache;
pub mod config;
pub mod crypto;
pub mod db;
pub mod httpx;
pub mod pool;
#[derive(Clone)]
pub struct App {
    pub config: config::Config,
    pub db: db::Db,
    pub cache: cache::Cache,
    pub rates: cache::RateLimit,
    pub outbound: httpx::Outbound,
}
impl App {
    pub fn new(config: config::Config) -> db::Result<Self> {
        let db = db::Db::open(&config.database_url, config.db_max_conns)?;
        Ok(Self {
            config,
            db,
            cache: cache::Cache::default(),
            rates: cache::RateLimit::default(),
            outbound: httpx::Outbound::new().map_err(|_| db::Error)?,
        })
    }
}
