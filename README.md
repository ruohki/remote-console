# remote-console

Management server and web viewer for [`remote-agent`](../remote-agent): device registry,
enrollment tokens, one-line install scripts, WebRTC signaling hub, TURN credentials and the
operator UI (live device list, remote control viewer, sessions, users).

Design and wire protocol: [`../remote-agent/ARCHITECTURE.md`](../remote-agent/ARCHITECTURE.md).

## Run it

```sh
docker compose up -d          # console on :8080, coturn on :3478 (udp/tcp) + relay ports
open http://localhost:8080    # first visit → create the admin account
```

Configuration is via environment variables (see `.env.example`):

| Variable | Default | Purpose |
|----------|---------|---------|
| `CONSOLE_PUBLIC_URL` | `http://localhost:8080` | URL agents and install scripts use |
| `DATABASE_URL` | `sqlite:///data/console.db` | SQLite (default) or `postgres://…` |
| `LISTEN_ADDR` | `0.0.0.0:8080` | HTTP/WebSocket listener |
| `TURN_URLS` | – | e.g. `turn:turn.example.com:3478?transport=udp,turns:…:5349` |
| `TURN_SECRET` | – | coturn `static-auth-secret` for short-lived credentials |
| `STUN_URLS` | `stun:stun.l.google.com:19302` | comma separated |
| `AGENT_DOWNLOAD_BASE` | GitHub releases of `ruohki/remote-agent` | where install scripts fetch binaries |
| `SESSION_TTL_HOURS` | `168` | login session lifetime |
| `RUST_LOG` | `info` | log filter |

Put the console behind a TLS terminating reverse proxy (Caddy/Traefik/nginx) — WebRTC in
browsers requires HTTPS, and agents connect over `wss://`.

## Development

```sh
# server (Rust) — the web/dist folder is embedded at build time; build it first
cd web && npm install && npm run build && cd ..
cargo run -p remote-console
# UI with hot reload (proxies /api and /ws to :8080)
cd web && npm run dev
# refresh protocol TypeScript types from ../remote-agent/crates/protocol
cd web && npm run sync-protocol
```

## Layout

```
server/src
  main.rs         CLI + startup
  config.rs       env configuration
  db/             sqlx models, migrations in server/migrations
  auth/           passwords, cookie sessions, roles, extractors
  api/            REST: auth, users, devices, sessions, enroll tokens, enroll, install scripts
  hub/            agent WebSocket hub, UI WebSocket, session signaling state
  turn.rs         short-lived TURN credentials
  static_files.rs embedded SPA
web/              Vite + React + TypeScript + Tailwind SPA
```

## License

AGPL-3.0-only.
