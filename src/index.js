/**
 * Personal SSO Middleware — Main Entry Point
 *
 * A generic OIDC proxy that supports multiple upstream Identity Providers
 * (Google, GitHub, etc.) and multiple downstream Relying Parties.
 *
 * Architecture:
 *   Upstream IdPs ←(OAuth2/OIDC)→ [This App] ←(oidc-provider)→ Downstream RPs
 */

import Koa from 'koa';
import Router from '@koa/router';
import bodyParser from 'koa-bodyparser';
import session from 'koa-session';
import mount from 'koa-mount';
import crypto from 'crypto';

import config from './config.js';
import { createProvider } from './provider.js';
import { getEnabledProviders, isProviderEnabled, getAuthUrl, handleCallback } from './upstream-providers.js';
import { getAllClients, getClientById, addClient, removeClient } from './clients.js';
import { getTargetAccounts, getAllMappings, addMapping, removeMapping } from './mapping.js';
import { render } from './render.js';

// ─── Application Setup ──────────────────────────────────────

const app = new Koa();
app.proxy = true; // Trust reverse proxy (nginx)
app.keys = [config.session.secret];

// ─── Session Store (in-memory) ──────────────────────────────

const sessionMap = new Map();
const sessionStore = {
  get(key) {
    const data = sessionMap.get(key);
    if (!data) return undefined;
    // Expire stale sessions
    if (data._expire && data._expire < Date.now()) {
      sessionMap.delete(key);
      return undefined;
    }
    return data;
  },
  set(key, sess, maxAge) {
    sess._expire = Date.now() + (maxAge || 600000);
    sessionMap.set(key, sess);
  },
  destroy(key) {
    sessionMap.delete(key);
  },
};

// Periodic cleanup of expired sessions (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [key, data] of sessionMap) {
    if (data._expire && data._expire < now) {
      sessionMap.delete(key);
    }
  }
}, 5 * 60 * 1000).unref();

app.use(session({
  key: 'sso:sess',
  maxAge: 10 * 60 * 1000, // 10 minutes
  store: sessionStore,
  renew: false,
  sameSite: 'lax',
}, app));

// ─── Body Parser ────────────────────────────────────────────

app.use(bodyParser());

// ─── Error Handler ──────────────────────────────────────────

app.use(async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    console.error('❌ Unhandled error:', err);
    ctx.status = err.status || 500;
    await render(ctx, 'error', {
      message: err.expose ? err.message : '服务器内部错误',
      hint: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    });
  }
});

// ─── Create OIDC Provider ───────────────────────────────────

const provider = await createProvider();

// ─── Routes ─────────────────────────────────────────────────

const router = new Router();

// ═══════════════════════════════════════════════════════════
// OIDC Interaction Routes
// ═══════════════════════════════════════════════════════════

/**
 * Handle OIDC interaction — called when oidc-provider needs user action.
 * For 'login' prompt: show the IdP selector page (Google / GitHub).
 * For 'consent' prompt: auto-approve (we control both sides).
 */
router.get('/interaction/:uid', async (ctx) => {
  const details = await provider.interactionDetails(ctx.req, ctx.res);
  const { prompt } = details;

  if (prompt.name === 'login') {
    const providers = getEnabledProviders();

    // If only one upstream IdP is configured, skip selector and redirect directly
    if (providers.length === 1) {
      const providerName = providers[0].id;
      const state = crypto.randomBytes(16).toString('hex');
      const nonce = crypto.randomBytes(16).toString('hex');

      ctx.session.oidc_uid = ctx.params.uid;
      ctx.session.oauth_state = state;
      ctx.session.oauth_nonce = nonce;
      ctx.session.oauth_provider = providerName;

      // Save the requesting client_id for mapping lookup later
      ctx.session.requesting_client_id = details.params.client_id;

      const authUrl = await getAuthUrl(providerName, state, nonce);
      console.log(`🔄 Login interaction ${ctx.params.uid} → redirecting to ${providerName} (only provider)`);
      ctx.redirect(authUrl);
      return;
    }

    // Multiple providers available — show selector page
    ctx.session.oidc_uid = ctx.params.uid;
    ctx.session.requesting_client_id = details.params.client_id;

    console.log(`🔄 Login interaction ${ctx.params.uid} → showing IdP selector`);
    await render(ctx, 'login-selector', {
      uid: ctx.params.uid,
      providers,
    });

  } else if (prompt.name === 'consent') {
    // Auto-approve consent — no user interaction needed
    console.log(`✅ Auto-approving consent for interaction ${ctx.params.uid}`);

    let grant;
    if (details.grantId) {
      grant = await provider.Grant.find(details.grantId);
    } else {
      grant = new provider.Grant({
        accountId: details.session.accountId,
        clientId: details.params.client_id,
      });
    }

    // Grant all requested scopes and claims
    if (prompt.details.missingOIDCScope) {
      grant.addOIDCScope(prompt.details.missingOIDCScope.join(' '));
    }
    if (prompt.details.missingOIDCClaims) {
      grant.addOIDCClaims(prompt.details.missingOIDCClaims);
    }
    if (prompt.details.missingResourceScopes) {
      for (const [indicator, scopes] of Object.entries(prompt.details.missingResourceScopes)) {
        grant.addResourceScope(indicator, scopes.join(' '));
      }
    }

    const grantId = await grant.save();

    await provider.interactionFinished(ctx.req, ctx.res, {
      consent: { grantId },
    }, { mergeWithLastSubmission: true });

  } else {
    // Unknown prompt — show error
    console.warn(`⚠️  Unknown interaction prompt: ${prompt.name}`);
    await render(ctx, 'error', {
      message: `不支持的交互类型: ${prompt.name}`,
    });
  }
});

