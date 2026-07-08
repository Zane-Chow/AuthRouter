import config from './config.js';

/**
 * GitHub OAuth2 Adapter
 *
 * GitHub uses standard OAuth2 (not OIDC) so we handle the flow manually:
 * 1. Generate authorization URL
 * 2. Exchange code for access token
 * 3. Fetch user info via GitHub REST API
 */

/**
 * Generate GitHub authorization URL.
 * @param {string} state - CSRF protection state parameter
 * @returns {string} The GitHub authorization URL
 */
export function getGithubAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: config.github.clientId,
    redirect_uri: `${config.sso.baseUrl}/sso/github/callback`,
    scope: 'read:user user:email',
    state,
  });
  return `${config.github.authorizeUrl}?${params.toString()}`;
}

/**
 * Exchange authorization code for access token.
 * @param {string} code - The authorization code from GitHub
 * @returns {Promise<string>} The access token
 */
async function exchangeCodeForToken(code) {
  const response = await fetch(config.github.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      client_id: config.github.clientId,
      client_secret: config.github.clientSecret,
      code,
    }),
  });

  const data = await response.json();

  if (data.error) {
    throw new Error(`GitHub token exchange failed: ${data.error_description || data.error}`);
  }

  return data.access_token;
}

/**
 * Fetch user profile from GitHub API.
 * @param {string} accessToken
 * @returns {Promise<object>} User profile { id, login, email, name, avatar_url }
 */
async function fetchUserProfile(accessToken) {
  const response = await fetch(config.github.userApiUrl, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'Personal-SSO-Middleware',
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

/**
 * Fetch the user's primary verified email from GitHub.
 * (The /user endpoint may not include email if it's set to private)
 * @param {string} accessToken
 * @returns {Promise<string|null>} Primary email or null
 */
async function fetchUserEmail(accessToken) {
  const response = await fetch(config.github.userEmailsApiUrl, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'Personal-SSO-Middleware',
    },
  });

  if (!response.ok) return null;

  const emails = await response.json();
  // Prefer the primary verified email
  const primary = emails.find(e => e.primary && e.verified);
  if (primary) return primary.email;
  // Fallback to any verified email
  const verified = emails.find(e => e.verified);
  return verified ? verified.email : null;
}

/**
 * Handle GitHub OAuth2 callback.
 * Exchanges code for token, fetches user info, returns normalized profile.
 *
 * @param {string} code - Authorization code from GitHub callback
 * @param {string} expectedState - The state we sent
 * @param {string} receivedState - The state we received back
 * @returns {Promise<object>} Normalized user profile
 */
export async function handleGithubCallback(code, expectedState, receivedState) {
  // Verify state to prevent CSRF
  if (!receivedState || receivedState !== expectedState) {
    throw new Error('State parameter mismatch — possible CSRF attack');
  }

  const accessToken = await exchangeCodeForToken(code);
  const profile = await fetchUserProfile(accessToken);

  // Get email — may need a separate API call if private
  let email = profile.email;
  if (!email) {
    email = await fetchUserEmail(accessToken);
  }

  return {
    provider: 'github',
    id: String(profile.id),
    login: profile.login,
    email: email || `${profile.login}@github.com`, // fallback if no public email
    name: profile.name || profile.login,
    avatar: profile.avatar_url || '',
  };
}
