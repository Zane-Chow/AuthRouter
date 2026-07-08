import { getEnabledProviderRows, getProviderConfig } from './upstream-providers-db.js';
import * as oidcAuth from './oidc-auth.js';
import * as oauth2Auth from './oauth2-auth.js';

/**
 * Upstream Providers — unified interface for all upstream IdPs.
 * Fully database-driven (configured via the /admin panel); dispatches by
 * `row.type` ('oidc' | 'oauth2') to the matching adapter module.
 */

/**
 * Get the list of enabled upstream providers with their metadata.
 * Used by the login selector page.
 * @returns {Promise<Array<{id: string, name: string, icon: string}>>}
 */
export async function getEnabledProviders() {
  const rows = await getEnabledProviderRows();
  return rows.map(row => ({
    id: row.provider_id,
    name: row.display_name,
    icon: row.icon || 'generic',
  }));
}

/**
 * Check if a provider is enabled.
 * @param {string} providerName
 * @returns {Promise<boolean>}
 */
export async function isProviderEnabled(providerName) {
  const row = await getProviderConfig(providerName);
  return !!row;
}

/**
 * Get the OAuth authorization URL for the specified provider.
 * @param {string} providerName - upstream_providers.provider_id
 * @param {string} state - CSRF state parameter
 * @param {string} nonce - Nonce (used by OIDC, ignored by plain OAuth2)
 * @returns {Promise<string>} The authorization URL
 */
export async function getAuthUrl(providerName, state, nonce) {
  const row = await getProviderConfig(providerName);
  if (!row) {
    throw new Error(`Unknown or disabled upstream provider: ${providerName}`);
  }

  switch (row.type) {
    case 'oidc':
      return oidcAuth.getAuthUrl(row, state, nonce);
    case 'oauth2':
      return oauth2Auth.getAuthUrl(row, state);
    default:
      throw new Error(`Unsupported provider type: ${row.type}`);
  }
}

/**
 * Handle the OAuth callback for the specified provider.
 * Returns a normalized user profile.
 *
 * @param {string} providerName - upstream_providers.provider_id
 * @param {object} ctx - Koa context (for reading query params)
 * @param {object} sessionData - Session data containing state/nonce
 * @returns {Promise<{provider: string, id: string, email: string, name: string, avatar: string}>}
 */
export async function handleCallback(providerName, ctx, sessionData) {
  const row = await getProviderConfig(providerName);
  if (!row) {
    throw new Error(`Unknown or disabled upstream provider: ${providerName}`);
  }

  switch (row.type) {
    case 'oidc':
      return oidcAuth.handleCallback(row, ctx, sessionData);

    case 'oauth2': {
      const code = ctx.query.code;
      if (!code) {
        throw new Error(`Missing authorization code from ${providerName}`);
      }
      return oauth2Auth.handleCallback(row, code, sessionData.oauth_state, ctx.query.state);
    }

    default:
      throw new Error(`Unsupported provider type: ${row.type}`);
  }
}