/**
 * IdP selection — user chose which provider to log in with.
 * Generates OAuth state/nonce and redirects to the upstream IdP.
 */
router.post('/interaction/:uid/select-idp', async (ctx) => {
  const { provider: providerName } = ctx.request.body;

  if (!providerName || !isProviderEnabled(providerName)) {
    await render(ctx, 'error', {
      message: `不支持的登录方式: ${providerName}`,
    });
    return;
  }

  const state = crypto.randomBytes(16).toString('hex');
  const nonce = crypto.randomBytes(16).toString('hex');

  ctx.session.oidc_uid = ctx.params.uid;
  ctx.session.oauth_state = state;
  ctx.session.oauth_nonce = nonce;
  ctx.session.oauth_provider = providerName;

  const authUrl = await getAuthUrl(providerName, state, nonce);
  console.log(`🔄 Login interaction ${ctx.params.uid} → redirecting to ${providerName}`);
  ctx.redirect(authUrl);
});

/**
 * Unified OAuth callback — handles callbacks from all upstream IdPs.
 * The :provider parameter determines which handler to use.
 */
router.get('/sso/:provider/callback', async (ctx) => {
  const providerName = ctx.params.provider;
  const uid = ctx.session.oidc_uid;

  if (!uid) {
    await render(ctx, 'error', {
      message: '会话已过期',
      hint: '请返回原网站重新发起 SSO 登录。',
    });
    return;
  }

  if (!isProviderEnabled(providerName)) {
    await render(ctx, 'error', {
      message: `不支持的登录方式: ${providerName}`,
    });
    return;
  }

  try {
    // Handle the callback and get normalized user profile
    const profile = await handleCallback(providerName, ctx, {
      oauth_state: ctx.session.oauth_state,
      oauth_nonce: ctx.session.oauth_nonce,
    });

    console.log(`✅ ${providerName} auth successful: ${profile.email} (${profile.name})`);

    // Save profile in session for the federated step
    ctx.session.userProfile = profile;

    // Redirect back to interaction path (where oidc-provider cookies are valid)
    ctx.redirect(`/interaction/${uid}/federated`);

  } catch (err) {
    console.error(`❌ ${providerName} callback error:`, err);
    await render(ctx, 'error', {
      message: `${providerName} 认证失败`,
      hint: err.message,
    });
  }
});

/**
 * Federated callback — processes the upstream identity and resolves
 * the target identity for the requesting downstream client.
 *
 * Logic:
 * - 0 mappings → use upstream identity directly (passthrough)
 * - 1 mapping  → use that mapped identity directly
 * - 2+ mappings → show account selection page
 */
router.get('/interaction/:uid/federated', async (ctx) => {
  const { userProfile, requesting_client_id } = ctx.session;

  if (!userProfile) {
    await render(ctx, 'error', {
      message: '认证信息丢失',
      hint: '请返回原网站重新发起 SSO 登录。',
    });
    return;
  }

  const { provider: authProvider, email, name, avatar } = userProfile;

  // Look up identity mappings for this client + provider + identity
  const mappings = getTargetAccounts(requesting_client_id, authProvider, email);

  if (mappings.length === 0) {
    // No mapping configured — use original upstream identity (passthrough)
    console.log(`✅ Passthrough: ${email} → ${email} (no mapping for client ${requesting_client_id})`);

    const result = {
      login: { accountId: email, remember: false },
    };

    await provider.interactionFinished(ctx.req, ctx.res, result, {
      mergeWithLastSubmission: false,
    });
    return;
  }

  if (mappings.length === 1) {
    // Single mapping — use it directly
    const targetIdentity = mappings[0].target_identity;
    console.log(`✅ Single mapping: ${email} → ${targetIdentity} (client ${requesting_client_id})`);

    const result = {
      login: { accountId: targetIdentity, remember: false },
    };

    await provider.interactionFinished(ctx.req, ctx.res, result, {
      mergeWithLastSubmission: false,
    });
    return;
  }

  // Multiple mappings — show account selection page
  console.log(`📋 Multiple mappings for ${email} on client ${requesting_client_id}: ${mappings.map(m => m.target_identity).join(', ')}`);

  await render(ctx, 'select-account', {
    uid: ctx.params.uid,
    userEmail: email,
    userName: name,
    userAvatar: avatar,
    providerName: authProvider,
    accounts: mappings,
  });
});

