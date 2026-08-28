-- Restrictions the person at the device applied locally (protocol LocalOverrides JSON).
ALTER TABLE devices ADD COLUMN local_overrides TEXT NOT NULL DEFAULT '{}';
