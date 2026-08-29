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

## Authentication: 2FA, passkeys, OIDC, SAML

Policy env: `REQUIRE_2FA=admins|all|off` (default `admins`) — affected users must complete 2FA
enrollment before any other API call succeeds (`403 { code: "two_factor_required" }`; the SPA
routes them to `/security/setup`). `LOCAL_LOGIN=1|0` (default 1) — when 0, password login is
disabled except for users flagged `break_glass`. Passkeys with user verification satisfy the
2FA requirement on their own; an IdP login satisfies it when the provider config has
`trust_idp_mfa` and the assertion carries an MFA `amr`/`AuthnContext`, else TOTP is still asked.

```ts
type AuthMethod = "password" | "passkey" | "oidc" | "saml" | "ldap";
interface User { …; two_factor_enabled: boolean; email_2fa_enabled: boolean; passkeys: number; auth_methods: AuthMethod[]; break_glass: boolean; last_login_method?: AuthMethod }
```

`two_factor_enabled` is derived: TOTP enrolled **or** at least one passkey **or** `email_2fa_enabled`.

### Login flow (password)
| Method | Path | Body → Response |
|--------|------|-----------------|
| POST | `/api/auth/login` | `{ email, password }` → `200 { user }` (no 2FA) **or** `202 { pending: "two_factor", methods: ("totp" \| "passkey" \| "email")[], challenge_id }` — a 5-minute pre-auth cookie `console_preauth` is set, no session yet. `503 second_factor_unavailable` when the user's only second factor is email codes and outgoing email is not configured (an admin must fix SMTP or reset the user's 2FA). |
| POST | `/api/auth/2fa/verify` | `{ challenge_id, code, method?: "totp" \| "email" }` → `{ user }` + session cookie; 5 attempts then the challenge is voided (`429`). Without `method`: a recovery code is recognised by its shape, otherwise TOTP — unless the challenge carries an outstanding emailed code and the user has no authenticator app, in which case the emailed code is checked. `method: "email"` forces the emailed code. |
| POST | `/api/auth/2fa/email/send` | `{ challenge_id }` (pre-auth cookie) → `{ sent_to: "a***@example.com", expires_in_s: 600 }`. User must have `email_2fa_enabled`; at most 3 codes per challenge with ≥ 30 s between them (`429` + `Retry-After`); `409 email_not_configured`; `502 smtp_failed`. Audited `2fa.email_sent`. |
| POST | `/api/auth/2fa/setup` | (logged in, or in `two_factor_required` state) → `{ secret, otpauth_url, qr_svg }` |
| POST | `/api/auth/2fa/enable` | `{ code }` → `{ recovery_codes: string[] }` (shown once; 10 codes, hashed at rest) |
| POST | `/api/auth/2fa/recovery-codes` | `{ code }` → regenerates |
| POST | `/api/auth/2fa/disable` | `{ code }` → 204 · `409 policy_requires_2fa` when the policy applies to this user |
| POST | `/api/auth/2fa/email/start` | (logged in, or in `two_factor_required` state) → `{ sent_to }` — emails a 6-digit verification code to the account address (valid 10 min); `409 email_not_configured`; 3 codes per 10 min per user (`429`) |
| POST | `/api/auth/2fa/email/enable` | `{ code }` → `{ recovery_codes: string[] \| null }` — codes are only issued when the user has none yet; 5 wrong codes void the setup (`429`) · audited `2fa.enable { method: "email" }` |
| POST | `/api/auth/2fa/email/disable` | (no body) → 204 · `409 policy_requires_2fa` when the policy applies and this is the last factor · audited `2fa.disable { method: "email" }` |
| POST | `/api/users/:id/2fa/reset` | admin → 204 (clears TOTP, passkeys, email codes and recovery codes; user must re-enroll at next login; audited `user.2fa_reset`) |

