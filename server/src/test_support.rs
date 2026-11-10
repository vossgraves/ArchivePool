use crate::{App, config::Config, health::Endpoints, httpx::Outbound};
use axum::{
    Router,
    body::{Body, to_bytes},
    extract::Request,
    response::Response,
};
use serde_json::Value;
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub struct Recorded {
    pub path: String,
    pub query: String,
    pub headers: axum::http::HeaderMap,
    pub body: Vec<u8>,
}
pub struct Mock {
    pub url: String,
    pub requests: Arc<Mutex<Vec<Recorded>>>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Mock {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Mock {
    pub async fn new(f: impl Fn(&Recorded) -> Response + Send + Sync + 'static) -> Self {
        let f = Arc::new(f);
        Self::new_async(move |r| std::future::ready(f(&r))).await
    }
    pub async fn new_async<F, Fut>(f: F) -> Self
    where
        F: Fn(Recorded) -> Fut + Send + Sync + 'static,
        Fut: std::future::Future<Output = Response> + Send + 'static,
    {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let seen = requests.clone();
        let f = Arc::new(f);
        let router = Router::new().fallback(move |req: Request| {
            let seen = seen.clone();
            let f = f.clone();
            async move {
                let r = Recorded {
                    path: req.uri().path().into(),
                    query: req.uri().query().unwrap_or("").into(),
                    headers: req.headers().clone(),
                    body: to_bytes(req.into_body(), 1024 * 1024)
                        .await
                        .unwrap()
                        .to_vec(),
                };
                seen.lock().unwrap().push(r.clone());
                let answer = f(r).await;
                answer
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        Self {
            url,
            requests,
            task,
        }
    }
    pub async fn fixed(status: u16, body: impl Into<String>) -> Self {
        let body = body.into();
        Self::new(move |_| {
            Response::builder()
                .status(status)
                .body(Body::from(body.clone()))
                .unwrap()
        })
        .await
    }
    pub fn app(&self) -> App {
        let mut app = App::new(Config {
            encryption_key: Some([7; 32]),
            client_key: Some([8; 32]),
            session_secret: "local-session-secret".into(),
            ..Config::default()
        })
        .unwrap();
        app.outbound = Outbound::local();
        app.endpoints = Endpoints {
            tidal_token: format!("{}/token", self.url),
            tidal_sessions: format!("{}/sessions", self.url),
            tidal_users: format!("{}/users", self.url),
            tidal_device: format!("{}/device", self.url),
            qobuz_api: format!("{}/qobuz", self.url),
            qobuz_play: self.url.clone(),
            qobuz_open: self.url.clone(),
            deezer: format!("{}/deezer", self.url),
            apple_home: self.url.clone(),
            apple_api: self.url.clone(),
            apple_playback: format!("{}/playback", self.url),
            monochrome: format!("{}/instances.json", self.url),
        };
        app
    }
    pub async fn database_app(&self) -> Option<App> {
        let raw = std::env::var("TEST_DATABASE_URL").ok()?;
        let url = url::Url::parse(&raw).unwrap();
        assert!(
            matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]")),
            "Database tests require local Postgres"
        );
        let mut app = self.app();
        app.db = crate::db::Db::open(&raw, 2).unwrap();
        app.db.ensure().await.unwrap();
        Some(app)
    }
}
pub async fn response_json(r: Response) -> Value {
    serde_json::from_slice(&to_bytes(r.into_body(), 1024 * 1024).await.unwrap()).unwrap()
}
