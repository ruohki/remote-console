-- Second factor, passkeys, SSO links and pending auth ceremonies.

ALTER TABLE users ADD COLUMN totp_secret_enc TEXT NULL;
ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN break_glass INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN auth_methods TEXT NOT NULL DEFAULT '["password"]';
ALTER TABLE users ADD COLUMN last_login_method TEXT NULL;

ALTER TABLE user_sessions ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'password';

CREATE TABLE user_recovery_codes (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    used_at   TEXT NULL
);
CREATE INDEX idx_recovery_codes_user ON user_recovery_codes(user_id);

CREATE TABLE user_passkeys (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    credential_id   TEXT NOT NULL UNIQUE,
    passkey_json    TEXT NOT NULL,
    counter         INTEGER NOT NULL DEFAULT 0,
    backup_eligible INTEGER NOT NULL DEFAULT 0,
    backup_state    INTEGER NOT NULL DEFAULT 0,
    transports      TEXT NOT NULL DEFAULT '[]',
    created_at      TEXT NOT NULL,
    last_used_at    TEXT NULL
);
CREATE INDEX idx_passkeys_user ON user_passkeys(user_id);

-- Short-lived state for pending 2FA challenges, WebAuthn ceremonies, OIDC/SAML requests and
-- SAML assertion replay protection.
CREATE TABLE auth_states (
    id          TEXT PRIMARY KEY,
    kind        TEXT NOT NULL,
    user_id     TEXT NULL REFERENCES users(id) ON DELETE CASCADE,
    payload_enc TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL
);
CREATE INDEX idx_auth_states_expires ON auth_states(expires_at);
CREATE INDEX idx_auth_states_kind ON auth_states(kind);

CREATE TABLE sso_links (
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider   TEXT NOT NULL CHECK (provider IN ('oidc', 'saml', 'ldap')),
    subject    TEXT NOT NULL,
    email      TEXT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (provider, subject)
);
CREATE INDEX idx_sso_links_user ON sso_links(user_id);

ALTER TABLE group_grants ADD COLUMN source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'sso'));
