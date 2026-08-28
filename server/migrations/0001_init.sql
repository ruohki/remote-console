-- Initial schema. Portable SQL (SQLite now, Postgres later): TEXT ids, ISO-8601 TEXT timestamps,
-- INTEGER booleans, JSON stored as TEXT.

CREATE TABLE users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name          TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('admin', 'operator')),
    disabled      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL,
    last_login_at TEXT
);

CREATE TABLE user_sessions (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);
CREATE INDEX idx_user_sessions_user ON user_sessions(user_id);
CREATE INDEX idx_user_sessions_expires ON user_sessions(expires_at);

CREATE TABLE enroll_tokens (
    id           TEXT PRIMARY KEY,
    label        TEXT NOT NULL,
    token_hash   TEXT NOT NULL UNIQUE,
    token_prefix TEXT NOT NULL,
    created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at   TEXT NOT NULL,
    expires_at   TEXT,
    max_uses     INTEGER,
    uses         INTEGER NOT NULL DEFAULT 0,
    revoked      INTEGER NOT NULL DEFAULT 0,
    default_mode TEXT NOT NULL DEFAULT 'unattended',
    default_tags TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE devices (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    hostname       TEXT NOT NULL,
    os             TEXT NOT NULL,
    arch           TEXT NOT NULL,
    agent_version  TEXT NOT NULL,
    secret_hash    TEXT NOT NULL,
    config         TEXT NOT NULL,
    tags           TEXT NOT NULL DEFAULT '[]',
    notes          TEXT NOT NULL DEFAULT '',
    online         INTEGER NOT NULL DEFAULT 0,
    last_seen_at   TEXT,
    last_ip        TEXT,
    logged_in_user TEXT,
    codecs         TEXT NOT NULL DEFAULT '[]',
    displays       TEXT NOT NULL DEFAULT '[]',
    enrolled_with  TEXT REFERENCES enroll_tokens(id) ON DELETE SET NULL,
    created_at     TEXT NOT NULL
);
CREATE INDEX idx_devices_name ON devices(name);

CREATE TABLE remote_sessions (
    id           TEXT PRIMARY KEY,
    device_id    TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    operator_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
    state        TEXT NOT NULL,
    started_at   TEXT NOT NULL,
    connected_at TEXT,
    ended_at     TEXT,
    end_reason   TEXT,
    codec        TEXT,
    client_ip    TEXT
);
CREATE INDEX idx_remote_sessions_device ON remote_sessions(device_id, started_at);
CREATE INDEX idx_remote_sessions_started ON remote_sessions(started_at);

CREATE TABLE audit_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        TEXT NOT NULL,
    user_id   TEXT,
    user_name TEXT,
    action    TEXT NOT NULL,
    target    TEXT,
    details   TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_audit_ts ON audit_log(ts);
