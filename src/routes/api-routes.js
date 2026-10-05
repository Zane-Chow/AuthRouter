import crypto from 'node:crypto';
import Router from '@koa/router';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { parseClientInput, parseMappingInput, parseNumericId, parseProviderInput, requiredString } from '../validation.js';

const PROVIDER_FIELDS = ['provider_id', 'display_name', 'type', 'issuer', 'authorize_url', 'token_url',
  'userinfo_url', 'email_url', 'client_id', 'client_secret', 'scope', 'field_id', 'field_email',
  'field_name', 'field_avatar', 'icon', 'enabled'];
const CLIENT_FIELDS = ['client_name', 'redirect_uris', 'token_endpoint_auth_method', 'scope', 'allowed_providers', 'enabled'];
const MAPPING_FIELDS = ['client_id', 'provider', 'provider_identity', 'target_identity', 'display_name'];

function bodyInput(ctx, fields, { allowEmpty = false } = {}) {
  const body = ctx.request.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ValidationError('请求体必须是 JSON 对象');
  const keys = Object.keys(body);
  if (!allowEmpty && keys.length === 0) throw new ValidationError('请求体不能为空');
  for (const key of keys) {
    if (!fields.includes(key)) throw new ValidationError(`不支持字段 ${key}`);
  }
  return body;
}

function enabledValue(value, fallback) {
  if (value === undefined) return Boolean(fallback);
  if (typeof value !== 'boolean') throw new ValidationError('enabled 必须是布尔值');
  return value;
}

function publicProvider(row) {
  const { client_secret: secret, ...data } = row;
  return { ...data, enabled: Boolean(row.enabled) };
}

function publicClient(row) {
  const { client_secret: secret, ...data } = row;
  return {
    ...data,
    redirect_uris: JSON.parse(row.redirect_uris),
    grant_types: JSON.parse(row.grant_types),
    response_types: JSON.parse(row.response_types),
    enabled: Boolean(row.enabled),
  };
}

function parseApiClient(body, existing = {}) {
  const merged = { ...existing, ...body };
  let redirectUris = merged.redirect_uris;
  if (Array.isArray(redirectUris)) {
    if (redirectUris.some((uri) => typeof uri !== 'string' || !uri.trim())) {
      throw new ValidationError('redirect_uris 必须包含非空字符串');
    }
    redirectUris = redirectUris.join('\n');
  }
  return {
    ...parseClientInput({ ...merged, redirect_uris: redirectUris, token_auth_method: merged.token_endpoint_auth_method }),
    enabled: enabledValue(body.enabled, existing.enabled ?? true),
  };
}

function parseApiProvider(body, existing) {
  const input = parseProviderInput({
    ...existing, ...body,
    // Existing secrets stay encrypted; this placeholder is only for shared input validation.
    client_secret: existing && body.client_secret === undefined ? 'keep-existing-secret' : body.client_secret,
  });
  if (existing && body.client_secret === undefined) input.clientSecret = null;
  for (const field of ['issuer', 'authorizeUrl', 'tokenUrl', 'userinfoUrl', 'emailUrl']) {
    if (input[field]?.length > 512) throw new ValidationError('上游 URL 长度不能超过 512');
  }
  return { ...input, enabled: enabledValue(body.enabled, existing?.enabled ?? true) };
}

