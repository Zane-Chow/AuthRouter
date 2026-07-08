import { Issuer } from 'openid-client';
import config from './config.js';

let googleClient = null;

/**
 * Get or create the Google OIDC client (singleton).
 * Uses OpenID Connect Discovery to auto-configure endpoints.
 */
export async function getGoogleClient() {
  if (googleClient) return googleClient;

  console.log('🔍 Discovering Google OIDC configuration...');
  const googleIssuer = await Issuer.discover(config.google.issuer);

  googleClient = new googleIssuer.Client({
    client_id: config.google.clientId,
    client_secret: config.google.clientSecret,
    redirect_uris: [`${config.sso.baseUrl}/sso/google/callback`],
    response_types: ['code'],
  });

  console.log('✅ Google OIDC client initialized');
  return googleClient;
}

/**
 * Generate the Google authorization URL for login.
 * @param {object} client - The Google OIDC client
 * @param {string} state - CSRF protection state parameter
 * @param {string} nonce - Nonce for ID token validation
 * @returns {string} The Google authorization URL
 */
export function getGoogleAuthUrl(client, state, nonce) {
  return client.authorizationUrl({
    scope: 'openid email profile',
    state,
    nonce,
    prompt: 'select_account', // Always show Google account chooser
  });
}
