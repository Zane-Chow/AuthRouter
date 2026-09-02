import { getDb } from './database.js';
import { encryptSecret, decryptSecret } from './crypto-util.js';

/**
 * CRUD for upstream_providers — upstream Identity Providers, fully
 * admin-panel-configurable (no env-var-based provider config).
 *
 * type: 'oidc'   — standards-compliant OIDC, discovered via `issuer`.
 * type: 'oauth2' — generic OAuth2 with manual endpoints + field mapping.
 */

/**
 * All providers, raw rows (secret stays encrypted) — for admin panel listing.
 */
export async function getAllProviders() {
  const db = await getDb();
  return db.all('SELECT * FROM upstream_providers ORDER BY created_at DESC');
}

/**
 * Enabled providers, raw rows — for the login selector / dispatch layer.
 */
export async function getEnabledProviderRows(clientId) {
  const db = await getDb();
  if (clientId) {
    return db.all(
      `SELECT p.* FROM upstream_providers p
       WHERE p.enabled = 1
         AND (
           NOT EXISTS (SELECT 1 FROM client_upstream_permissions cp WHERE cp.client_id = ?)
           OR EXISTS (
             SELECT 1 FROM client_upstream_permissions cp
             WHERE cp.client_id = ? AND cp.provider_id = p.provider_id
           )
         )
       ORDER BY p.display_name`,
      [clientId, clientId],
    );
  }
  return db.all('SELECT * FROM upstream_providers WHERE enabled = 1 ORDER BY display_name');
}

/**
 * Look up a provider by its numeric id (used by admin delete/toggle routes).
 */
export async function getProviderById(id) {
  const db = await getDb();
  return db.get('SELECT * FROM upstream_providers WHERE id = ?', [id]);
}

/**
 * Look up a provider by its slug (used by the login/callback flow), with the
 * secret decrypted — ready to use for outbound OAuth2/OIDC calls.
 */
export async function getProviderConfig(providerId, clientId) {
  const db = await getDb();
  const row = clientId
    ? await db.get(
      `SELECT p.* FROM upstream_providers p
       WHERE p.provider_id = ? AND p.enabled = 1
         AND (
           NOT EXISTS (SELECT 1 FROM client_upstream_permissions cp WHERE cp.client_id = ?)
           OR EXISTS (
             SELECT 1 FROM client_upstream_permissions cp
             WHERE cp.client_id = ? AND cp.provider_id = p.provider_id
           )
         )`,
      [providerId, clientId, clientId],
    )
    : await db.get('SELECT * FROM upstream_providers WHERE provider_id = ? AND enabled = 1', [providerId]);
  if (!row) return null;
  return { ...row, client_secret: decryptSecret(row.client_secret) };
}

/**
 * Add a new upstream provider. The secret is encrypted before being stored.
 */
export async function addProvider({
  providerId,
  displayName,
  type,
  issuer = null,
  authorizeUrl = null,
  tokenUrl = null,
  userinfoUrl = null,
  emailUrl = null,
  clientId,
  clientSecret,
  scope,
  fieldId = 'sub',
  fieldEmail = 'email',
  fieldName = 'name',
  fieldAvatar = 'picture',
  icon = 'generic',
}) {
  const db = await getDb();
  return db.run(
    `INSERT INTO upstream_providers
       (provider_id, display_name, type, issuer, authorize_url, token_url, userinfo_url, email_url,
        client_id, client_secret, scope, field_id, field_email, field_name, field_avatar, icon)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      providerId, displayName, type, issuer, authorizeUrl, tokenUrl, userinfoUrl, emailUrl,
      clientId, encryptSecret(clientSecret), scope, fieldId, fieldEmail, fieldName, fieldAvatar, icon,
    ]
  );
}

/**
 * Remove a provider by numeric id. Existing identity_mappings and client
 * permission rows that reference its provider_id string are left untouched.
 * Keeping permission rows prevents a restricted client from accidentally
 * becoming unrestricted when its last allowed provider is removed.
 */
export async function removeProvider(id) {
  const db = await getDb();
  return db.run('DELETE FROM upstream_providers WHERE id = ?', [id]);
}

/**
 * Enable/disable a provider by numeric id.
 */
export async function setProviderEnabled(id, enabled) {
  const db = await getDb();
  return db.run('UPDATE upstream_providers SET enabled = ? WHERE id = ?', [enabled ? 1 : 0, id]);
}
