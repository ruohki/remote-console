# Security

## Threat model in one page

**The console is the trust anchor.** It authenticates operators (argon2id passwords, cookie
sessions, roles and device-group grants), authenticates agents (per-device secrets, argon2id
hashed), relays WebRTC signaling and mints TURN credentials. Whoever controls the console
controls who may connect to which device. Everything below assumes the console host itself is
trustworthy and administered like any other privileged server.

**Media and control are end-to-end encrypted between browser and agent.** Screen, audio,
keyboard/mouse, files, chat and annotations travel over WebRTC: DTLS-SRTP for media, DTLS over
SCTP for data channels. Keys are negotiated between the two peers; the console only sees SDP
and ICE candidates (addresses and DTLS fingerprints), never content. A TURN relay forwards
encrypted packets it cannot decrypt.

**What the console can see:** who connected to which device and when (sessions, audit log),
chat transcripts and transfer metadata *as reported by the agent* (session events), device
inventory and presence. **What it cannot see:** screen content, input, file contents.

**Agents trust the console they enrolled with.** Baked binaries carry the console URL, token
and branding signed with the console's ed25519 key; the agent pins that key at enrollment and
rejects configuration from any other key. Enrollment tokens inside distributed binaries are
readable — use limited-use or expiring tokens for distributed builds.

## Built-in protections

| Area | Measure |
|------|---------|
| Transport | Refuses a plain-http `CONSOLE_PUBLIC_URL` on a public host (`ALLOW_INSECURE_PUBLIC_URL=1` to override, loudly). HSTS when https. `TRUST_PROXY=1` required before forwarding headers are honoured. |
| Browser | CSP (`default-src 'self'`, no inline scripts, `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (camera/mic/geolocation off), COOP `same-origin`. |
| CSRF | Mutating `/api` requests must be JSON; when the browser sends `Origin` it must match the console origin (also on the UI WebSocket upgrade). Session cookie `HttpOnly`, `Secure` (https), `SameSite=Lax` (Lax rather than Strict so deep links from other sites keep working; the Origin check closes the gap). |
| Sessions | Random 128-bit ids, absolute lifetime `SESSION_TTL_HOURS`, 12 h idle timeout, new id on every login (old cookie session invalidated), server-side logout, all sessions revoked when a user is disabled/deleted. |
| Brute force | Login: per-IP window (10 failures / 15 min) and per-account exponential backoff (5 failures → 60 s, doubling to 1 h). Agent hello: per-IP backoff. Enrollment: 10/min per IP and per token. Bakes: 6/min per IP. argon2 verifications bounded to 4 concurrent. |
| Secrets | Passwords and device secrets: argon2id. Enrollment tokens: SHA-256 only. Bakery signing key: encrypted with XChaCha20-Poly1305 under `CONSOLE_MASTER_KEY` (HKDF-derived); without a master key it is plaintext in the SQLite file (the server warns). TURN credentials: HMAC, 1 h, bound to the session id. |
| WebSockets | 256 KiB text frame limit, binary frames rejected, agent hello timeout 10 s, idle UI sockets closed, per-session event rate limiting. |
| Bodies | 2 MiB JSON limit; branding logo ≤ 1 MiB PNG (magic checked). |
| Access control | Every API route is behind `AuthUser`/`AdminUser` extractors or a token check; device visibility and `connect` permission enforced server-side for REST, WebSocket pushes and `session_offer`. |
| Relay | coturn with per-session credentials, `denied-peer-ip` for all private ranges (the relay cannot reach your LAN), TLS 1.2+ only, quotas. |
| Logs | Secrets, tokens and passwords are never logged; failed logins are audited with IP and email. |

## Deployment checklist

1. **TLS**: terminate HTTPS in front of the console (Caddy/Traefik/nginx), set
   `CONSOLE_PUBLIC_URL=https://…` and `TRUST_PROXY=1`. Bind the console to localhost or the
   Docker network only (the compose file publishes `127.0.0.1:8080`).
2. **Master key**: `CONSOLE_MASTER_KEY=$(openssl rand -base64 32)` before the first start;
   store it in your secret manager, not next to the database backup.
3. **TURN**: run coturn with `turn:` on 3478 and `turns:` on 443, a real certificate, and
   your own `STUN_URLS` (see `coturn/README.md`). Set a strong `TURN_SECRET`.
4. **Firewall**: expose only 443 (console via proxy), 3478 udp/tcp, 443 tcp on the relay
   host, and the relay UDP range. Nothing else.
5. **Pinning**: set `CONSOLE_TLS_CERT_PEM` (or `CONSOLE_TLS_SPKI_SHA256`) so agents can pin
   the console's public key; rotate the pin when the certificate key changes.
6. **Accounts**: one admin per person, operators with group grants only, disable accounts
   instead of sharing them. Passwords ≥ 10 characters (use a password manager).
7. **Tokens**: short-lived, limited-use enrollment tokens; revoke after rollouts; single-use
   tokens for quick-support builds.
8. **Backups**: `data/console.db` (contains hashed secrets and, without a master key, the
   signing key) — encrypt backups; keep the master key separately.
9. **Updates**: rebuild from tagged releases; the agent's `update` path verifies SHA-256 and
   the console key.
10. **Monitoring**: watch the audit log for `login_failed` bursts, `session.deny`, and bakes.

## Known limitations

* The console cannot verify what the agent reports about a session (transcripts, transfer
  names) — a compromised agent could lie in its own audit trail.
* SDP passes through the console unsigned; a malicious console could substitute DTLS
  fingerprints (console = trust anchor). Signing offers/answers with the console key is a
  possible future hardening.
* The device secret and the master key are plaintext in the agent's/console's process
  memory and, for the agent, in `agent.toml` (owner-only permissions). Keychain/DPAPI
  storage is a follow-up.
* Windows Authenticode signing of baked agents is not implemented yet.

## Reporting a vulnerability

Please report security issues privately to the maintainers (see the repository owner's
contact) rather than in public issues. Include reproduction steps and the affected version;
you will get an acknowledgement within a few days.
