-- Nonlinear sync schema. Payloads are client-side encrypted; the server sees opaque keys only.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,            -- GitHub user id
  login TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,          -- SHA-256 of session secret
  user_id INTEGER NOT NULL REFERENCES users(id),
  token_ct TEXT NOT NULL,            -- AES-GCM(TOKEN_KEY) GitHub access token
  scopes TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  return_url TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS login_codes (
  code_hash TEXT PRIMARY KEY,        -- one-time code handed to the client after OAuth
  session TEXT NOT NULL,             -- AES-GCM(TOKEN_KEY) session secret
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ops (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  op_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  action TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, op_id)
);
CREATE INDEX IF NOT EXISTS ops_user_seq ON ops(user_id, seq);
