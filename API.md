# Console HTTP / WebSocket API

Contract shared by `server/` (axum) and `web/` (React). All request/response bodies are JSON.
Types written as `protocol::…` are the ts-rs generated types from
`../remote-agent/crates/protocol` (copied to `web/src/protocol/`).

## Conventions

* Auth: cookie `console_session` (opaque id, `HttpOnly; SameSite=Lax; Path=/`, `Secure` when
  `CONSOLE_PUBLIC_URL` is https). Mutating requests must send `Content-Type: application/json`
  (the server rejects others with 415 — this is the CSRF guard together with SameSite).
* Errors: status code + `{ "error": { "code": "snake_case", "message": "human readable" } }`.
  Common codes: `unauthorized` (401), `forbidden` (403), `not_found` (404), `validation` (422),
  `conflict` (409), `device_offline` (409), `rate_limited` (429).
* Timestamps: ISO-8601 UTC strings.
* Roles: `admin` (everything) · `operator` (view devices, connect, rename/tag devices, own sessions).
* Ids: UUID v4 strings; device ids are `dev_<22 base62 chars>`, tokens `enr_<…>`, sessions `ses_<…>`.

```ts
type Role = "admin" | "operator";
interface User { id: string; email: string; name: string; role: Role; disabled: boolean; created_at: string; last_login_at?: string }
```

## First run & auth

| Method | Path | Body → Response | Notes |
|--------|------|-----------------|-------|
| GET | `/api/setup` | → `{ needs_setup: boolean }` | true while no user exists |
| POST | `/api/setup` | `{ email, name, password }` → `{ user }` | creates the first **admin**, logs in; 409 once a user exists |
| POST | `/api/auth/login` | `{ email, password }` → `{ user }` | sets cookie; 401 `invalid_credentials`; rate limited per IP |
| POST | `/api/auth/logout` | → 204 | clears cookie |
| GET | `/api/auth/me` | → `{ user }` | 401 when not logged in |
| GET | `/api/info` | → `{ version, protocol_version, public_url, stun_urls: string[], turn_enabled: boolean }` | public |

Password rules: ≥ 10 chars. Hash: argon2id.

## Users (admin)

| Method | Path | Body → Response |
|--------|------|-----------------|
| GET | `/api/users` | → `User[]` |
| POST | `/api/users` | `{ email, name, password, role }` → `User` |
| PATCH | `/api/users/:id` | `{ name?, role?, password?, disabled? }` → `User` (cannot disable/demote the last admin → 409) |
| DELETE | `/api/users/:id` | → 204 (cannot delete yourself / last admin → 409) |

## Enrollment tokens (admin)

```ts
interface EnrollToken {
  id: string; label: string; token_prefix: string;           // first 8 chars for display
  created_by: string; created_at: string; expires_at?: string;
  max_uses?: number; uses: number; revoked: boolean;
  default_mode: protocol.DeviceMode; default_tags: string[];
}
```

| Method | Path | Body → Response |
|--------|------|-----------------|
| GET | `/api/enroll-tokens` | → `EnrollToken[]` |
| POST | `/api/enroll-tokens` | `{ label, expires_in_hours?, max_uses?, default_mode, default_tags }` → `EnrollToken & { token: string, install: { macos: string, windows: string } }` — the plain token and ready-to-paste one-liners are returned **only here** |
| DELETE | `/api/enroll-tokens/:id` | → 204 (revoke) |

Tokens are 32 random bytes, base62; only `sha256(token)` is stored.

## Enrollment & install scripts (unauthenticated)

| Method | Path | Body → Response |
|--------|------|-----------------|
| POST | `/api/enroll` | `protocol.EnrollRequest` → `protocol.EnrollResponse` · 401 `invalid_token` / 410 `token_exhausted` |
| GET | `/install.sh?token=T` | `text/x-shellscript` — macOS installer with `SERVER_URL` and `TOKEN` baked in |
| GET | `/install.ps1?token=T` | `text/plain` — Windows installer, same |

Both scripts: detect arch, download `remote-agent-<os>-<arch>` (+ `SHA256SUMS`) from
`AGENT_DOWNLOAD_BASE`, verify, install to `/usr/local/bin/remote-agent` or
`%ProgramFiles%\RemoteAgent\remote-agent.exe`, run `enroll`, then `service install`.
A missing/invalid token yields a script that prints a clear error and exits 1 (status 200 so `| sh` shows it).

## Devices (operator+)

```ts
interface DeviceDetail extends protocol.DeviceSummary {
  notes: string; created_at: string; enrolled_with?: string;   // token label
  config: protocol.AgentConfig;
}
```

| Method | Path | Body → Response | Role |
|--------|------|-----------------|------|
| GET | `/api/devices` | → `protocol.DeviceSummary[]` | operator |
| GET | `/api/devices/:id` | → `DeviceDetail` | operator |
| PATCH | `/api/devices/:id` | `{ name?, tags?, notes? }` → `DeviceDetail` | operator |
| PATCH | `/api/devices/:id/config` | `Partial<protocol.AgentConfig>` → `DeviceDetail` (merged, pushed live as `config_update` when online) | admin |
| DELETE | `/api/devices/:id` | → 204 (agent receives `goodbye`) | admin |
| GET | `/api/devices/:id/sessions` | → `protocol.SessionSummary[]` (newest first, `?limit=`) | operator |

`DeviceSummary.mode` always mirrors `config.mode`.

## Device groups & access control (RBAC)

Roles stay `admin` / `operator`. **Admins** see and manage everything. **Operators** only see
devices that belong to a group they have a *grant* on; the grant's permission decides what they
may do. Devices in no group are visible to admins only.

