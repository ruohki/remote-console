-- Console-wide settings: branding JSON and the bakery ed25519 signing key.
CREATE TABLE settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
