-- Idle timeout for login sessions: last use, updated at most every few minutes.
ALTER TABLE user_sessions ADD COLUMN last_seen_at TEXT;
