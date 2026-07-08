import { Issuer } from 'openid-client';
import config from './config.js';

/**
 * Generic OIDC upstream adapter — works with any standards-compliant OIDC
 * IdP (Google, Keycloak, Azure AD, Okta, ...) configured via `issuer`
 * discovery, rather than hardcoding one provider.
 */

// provider_id -> { client, cacheKey } — avoids re-discovering on every request,
// but re-discovers if the admin changes issuer/client_id for that provider.
const clientCache = new Map();

async function getClient(row) {
  const cacheKey = `${row.issuer}::${row.client_id}`;
  const cached = clientCache.get(row.provider_id);
  if (cached && cached.cacheKey === cacheKey) return cached.client;

  console.log(`🔍 Discovering OIDC configuration for ${row.provider_id} (${row.issuer})...`);
  const issuer = await Issuer.discover(row.issuer);

  const client = new issuer.Client({
    client_id: row.client_id,
    client_secret: row.client_secret,
    redirect_uris: [`${config.sso.baseUrl}/sso/${row.provider_id}/callback`],
    response_types: ['code'],
  });

  clientCache.set(row.provider_id, { client, cacheKey });
  return client;
}

/**
 * Generate the authorization URL for an OIDC upstream provider.
 * @param {object} row - upstream_providers row (type === 'oidc')
 */
export async function getAuthUrl(row, state, nonce) {
  const client = await getClient(row);
  return client.authorizationUrl({
    scope: row.scope || 'openid email profile',
    state,
    nonce,
    prompt: 'select_account',
  });
}

/**
 * Handle the OIDC callback and return a normalized user profile.
 * @param {object} row - upstream_providers row (type === 'oidc')
 */
export async function handleCallback(row, ctx, sessionData) {
  const client = await getClient(row);
  const params = client.callbackParams(ctx.req);

  const tokenSet = await client.callback(
    `${config.sso.baseUrl}/sso/${row.provider_id}/callback`,
    params,
    { state: sessionData.oauth_state, nonce: sessionData.oauth_nonce }
  );

  const userinfo = await client.userinfo(tokenSet);

  return {
    provider: row.provider_id,
    id: userinfo.sub,
    email: userinfo.email,
    name: userinfo.name || '',
    avatar: userinfo.picture || '',
  };
}

/**
 * Drop the cached client for a provider (call after deleting/reconfiguring it).
 */
export function clearProviderCache(providerId) {
  clientCache.delete(providerId);
}
