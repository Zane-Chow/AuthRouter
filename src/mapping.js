import { getDb } from './database.js';

/**
 * Get target accounts for a given client + provider + identity.
 * Returns the mapped identities for this specific downstream client.
 *
 * @param {string} clientId - The downstream OIDC client ID
 * @param {string} provider - Upstream IdP id (e.g., 'google', 'github')
 * @param {string} providerIdentity - The upstream identity (email or username)
 * @returns {Promise<Array>} List of mapping records
 */
export async function getTargetAccounts(clientId, provider, providerIdentity) {
  const db = await getDb();
  return db.all(
    'SELECT * FROM identity_mappings WHERE client_id = ? AND provider = ? AND provider_identity = ? ORDER BY display_name, target_identity',
    [clientId, provider, providerIdentity.toLowerCase()]
  );
}

/**
 * Get all mappings, optionally filtered by client.
 * @param {string} [clientId] - If provided, filter by this client
 * @returns {Promise<Array>} All mapping records
 */
export async function getAllMappings(clientId) {
  const db = await getDb();
  if (clientId) {
    return db.all(
      'SELECT * FROM identity_mappings WHERE client_id = ? ORDER BY provider, provider_identity, target_identity',
      [clientId]
    );
  }
  return db.all('SELECT * FROM identity_mappings ORDER BY client_id, provider, provider_identity, target_identity');
}

/**
 * Add a new identity mapping.
 * @param {string} clientId - Downstream client ID
 * @param {string} provider - Upstream IdP id
 * @param {string} providerIdentity - Source identity
 * @param {string} targetIdentity - Target identity for this client
 * @param {string|null} displayName - Optional display name
 */
export async function addMapping(clientId, provider, providerIdentity, targetIdentity, displayName = null) {
  const db = await getDb();
  const insertIgnore = db.dialect === 'mysql' ? 'INSERT IGNORE' : 'INSERT OR IGNORE';
  return db.run(
    `${insertIgnore} INTO identity_mappings (client_id, provider, provider_identity, target_identity, display_name) VALUES (?, ?, ?, ?, ?)`,
    [
      clientId,
      provider,
      providerIdentity.toLowerCase().trim(),
      targetIdentity.toLowerCase().trim(),
      displayName?.trim() || null,
    ]
  );
}

/**
 * Remove a mapping by ID.
 * @param {number} id - Mapping record ID
 */
export async function removeMapping(id) {
  const db = await getDb();
  return db.run('DELETE FROM identity_mappings WHERE id = ?', [id]);
}

/**
 * Get a single mapping by ID.
 * @param {number} id - Mapping record ID
 * @returns {Promise<object|undefined>} Mapping record or undefined
 */
export async function getMappingById(id) {
  const db = await getDb();
  return db.get('SELECT * FROM identity_mappings WHERE id = ?', [id]);
}

export async function updateMapping(id, input) {
  const db = await getDb();
  return db.run(
    `UPDATE identity_mappings SET client_id = ?, provider = ?, provider_identity = ?,
      target_identity = ?, display_name = ? WHERE id = ?`,
    [input.clientId, input.provider, input.providerIdentity, input.targetIdentity, input.displayName, id],
  );
}
