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
| `TURN_USERNAME` / `TURN_PASSWORD` | – | long-term credentials for a hosted relay that issues a fixed pair; ignored when `TURN_SECRET` is set |
| `STUN_URLS` | `stun:stun.l.google.com:19302` | comma separated |
| `AGENT_DOWNLOAD_BASE` | GitHub releases of `ruohki/remote-agent` | where install scripts fetch binaries (fallback for baking) |
| `AGENT_BINARY_DIR` | – | directory of base agent binaries to bake branding into (else fetched & cached) |
| `MACOS_SIGN_IDENTITY` | – | `Developer ID Application: Name (TEAMID)`; signs baked `.app` bundles with `codesign` (macOS host) |
| `MACOS_NOTARY_PROFILE` | – | `notarytool` keychain profile (`xcrun notarytool store-credentials <profile>`); notarizes + staples bundles |
| `MACOS_SIGN_P12` / `MACOS_SIGN_P12_PASSWORD` (or `MACOS_SIGN_P12_PASSWORD_FILE`) | – | Developer ID certificate for `rcodesign` on non-macOS hosts (Docker); see [Signing from Linux](#signing-macos-agents-from-linux--docker) |
| `APPLE_API_KEY_JSON` | – | App Store Connect API key file for `rcodesign notary-submit` |
| `WINDOWS_SIGN_PFX` / `WINDOWS_SIGN_PFX_PASSWORD` | – | reserved for Authenticode signing (not applied yet, see docs) |
| `SESSION_TTL_HOURS` | `168` | absolute login session lifetime (sessions also expire after 12 h idle) |
| `REQUIRE_2FA` | `admins` | `admins` / `all` / `off` — who must enrol a second factor (TOTP or passkey) before using the console |
| `LOCAL_LOGIN` | `1` | set `0` to disable password sign-in except for accounts flagged `break_glass` (requires at least one such admin; SSO/LDAP/passkeys still work) |
| `ALLOW_INSECURE_PUBLIC_URL` | – | set `1` to allow a plain-http public URL on a public host (never in production) |
| `TRUST_PROXY` | – | set `1` behind a reverse proxy so `X-Forwarded-For`/`-Proto` are honoured |
| `CONSOLE_MASTER_KEY` | – | 32 bytes base64; encrypts the bakery signing key at rest (see SECURITY.md) |
| `CONSOLE_TLS_CERT_PEM` / `CONSOLE_TLS_SPKI_SHA256` | – | publish the console's TLS public-key pin in `/api/info` |
| `TURN_HOST` | – | DNS name of the relay (docker-compose builds `turn:`/`turns:` URLs from it) |
| `RUST_LOG` | `info` | log filter |

Put the console behind a TLS terminating reverse proxy (Caddy/Traefik/nginx) — WebRTC in
browsers requires HTTPS, and agents connect over `wss://`.

### Sign-in options

Local accounts use a password plus, when enrolled, an authenticator app (TOTP with recovery
codes) or a passkey / FIDO2 security key (WebAuthn; the RP id is the host of
`CONSOLE_PUBLIC_URL`, so decide on the public hostname before people enrol keys). Passkeys
with user verification can also sign in on their own.

Single sign-on is configured by an administrator under *Settings → Authentication*
(`/api/auth/{oidc,saml,ldap}/config`); secrets are stored encrypted with `CONSOLE_MASTER_KEY`:

| Provider | Notes |
|----------|-------|
| OIDC | discovery from the issuer URL, authorization code + PKCE, ID token checked against the JWKS; redirect URI `CONSOLE_PUBLIC_URL/api/auth/oidc/callback`; groups from the `groups` claim or UserInfo |
| SAML 2.0 | SP metadata at `/api/auth/saml/metadata` (entity id `CONSOLE_PUBLIC_URL/saml`, ACS `/api/auth/saml/acs`); paste or fetch the IdP metadata; assertions must be signed (encrypted assertions are not supported); IdP-initiated login is off unless enabled |
| LDAP / Active Directory | simple bind through a read-only service account (`ldap://` + StartTLS or `ldaps://`, optional CA certificate); `POST /api/auth/ldap/login { username, password }`; groups from `memberOf` |

Every provider maps IdP groups to console roles and device-group grants (`mappings`, glob
patterns allowed) with `sync_mode` `additive` or `authoritative`; `POST
/api/auth/<provider>/test-mapping { groups }` previews the result. With `trust_idp_mfa` an
assertion that carries an MFA context (`amr` / `AuthnContextClassRef`) satisfies the
second-factor requirement; otherwise enrolled users are still asked for their TOTP or
passkey. See `API.md` for the full contract.

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


## Signing macOS agents from Linux / Docker

The Docker image ships [`rcodesign`](https://github.com/indygreg/apple-platform-rs) (pinned,
checksum-verified), so baked `.app` bundles are signed and notarized without a Mac. One-time
preparation, on a Mac with the Developer ID identity:

1. **Certificate** — Keychain Access → My Certificates → right-click *Developer ID Application:
   … (TEAMID)* → Export → `.p12` with a password (the private key must be included).
2. **API key** — App Store Connect → Users and Access → Integrations → Team Keys → generate a
   key with the *Developer* role; download `AuthKey_<KEYID>.p8` once. Encode it:
   `rcodesign encode-app-store-connect-api-key -o app-store-connect.json <ISSUER-ID> <KEYID> AuthKey_<KEYID>.p8`
3. Mount both files into the container and set

   ```
   MACOS_SIGN_P12=/secrets/developer-id.p12
   MACOS_SIGN_P12_PASSWORD_FILE=/secrets/developer-id.password   # or MACOS_SIGN_P12_PASSWORD
   APPLE_API_KEY_JSON=/secrets/app-store-connect.json
   ```

`MACOS_SIGN_IDENTITY` / `MACOS_NOTARY_PROFILE` are the macOS-host equivalents and are ignored on
Linux. The container needs outbound HTTPS to `appstoreconnect.apple.com` (notary service) and
`timestamp.apple.com` (secure timestamps). Notarization takes 1–5 minutes; the bakery caches
the result per platform and branding, so only the first download waits.
