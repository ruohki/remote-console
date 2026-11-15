//! remote-console — management server. See ../../remote-agent/ARCHITECTURE.md.

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use remote_console::app::{build_router, AppState};
use remote_console::config::Config;
use std::net::SocketAddr;

#[derive(Parser)]
#[command(
    name = "remote-console",
    version,
    about = "Management console for remote-agent"
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Run the HTTP/WebSocket server (default).
    Serve,
    /// Create an administrator account (or promote/reset an existing user by email).
    CreateAdmin {
        #[arg(long)]
        email: String,
        #[arg(long)]
        name: String,
        #[arg(long)]
        password: String,
    },
    /// Apply pending database migrations and exit.
    Migrate,
}

#[tokio::main]
async fn main() -> Result<()> {
    let _ = dotenvy::dotenv();
    init_tracing();
    let cli = Cli::parse();
    let config = Config::from_env()?;

    match cli.command.unwrap_or(Command::Serve) {
        Command::Serve => serve(config).await,
        Command::Migrate => {
            remote_console::db::connect(&config).await?;
            println!("migrations applied");
            Ok(())
        }
        Command::CreateAdmin {
            email,
            name,
            password,
        } => create_admin(config, email, name, password).await,
    }
}

fn init_tracing() {
    use tracing_subscriber::{fmt, prelude::*, EnvFilter};
    let filter = EnvFilter::try_from_env("RUST_LOG")
        .unwrap_or_else(|_| EnvFilter::new("info,tower_http=info"));
    tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer().with_target(false))
        .init();
}

async fn serve(config: Config) -> Result<()> {
    remote_console::app::install_crypto_provider();
    config.validate_for_serve()?;
    let listen = config.listen_addr.clone();
    let public_url = config.public_url.clone();
    tokio::spawn(remote_console::turn::run_cloudflare_refresher(
        config.clone(),
    ));
    let state = AppState::init(config).await?;
    let hub = state.hub.clone();
    let app = build_router(state);
    let listener = tokio::net::TcpListener::bind(&listen)
        .await
        .with_context(|| format!("binding {listen}"))?;
    tracing::info!(version = remote_console::VERSION, %listen, %public_url, "remote-console listening");

    // On SIGTERM / Ctrl-C the listener stops accepting and, in parallel, every agent is told
    // `goodbye { reason: "console restarting" }` and closed cleanly — agents then reconnect
    // within seconds instead of backing off. Upgraded WebSockets are not tracked by the
    // server's graceful shutdown, so the hub closes them itself.
    let shutdown = tokio_util::sync::CancellationToken::new();
    tokio::spawn({
        let shutdown = shutdown.clone();
        async move {
            shutdown_signal().await;
            shutdown.cancel();
        }
    });
    let agents_closed = tokio::spawn({
        let shutdown = shutdown.clone();
        async move {
            shutdown.cancelled().await;
            let n = hub.shutdown_agents(AGENT_SHUTDOWN_GRACE).await;
            tracing::info!("said goodbye to {n} agent(s)");
        }
    });
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown.clone().cancelled_owned())
    .await
    .context("server error")?;
    let _ = agents_closed.await;
    tracing::info!("shutdown complete");
    Ok(())
}

/// How long shutdown waits for agent sockets to flush their goodbye and close.
const AGENT_SHUTDOWN_GRACE: std::time::Duration = std::time::Duration::from_secs(5);

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut sig) => {
                sig.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("shutdown signal received");
}

async fn create_admin(config: Config, email: String, name: String, password: String) -> Result<()> {
    use remote_console::auth;
    use remote_console::db::{self, models::Role, users::UserUpdate};

    auth::validate_email(&email).map_err(|e| anyhow::anyhow!(e.message))?;
    auth::validate_password(&password).map_err(|e| anyhow::anyhow!(e.message))?;
    let pool = db::connect(&config).await?;
    let hash = auth::hash_password(&password)?;
    match db::users::by_email(&pool, &email).await? {
        Some(existing) => {
            db::users::update(
                &pool,
                &existing.id,
                UserUpdate {
                    name: Some(&name),
                    role: Some(Role::Admin),
                    password_hash: Some(&hash),
                    disabled: Some(false),
                },
            )
            .await?;
            println!(
                "updated existing user {} → admin, password reset",
                existing.email
            );
        }
        None => {
            let user = db::users::create(&pool, &email, &name, &hash, Role::Admin).await?;
            println!("created admin {} ({})", user.email, user.id);
        }
    }
    Ok(())
}
