import config from './config.js';
import { getGoogleClient, getGoogleAuthUrl } from './google-auth.js';
import { getGithubAuthUrl, handleGithubCallback } from './github-auth.js';

/**
 * Upstream Providers — unified interface for all upstream IdPs.
 *
 * Each provider must support:
 * - getAuthUrl(state, nonce) → string
 * - handleCallback(ctx, session) → { provider, id, email, name, avatar }
 */

/**
 * Metadata for each upstream IdP (used by login selector page).
 */
const providerMeta = {
  google: {
    name: 'Google',
    icon: 'google',      // icon key for frontend rendering
  },
  github: {
    name: 'GitHub',
    icon: 'github',
  },
};

/**
 * Get the list of enabled upstream providers with their metadata.
 * Used by the login selector page.
 * @returns {Array<{id: string, name: string, icon: string}>}
 */
export function getEnabledProviders() {
  return config.enabledProviders.map(id => ({
    id,
    ...providerMeta[id],
  }));
}

/**
 * Check if a provider is enabled.
 * @param {string} providerName
 * @returns {boolean}
 */
export function isProviderEnabled(providerName) {
  return config.enabledProviders.includes(providerName);
}

/**
 * Get the OAuth authorization URL for the specified provider.
 * @param {string} providerName - 'google' | 'github'
 * @param {string} state - CSRF state parameter
 * @param {string} nonce - Nonce for OIDC (used by Google, ignored by GitHub)
 * @returns {Promise<string>} The authorization URL
 */
export async function getAuthUrl(providerName, state, nonce) {
  switch (providerName) {
    case 'google': {
      const client = await getGoogleClient();
      return getGoogleAuthUrl(client, state, nonce);
    }
    case 'github': {
      return getGithubAuthUrl(state);
    }
    default:
      throw new Error(`Unknown upstream provider: ${providerName}`);
  }
}

/**
 * Handle the OAuth callback for the specified provider.
 * Returns a normalized user profile.
 *
 * @param {string} providerName - 'google' | 'github'
 * @param {object} ctx - Koa context (for reading query params)
 * @param {object} sessionData - Session data containing state/nonce
 * @returns {Promise<{provider: string, id: string, email: string, name: string, avatar: string}>}
 */
export async function handleCallback(providerName, ctx, sessionData) {
  switch (providerName) {
    case 'google': {
      const client = await getGoogleClient();
      const params = client.callbackParams(ctx.req);

      const tokenSet = await client.callback(
        `${config.sso.baseUrl}/sso/google/callback`,
        params,
        {
          state: sessionData.oauth_state,
          nonce: sessionData.oauth_nonce,
        }
      );

      const userinfo = await client.userinfo(tokenSet);

      return {
        provider: 'google',
        id: userinfo.sub,
        email: userinfo.email,
        name: userinfo.name || '',
        avatar: userinfo.picture || '',
      };
    }

    case 'github': {
      const code = ctx.query.code;
      if (!code) {
        throw new Error('Missing authorization code from GitHub');
      }
      return handleGithubCallback(code, sessionData.oauth_state, ctx.query.state);
    }

    default:
      throw new Error(`Unknown upstream provider: ${providerName}`);
  }
}
