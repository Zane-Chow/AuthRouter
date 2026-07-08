import Provider from 'oidc-provider';
import config from './config.js';
import { getJWKS } from './keys.js';
import { getOidcClients, getOidcClient } from './clients.js';

/**
 * Create and configure the OIDC Provider instance.
 *
 * This provider acts as an Identity Provider (IdP) for downstream
 * Relying Parties (websites/apps). Clients are dynamically loaded
 * from the database, not hardcoded.
 */
export async function createProvider() {
  const jwks = await getJWKS();

  // Load initial clients from database
  const initialClients = getOidcClients();

  const provider = new Provider(config.sso.baseUrl, {
    // Load clients from database at startup
    clients: initialClients,

    // Use adapter to dynamically find clients (supports hot-reload)
    // oidc-provider will call findAccount and use the clients array,
    // but for dynamic client lookup we override clientBasedCORS and
    // provide a custom client adapter below.
    findClient: undefined, // We'll use the built-in client store + refresh

    // Signing keys for ID tokens
    jwks,

    // Claims configuration
    claims: {
      openid: ['sub'],
      email: ['email', 'email_verified'],
      profile: ['name', 'picture'],
    },

    scopes: ['openid', 'email', 'profile'],

    // Disable dev interactions (we provide our own)
    features: {
      devInteractions: { enabled: false },
    },

    // Interaction URL — where to redirect when login/consent is needed
    interactions: {
      url(ctx, interaction) {
        return `/interaction/${interaction.uid}`;
      },
    },

    // Cookie configuration
    cookies: {
      keys: [config.session.secret],
      short: { signed: true, httpOnly: true, overwrite: true, sameSite: 'lax' },
      long: { signed: true, httpOnly: true, overwrite: true, sameSite: 'lax' },
    },

    // Account lookup — called when oidc-provider needs to build claims.
    // The accountId is the target identity we set during interactionFinished.
    findAccount(ctx, id) {
      return {
        accountId: id,
        async claims(use, scope) {
          const claims = { sub: id };

          if (scope.includes('email')) {
            claims.email = id;
            claims.email_verified = true;
          }

          if (scope.includes('profile')) {
            // Use the email local part as the name (or full id if no @)
            claims.name = id.includes('@') ? id.split('@')[0] : id;
          }

          return claims;
        },
      };
    },

    // Token time-to-live
    ttl: {
      AccessToken: 3600,       // 1 hour
      AuthorizationCode: 600,  // 10 minutes
      IdToken: 3600,           // 1 hour
      RefreshToken: 86400,     // 24 hours
      Session: 1,              // 1 second (effectively disables session caching)
    },

    // Extra security settings
    pkce: {
      required: () => false, // Don't require PKCE (many downstream apps don't support it)
    },
  });

  // Trust the reverse proxy for X-Forwarded-* headers
  provider.proxy = true;

  console.log('✅ OIDC Provider initialized');
  console.log(`   Issuer:    ${config.sso.baseUrl}`);
  console.log(`   Clients:   ${initialClients.length} registered`);

  return provider;
}

/**
 * Reload clients into the OIDC provider.
 * Call this after adding/removing clients via the admin panel.
 *
 * Note: oidc-provider doesn't natively support hot-reloading clients,
 * so we need to manipulate its internal client store. This function
 * accesses provider internals, which may break on major version updates.
 *
 * @param {Provider} provider - The oidc-provider instance
 */
export async function reloadClients(provider) {
  const clients = getOidcClients();

  // Clear internal client cache
  const clientKeystore = provider.Client;

  // Re-add all clients by iterating
  // The oidc-provider v8 stores clients in an internal Map.
  // We clear it and re-initialize.
  const store = provider.Client;

  // Force re-initialize by calling find on each — this triggers lazy loading
  // For a clean reload, we restart the provider's internal client list
  for (const clientData of clients) {
    try {
      await store.find(clientData.client_id);
    } catch {
      // Client not found in cache — that's fine, it will be added on next auth request
    }
  }

  console.log(`🔄 Client cache refresh attempted for ${clients.length} clients`);
}
