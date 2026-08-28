# remote-console

Management server and web viewer for [`remote-agent`](../remote-agent): device registry,
enrollment tokens, one-line install scripts, WebRTC signaling hub, TURN credentials and the
operator UI (live device list, multi-display remote control viewer with audio, file transfer,
chat and clipboard, session timelines, device groups with per-user access, users, audit log).

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
| `DATABASE_URL` | `sqlite://data/console.db?mode=rwc` | SQLite (Postgres support is compiled in but not wired up yet) |
| `LISTEN_ADDR` | `0.0.0.0:8080` | HTTP/WebSocket listener |
| `TURN_URLS` | – | e.g. `turn:turn.example.com:3478?transport=udp,turns:…:5349` |
| `TURN_SECRET` | – | coturn `static-auth-secret` for short-lived credentials |
| `STUN_URLS` | `stun:stun.l.google.com:19302` | comma separated |
| `AGENT_DOWNLOAD_BASE` | GitHub releases of `ruohki/remote-agent` | where install scripts fetch binaries (fallback for baking) |
| `AGENT_BINARY_DIR` | – | directory of base agent binaries to bake branding into (else fetched & cached) |
| `MACOS_SIGN_IDENTITY` | – | `Developer ID Application: Name (TEAMID)`; signs baked `.app` bundles with `codesign` (macOS host) |
| `MACOS_NOTARY_PROFILE` | – | `notarytool` keychain profile (`xcrun notarytool store-credentials <profile>`); notarizes + staples bundles |
| `MACOS_SIGN_P12` / `MACOS_SIGN_P12_PASSWORD` | – | Developer ID certificate for `rcodesign` on non-macOS hosts (Docker) |
| `APPLE_API_KEY_JSON` | – | App Store Connect API key file for `rcodesign notary-submit` |
| `WINDOWS_SIGN_PFX` / `WINDOWS_SIGN_PFX_PASSWORD` | – | reserved for Authenticode signing (not applied yet, see docs) |
| `SESSION_TTL_HOURS` | `168` | absolute login session lifetime (sessions also expire after 12 h idle) |
| `ALLOW_INSECURE_PUBLIC_URL` | – | set `1` to allow a plain-http public URL on a public host (never in production) |
| `TRUST_PROXY` | – | set `1` behind a reverse proxy so `X-Forwarded-For`/`-Proto` are honoured |
| `CONSOLE_MASTER_KEY` | – | 32 bytes base64; encrypts the bakery signing key at rest (see SECURITY.md) |
| `CONSOLE_TLS_CERT_PEM` / `CONSOLE_TLS_SPKI_SHA256` | – | publish the console's TLS public-key pin in `/api/info` |
| `TURN_HOST` | – | DNS name of the relay (docker-compose builds `turn:`/`turns:` URLs from it) |
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
