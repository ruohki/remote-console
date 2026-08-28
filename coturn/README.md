# coturn for remote-console

The console mints short-lived TURN credentials (`<expiry>:<session_id>` + HMAC with
`TURN_SECRET`, one hour) for every session. coturn verifies them with `use-auth-secret`, so
no static usernames or passwords exist.

## Ports to open on the host firewall

| Port | Protocol | Purpose |
|------|----------|---------|
| 3478 | UDP + TCP | STUN and plain TURN |
| 443 | TCP | TURN over TLS (`turns:`) — the fallback for strict networks and browsers with "disable non-proxied UDP" |
| 49160–49200 | UDP | relay ports (media between the relay and the peers) |

If 443 is already used by the reverse proxy on the same host, either give coturn its own
IP/host (recommended: `TURN_HOST=turn.example.com`) or change `tls-listening-port` and the
`turns:` entry in `TURN_URLS` to 5349.

## TLS certificate

`turns:` needs a certificate for `TURN_HOST`. Mount `fullchain.pem` and `privkey.pem` into
`./coturn/certs/` — e.g. from certbot:

```sh
mkdir -p coturn/certs
certbot certonly --standalone -d turn.example.com
cp /etc/letsencrypt/live/turn.example.com/{fullchain,privkey}.pem coturn/certs/
docker compose restart coturn
```

Renewals: copy the new files and restart coturn (or run certbot with a `--deploy-hook`).

## Environment

```
TURN_SECRET=<openssl rand -hex 32>
TURN_HOST=turn.example.com          # DNS name of the relay (also used as the TLS name)
TURN_PUBLIC_IP=203.0.113.10         # public IP coturn advertises (external-ip)
TURN_URLS=turn:turn.example.com:3478?transport=udp,turns:turn.example.com:443?transport=tcp
STUN_URLS=stun:turn.example.com:3478
```

## Test the relay

With the console running, take the credentials from any session's `session_created` message
or compute them by hand:

```sh
EXP=$(( $(date +%s) + 600 ))
USER="$EXP:test"
CRED=$(printf '%s' "$USER" | openssl dgst -sha1 -hmac "$TURN_SECRET" -binary | base64)
turnutils_uclient -T -u "$USER" -w "$CRED" -y turn.example.com          # TCP/TLS
turnutils_uclient -u "$USER" -w "$CRED" -y -p 3478 turn.example.com    # UDP
```

Or use https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/ with the
`turns:` URL and the same credentials: a `relay` candidate must appear.

## What the relay will not do

* relay into private networks (`denied-peer-ip` for RFC 1918, CGNAT, link-local, ULA, …) —
  a compromised operator account cannot use your relay to reach hosts behind it;
* accept TLS 1.0/1.1 or weak ciphers;
* reveal its software version (`no-software-attribute`).

Quotas (`user-quota`, `total-quota`, `max-bps`) bound abuse; raise them for large fleets.
