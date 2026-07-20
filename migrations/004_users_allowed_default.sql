-- New accounts are allowed by default; uncheck Allowed to blacklist.
ALTER TABLE users ALTER COLUMN is_allowed SET DEFAULT 1;