```ts
type GroupPermission = "view" | "connect";
interface Group { id: string; name: string; description: string; device_count: number; created_at: string }
interface GroupGrant { user_id: string; user_name: string; user_email: string; permission: GroupPermission }
```

| Method | Path | Body → Response | Role |
|--------|------|-----------------|------|
| GET | `/api/groups` | → `Group[]` (operators: only groups they are granted) | operator |
| POST | `/api/groups` | `{ name, description? }` → `Group` (409 on duplicate name) | admin |
| PATCH | `/api/groups/:id` | `{ name?, description? }` → `Group` | admin |
| DELETE | `/api/groups/:id` | → 204 (devices stay, just ungrouped) | admin |
| GET | `/api/groups/:id/devices` | → `protocol.DeviceSummary[]` | operator (granted) |
| PUT | `/api/groups/:id/devices` | `{ device_ids: string[] }` → 204 — replaces membership | admin |
| GET | `/api/groups/:id/grants` | → `GroupGrant[]` | admin |
| PUT | `/api/groups/:id/grants` | `{ grants: { user_id, permission }[] }` → `GroupGrant[]` — replaces grants | admin |
| PUT | `/api/devices/:id/groups` | `{ group_ids: string[] }` → `DeviceDetail` | admin |
| GET | `/api/users/:id/grants` | → `{ group_id, group_name, permission }[]` | admin |

Enrollment tokens get an optional `default_group_id` (`POST /api/enroll-tokens`), and the token
row exposes `default_group?: { id, name }`; enrolled devices join that group.

**Effective permission** (`protocol.DeviceSummary.permission`, computed per requesting user):
admin → `manage`; operator → highest of their grants over the device's groups (`connect` >
`view`); no grant → the device is not returned at all (404 on direct access).

**Enforcement** (server side, always): `GET /api/devices`, `/api/sessions`,
`/api/devices/:id/sessions`, `/api/sessions/:id/events` and the `/ws/ui` `snapshot` /
`device_update` / `session_update` / `session_event` pushes are filtered to devices the user may
see. `session_offer` needs `connect` (error code `forbidden`). `PATCH /api/devices/:id`
(name/tags/notes) needs `connect`. Config, groups, delete need `manage` (admin).
Audit actions: `group.create|update|delete|members|grants`, `device.groups`.

## Sessions (operator+)

| Method | Path | Body → Response |
|--------|------|-----------------|
| GET | `/api/sessions?active=1&device_id=&limit=50` | → `protocol.SessionSummary[]` |
| POST | `/api/sessions/:id/end` | → 204 — operator: own sessions; admin: any |

Sessions are *created* over `/ws/ui` (see below), never over REST.

## Session shadowing (admin)

An admin can watch a running operator session. The browser sends
`session_offer { device_id, shadow_of: <operator session id> }` (admins only, else `forbidden`);
the console creates a second session row with `role = observer`, forwards
`session_request { role: observer, shadow_of, notify_operator }` to the agent (which fans out
the same encoded video/audio to the extra peer and ignores its `input` channel), lists the admin in
the operator session's `SessionSummary.observers`, and — when `notify_operator` (console setting
`SHADOW_NOTIFY_OPERATOR`, default `true`) — the operator's viewer receives
`ControlMessage::ObserverJoined/Left` from the agent. Audit: `session.shadow` (start/stop);
timeline: `observer_joined` / `observer_left`. Ending the operator session ends its observers.
`POST /api/sessions/:id/end` on an operator session by an admin remains the "kill switch".

## Session events (operator+)

`GET /api/sessions/:id/events?limit=500` → `{ id: number, session_id, ts, event: protocol.SessionEvent }[]`
(oldest first). Events (`{ type: "chat" | "transfer_started" | … }`) are reported by the agent (`AgentToConsole::SessionEvent`: chat lines,
file transfers started/completed/failed, clipboard syncs, display/audio changes), stored by the
console and pushed live to every UI as `ConsoleToUi::SessionEvent`. Transfers additionally
create audit entries `session.transfer`.

## Audit log (admin)

`GET /api/audit?limit=100&before=<id>` → `{ id, ts, user_id?, user_name?, action, target?, details }[]`
Actions: `login`, `login_failed`, `user.create|update|delete`, `token.create|revoke`, `device.update|config|delete`,
`session.start|approve|deny|end`, `enroll`.

## WebSocket `/ws/ui` (cookie auth)

Browser → console: `protocol.UiToConsole`; console → browser: `protocol.ConsoleToUi`.

1. Browser sends `{ type: "subscribe" }` → receives `snapshot`.
2. Live pushes: `device_update`, `device_removed`, `session_update`.
3. Starting a session: `session_offer` → `session_created { session_id, ice_servers }` →
   (later) `session_answer`, `ice_candidate…`, `session_update`.
4. Errors tied to a session carry `session_id`; codes: `device_offline`, `device_busy`
   (already has an active session), `denied`, `approval_timeout`, `agent_error`.
5. `ping`/`pong` every 30 s from the browser; server closes idle sockets after 90 s.

## WebSocket `/ws/agent`

Agent → console: `protocol.AgentToConsole`; console → agent: `protocol.ConsoleToAgent`.
First frame must be `hello`; the console verifies `device_secret` (argon2id) and replies `hello_ack`
or closes with code 4401 (bad credentials) / 4409 (device deleted) / 4426 (protocol version).
A second connection for the same device replaces the first (old one gets `goodbye`).
Missing heartbeats for `3 × heartbeat_interval_s` mark the device offline.

## TURN credentials

When `TURN_SECRET` is set, every `session_created` / `session_request` includes
`{ urls: TURN_URLS, username: "<unix_expiry>:<session_id>", credential: base64(hmac_sha1(secret, username)) }`
(coturn `use-auth-secret` scheme), valid 1 h. STUN servers are always included.