/**
 * Account selection — user picked which target identity to log in as.
 */
router.post('/interaction/:uid/select', async (ctx) => {
  const { selected_account } = ctx.request.body;
  const { userProfile, requesting_client_id } = ctx.session;

  if (!userProfile || !selected_account) {
    await render(ctx, 'error', {
      message: '无效的请求',
      hint: '会话可能已过期，请重新登录。',
    });
    return;
  }

  const { provider: authProvider, email } = userProfile;

  // Verify the selected account is a valid mapping for this user + client
  const mappings = getTargetAccounts(requesting_client_id, authProvider, email);
  const valid = mappings.find(m => m.target_identity === selected_account);

  if (!valid) {
    console.warn(`⚠️  Invalid account selection: ${selected_account} for ${email}`);
    await render(ctx, 'error', {
      message: '所选账号无效',
      hint: '该身份未与您的登录账号关联。',
    });
    return;
  }

  console.log(`✅ Account selected: ${email} → ${selected_account}`);

  const result = {
    login: { accountId: selected_account, remember: false },
  };

  await provider.interactionFinished(ctx.req, ctx.res, result, {
    mergeWithLastSubmission: false,
  });
});

// ═══════════════════════════════════════════════════════════
// Admin Panel Routes
// ═══════════════════════════════════════════════════════════

// --- Admin Auth Middleware ---
function requireAdmin(ctx) {
  if (!ctx.session.isAdmin) {
    ctx.status = 403;
    ctx.body = 'Forbidden';
    return false;
  }
  return true;
}

/** Admin panel — login gate + main dashboard */
router.get('/admin', async (ctx) => {
  if (!ctx.session.isAdmin) {
    await render(ctx, 'admin', { loggedIn: false });
    return;
  }

  const clients = getAllClients();
  const mappings = getAllMappings();
  const enabledProviders = getEnabledProviders();

  await render(ctx, 'admin', {
    loggedIn: true,
    clients,
    mappings,
    enabledProviders,
    message: ctx.query.message || undefined,
    error: ctx.query.error || undefined,
  });
});

/** Admin login */
router.post('/admin/login', async (ctx) => {
  const { username, password } = ctx.request.body;

  if (username === config.admin.username && password === config.admin.password) {
    ctx.session.isAdmin = true;
    ctx.redirect('/admin');
  } else {
    await render(ctx, 'admin', { loggedIn: false, error: '用户名或密码错误' });
  }
});

/** Admin logout */
router.post('/admin/logout', async (ctx) => {
  ctx.session.isAdmin = false;
  ctx.redirect('/admin');
});

// --- Client Management ---

/** Add a new OIDC client */
router.post('/admin/clients', async (ctx) => {
  if (!requireAdmin(ctx)) return;

  const {
    client_id,
    client_secret,
    client_name,
    redirect_uris,
    token_auth_method,
    scope,
  } = ctx.request.body;

  if (!client_id || !client_secret || !client_name || !redirect_uris) {
    ctx.redirect('/admin?error=' + encodeURIComponent('Client ID、Secret、名称和回调地址不能为空'));
    return;
  }

  try {
    // Parse redirect_uris: support comma-separated or newline-separated
    const uris = redirect_uris
      .split(/[,\n]/)
      .map(u => u.trim())
      .filter(Boolean);

    addClient({
      clientId: client_id.trim(),
      clientSecret: client_secret.trim(),
      clientName: client_name.trim(),
      redirectUris: uris,
      tokenAuthMethod: token_auth_method || 'client_secret_post',
      scope: scope || 'openid email profile',
    });

    console.log(`✅ Client added: ${client_id} (${client_name})`);
    console.log('⚠️  Note: New clients require a server restart to take effect in oidc-provider.');
    ctx.redirect('/admin?message=' + encodeURIComponent(`客户端 ${client_name} 添加成功。注意：需要重启服务才能生效。`));

  } catch (err) {
    console.error('❌ Failed to add client:', err);
    const msg = err.message.includes('UNIQUE') ? '该 Client ID 已存在' : err.message;
    ctx.redirect('/admin?error=' + encodeURIComponent(msg));
  }
});

