import Provider from 'oidc-provider';
import config from './config.js';
import { getJWKS } from './keys.js';
import { getEnabledClients } from './clients.js';
import { DbAdapter } from './oidc-adapter.js';

/**
 * Create and configure the OIDC Provider instance.
 *
 * This provider acts as an Identity Provider (IdP) for downstream
 * Relying Parties (websites/apps). Clients are looked up live from the
 * database via a custom Adapter, so admin panel changes (add/update/remove)
 * take effect immediately without restarting the process.
 */
export async function createProvider() {
  const jwks = await getJWKS();
  const enabledClients = await getEnabledClients();

  const issuer = config.sso.baseUrl || `http://localhost:${config.sso.port}`;
  const provider = new Provider(issuer, {
    // Custom adapter: Client lookups query the database live (hot-reload);
    // all other models use in-process memory storage.
    adapter: DbAdapter,

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
      Grant: 1209600,          // 14 days — how long a consent grant is remembered
      Interaction: 600,        // 10 minutes — time window for a login/consent flow
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
  console.log(`   Issuer:    ${issuer}`);
  console.log(`   Clients:   ${enabledClients.length} registered`);

  return provider;
}
