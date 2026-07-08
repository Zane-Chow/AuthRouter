import config from './config.js';

/**
 * Generic OAuth2 upstream adapter — for non-OIDC providers configured with
 * manual authorize/token/userinfo endpoints + a field mapping (replaces the
 * previously hardcoded GitHub integration).
 */

/**
 * Generate the authorization URL for an OAuth2 upstream provider.
 * @param {object} row - upstream_providers row (type === 'oauth2')
 * @param {string} state - CSRF protection state parameter
 */
export function getAuthUrl(row, state) {
  const params = new URLSearchParams({
    client_id: row.client_id,
    redirect_uri: `${config.sso.baseUrl}/sso/${row.provider_id}/callback`,
    scope: row.scope || '',
    state,
  });
  return `${row.authorize_url}?${params.toString()}`;
}

async function exchangeCodeForToken(row, code) {
  const response = await fetch(row.token_url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      client_id: row.client_id,
      client_secret: row.client_secret,
      code,
      redirect_uri: `${config.sso.baseUrl}/sso/${row.provider_id}/callback`,
    }),
  });

  const data = await response.json();

  if (data.error) {
    throw new Error(`${row.provider_id} token exchange failed: ${data.error_description || data.error}`);
  }

  return data.access_token;
}

async function fetchUserProfile(row, accessToken) {
  const response = await fetch(row.userinfo_url, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json',
      'User-Agent': 'Personal-SSO-Middleware',
    },
  });

  if (!response.ok) {
    throw new Error(`${row.provider_id} userinfo API error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

/**
 * GitHub-shaped secondary email lookup (`{email, primary, verified}[]`).
 * Only applies when `row.email_url` is configured — other OAuth2 providers
 * that need a similar fallback but return a different shape aren't
 * supported by this generic path (known limitation).
 */
async function fetchFallbackEmail(row, accessToken) {
  if (!row.email_url) return null;

  const response = await fetch(row.email_url, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json',
      'User-Agent': 'Personal-SSO-Middleware',
    },
  });

  if (!response.ok) return null;

  const emails = await response.json();
  if (!Array.isArray(emails)) return null;

  const primary = emails.find(e => e.primary && e.verified);
  if (primary) return primary.email;
  const verified = emails.find(e => e.verified);
  return verified ? verified.email : null;
}

/**
 * Handle the OAuth2 callback and return a normalized user profile.
 * @param {object} row - upstream_providers row (type === 'oauth2')
 * @param {string} code - Authorization code from the provider's callback
 * @param {string} expectedState - The state we sent
 * @param {string} receivedState - The state we received back
 */
export async function handleCallback(row, code, expectedState, receivedState) {
  if (!receivedState || receivedState !== expectedState) {
    throw new Error('State parameter mismatch — possible CSRF attack');
  }

  const accessToken = await exchangeCodeForToken(row, code);
  const profile = await fetchUserProfile(row, accessToken);

  const id = profile[row.field_id];
  let email = profile[row.field_email];
  if (!email) {
    email = await fetchFallbackEmail(row, accessToken);
  }

  return {
    provider: row.provider_id,
    id: String(id),
    email: email || `${id}@${row.provider_id}`,
    name: profile[row.field_name] || String(id),
    avatar: profile[row.field_avatar] || '',
  };
}
