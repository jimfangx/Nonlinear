-- One-click sync: key check (encrypted known plaintext) and device pairing relay.
CREATE TABLE IF NOT EXISTS user_keys (
  user_id INTEGER PRIMARY KEY,
  keycheck TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pairings (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  device_pub TEXT NOT NULL,
  label TEXT NOT NULL,
  wrapped TEXT,
  approver_pub TEXT,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pairings_user ON pairings(user_id);
