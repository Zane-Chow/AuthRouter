import db from './database.js';

// Pre-compile statements
const stmts = {
  getByClientAndProvider: db.prepare(
    'SELECT * FROM identity_mappings WHERE client_id = ? AND provider = ? AND provider_identity = ? ORDER BY display_name, target_identity'
  ),
  getAll: db.prepare(
    'SELECT * FROM identity_mappings ORDER BY client_id, provider, provider_identity, target_identity'
  ),
  getByClient: db.prepare(
    'SELECT * FROM identity_mappings WHERE client_id = ? ORDER BY provider, provider_identity, target_identity'
  ),
  add: db.prepare(
    'INSERT OR IGNORE INTO identity_mappings (client_id, provider, provider_identity, target_identity, display_name) VALUES (?, ?, ?, ?, ?)'
  ),
  remove: db.prepare(
    'DELETE FROM identity_mappings WHERE id = ?'
  ),
  getById: db.prepare(
    'SELECT * FROM identity_mappings WHERE id = ?'
  ),
};

/**
 * Get target accounts for a given client + provider + identity.
 * Returns the mapped identities for this specific downstream client.
 *
 * @param {string} clientId - The downstream OIDC client ID
 * @param {string} provider - Upstream IdP name (e.g., 'google', 'github')
 * @param {string} providerIdentity - The upstream identity (email or username)
 * @returns {Array} List of mapping records
 */
export function getTargetAccounts(clientId, provider, providerIdentity) {
  return stmts.getByClientAndProvider.all(clientId, provider, providerIdentity.toLowerCase());
}

/**
 * Get all mappings, optionally filtered by client.
 * @param {string} [clientId] - If provided, filter by this client
 * @returns {Array} All mapping records
 */
export function getAllMappings(clientId) {
  if (clientId) {
    return stmts.getByClient.all(clientId);
  }
  return stmts.getAll.all();
}

/**
 * Add a new identity mapping.
 * @param {string} clientId - Downstream client ID
 * @param {string} provider - Upstream IdP name
 * @param {string} providerIdentity - Source identity
 * @param {string} targetIdentity - Target identity for this client
 * @param {string|null} displayName - Optional display name
 * @returns {object} SQLite run result
 */
export function addMapping(clientId, provider, providerIdentity, targetIdentity, displayName = null) {
  return stmts.add.run(
    clientId,
    provider,
    providerIdentity.toLowerCase().trim(),
    targetIdentity.toLowerCase().trim(),
    displayName?.trim() || null
  );
}

/**
 * Remove a mapping by ID.
 * @param {number} id - Mapping record ID
 * @returns {object} SQLite run result
 */
export function removeMapping(id) {
  return stmts.remove.run(id);
}

/**
 * Get a single mapping by ID.
 * @param {number} id - Mapping record ID
 * @returns {object|undefined} Mapping record or undefined
 */
export function getMappingById(id) {
  return stmts.getById.get(id);
}
