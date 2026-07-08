import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import config from './config.js';

// Ensure data directory exists
if (!fs.existsSync(config.dataDir)) {
  fs.mkdirSync(config.dataDir, { recursive: true });
}

const dbPath = path.join(config.dataDir, 'sso.db');
const db = new Database(dbPath);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Initialize schema
db.exec(`
  -- OIDC Clients (downstream Relying Parties)
  CREATE TABLE IF NOT EXISTS oidc_clients (
    id                          INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id                   TEXT    NOT NULL UNIQUE,
    client_secret               TEXT    NOT NULL,
    client_name                 TEXT    NOT NULL,
    redirect_uris               TEXT    NOT NULL,  -- JSON array
    grant_types                 TEXT    NOT NULL DEFAULT '["authorization_code"]',
    response_types              TEXT    NOT NULL DEFAULT '["code"]',
    token_endpoint_auth_method  TEXT    NOT NULL DEFAULT 'client_secret_post',
    scope                       TEXT    NOT NULL DEFAULT 'openid email profile',
    enabled                     INTEGER NOT NULL DEFAULT 1,
    created_at                  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Identity Mappings (per-client, optional overrides)
  CREATE TABLE IF NOT EXISTS identity_mappings (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id         TEXT    NOT NULL,
    provider          TEXT    NOT NULL,
    provider_identity TEXT    NOT NULL,
    target_identity   TEXT    NOT NULL,
    display_name      TEXT,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(client_id, provider, provider_identity, target_identity),
    FOREIGN KEY (client_id) REFERENCES oidc_clients(client_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_mappings_lookup
    ON identity_mappings(client_id, provider, provider_identity);
`);

// Migrate from old schema if email_mappings table exists
try {
  const oldTableExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='email_mappings'"
  ).get();

  if (oldTableExists) {
    console.log('📦 Legacy email_mappings table detected. Data preserved but no longer used by the new schema.');
    console.log('   You can manually migrate entries to identity_mappings via the admin panel.');
  }
} catch (err) {
  // Ignore migration check errors
}

console.log(`✅ Database initialized at ${dbPath}`);

export default db;
