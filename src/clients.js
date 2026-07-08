import { getDb } from './database.js';
import { encryptSecret, decryptSecret } from './crypto-util.js';

/**
 * Parse a JSON array field from the database, returning a JS array.
 */
function parseJsonArray(str) {
  try {
    return JSON.parse(str);
  } catch {
    return [str]; // fallback: treat as single-element array
  }
}

/**
 * Convert a DB row into the format expected by oidc-provider.
 * Decrypts the stored client_secret (transparently handles legacy plaintext).
 */
function toOidcClient(row) {
  if (!row) return null;
  return {
    client_id: row.client_id,
    client_secret: decryptSecret(row.client_secret),
    client_name: row.client_name,
    redirect_uris: parseJsonArray(row.redirect_uris),
    grant_types: parseJsonArray(row.grant_types),
    response_types: parseJsonArray(row.response_types),
    token_endpoint_auth_method: row.token_endpoint_auth_method,
    scope: row.scope,
  };
}

/**
 * Get all registered clients (for admin panel). Secrets remain encrypted.
 */
export async function getAllClients() {
  const db = await getDb();
  return db.all('SELECT * FROM oidc_clients ORDER BY created_at DESC');
}

/**
 * Get all enabled clients (raw rows, secrets encrypted).
 */
export async function getEnabledClients() {
  const db = await getDb();
  return db.all('SELECT * FROM oidc_clients WHERE enabled = 1 ORDER BY client_name');
}

/**
 * Get a client by client_id (raw row, secret encrypted).
 */
export async function getClientById(clientId) {
  const db = await getDb();
  return db.get('SELECT * FROM oidc_clients WHERE client_id = ?', [clientId]);
}

/**
 * Get a client in oidc-provider format (secret decrypted). Used by the
 * custom oidc-provider Adapter for live/hot-reloading client lookups.
 */
export async function getOidcClient(clientId) {
  const db = await getDb();
  const row = await db.get('SELECT * FROM oidc_clients WHERE client_id = ?', [clientId]);
  if (!row || !row.enabled) return null;
  return toOidcClient(row);
}

/**
 * Add a new OIDC client. The secret is encrypted before being stored.
 * @param {object} opts
 * @param {string} opts.clientId
 * @param {string} opts.clientSecret
 * @param {string} opts.clientName
 * @param {string[]} opts.redirectUris
 * @param {string} [opts.tokenAuthMethod='client_secret_post']
 * @param {string} [opts.scope='openid email profile']
 */
export async function addClient({
  clientId,
  clientSecret,
  clientName,
  redirectUris,
  tokenAuthMethod = 'client_secret_post',
  scope = 'openid email profile',
}) {
  const db = await getDb();
  return db.run(
    `INSERT INTO oidc_clients (client_id, client_secret, client_name, redirect_uris, grant_types, response_types, token_endpoint_auth_method, scope)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      clientId,
      encryptSecret(clientSecret),
      clientName.trim(),
      JSON.stringify(Array.isArray(redirectUris) ? redirectUris : [redirectUris]),
      '["authorization_code"]',
      '["code"]',
      tokenAuthMethod,
      scope,
    ]
  );
}

/**
 * Update an existing client. The secret is encrypted before being stored.
 */
export async function updateClient(clientId, {
  clientName,
  clientSecret,
  redirectUris,
  tokenAuthMethod = 'client_secret_post',
  scope = 'openid email profile',
  enabled = 1,
}) {
  const db = await getDb();
  return db.run(
    `UPDATE oidc_clients
     SET client_name = ?, client_secret = ?, redirect_uris = ?, token_endpoint_auth_method = ?, scope = ?, enabled = ?
     WHERE client_id = ?`,
    [
      clientName.trim(),
      encryptSecret(clientSecret),
      JSON.stringify(Array.isArray(redirectUris) ? redirectUris : [redirectUris]),
      tokenAuthMethod,
      scope,
      enabled ? 1 : 0,
      clientId,
    ]
  );
}

/**
 * Remove a client by client_id. Also cascades to delete its identity_mappings.
 */
export async function removeClient(clientId) {
  const db = await getDb();
  return db.run('DELETE FROM oidc_clients WHERE client_id = ?', [clientId]);
}
