use crate::crypto;
use chrono::{DateTime, Utc};
use serde_json::{Map, Value};
use sqlx::{
    Column, PgPool, Row, TypeInfo,
    postgres::{PgConnectOptions, PgPoolOptions, PgRow},
};
use std::{str::FromStr, sync::Arc, time::Duration};
use tokio::sync::OnceCell;

pub type Result<T> = std::result::Result<T, Error>;
#[derive(Debug, Clone, Copy)]
pub struct Error;
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Database operation unavailable.")
    }
}
impl std::error::Error for Error {}
impl From<sqlx::Error> for Error {
    fn from(_: sqlx::Error) -> Self {
        Self
    }
}
impl From<crypto::CryptoError> for Error {
    fn from(_: crypto::CryptoError) -> Self {
        Self
    }
}
#[derive(Clone)]
pub struct Db {
    pool: Option<PgPool>,
    ready: Arc<OnceCell<()>>,
    #[cfg(test)]
    statements: Arc<std::sync::Mutex<Vec<String>>>,
}
impl Db {
    pub fn open(url: &str, max: u32) -> Result<Self> {
        let pool = if url.is_empty() {
            None
        } else {
            let options = PgConnectOptions::from_str(url)
                .map_err(|_| Error)?
                .statement_cache_capacity(0)
                .options([("statement_timeout", "15000"), ("lock_timeout", "5000")]);
            Some(
                PgPoolOptions::new()
                    .max_connections(max.clamp(1, 32))
                    .min_connections(0)
                    .acquire_timeout(Duration::from_secs(10))
                    .idle_timeout(Duration::from_secs(10))
                    .max_lifetime(Duration::from_secs(1800))
                    .test_before_acquire(false)
                    .connect_lazy_with(options),
            )
        };
        Ok(Self {
            pool,
            ready: Arc::new(OnceCell::new()),
            #[cfg(test)]
            statements: Arc::default(),
        })
    }
    pub fn pool(&self) -> Result<&PgPool> {
        self.pool.as_ref().ok_or(Error)
    }
    pub async fn close(&self) {
        if let Some(p) = &self.pool {
            p.close().await;
        }
    }
    pub async fn ensure(&self) -> Result<()> {
        self.ready.get_or_try_init(||async {
            let pool=self.pool()?;
            let applied:bool=sqlx::query_scalar("select to_regclass('public.archivepool_schema_rust_v1') is not null")
                .persistent(false).fetch_one(pool).await?;
            if applied{return Ok(());}
            let mut tx=pool.begin().await?;
            sqlx::query("select pg_advisory_xact_lock(728493501)").persistent(false).execute(&mut *tx).await?;
            let applied:bool=sqlx::query_scalar("select to_regclass('public.archivepool_schema_rust_v1') is not null")
                .persistent(false).fetch_one(&mut *tx).await?;
            if !applied {
                sqlx::Executor::execute(&mut *tx, include_str!("../migrations/001_schema.sql")).await?;
                sqlx::Executor::execute(&mut *tx, include_str!("../migrations/002_runtime.sql")).await?;
                sqlx::query("create table archivepool_schema_rust_v1 (applied_at timestamptz not null default now())")
                    .persistent(false).execute(&mut *tx).await?;
            }
            tx.commit().await?;
            Ok::<(),Error>(())
        }).await.map(|_|())
    }
    pub async fn rows(&self, sql: &str, args: Vec<Arg>) -> Result<Vec<Value>> {
        self.ensure().await?;
        #[cfg(test)]
        self.statements.lock().unwrap().push(sql.to_owned());
        rows(self.pool()?, sql, args).await
    }
    pub async fn one(&self, sql: &str, args: Vec<Arg>) -> Result<Option<Value>> {
        Ok(self.rows(sql, args).await?.into_iter().next())
    }
    pub async fn exec(&self, sql: &str, args: Vec<Arg>) -> Result<u64> {
        self.ensure().await?;
        #[cfg(test)]
        self.statements.lock().unwrap().push(sql.to_owned());
        Ok(query(sql, args)
            .execute(self.pool()?)
            .await?
            .rows_affected())
    }
    pub async fn claim_job(&self, name: &str, ttl: i32) -> Result<Option<String>> {
        let holder = crypto::random_hex(16);
        let row=self.one("insert into job_locks (name,holder,expires_at) values ($1,$2,now()+make_interval(secs=>$3)) on conflict(name) do update set holder=excluded.holder,expires_at=excluded.expires_at where job_locks.expires_at<=now() returning holder",vec![name.into(),holder.clone().into(),ttl.into()]).await?;
        Ok(row.map(|_| holder))
    }
    pub async fn release_job(&self, name: &str, holder: &str) {
        let _ = self
            .exec(
                "delete from job_locks where name=$1 and holder=$2",
                vec![name.into(), holder.into()],
            )
            .await;
    }
    #[cfg(test)]
    pub fn take_statements(&self) -> Vec<String> {
        std::mem::take(&mut *self.statements.lock().unwrap())
    }
}
#[derive(Clone)]
pub enum Arg {
    Text(String),
    Int(i32),
    Big(i64),
    Bool(bool),
    Json(Value),
    Time(DateTime<Utc>),
    Ints(Vec<i32>),
    Texts(Vec<String>),
    NullJson,
    NullInt,
    NullText,
    NullTime,
}
impl From<&str> for Arg {
    fn from(v: &str) -> Self {
        Self::Text(v.to_owned())
    }
}
impl From<String> for Arg {
    fn from(v: String) -> Self {
        Self::Text(v)
    }
}
impl From<i32> for Arg {
    fn from(v: i32) -> Self {
        Self::Int(v)
    }
}
impl From<i64> for Arg {
    fn from(v: i64) -> Self {
        Self::Big(v)
    }
}
impl From<bool> for Arg {
    fn from(v: bool) -> Self {
        Self::Bool(v)
    }
}
impl From<Value> for Arg {
    fn from(v: Value) -> Self {
        Self::Json(v)
    }
}
impl From<DateTime<Utc>> for Arg {
    fn from(v: DateTime<Utc>) -> Self {
        Self::Time(v)
    }
}
impl From<Vec<i32>> for Arg {
    fn from(v: Vec<i32>) -> Self {
        Self::Ints(v)
    }
}
impl From<Option<i32>> for Arg {
    fn from(v: Option<i32>) -> Self {
        v.map(Self::Int).unwrap_or(Self::NullInt)
    }
}
impl From<Option<String>> for Arg {
    fn from(v: Option<String>) -> Self {
        v.map(Self::Text).unwrap_or(Self::NullText)
    }
}
impl From<Option<DateTime<Utc>>> for Arg {
    fn from(v: Option<DateTime<Utc>>) -> Self {
        v.map(Self::Time).unwrap_or(Self::NullTime)
    }
}
pub fn query(
    sql: &str,
    args: Vec<Arg>,
) -> sqlx::query::Query<'_, sqlx::Postgres, sqlx::postgres::PgArguments> {
    let mut q = sqlx::query(sql).persistent(false);
    for a in args {
        q = match a {
            Arg::Text(v) => q.bind(v),
            Arg::Int(v) => q.bind(v),
            Arg::Big(v) => q.bind(v),
            Arg::Bool(v) => q.bind(v),
            Arg::Json(v) => q.bind(v),
            Arg::Time(v) => q.bind(v),
            Arg::Ints(v) => q.bind(v),
            Arg::Texts(v) => q.bind(v),
            Arg::NullJson => q.bind(None::<Value>),
            Arg::NullInt => q.bind(None::<i32>),
            Arg::NullText => q.bind(None::<String>),
            Arg::NullTime => q.bind(None::<DateTime<Utc>>),
        }
    }
    q
}
pub async fn rows<'e, E>(executor: E, sql: &str, args: Vec<Arg>) -> Result<Vec<Value>>
where
    E: sqlx::Executor<'e, Database = sqlx::Postgres>,
{
    Ok(query(sql, args)
        .fetch_all(executor)
        .await?
        .iter()
        .map(row_json)
        .collect())
}
pub fn row_json(row: &PgRow) -> Value {
    let mut out = Map::new();
    for c in row.columns() {
        let k = c.name();
        let v = match c.type_info().name() {
            "BOOL" => row
                .try_get::<Option<bool>, _>(k)
                .ok()
                .flatten()
                .map(Value::Bool),
            "INT2" => row
                .try_get::<Option<i16>, _>(k)
                .ok()
                .flatten()
                .map(|v| Value::from(v as i64)),
            "INT4" => row
                .try_get::<Option<i32>, _>(k)
                .ok()
                .flatten()
                .map(Value::from),
            "INT8" => row
                .try_get::<Option<i64>, _>(k)
                .ok()
                .flatten()
                .map(Value::from),
            "FLOAT8" => row
                .try_get::<Option<f64>, _>(k)
                .ok()
                .flatten()
                .map(Value::from),
            "JSON" | "JSONB" => row.try_get::<Option<Value>, _>(k).ok().flatten(),
            "TIMESTAMPTZ" => row
                .try_get::<Option<DateTime<Utc>>, _>(k)
                .ok()
                .flatten()
                .map(|v| Value::String(v.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))),
            _ => row
                .try_get::<Option<String>, _>(k)
                .ok()
                .flatten()
                .map(Value::String),
        }
        .unwrap_or(Value::Null);
        out.insert(k.to_owned(), v);
    }
    Value::Object(out)
}
pub fn camel_row(row: &Value) -> Value {
    let mut out = Map::new();
    if let Some(obj) = row.as_object() {
        for (k, v) in obj {
            let mut upper = false;
            let key = k
                .chars()
                .filter_map(|c| {
                    if c == '_' {
                        upper = true;
                        None
                    } else if upper {
                        upper = false;
                        Some(c.to_ascii_uppercase())
                    } else {
                        Some(c)
                    }
                })
                .collect::<String>();
            out.insert(key, v.clone());
        }
    }
    Value::Object(out)
}
