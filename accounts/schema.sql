-- WishlistMarket accounts (Cloudflare D1). Safe to run more than once.
-- Times are Unix seconds. Secrets are never stored in plain text:
-- passwords are PBKDF2 hashes, session and agent tokens are SHA-256 hashes,
-- and users' AI keys are AES-GCM encrypted with ACCOUNTS_SECRET.

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name        TEXT NOT NULL DEFAULT '',
  pw_hash     TEXT NOT NULL,
  pw_salt     TEXT NOT NULL,
  pw_iter     INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Browser sign-ins. id is the SHA-256 of the cookie value.
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  user_agent  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

-- Tokens a user gives their own AI agent so it can read or edit their lists.
CREATE TABLE IF NOT EXISTS api_tokens (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  prefix      TEXT NOT NULL,
  scope       TEXT NOT NULL CHECK (scope IN ('read', 'write')),
  created_at  INTEGER NOT NULL,
  last_used   INTEGER
);
CREATE INDEX IF NOT EXISTS api_tokens_user ON api_tokens(user_id);

-- A user's own AI provider settings (bring your own key).
CREATE TABLE IF NOT EXISTS agents (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL,
  model       TEXT NOT NULL DEFAULT '',
  key_enc     TEXT NOT NULL,
  key_iv      TEXT NOT NULL,
  key_last4   TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, provider)
);

-- Each user's Market data, one JSON document per row, in the same
-- collections the site uses (lists, projects, stores, requests, svc_*).
CREATE TABLE IF NOT EXISTS docs (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  collection  TEXT NOT NULL,
  id          TEXT NOT NULL,
  data        TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, collection, id)
);

-- Each user's preferences (location, favorite stores, list size, theme...).
-- Never keys: those go in agents.
CREATE TABLE IF NOT EXISTS user_settings (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data        TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Fixed-window counters for sign-in and sign-up limits.
CREATE TABLE IF NOT EXISTS rate_limits (
  key         TEXT PRIMARY KEY,
  count       INTEGER NOT NULL,
  reset_at    INTEGER NOT NULL
);
