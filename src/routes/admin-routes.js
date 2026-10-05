import crypto from 'node:crypto';
import Router from '@koa/router';
import { ensureCsrfToken, secureCompare } from '../security.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { parseClientInput, parseMappingInput, parseNumericId, parseProviderInput } from '../validation.js';

function redirectWith(ctx, kind, message) {
  ctx.redirect(`/admin?${kind}=${encodeURIComponent(message)}`);
}

function requireAdmin(ctx) {
  if (ctx.session?.isAdmin) return true;
  redirectWith(ctx, 'error', '登录已过期，请重新登录');
  return false;
}

function duplicateMessage(error, fallback) {
  return error?.code === 'SQLITE_CONSTRAINT_UNIQUE'
    || error?.code === 'ER_DUP_ENTRY'
    || /UNIQUE|Duplicate/i.test(error?.message || '')
    ? fallback
    : error.message;
}

export function createAdminRouter({ config, clients, mappings, providerStore, upstream, apiSettings, render, logger, loginLimiter }) {
  const router = new Router();
  router.use(async (ctx, next) => {
    if (ctx.path === '/admin' || ctx.path.startsWith('/admin/')) ctx.set('Cache-Control', 'no-store');
    await next();
  });

  async function validateAllowedProviders(providerIds) {
    if (providerIds.length === 0) return;
    const known = new Set((await providerStore.getAllProviders()).map((row) => row.provider_id));
    const unknown = providerIds.find((providerId) => !known.has(providerId));
    if (unknown) throw new ValidationError(`上游 IdP ${unknown} 不存在`);
  }

  async function loadViewData() {
    const [clientRows, mappingRows, enabledProviders, providers, apiConfig] = await Promise.all([
      clients.getAllClients(),
      mappings.getAllMappings(),
      upstream.getEnabledProviders(),
      providerStore.getAllProviders(),
      apiSettings.getApiSettings(),
    ]);
    return { clients: clientRows, mappings: mappingRows, enabledProviders, providers, apiConfig };
  }

  router.get('/admin', async (ctx) => {
    if (!ctx.session?.isAdmin) {
      await render(ctx, 'admin', { loggedIn: false, error: ctx.query.error || undefined });
      return;
    }
    await render(ctx, 'admin', {
      loggedIn: true,
      ...await loadViewData(),
      message: ctx.query.message || undefined,
      error: ctx.query.error || undefined,
    });
  });

  router.post('/admin/login', async (ctx) => {
    const key = ctx.ip || 'unknown';
    if (!loginLimiter.check(key)) {
      ctx.status = 429;
      await render(ctx, 'admin', { loggedIn: false, error: '登录失败次数过多，请稍后再试' });
      return;
    }

    const valid = secureCompare(ctx.request.body.username, config.admin.username)
      && secureCompare(ctx.request.body.password, config.admin.password);
    if (!valid) {
      loginLimiter.fail(key);
      ctx.status = 401;
      await render(ctx, 'admin', { loggedIn: false, error: '用户名或密码错误' });
      return;
    }

    loginLimiter.reset(key);
    ctx.session.isAdmin = true;
    delete ctx.session.csrfToken;
    ctx.state.csrfToken = ensureCsrfToken(ctx.session);
    ctx.redirect('/admin');
  });

  router.post('/admin/logout', async (ctx) => {
    ctx.session = null;
    ctx.redirect('/admin');
  });

  router.post('/admin/api/settings', async (ctx) => {
    if (!requireAdmin(ctx)) return;
    try {
      const value = ctx.request.body.enabled;
      if (!['0', '1'].includes(value)) throw new ValidationError('API 开关值无效');
      const enabled = value === '1';
      const settings = await apiSettings.getApiSettings();
      if (enabled && !settings.hasToken) throw new ValidationError('请先生成 API Token');
      await apiSettings.setApiEnabled(enabled);
      logger.info('management API settings updated', { enabled });
      redirectWith(ctx, 'message', enabled ? '管理 API 已开启' : '管理 API 已关闭');
    } catch (error) {
      redirectWith(ctx, 'error', error.message);
    }
  });

  router.post('/admin/api/token', async (ctx) => {
    if (!requireAdmin(ctx)) return;
    try {
      const apiToken = await apiSettings.generateApiToken();
      logger.info('management API token rotated');
      await render(ctx, 'admin', {
        loggedIn: true,
        ...await loadViewData(),
        apiToken,
        message: 'API Token 已生成，请立即保存。此前的 Token 已失效。',
      });
    } catch (error) {
      redirectWith(ctx, 'error', error.message);
    }
  });

  router.post('/admin/clients', async (ctx) => {
    if (!requireAdmin(ctx)) return;
    try {
      const input = parseClientInput(ctx.request.body);
      await validateAllowedProviders(input.allowedProviderIds);
      const clientId = crypto.randomBytes(12).toString('hex');
      const clientSecret = crypto.randomBytes(32).toString('base64url');
      await clients.addClient({ clientId, clientSecret, ...input });
      logger.info('OIDC client created', { clientId });
      await render(ctx, 'admin', {
        loggedIn: true,
        ...await loadViewData(),
        reveal: { clientId, clientSecret, clientName: input.clientName },
      });
    } catch (error) {
      redirectWith(ctx, 'error', duplicateMessage(error, '客户端标识已存在'));
    }
  });

  router.post('/admin/clients/:clientId/update', async (ctx) => {
    if (!requireAdmin(ctx)) return;
    try {
      const clientId = ctx.params.clientId;
      const existing = await clients.getClientById(clientId);
      if (!existing) throw new NotFoundError('客户端不存在');
      const input = parseClientInput(ctx.request.body);
      await validateAllowedProviders(input.allowedProviderIds);
      const newSecret = ctx.request.body.reset_secret ? crypto.randomBytes(32).toString('base64url') : null;
      await clients.updateClient(clientId, { ...input, clientSecret: newSecret, enabled: existing.enabled });
      logger.info('OIDC client updated', { clientId, secretRotated: Boolean(newSecret) });
      if (newSecret) {
        await render(ctx, 'admin', {
          loggedIn: true,
          ...await loadViewData(),
          reveal: { clientId, clientSecret: newSecret, clientName: input.clientName },
        });
        return;
      }
      redirectWith(ctx, 'message', '客户端已更新');
    } catch (error) {
      redirectWith(ctx, 'error', error.message);
    }
  });

  router.post('/admin/clients/:clientId/delete', async (ctx) => {
    if (!requireAdmin(ctx)) return;
    try {
      await clients.removeClient(ctx.params.clientId);
      logger.info('OIDC client deleted', { clientId: ctx.params.clientId });
      redirectWith(ctx, 'message', '客户端已删除');
    } catch (error) {
      redirectWith(ctx, 'error', error.message);
    }
  });

  router.post('/admin/upstream-providers', async (ctx) => {
    if (!requireAdmin(ctx)) return;
    try {
      const input = parseProviderInput(ctx.request.body);
      await providerStore.addProvider(input);
      logger.info('upstream provider created', { providerId: input.providerId, type: input.type });
      redirectWith(ctx, 'message', `上游 IdP ${input.displayName} 添加成功`);
    } catch (error) {
      redirectWith(ctx, 'error', duplicateMessage(error, '该标识已存在'));
    }
  });

  router.post('/admin/upstream-providers/:id/toggle', async (ctx) => {
    if (!requireAdmin(ctx)) return;
    try {
      const id = parseNumericId(ctx.params.id);
      const row = await providerStore.getProviderById(id);
      if (!row) throw new NotFoundError('未找到该上游 IdP');
      await providerStore.setProviderEnabled(id, !row.enabled);
      upstream.clearProviderCache(row.provider_id);
      redirectWith(ctx, 'message', `上游 IdP 已${row.enabled ? '禁用' : '启用'}`);
    } catch (error) {
      redirectWith(ctx, 'error', error.message);
    }
  });

  router.post('/admin/upstream-providers/:id/delete', async (ctx) => {
    if (!requireAdmin(ctx)) return;
    try {
      const id = parseNumericId(ctx.params.id);
      const row = await providerStore.getProviderById(id);
      if (!row) throw new NotFoundError('未找到该上游 IdP');
      await providerStore.removeProvider(id);
      upstream.clearProviderCache(row.provider_id);
      logger.info('upstream provider deleted', { providerId: row.provider_id });
      redirectWith(ctx, 'message', '上游 IdP 已删除');
    } catch (error) {
      redirectWith(ctx, 'error', error.message);
    }
  });

  router.post('/admin/mappings', async (ctx) => {
    if (!requireAdmin(ctx)) return;
    try {
      const input = parseMappingInput(ctx.request.body);
      if (!(await clients.getClientById(input.clientId))) throw new ValidationError(`客户端 ${input.clientId} 不存在`);
      if (!(await upstream.isProviderAllowedForClient(input.provider, input.clientId))) {
        throw new ValidationError(`客户端无权使用上游 IdP ${input.provider}，或该 IdP 未启用`);
      }
      const result = await mappings.addMapping(
        input.clientId,
        input.provider,
        input.providerIdentity,
        input.targetIdentity,
        input.displayName,
      );
      if (result.changes === 0) throw new ValidationError('该映射已存在');
      logger.info('identity mapping created', { clientId: input.clientId, providerId: input.provider });
      redirectWith(ctx, 'message', '映射添加成功');
    } catch (error) {
      redirectWith(ctx, 'error', error.message);
    }
  });

  router.post('/admin/mappings/:id/delete', async (ctx) => {
    if (!requireAdmin(ctx)) return;
    try {
      await mappings.removeMapping(parseNumericId(ctx.params.id));
      redirectWith(ctx, 'message', '映射已删除');
    } catch (error) {
      redirectWith(ctx, 'error', error.message);
    }
  });

  return router;
}
