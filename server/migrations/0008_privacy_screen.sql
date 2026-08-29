-- Privacy screen support reported by the agent in `hello` (protocol PrivacyScreenSupport,
-- snake_case). Kept across reconnects so offline devices show their last known value.
ALTER TABLE devices ADD COLUMN privacy_screen TEXT NOT NULL DEFAULT 'unsupported';
