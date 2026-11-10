#![forbid(unsafe_code)]
use archivepool::{App, config::Config};
use std::{sync::Arc, time::Duration};
#[tokio::main]
async fn main() {
    let config = Config::load();
    let port = config.port;
    let app = match App::new(config) {
        Ok(app) => Arc::new(app),
        Err(_) => {
            eprintln!("archivepool: invalid server configuration");
            std::process::exit(1)
        }
    };
    let boot = app.db.clone();
    tokio::spawn(async move {
        if boot.ensure().await.is_err() {
            eprintln!("archivepool: schema bootstrap unavailable");
        }
    });
    let listener =
        match tokio::net::TcpListener::bind((std::net::Ipv4Addr::UNSPECIFIED, port)).await {
            Ok(l) => l,
            Err(_) => {
                eprintln!("archivepool: cannot bind listener");
                std::process::exit(1)
            }
        };
    eprintln!("archivepool listening on port {port}");
    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
    let server = axum::serve(listener, archivepool::api::router(app.clone()))
        .with_graceful_shutdown(async {
            let _ = stop_rx.await;
        });
    let task = tokio::spawn(async move {
        let _ = server.await;
    });
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .expect("signal registration");
    tokio::select! {_ = tokio::signal::ctrl_c()=>{},_ = term.recv()=>{}}
    let _ = stop_tx.send(());
    let _ = tokio::time::timeout(Duration::from_secs(20), task).await;
    app.db.close().await;
}
