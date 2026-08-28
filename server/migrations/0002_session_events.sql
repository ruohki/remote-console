-- In-session activity reported by agents (chat lines, file transfers, clipboard syncs,
-- display/audio changes). `event` is the JSON-encoded protocol `SessionEvent`.

CREATE TABLE session_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES remote_sessions(id) ON DELETE CASCADE,
    ts         TEXT NOT NULL,
    event      TEXT NOT NULL
);
CREATE INDEX idx_session_events_session ON session_events(session_id, id);
