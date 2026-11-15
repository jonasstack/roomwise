-- roomwise diagnostics: one row per install and day (upsert), errors deduplicated by fingerprint.
-- No IP addresses, no headers, nothing but the validated report.

CREATE TABLE reports (
  install_id TEXT NOT NULL,
  day TEXT NOT NULL,                -- YYYY-MM-DD (UTC)
  received_at INTEGER NOT NULL,     -- unix seconds
  schema INTEGER NOT NULL,
  roomwise_version TEXT,
  ha_version TEXT,
  language TEXT,
  payload TEXT NOT NULL,            -- the validated report (JSON)
  PRIMARY KEY (install_id, day)
);
CREATE INDEX reports_day ON reports (day);

CREATE TABLE errors (
  fingerprint TEXT PRIMARY KEY,     -- sha256 of type + frames without line numbers
  exc_type TEXT NOT NULL,
  frames TEXT NOT NULL,             -- JSON array, newest report
  versions TEXT NOT NULL,           -- JSON array of roomwise versions it was seen in
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX errors_last ON errors (last_seen);

-- which install saw which error (for "how many installs"); deleted with the install
CREATE TABLE error_installs (
  fingerprint TEXT NOT NULL,
  install_id TEXT NOT NULL,
  last_day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (fingerprint, install_id)
);
CREATE INDEX error_installs_install ON error_installs (install_id);

-- rate limit per install id and day
CREATE TABLE rate (
  install_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (install_id, kind, day)
);