### Password reset (local accounts only)
Requires `LOCAL_LOGIN=1` **and** outgoing email configured (`GET /api/auth/providers` → `password_reset: true`). Only enabled accounts whose `auth_methods` contain `"password"` are mailed — SSO/LDAP-provisioned users get the same `202` and nothing else (they reset at their identity provider).
| Method | Path | Body → Response |
|--------|------|-----------------|
| POST | `/api/auth/password/forgot` | `{ email }` → always `202 {}` (no account enumeration; also 202 when SMTP is unconfigured, logged as a warning). Rate limited: 5 / 15 min per IP, 3 / 15 min per account. Sends a link `{public_url}/reset-password?token=…` valid 30 minutes; a new request invalidates earlier tokens. Audited `password_reset.request { email, ip, sent }` (no actor). |
| POST | `/api/auth/password/reset` | `{ token, password }` → `200 {}`; `400 invalid_token` (unknown, expired or already used); `422 validation` for a weak password. Sets the password, signs the user out everywhere, deletes the token, sends a "password changed" notice (best effort). Audited `password_reset.complete` (actor = the user). |

### Passkeys (WebAuthn)
| Method | Path | Body → Response |
|--------|------|-----------------|
| POST | `/api/auth/passkeys/register/start` | (logged in) `{ name }` → `PublicKeyCredentialCreationOptions` (JSON, base64url) |
| POST | `/api/auth/passkeys/register/finish` | credential → `Passkey { id, name, created_at, last_used_at, backup_eligible }` |
| GET | `/api/auth/passkeys` | → `Passkey[]` (own); admins: `/api/users/:id/passkeys` |
| PATCH | `/api/auth/passkeys/:id` | `{ name }` → `Passkey` (rename, own; admins may rename any) |
| DELETE | `/api/auth/passkeys/:id` | → 204 (cannot remove the last one while it is the only 2FA method under policy → 409) |
| POST | `/api/auth/passkeys/login/start` | `{}` → `PublicKeyCredentialRequestOptions` (discoverable; UV required) |
| POST | `/api/auth/passkeys/login/finish` | assertion → `{ user }` + session (satisfies 2FA) |
| POST | `/api/auth/2fa/passkey/start|finish` | second-factor variant during a pending challenge |
RP id = host of `CONSOLE_PUBLIC_URL`; origins = the public URL; counters/backup flags checked; audited `passkey.register|remove`, `login` with `method`.
**Security keys (FIDO2 / YubiKey etc.)**: registration never restricts `authenticatorAttachment`, so roaming keys work alongside platform passkeys; `residentKey: preferred` — resident credentials give usernameless login, non-resident ones are offered as a second factor (`POST /api/auth/2fa/passkey/start` uses `allowCredentials` with the user's registered keys); `userVerification: required` for passwordless login, `preferred` for the second-factor step (touch-only keys still count as possession factor together with the password).

### OIDC
Config in `settings` (admin UI) — `{ enabled, display_name, issuer, client_id, client_secret (encrypted), scopes (default "openid email profile"), auto_provision: bool, default_role, admin_claim?: { name, value }, groups_claim?, trust_idp_mfa: bool, allowed_domains?: string[] }`.
| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/auth/providers` | public → `{ local_login: bool, oidc?: { display_name }, saml?: { display_name }, ldap?: { display_name }, passkeys: bool, require_2fa, password_reset: bool, email_2fa: bool }` — `password_reset` = local login **and** SMTP configured; `email_2fa` = SMTP configured (email codes can be enrolled / used) |
| GET | `/api/auth/oidc/start?return=/devices` | redirect to the IdP (PKCE + state + nonce in a short-lived cookie) |
| GET | `/api/auth/oidc/callback` | validates ID token (issuer, aud, nonce, exp, signature via JWKS), links by verified email or provisions; sets session; redirects to `return` |
| GET/PUT | `/api/auth/oidc/config` | admin; `POST /api/auth/oidc/test` performs discovery and reports the endpoints |

### LDAP (simple bind)
Config `{ enabled, display_name, url (ldap:// or ldaps://), bind_dn, bind_password (encrypted), base_dn, user_filter (default "(|(mail={login})(sAMAccountName={login})(uid={login}))"), attribute_map: { email, name, groups (default memberOf) }, auto_provision, default_role, trust_idp_mfa: false, mappings, sync_mode }`.
`POST /api/auth/ldap/login { username, password }` → same `200`/`202` flow as password login; `GET/PUT /api/auth/ldap/config`, `POST /api/auth/ldap/test`, `POST /api/auth/ldap/test-mapping`. `AuthMethod` gains `"ldap"`; `/api/auth/providers` gains `ldap?: { display_name }` and `require_2fa`. GSSAPI/Kerberos not supported.

### Implementation notes (server ≥ this pass)
* SSO logins that still need a second factor redirect the browser to `/login?pending=two_factor&challenge_id=…&methods=totp,passkey&return=/devices`; SSO failures redirect to `/login?error=<code>&provider=<oidc|saml>&message=…`. `POST /api/auth/2fa/verify` returns `{ user, auth_method, return_to }`.
* Login/setup/`me` envelopes carry `two_factor_required` and `auth_method`; passkey `login/start` adds `challenge_id`; finish endpoints accept the bare credential or `{ challenge_id, credential }`.
* Passkey second factor uses `userVerification: required` (touch-only U2F keys need the separate security-key ceremony — not yet offered).
* `429` responses carry `Retry-After`. With `LOCAL_LOGIN=0` the first admin created by `/api/setup` is flagged break-glass automatically.
* Not supported: SAML encrypted assertions, single logout, RSA-SHA1 signatures; Duo (planned as a `2fa` method `duo`).

### IdP group / role mapping (OIDC and SAML)

Access can be defined at the IdP and mapped into the console. Provider config gains
`mappings: Mapping[]` (evaluated top to bottom, all matching rules apply) and `sync_mode`:

```ts
interface Mapping {
  idp_group: string;                 // exact value or glob (e.g. "it-support-*"), matched against the groups claim / SAML attribute
  role?: "admin" | "operator";        // highest matching role wins; admin only via explicit rule
  groups?: { group_id: string; permission: "view" | "connect" }[];  // console device-group grants to apply
}
```

`sync_mode: "additive" | "authoritative"` — additive only ever adds grants/roles on login;
authoritative makes SSO the source of truth: grants that were created by SSO (`group_grants.source
= 'sso'`) and no longer match are removed on each login, while manually created grants (`source =
'manual'`) are kept. Users with no matching rule get `default_role` (or are rejected when
`default_role` is `none`). Role demotion via SSO never removes the last admin (409 logged, user
keeps admin). Group claims: OIDC `groups_claim` (default `groups`, also read from the UserInfo
endpoint when absent from the ID token); SAML `attribute_map.groups` (multi-valued attribute).
`POST /api/auth/{oidc,saml}/test-mapping { groups: string[] }` (admin) shows the resulting
role/grants. Audit `sso.mapping` with the applied changes.

### SAML 2.0
Config: `{ enabled, display_name, idp_metadata_xml | idp_metadata_url, sp_entity_id (default CONSOLE_PUBLIC_URL + "/saml"), attribute_map: { email, name, groups }, auto_provision, default_role, admin_group?, trust_idp_mfa, sign_requests: bool }`; SP key/cert generated at first enable (stored encrypted).
| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/auth/saml/metadata` | SP metadata XML (public) |
| GET | `/api/auth/saml/start?return=` | SP-initiated AuthnRequest (redirect binding) |
| POST | `/api/auth/saml/acs` | Assertion Consumer Service (POST binding); validates signature, audience, conditions, InResponseTo (IdP-initiated allowed when enabled) |
| GET/PUT | `/api/auth/saml/config` · `POST /api/auth/saml/test` | admin |

Sessions record `auth_method`; `GET /api/auth/me` returns it plus `two_factor_enabled` and `two_factor_required` (true while enrollment is pending). Audit: `login` (method, `second_factor: "totp" | "passkey" | "email" | "recovery"`), `login_failed`, `2fa.enable|disable|reset|recovery|email_sent`, `passkey.register|remove`, `sso.link|provision`, `auth.config`, `email.config|test`, `password_reset.request|complete`.

## Email (admin)

Outgoing mail is configured in the admin UI (Settings → Email), not via environment variables. The SMTP password is write-only and sealed with `CONSOLE_MASTER_KEY` like the SSO secrets; changes apply immediately (the configuration is read on every send). Every message uses the branding (product name, accent colour, logo inline as `cid:logo`, organisation and support text) and carries a plain-text alternative.

```ts
type SmtpSecurity = "starttls" | "tls" | "none";        // STARTTLS (587) · implicit TLS (465) · plain
interface SmtpConfig { enabled: boolean; host: string; port: number; security: SmtpSecurity; username: string; password_set: boolean; from_address: string; from_name: string /* "" = product name */; reply_to: string }
interface SmtpConfigInput { enabled: boolean; host: string; port: number; security: SmtpSecurity; username: string; password?: string /* absent/empty = keep stored */; from_address: string; from_name: string; reply_to: string }
```

| Method | Path | Body → Response |
|--------|------|-----------------|
| GET | `/api/email/config` | → `SmtpConfig` |
| PUT | `/api/email/config` | `SmtpConfigInput` → `SmtpConfig` · 422: `host` required when enabled, `port` 1–65535, `from_address` must be an address, `reply_to` empty or an address · audited `email.config` (password stripped) |
| POST | `/api/email/test` | `{ config?: SmtpConfigInput, to?: string }` → `200 { ok: true, detail: "Sent to a@b" }` · sends the branded test message with the given (unsaved) values merged over the stored ones — `enabled` is ignored so a draft can be tested — to `to` or the admin's own address · `400 { error: { code: "smtp_failed", message } }` with the relay's error · 422 when no host / sender is configured |

Mail-dependent features: password reset (`/api/auth/password/*`, local accounts only) and email codes as a second factor (`/api/auth/2fa/email/*`). Both are advertised in `GET /api/auth/providers` (`password_reset`, `email_2fa`) only while SMTP is enabled with a host and sender address.

## Users (admin)

| Method | Path | Body → Response |
|--------|------|-----------------|
| GET | `/api/users` | → `User[]` |
| POST | `/api/users` | `{ email, name, password, role }` → `User` |
| PATCH | `/api/users/:id` | `{ name?, role?, password?, disabled?, break_glass? }` → `User` (cannot disable/demote the last admin → 409) |
| DELETE | `/api/users/:id` | → 204 (cannot delete yourself / last admin → 409) |

`User` carries `email_2fa_enabled` (email codes enrolled) next to `two_factor_enabled` and `passkeys`, so the security pages can show each factor separately.

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

`DeviceSummary.mode` always mirrors `config.mode`. `DeviceSummary.privacy_screen`
(`protocol.PrivacyScreenSupport`: `unsupported` | `screen_only` | `standard`) is what the agent
reported in its last `hello`; it is kept while the device is offline. Config gains
`allow_privacy_screen: boolean` (default `false`, admin PATCH like every other flag, audited in
`device.config`) — see [Privacy screen](#privacy-screen).

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

## Branding & agent bakery

Branding (`protocol.Branding`) is shown in the web console (login page, header) and baked into
agent binaries. The console owns an ed25519 signing key (generated at first start, stored in
the `settings` table); its public key is exposed as `console_public_key` in `GET /api/info`.

| Method | Path | Body → Response | Role |
|--------|------|-----------------|------|
| GET | `/api/branding` | → `protocol.Branding` | public |
| PUT | `/api/branding` | `protocol.Branding` → `protocol.Branding` (logo ≤ 512 KiB PNG, accent `#rrggbb`) | admin |
| GET | `/api/agent/downloads` | → `{ platform, available, source: "local" \| "release", size?: number }[]` for `macos-universal`, `windows-x86_64`, `windows-aarch64` | admin |
| GET | `/api/agent/download/:platform?token=T&quick=0\|1` | baked binary (`application/octet-stream`, `Content-Disposition: attachment; filename="<Product>-<platform>[.exe]"`) | admin cookie **or** a valid enrollment token (`?token=`) |

Baking = `protocol::bakery::append_trailer(base, sign_payload(BakedConfig { server_url: CONSOLE_PUBLIC_URL, enroll_token: token?, quick_support, branding, issued_at }, key))`.
Base binaries come from `AGENT_BINARY_DIR` (files named like the release assets) when set, else
are fetched from `AGENT_DOWNLOAD_BASE` and cached under `data/agent-cache/` (`SHA256SUMS` verified).
Install scripts (`/install.sh`, `/install.ps1`) download the **baked** binary from
`/api/agent/download/<platform>?token=T` (falling back to the release URL only when no base
binary is available) and then only run `remote-agent service install`; the agent enrolls itself
from the trailer token when it is not enrolled yet. Audit: `branding.update`, `agent.bake`.

## Device-side overrides

The person at the device can restrict what operators may do from the agent app's Settings
screen (`protocol.LocalOverrides`: require approval, block input / audio / clipboard / file
transfer / privacy screen). Overrides can only **tighten** the console config; they are reported in `hello`
and `heartbeat` and exposed read-only as `DeviceSummary.local_overrides` so admins see the
effective policy (the device detail page shows them next to the console config, and the
config form no longer has a banner toggle — the branded banner is always shown).

## Privacy screen

An operator can hide the device's own displays behind a branded notice while working
(`config.allow_privacy_screen`). Every gate must pass, in this order:

1. Console policy: `AgentConfig.allow_privacy_screen` (admin-only `PATCH /api/devices/:id/config`,
   default `false`).
2. Operator permission: the requester's effective `DevicePermission` on the device must be
   `manage` (admins always; `connect` is not enough). The console decides this when it grants the
   session and sends it to the agent as `session_request.privacy_screen_allowed: boolean`
   (`false` for observers).
3. The device user's local override (`LocalOverrides.allow_privacy_screen = false`) vetoes.
4. Device support: `DeviceSummary.privacy_screen` must not be `unsupported`.

The person at the device can always lift the screen; once they do, the operator cannot re-engage
it for the rest of that session (`reason: locked`).

Engaging / releasing happens **browser ↔ agent over the WebRTC control channel**, the console
never sees these messages: `set_privacy_screen { enabled }` (browser → agent),
`privacy_screen { active, reason, locked }` (agent → browser, current state) and
`privacy_screen_denied { reason }` (agent → browser; `protocol.PrivacyScreenReason`:
`policy` | `permission` | `unsupported` | `locked` | …). The agent reports every state change to the
console as session event `privacy_screen { active, reason }` (timeline, pushed live) and the
console audits each one as `session.privacy_screen { device_id, active, reason }`.

## macOS app bundle & code signing

For `macos-universal` the bakery returns a **zip** (`<Product>.zip`, `application/zip`)
containing `<Product>.app` (`Contents/Info.plist` with `CFBundleName`/`CFBundleIdentifier`
`com.remoteagent.<slug>`, `LSUIElement` false, `Contents/MacOS/remote-agent`,
`Contents/Resources/baked.json` = the signed `BakedPayload` as a sidecar, `Contents/Resources/AppIcon.icns`
from the branding logo when present). The agent reads the sidecar when running from a bundle,
else the executable trailer. When signing is configured the console signs and notarizes the
bundle before zipping:

| Variable | Purpose |
|----------|---------|
| `MACOS_SIGN_IDENTITY` | e.g. `Developer ID Application: Name (TEAMID)`; uses `codesign` when running on macOS, else `rcodesign` with `MACOS_SIGN_P12` + `MACOS_SIGN_P12_PASSWORD` |
| `MACOS_NOTARY_PROFILE` | `notarytool` keychain profile (macOS host); or `APPLE_API_KEY_JSON` for `rcodesign notary-submit` |

`GET /api/agent/downloads` reports `signed: boolean` and `notarized: boolean` per platform (from
the last bake) and the bake endpoint accepts `?sign=0` to skip signing. Unsigned bundles are
still produced (Gatekeeper then requires "Open Anyway"). Windows Authenticode signing:
`WINDOWS_SIGN_PFX` + `WINDOWS_SIGN_PFX_PASSWORD` via `osslsigncode` when available (optional).

## List pagination

`GET /api/sessions?limit=50&before=<started_at ISO>` and `GET /api/devices/:id/sessions?limit=&before=`
return rows ordered by `started_at` desc; pass the last row's `started_at` as `before` for the
next page. `GET /api/audit?limit=100&before=<id>` unchanged. Responses stay plain arrays; a page
shorter than `limit` is the last one.

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
file transfers started/completed/failed, clipboard syncs, display/audio changes, privacy screen
engaged/released), stored by the console and pushed live to every UI as `ConsoleToUi::SessionEvent`.
Transfers, clipboard syncs and privacy screen changes additionally create audit entries
`session.transfer`, `session.clipboard` and `session.privacy_screen`.

## Audit log (admin)

`GET /api/audit?limit=100&before=<id>` → `{ id, ts, user_id?, user_name?, action, target?, details }[]`
Actions: `login`, `login_failed`, `user.create|update|delete`, `token.create|revoke`, `device.update|config|delete`,
`session.start|approve|deny|end|transfer|clipboard|privacy_screen`, `enroll`.

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
