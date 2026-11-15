-- Stable hardware identity (Windows MachineGuid, macOS IOPlatformUUID) reported at enrollment
-- and in `hello` (protocol 2). A re-enrollment with a known machine id and the same OS reuses
-- the existing device row instead of adding a duplicate.
ALTER TABLE devices ADD COLUMN machine_id TEXT NULL;
CREATE INDEX idx_devices_machine_id ON devices(machine_id);

-- What the device's screen shows (protocol DesktopState wire name: user | locked | sign_in |
-- unknown), from `hello` and heartbeats. Reset to `unknown` whenever the agent goes offline.
ALTER TABLE devices ADD COLUMN desktop TEXT NOT NULL DEFAULT 'unknown';