export function createApiRouter({ clients, mappings, providerStore, upstream, logger }) {
  const router = new Router({ prefix: '/api' });
  router.use(async (ctx, next) => {
    try {
      await next();
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE' || error.code === 'ER_DUP_ENTRY'
        || /UNIQUE constraint failed/.test(error.message || '')) throw new ConflictError();
      throw error;
    }
  });

  async function getProvider(value) {
    const row = await providerStore.getProviderById(parseNumericId(value));
    if (!row) throw new NotFoundError('上游 IdP 不存在');
    return row;
  }

  async function getClient(clientId) {
    const row = await clients.getClientById(clientId);
    if (!row) throw new NotFoundError('客户端不存在');
    return { ...row, allowed_providers: await clients.getAllowedProviderIds(clientId) };
  }

  async function getMapping(value) {
    const row = await mappings.getMappingById(parseNumericId(value));
    if (!row) throw new NotFoundError('身份映射不存在');
    return row;
  }

  async function validatePermissions(providerIds) {
    if (providerIds.length === 0) return;
    const known = new Set((await providerStore.getAllProviders()).map((row) => row.provider_id));
    for (const id of providerIds) {
      if (!known.has(id)) throw new ValidationError(`上游 IdP ${id} 不存在`);
    }
  }

  async function mappingInput(body, existing) {
    const merged = { ...existing, ...body };
    const input = parseMappingInput({ ...merged, provider_type: merged.provider });
    if (!await clients.getClientById(input.clientId)) throw new ValidationError('客户端不存在');
    if (!await upstream.isProviderAllowedForClient(input.provider, input.clientId)) {
      throw new ValidationError('客户端无权使用该上游 IdP，或该 IdP 未启用');
    }
    return input;
  }

  router.get('/upstream-providers', async (ctx) => {
    ctx.body = (await providerStore.getAllProviders()).map(publicProvider);
  });
  router.post('/upstream-providers', async (ctx) => {
    const input = parseApiProvider(bodyInput(ctx, PROVIDER_FIELDS));
    const result = await providerStore.addProvider(input);
    ctx.status = 201;
    ctx.set('Location', `/api/upstream-providers/${result.insertId}`);
    ctx.body = publicProvider(await getProvider(result.insertId));
    logger.info('upstream provider created via API', { providerId: input.providerId });
  });
  router.get('/upstream-providers/:id', async (ctx) => {
    ctx.body = publicProvider(await getProvider(ctx.params.id));
  });
  router.patch('/upstream-providers/:id', async (ctx) => {
    const row = await getProvider(ctx.params.id);
    const body = bodyInput(ctx, PROVIDER_FIELDS.filter((key) => key !== 'provider_id'));
    const input = parseApiProvider(body, row);
    await providerStore.updateProvider(row.id, input);
    upstream.clearProviderCache(row.provider_id);
    ctx.body = publicProvider(await getProvider(row.id));
    logger.info('upstream provider updated via API', { providerId: row.provider_id });
  });
  router.delete('/upstream-providers/:id', async (ctx) => {
    const row = await getProvider(ctx.params.id);
    await providerStore.removeProvider(row.id);
    upstream.clearProviderCache(row.provider_id);
    ctx.status = 204;
    logger.info('upstream provider deleted via API', { providerId: row.provider_id });
  });

  router.get('/clients', async (ctx) => {
    ctx.body = (await clients.getAllClients()).map(publicClient);
  });
  router.post('/clients', async (ctx) => {
    const input = parseApiClient(bodyInput(ctx, CLIENT_FIELDS));
    await validatePermissions(input.allowedProviderIds);
    const clientId = crypto.randomBytes(12).toString('hex');
    const clientSecret = crypto.randomBytes(32).toString('base64url');
    await clients.addClient({ ...input, clientId, clientSecret });
    ctx.status = 201;
    ctx.set('Location', `/api/clients/${clientId}`);
    ctx.body = { ...publicClient(await getClient(clientId)), client_secret: clientSecret };
    logger.info('OIDC client created via API', { clientId });
  });
  router.get('/clients/:clientId', async (ctx) => {
    ctx.body = publicClient(await getClient(ctx.params.clientId));
  });
  router.patch('/clients/:clientId', async (ctx) => {
    const row = await getClient(ctx.params.clientId);
    const body = bodyInput(ctx, CLIENT_FIELDS);
    const input = parseApiClient(body, { ...row, redirect_uris: JSON.parse(row.redirect_uris) });
    if (body.allowed_providers !== undefined) await validatePermissions(input.allowedProviderIds);
    await clients.updateClient(row.client_id, input);
    ctx.body = publicClient(await getClient(row.client_id));
    logger.info('OIDC client updated via API', { clientId: row.client_id });
  });
  router.post('/clients/:clientId/reset-secret', async (ctx) => {
    bodyInput(ctx, [], { allowEmpty: true });
    const row = await getClient(ctx.params.clientId);
    const clientSecret = crypto.randomBytes(32).toString('base64url');
    await clients.rotateClientSecret(row.client_id, clientSecret);
    ctx.body = { client_id: row.client_id, client_secret: clientSecret };
    logger.info('OIDC client secret rotated via API', { clientId: row.client_id });
  });
  router.delete('/clients/:clientId', async (ctx) => {
    const row = await getClient(ctx.params.clientId);
    await clients.removeClient(row.client_id);
    ctx.status = 204;
    logger.info('OIDC client deleted via API', { clientId: row.client_id });
  });

  router.get('/mappings', async (ctx) => {
    const clientId = ctx.query.client_id === undefined ? undefined
      : requiredString(ctx.query.client_id, '客户端', { maxLength: 100 });
    ctx.body = await mappings.getAllMappings(clientId);
  });
  router.post('/mappings', async (ctx) => {
    const input = await mappingInput(bodyInput(ctx, MAPPING_FIELDS));
    const result = await mappings.addMapping(input.clientId, input.provider, input.providerIdentity, input.targetIdentity, input.displayName);
    if (result.changes === 0) throw new ConflictError('该映射已存在');
    ctx.status = 201;
    ctx.set('Location', `/api/mappings/${result.insertId}`);
    ctx.body = await getMapping(result.insertId);
    logger.info('identity mapping created via API', { clientId: input.clientId, providerId: input.provider });
  });
  router.get('/mappings/:id', async (ctx) => {
    ctx.body = await getMapping(ctx.params.id);
  });
  router.patch('/mappings/:id', async (ctx) => {
    const row = await getMapping(ctx.params.id);
    const input = await mappingInput(bodyInput(ctx, MAPPING_FIELDS), row);
    await mappings.updateMapping(row.id, input);
    ctx.body = await getMapping(row.id);
    logger.info('identity mapping updated via API', { mappingId: row.id });
  });
  router.delete('/mappings/:id', async (ctx) => {
    const row = await getMapping(ctx.params.id);
    await mappings.removeMapping(row.id);
    ctx.status = 204;
    logger.info('identity mapping deleted via API', { mappingId: row.id });
  });
  return router;
}

export function createHealthRouter({ upstream }) {
  const router = new Router();
  router.get('/health', async (ctx) => {
    const providers = await upstream.getEnabledProviders();
    ctx.body = { status: 'ok', timestamp: new Date().toISOString(), providers: providers.map((item) => item.id) };
  });
  return router;
}
