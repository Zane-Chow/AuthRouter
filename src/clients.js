import db from './database.js';

// Pre-compile statements
const stmts = {
  getAll: db.prepare(
    'SELECT * FROM oidc_clients ORDER BY created_at DESC'
  ),
  getEnabled: db.prepare(
    'SELECT * FROM oidc_clients WHERE enabled = 1 ORDER BY client_name'
  ),
  getById: db.prepare(
    'SELECT * FROM oidc_clients WHERE client_id = ?'
  ),
  add: db.prepare(
    `INSERT INTO oidc_clients (client_id, client_secret, client_name, redirect_uris, grant_types, response_types, token_endpoint_auth_method, scope)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ),
  update: db.prepare(
    `UPDATE oidc_clients
     SET client_name = ?, client_secret = ?, redirect_uris = ?, token_endpoint_auth_method = ?, scope = ?, enabled = ?
     WHERE client_id = ?`
  ),
  remove: db.prepare(
    'DELETE FROM oidc_clients WHERE client_id = ?'
  ),
};

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
 */
function toOidcClient(row) {
  if (!row) return null;
  return {
    client_id: row.client_id,
    client_secret: row.client_secret,
    client_name: row.client_name,
    redirect_uris: parseJsonArray(row.redirect_uris),
    grant_types: parseJsonArray(row.grant_types),
    response_types: parseJsonArray(row.response_types),
    token_endpoint_auth_method: row.token_endpoint_auth_method,
    scope: row.scope,
  };
}

/**
 * Get all registered clients (for admin panel).
 */
export function getAllClients() {
  return stmts.getAll.all();
}

/**
 * Get all enabled clients (for oidc-provider).
 */
export function getEnabledClients() {
  return stmts.getEnabled.all();
}

/**
 * Get a client by client_id.
 */
export function getClientById(clientId) {
  return stmts.getById.get(clientId);
}

/**
 * Get a client in oidc-provider format.
 */
export function getOidcClient(clientId) {
  const row = stmts.getById.get(clientId);
  if (!row || !row.enabled) return null;
  return toOidcClient(row);
}

/**
 * Get all enabled clients in oidc-provider format.
 */
export function getOidcClients() {
  return stmts.getEnabled.all().map(toOidcClient);
}

/**
 * Add a new OIDC client.
 * @param {object} opts
 * @param {string} opts.clientId
 * @param {string} opts.clientSecret
 * @param {string} opts.clientName
 * @param {string[]} opts.redirectUris
 * @param {string} [opts.tokenAuthMethod='client_secret_post']
 * @param {string} [opts.scope='openid email profile']
 * @returns {object} SQLite run result
 */
export function addClient({
  clientId,
  clientSecret,
  clientName,
  redirectUris,
  tokenAuthMethod = 'client_secret_post',
  scope = 'openid email profile',
}) {
  return stmts.add.run(
    clientId,
    clientSecret,
    clientName.trim(),
    JSON.stringify(Array.isArray(redirectUris) ? redirectUris : [redirectUris]),
    '["authorization_code"]',
    '["code"]',
    tokenAuthMethod,
    scope
  );
}

/**
 * Update an existing client.
 */
export function updateClient(clientId, {
  clientName,
  clientSecret,
  redirectUris,
  tokenAuthMethod = 'client_secret_post',
  scope = 'openid email profile',
  enabled = 1,
}) {
  return stmts.update.run(
    clientName.trim(),
    clientSecret,
    JSON.stringify(Array.isArray(redirectUris) ? redirectUris : [redirectUris]),
    tokenAuthMethod,
    scope,
    enabled ? 1 : 0,
    clientId
  );
}

/**
 * Remove a client by client_id. Also cascades to delete its identity_mappings.
 */
export function removeClient(clientId) {
  return stmts.remove.run(clientId);
}
