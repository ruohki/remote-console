-- Device groups and per-user access grants (RBAC). Admins see everything; operators only see
-- devices in groups they have a grant on (`view` or `connect`).

CREATE TABLE device_groups (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
    description TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL
);

CREATE TABLE device_group_members (
    group_id  TEXT NOT NULL REFERENCES device_groups(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, device_id)
);
CREATE INDEX idx_device_group_members_device ON device_group_members(device_id);

CREATE TABLE group_grants (
    group_id   TEXT NOT NULL REFERENCES device_groups(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    permission TEXT NOT NULL CHECK (permission IN ('view', 'connect')),
    PRIMARY KEY (group_id, user_id)
);
CREATE INDEX idx_group_grants_user ON group_grants(user_id);

ALTER TABLE enroll_tokens
    ADD COLUMN default_group_id TEXT NULL REFERENCES device_groups(id) ON DELETE SET NULL;
