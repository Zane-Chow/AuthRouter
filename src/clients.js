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
  const [rows, permissions] = await Promise.all([
    db.all('SELECT * FROM oidc_clients ORDER BY created_at DESC'),
    db.all('SELECT client_id, provider_id FROM client_upstream_permissions ORDER BY provider_id'),
  ]);
  const byClient = new Map();
  for (const permission of permissions) {
    const providerIds = byClient.get(permission.client_id) || [];
    providerIds.push(permission.provider_id);
    byClient.set(permission.client_id, providerIds);
  }
  return rows.map((row) => ({ ...row, allowed_providers: byClient.get(row.client_id) || [] }));
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
 * Return the configured upstream whitelist for a client. An empty list means
 * unrestricted access, preserving the behaviour of clients created before
 * per-client permissions were introduced.
 */
export async function getAllowedProviderIds(clientId) {
  const db = await getDb();
  const rows = await db.all(
    'SELECT provider_id FROM client_upstream_permissions WHERE client_id = ? ORDER BY provider_id',
    [clientId],
  );
  return rows.map((row) => row.provider_id);
}

/** Replace a client's upstream whitelist. Passing [] grants access to all. */
export async function setAllowedProviderIds(clientId, providerIds = []) {
  const db = await getDb();
  const normalized = [...new Set(providerIds)];
  await db.run('DELETE FROM client_upstream_permissions WHERE client_id = ?', [clientId]);
  const insert = db.dialect === 'mysql' ? 'INSERT IGNORE' : 'INSERT OR IGNORE';
  for (const providerId of normalized) {
    await db.run(
      `${insert} INTO client_upstream_permissions (client_id, provider_id) VALUES (?, ?)`,
      [clientId, providerId],
    );
  }
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
  allowedProviderIds = [],
}) {
  const db = await getDb();
  const result = await db.run(
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
  await setAllowedProviderIds(clientId, allowedProviderIds);
  return result;
}

/**
 * Update an existing client. The secret is encrypted before being stored.
 * `clientSecret` is optional — omit it (or pass a falsy value) to keep the
 * existing Client ID/Secret pair unchanged while updating everything else
 * (e.g. redirect URIs), since downstream systems already have the old
 * secret configured and shouldn't need to be touched for a redirect URI
 * change.
 */
export async function updateClient(clientId, {
  clientName,
  clientSecret,
  redirectUris,
  tokenAuthMethod = 'client_secret_post',
  scope = 'openid email profile',
  enabled = 1,
  allowedProviderIds,
}) {
  const db = await getDb();

  if (clientSecret) {
    const result = await db.run(
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
    if (allowedProviderIds !== undefined) await setAllowedProviderIds(clientId, allowedProviderIds);
    return result;
  }

  const result = await db.run(
    `UPDATE oidc_clients
     SET client_name = ?, redirect_uris = ?, token_endpoint_auth_method = ?, scope = ?, enabled = ?
     WHERE client_id = ?`,
    [
      clientName.trim(),
      JSON.stringify(Array.isArray(redirectUris) ? redirectUris : [redirectUris]),
      tokenAuthMethod,
      scope,
      enabled ? 1 : 0,
      clientId,
    ]
  );
  if (allowedProviderIds !== undefined) await setAllowedProviderIds(clientId, allowedProviderIds);
  return result;
}

/**
 * Remove a client by client_id. Also cascades to delete its identity_mappings.
 */
export async function removeClient(clientId) {
  const db = await getDb();
  return db.run('DELETE FROM oidc_clients WHERE client_id = ?', [clientId]);
}
