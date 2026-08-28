//! remote-console — management server. See ../../remote-agent/ARCHITECTURE.md.
fn main() {
    println!("remote-console {}", env!("CARGO_PKG_VERSION"));
    let _ = protocol::PROTOCOL_VERSION;
}
