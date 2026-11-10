#![forbid(unsafe_code)]
pub mod api;
pub mod cache;
pub mod config;
pub mod crypto;
pub mod db;
pub mod health;
pub mod httpx;
pub mod pool;
#[derive(Clone)]
pub struct App {
    pub config: config::Config,
    pub db: db::Db,
    pub cache: cache::Cache,
    pub rates: cache::RateLimit,
    pub outbound: httpx::Outbound,
    pub endpoints: health::Endpoints,
    pub password_slots: std::sync::Arc<tokio::sync::Semaphore>,
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
            endpoints: health::Endpoints::default(),
            password_slots: std::sync::Arc::new(tokio::sync::Semaphore::new(2)),
        })
    }
}
pub mod snapshot;
#[cfg(test)]
pub mod test_support;
