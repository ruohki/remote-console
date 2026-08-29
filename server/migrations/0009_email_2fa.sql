-- Email codes as a second factor (SMTP settings live in the sealed `settings` store).

ALTER TABLE users ADD COLUMN email_2fa_enabled INTEGER NOT NULL DEFAULT 0;
