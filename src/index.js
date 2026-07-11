/**
 * AuthRouter - Main Entry Point
 *
 * A generic OIDC proxy that supports multiple upstream Identity Providers
 * (configured via the /admin panel) and multiple downstream Relying Parties.
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
import { getAllClients, getClientById, addClient, updateClient, removeClient } from './clients.js';
import { getTargetAccounts, getAllMappings, addMapping, removeMapping } from './mapping.js';
import {
  getAllProviders,
  getProviderById,
  addProvider,
  removeProvider,
  setProviderEnabled,
} from './upstream-providers-db.js';
import { clearProviderCache } from './oidc-auth.js';
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
  // 2 hours, renewed on activity — long enough that admin dashboard use
  // doesn't get logged out mid-session, while still short-lived overall.
  // OIDC interactions (login/consent) complete within seconds regardless
  // of this ceiling, so a longer maxAge has no effect on that flow.
  maxAge: 2 * 60 * 60 * 1000,
  store: sessionStore,
  renew: true,
  sameSite: 'lax',
}, app));

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

// ─── Mount OIDC Provider (before body parser) ───────────────
// Force proxy trust: we inject the x-forwarded-proto header so the
// underlying OIDC engine always treats the request as secure (HTTPS).
// This guarantees it will never complain about proxy headers, even for
// local internal requests (like Docker healthchecks).
app.use(async (ctx, next) => {
  ctx.headers['x-forwarded-proto'] = 'https';
  await next();
});

// The OIDC provider must be mounted BEFORE the global body parser so that
// it can parse POST bodies (e.g. /token) with its own internal parser.
// If koa-bodyparser runs first, the provider sees an already-consumed body
// and emits: "already parsed request body detected".
app.use(mount(provider.app));

// ─── Body Parser (for our own routes only) ──────────────────
// Placed after the OIDC provider mount so it only affects interaction,
// admin, and API routes — never the provider's own endpoints.
app.use(bodyParser());

// ─── Routes ─────────────────────────────────────────────────

const router = new Router();

// ═══════════════════════════════════════════════════════════
// OIDC Interaction Routes
// ═══════════════════════════════════════════════════════════

/**
 * Handle OIDC interaction — called when oidc-provider needs user action.
 * For 'login' prompt: show the IdP selector page (from configured upstream IdPs).
 * For 'consent' prompt: auto-approve (we control both sides).
 */
