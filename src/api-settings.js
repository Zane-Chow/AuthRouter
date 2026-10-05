import crypto from 'node:crypto';
import { getDb } from './database.js';
import { secureCompare } from './security.js';

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function ensureSettings(db) {
  const insert = db.dialect === 'mysql' ? 'INSERT IGNORE' : 'INSERT OR IGNORE';
  await db.run(`${insert} INTO api_settings (id, enabled) VALUES (1, 0)`);
}

export async function getApiSettings() {
  const db = await getDb();
  const row = await db.get('SELECT enabled, token_hash, token_created_at FROM api_settings WHERE id = 1');
  return {
    enabled: Boolean(row?.enabled),
    hasToken: Boolean(row?.token_hash),
    tokenCreatedAt: row?.token_created_at || null,
  };
}

export async function setApiEnabled(enabled) {
  const db = await getDb();
  await ensureSettings(db);
  await db.run('UPDATE api_settings SET enabled = ? WHERE id = 1', [enabled ? 1 : 0]);
}

export async function generateApiToken() {
  const token = `ar_${crypto.randomBytes(32).toString('base64url')}`;
  const db = await getDb();
  await ensureSettings(db);
  await db.run('UPDATE api_settings SET token_hash = ?, token_created_at = ? WHERE id = 1', [
    hashToken(token), new Date().toISOString(),
  ]);
  return token;
}

// Read settings on every request so disabling or rotating takes effect immediately.
export async function authenticateApiToken(token) {
  const db = await getDb();
  const row = await db.get('SELECT enabled, token_hash FROM api_settings WHERE id = 1');
  if (!row?.enabled) return 'disabled';
  if (typeof token !== 'string' || !/^ar_[A-Za-z0-9_-]{43}$/.test(token)) return 'invalid';
  return row.token_hash && secureCompare(hashToken(token), row.token_hash) ? 'valid' : 'invalid';
}
