//! remote-console library: everything except the CLI entry point lives here so the
//! integration tests can build the application in-process.

pub mod agent_bakery;
pub mod api;
pub mod app;
pub mod auth;
pub mod config;
pub mod db;
pub mod error;
pub mod hub;
pub mod ids;
pub mod install;
pub mod mail;
pub mod static_files;
pub mod turn;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