router.get('/interaction/:uid', async (ctx) => {
  const details = await provider.interactionDetails(ctx.req, ctx.res);
  const { prompt } = details;

  if (prompt.name === 'login') {
    const providers = await getEnabledProviders();

    if (providers.length === 0) {
      await render(ctx, 'error', {
        message: '尚未配置任何上游身份提供商',
        hint: '请前往 /admin 面板添加至少一个上游 IdP。',
      });
      return;
    }

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

  if (!providerName || !(await isProviderEnabled(providerName))) {
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

  if (!(await isProviderEnabled(providerName))) {
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
  const mappings = await getTargetAccounts(requesting_client_id, authProvider, email);

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
  const mappings = await getTargetAccounts(requesting_client_id, authProvider, email);
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
// Redirects to the login page rather than returning a bare 403 — the vast
// majority of "Forbidden" hits here are an expired/missing session rather
// than an actual authorization failure, so sending the user back to
// /admin (where they can just log back in) is both more accurate and
// more useful than a dead-end error page.
function requireAdmin(ctx) {
  if (!ctx.session.isAdmin) {
    ctx.redirect('/admin?error=' + encodeURIComponent('登录已过期，请重新登录'));
    return false;
  }
  return true;
}

/** Gather the data needed to render the logged-in admin dashboard. */
async function loadAdminViewData() {
  const [clients, mappings, enabledProviders, providers] = await Promise.all([
    getAllClients(),
    getAllMappings(),
    getEnabledProviders(),
    getAllProviders(),
  ]);
  return { clients, mappings, enabledProviders, providers };
}

/** Admin panel — login gate + main dashboard */
router.get('/admin', async (ctx) => {
  if (!ctx.session.isAdmin) {
    await render(ctx, 'admin', { loggedIn: false });
    return;
  }

  const data = await loadAdminViewData();

  await render(ctx, 'admin', {
    loggedIn: true,
    ...data,
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

/**
 * Add a new OIDC client. Client ID/Secret are generated server-side and
 * revealed exactly once on this render — they are never shown again.
 */
router.post('/admin/clients', async (ctx) => {
  if (!requireAdmin(ctx)) return;

  const { client_name, redirect_uris, token_auth_method, scope } = ctx.request.body;

  if (!client_name || !redirect_uris) {
    ctx.redirect('/admin?error=' + encodeURIComponent('名称和回调地址不能为空'));
    return;
  }

  try {
    const uris = redirect_uris
      .split(/[,\n]/)
      .map(u => u.trim())
      .filter(Boolean);

    const clientId = crypto.randomBytes(12).toString('hex');
    const clientSecret = crypto.randomBytes(32).toString('base64url');

    await addClient({
      clientId,
      clientSecret,
      clientName: client_name.trim(),
      redirectUris: uris,
      tokenAuthMethod: token_auth_method || 'client_secret_post',
      scope: scope || 'openid email profile',
    });

    console.log(`✅ Client added: ${clientId} (${client_name})`);

    const data = await loadAdminViewData();
    await render(ctx, 'admin', {
      loggedIn: true,
      ...data,
      reveal: { clientId, clientSecret, clientName: client_name.trim() },
    });

  } catch (err) {
    console.error('❌ Failed to add client:', err);
    ctx.redirect('/admin?error=' + encodeURIComponent(err.message));
  }
});

/** Delete an OIDC client */
router.post('/admin/clients/:clientId/delete', async (ctx) => {
  if (!requireAdmin(ctx)) return;

  try {
    await removeClient(ctx.params.clientId);
    console.log(`🗑️  Client ${ctx.params.clientId} deleted`);
    ctx.redirect('/admin?message=' + encodeURIComponent('客户端已删除'));
  } catch (err) {
    console.error('❌ Failed to delete client:', err);
    ctx.redirect('/admin?error=' + encodeURIComponent(err.message));
  }
});

/**
 * Update an existing OIDC client — name, redirect URIs, auth method, scope.
 * The Client ID always stays the same. The Client Secret is only rotated
 * when the "reset secret" checkbox was checked; otherwise the existing
 * secret is preserved so downstream systems don't need reconfiguring just
 * because a callback URL changed.
 */
router.post('/admin/clients/:clientId/update', async (ctx) => {
  if (!requireAdmin(ctx)) return;

  const { client_name, redirect_uris, token_auth_method, scope, reset_secret } = ctx.request.body;
  const clientId = ctx.params.clientId;

  if (!client_name || !redirect_uris) {
    ctx.redirect('/admin?error=' + encodeURIComponent('名称和回调地址不能为空'));
    return;
  }

  const existing = await getClientById(clientId);
  if (!existing) {
    ctx.redirect('/admin?error=' + encodeURIComponent('客户端不存在'));
    return;
  }

  try {
    const uris = redirect_uris
      .split(/[,\n]/)
      .map(u => u.trim())
      .filter(Boolean);

    const newSecret = reset_secret ? crypto.randomBytes(32).toString('base64url') : null;

    await updateClient(clientId, {
      clientName: client_name.trim(),
      clientSecret: newSecret,
      redirectUris: uris,
      tokenAuthMethod: token_auth_method || 'client_secret_post',
      scope: scope || 'openid email profile',
      enabled: existing.enabled,
    });

    console.log(`✅ Client updated: ${clientId} (${client_name})${newSecret ? ' [secret reset]' : ''}`);

    if (newSecret) {
      const data = await loadAdminViewData();
      await render(ctx, 'admin', {
        loggedIn: true,
        ...data,
        reveal: { clientId, clientSecret: newSecret, clientName: client_name.trim() },
      });
      return;
    }

    ctx.redirect('/admin?message=' + encodeURIComponent('客户端已更新'));
  } catch (err) {
    console.error('❌ Failed to update client:', err);
    ctx.redirect('/admin?error=' + encodeURIComponent(err.message));
  }
});

// --- Upstream Identity Provider Management ---

/** Add a new upstream IdP (type: 'oidc' | 'oauth2') */
router.post('/admin/upstream-providers', async (ctx) => {
  if (!requireAdmin(ctx)) return;

  const {
    provider_id,
    display_name,
    type,
    issuer,
    authorize_url,
    token_url,
    userinfo_url,
    email_url,
    client_id,
    client_secret,
    scope,
    field_id,
    field_email,
    field_name,
    field_avatar,
    icon,
  } = ctx.request.body;

  if (!provider_id || !display_name || !type || !client_id || !client_secret) {
    ctx.redirect('/admin?error=' + encodeURIComponent('标识、名称、类型、Client ID、Client Secret 不能为空'));
    return;
  }

  if (type === 'oidc' && !issuer) {
    ctx.redirect('/admin?error=' + encodeURIComponent('OIDC 类型需要填写 Issuer'));
    return;
  }

  if (type === 'oauth2' && (!authorize_url || !token_url || !userinfo_url)) {
    ctx.redirect('/admin?error=' + encodeURIComponent('OAuth2 类型需要填写 Authorize/Token/Userinfo 地址'));
    return;
  }

  try {
    await addProvider({
      providerId: provider_id.trim(),
      displayName: display_name.trim(),
      type,
      issuer: issuer || null,
      authorizeUrl: authorize_url || null,
      tokenUrl: token_url || null,
      userinfoUrl: userinfo_url || null,
      emailUrl: email_url || null,
      clientId: client_id.trim(),
      clientSecret: client_secret.trim(),
      scope: scope || (type === 'oidc' ? 'openid email profile' : ''),
      fieldId: field_id || 'sub',
      fieldEmail: field_email || 'email',
      fieldName: field_name || 'name',
      fieldAvatar: field_avatar || 'picture',
      icon: icon || 'generic',
    });

    console.log(`✅ Upstream provider added: ${provider_id} (${display_name}, ${type})`);
    ctx.redirect('/admin?message=' + encodeURIComponent(`上游 IdP ${display_name} 添加成功`));
  } catch (err) {
    console.error('❌ Failed to add upstream provider:', err);
    const msg = err.message.includes('UNIQUE') || err.message.includes('Duplicate') ? '该标识已存在' : err.message;
    ctx.redirect('/admin?error=' + encodeURIComponent(msg));
  }
});

/** Delete an upstream IdP */
router.post('/admin/upstream-providers/:id/delete', async (ctx) => {
  if (!requireAdmin(ctx)) return;

  try {
    const row = await getProviderById(ctx.params.id);
    await removeProvider(ctx.params.id);
    if (row) clearProviderCache(row.provider_id);
    console.log(`🗑️  Upstream provider ${ctx.params.id} deleted`);
    ctx.redirect('/admin?message=' + encodeURIComponent('上游 IdP 已删除'));
  } catch (err) {
    console.error('❌ Failed to delete upstream provider:', err);
    ctx.redirect('/admin?error=' + encodeURIComponent(err.message));
  }
});

/** Toggle enabled/disabled state for an upstream IdP */
router.post('/admin/upstream-providers/:id/toggle', async (ctx) => {
  if (!requireAdmin(ctx)) return;

  try {
    const row = await getProviderById(ctx.params.id);
    if (!row) {
      ctx.redirect('/admin?error=' + encodeURIComponent('未找到该上游 IdP'));
      return;
    }
    await setProviderEnabled(ctx.params.id, !row.enabled);
    clearProviderCache(row.provider_id);
    ctx.redirect('/admin?message=' + encodeURIComponent(`上游 IdP 已${row.enabled ? '禁用' : '启用'}`));
  } catch (err) {
    console.error('❌ Failed to toggle upstream provider:', err);
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
  const client = await getClientById(client_id);
  if (!client) {
    ctx.redirect('/admin?error=' + encodeURIComponent(`客户端 ${client_id} 不存在`));
    return;
  }

  try {
    const result = await addMapping(
      client_id,
      provider_type || '',
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
    await removeMapping(ctx.params.id);
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
  const clients = await getAllClients();
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
  ctx.body = await getAllMappings(clientId || undefined);
});

// ═══════════════════════════════════════════════════════════
// Health Check
// ═══════════════════════════════════════════════════════════

router.get('/health', async (ctx) => {
  const providers = await getEnabledProviders();
  ctx.body = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    providers: providers.map(p => p.id),
  };
});

// ─── Mount Routes ───────────────────────────────────────────

// Our routes (interaction, auth, admin)
// The OIDC provider is already mounted above (before body parser).
app.use(router.routes());
app.use(router.allowedMethods());

// ─── Start Server ───────────────────────────────────────────

const port = config.sso.port;
const startupProviders = await getEnabledProviders();

app.listen(port, () => {
  const issuerDisplay = config.sso.baseUrl || `http://localhost:${port}`;
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║               AuthRouter Started                  ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  Port:      ${String(port).padEnd(37)}║`);
  console.log(`║  Issuer:    ${issuerDisplay.padEnd(37)}║`);
  console.log(`║  DB Driver: ${config.db.driver.padEnd(37)}║`);
  console.log(`║  Data Dir:  ${config.dataDir.padEnd(37)}║`);
  console.log(`║  Providers: ${(startupProviders.map(p => p.id).join(', ') || '(none — configure via /admin)').padEnd(37)}║`);
  console.log('║                                                  ║');
  console.log('║  Endpoints:                                      ║');
  console.log(`║  Admin:     ${(issuerDisplay + '/admin').padEnd(37)}║`);
  console.log(`║  Health:    ${(issuerDisplay + '/health').padEnd(37)}║`);
  console.log('╚══════════════════════════════════════════════════╝');

  // Print generated admin credentials to Docker logs
  if (config.admin.passwordGenerated) {
    console.log('');
    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║  ⚠️  Admin Password Auto-Generated               ║');
    console.log('╠══════════════════════════════════════════════════╣');
    console.log(`║  Username: ${config.admin.username.padEnd(38)}║`);
    console.log(`║  Password: ${config.admin.password.padEnd(38)}║`);
    console.log('║                                                  ║');
    console.log('║  Set ADMIN_PASSWORD env var to use your own.     ║');
    console.log('╚══════════════════════════════════════════════════╝');
  }

  console.log('');
});