/** Delete an OIDC client */
router.post('/admin/clients/:clientId/delete', async (ctx) => {
  if (!requireAdmin(ctx)) return;

  try {
    removeClient(ctx.params.clientId);
    console.log(`🗑️  Client ${ctx.params.clientId} deleted`);
    ctx.redirect('/admin?message=' + encodeURIComponent('客户端已删除。需要重启服务才能生效。'));
  } catch (err) {
    console.error('❌ Failed to delete client:', err);
    ctx.redirect('/admin?error=' + encodeURIComponent(err.message));
  }
});

// --- Identity Mapping Management ---

/** Add a new identity mapping */
router.post('/admin/mappings', async (ctx) => {
  if (!requireAdmin(ctx)) return;

  const { client_id, provider_type, provider_identity, target_identity, display_name } = ctx.request.body;

  if (!client_id || !provider_identity || !target_identity) {
    ctx.redirect('/admin?error=' + encodeURIComponent('客户端、来源身份和目标身份不能为空'));
    return;
  }

  // Verify the client exists
  const client = getClientById(client_id);
  if (!client) {
    ctx.redirect('/admin?error=' + encodeURIComponent(`客户端 ${client_id} 不存在`));
    return;
  }

  try {
    const result = addMapping(
      client_id,
      provider_type || 'google',
      provider_identity,
      target_identity,
      display_name || null
    );

    if (result.changes === 0) {
      ctx.redirect('/admin?error=' + encodeURIComponent('该映射已存在'));
    } else {
      console.log(`✅ Mapping added: [${provider_type}] ${provider_identity} → ${target_identity} (client: ${client_id})`);
      ctx.redirect('/admin?message=' + encodeURIComponent('映射添加成功'));
    }
  } catch (err) {
    console.error('❌ Failed to add mapping:', err);
    ctx.redirect('/admin?error=' + encodeURIComponent(err.message));
  }
});

/** Delete an identity mapping */
router.post('/admin/mappings/:id/delete', async (ctx) => {
  if (!requireAdmin(ctx)) return;

  try {
    removeMapping(ctx.params.id);
    console.log(`🗑️  Mapping ${ctx.params.id} deleted`);
    ctx.redirect('/admin?message=' + encodeURIComponent('映射已删除'));
  } catch (err) {
    console.error('❌ Failed to delete mapping:', err);
    ctx.redirect('/admin?error=' + encodeURIComponent(err.message));
  }
});

// ═══════════════════════════════════════════════════════════
// API Routes (for potential future use)
// ═══════════════════════════════════════════════════════════

/** Get all registered clients (JSON) */
router.get('/api/clients', async (ctx) => {
  if (!ctx.session.isAdmin) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }
  const clients = getAllClients();
  // Don't expose secrets in API response
  ctx.body = clients.map(c => ({
    ...c,
    client_secret: '••••••••',
  }));
});

/** Get all mappings (JSON) */
router.get('/api/mappings', async (ctx) => {
  if (!ctx.session.isAdmin) {
    ctx.status = 401;
    ctx.body = { error: 'Unauthorized' };
    return;
  }
  const clientId = ctx.query.client_id;
  ctx.body = getAllMappings(clientId || undefined);
});

// ═══════════════════════════════════════════════════════════
// Health Check
// ═══════════════════════════════════════════════════════════

router.get('/health', (ctx) => {
  ctx.body = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    providers: config.enabledProviders,
  };
});

// ─── Mount Routes & Provider ────────────────────────────────

// Our routes first (interaction, auth, admin)
app.use(router.routes());
app.use(router.allowedMethods());

// OIDC Provider handles: /auth, /token, /me, /jwks, /.well-known/*
// Use koa-mount to properly mount the oidc-provider (which is itself a Koa app)
// as a sub-application. This ensures the provider gets its own Koa context with
// proper raw Node.js req/res objects, avoiding "setHeader is not a function" errors.
app.use(mount(provider.app));

// ─── Start Server ───────────────────────────────────────────

const port = config.sso.port;

app.listen(port, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║          Personal SSO Middleware Started          ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  Port:      ${String(port).padEnd(37)}║`);
  console.log(`║  Issuer:    ${config.sso.baseUrl.padEnd(37)}║`);
  console.log(`║  Providers: ${config.enabledProviders.join(', ').padEnd(37)}║`);
  console.log('║                                                  ║');
  console.log('║  Endpoints:                                      ║');
  console.log(`║  Discovery: ${(config.sso.baseUrl + '/.well-known/openid-configuration').padEnd(37)}║`);
  console.log(`║  Admin:     ${(config.sso.baseUrl + '/admin').padEnd(37)}║`);
  console.log(`║  Health:    ${(config.sso.baseUrl + '/health').padEnd(37)}║`);
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');
});
