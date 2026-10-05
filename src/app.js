import Koa from 'koa';
import bodyParser from 'koa-bodyparser';
import session from 'koa-session';

import config from './config.js';
import { createProvider } from './provider.js';
import * as clients from './clients.js';
import * as mappings from './mapping.js';
import * as providerStore from './upstream-providers-db.js';
import * as upstreamProviders from './upstream-providers.js';
import * as apiSettings from './api-settings.js';
import { apiAuthentication, isApiPath } from './api-auth.js';
import { render } from './render.js';
import { logger } from './logger.js';
import { MemorySessionStore } from './session-store.js';
import { LoginRateLimiter, csrfProtection, exposeCsrfToken, securityHeaders } from './security.js';
import { errorHandler, notFound, requestContext } from './middleware.js';
import { createInteractionRouter } from './routes/interaction-routes.js';
import { createAdminRouter } from './routes/admin-routes.js';
import { createApiRouter, createHealthRouter } from './routes/api-routes.js';
import { closeDb } from './db/index.js';
import { ValidationError } from './errors.js';

function isProviderPath(path) {
  return path === '/.well-known/openid-configuration'
    || path === '/auth'
    || path.startsWith('/auth/')
    || path === '/token'
    || path === '/me'
    || path === '/jwks'
    || path === '/request'
    || path === '/session/end'
    || path.startsWith('/session/end/');
}

function dispatchToProvider(provider) {
  const callback = provider.callback();
  return async (ctx, next) => {
    if (!isProviderPath(ctx.path)) {
      await next();
      return;
    }

    ctx.respond = false;
    await new Promise((resolve, reject) => {
      const finish = () => {
        ctx.res.off('finish', finish);
        ctx.res.off('close', finish);
        resolve();
      };
      ctx.res.once('finish', finish);
      ctx.res.once('close', finish);
      Promise.resolve(callback(ctx.req, ctx.res)).catch(reject);
    });
  };
}

export async function createApplication(overrides = {}) {
  const dependencies = {
    config,
    clients,
    mappings,
    providerStore,
    upstream: upstreamProviders,
    apiSettings,
    render,
    logger,
    ...overrides,
  };
  const provider = overrides.provider || await createProvider();
  const sessionStore = overrides.sessionStore || new MemorySessionStore();
  const loginLimiter = overrides.loginLimiter || new LoginRateLimiter();

  const app = new Koa();
  app.proxy = true;
  app.keys = [dependencies.config.session.secret];
  app.context.provider = provider;

  app.use(securityHeaders());
  app.use(requestContext(dependencies.logger));
  app.use(errorHandler(dependencies));
  app.use(dispatchToProvider(provider));
  // Token APIs run before session and CSRF middleware; browser cookies cannot authenticate them.
  const apiRouter = createApiRouter(dependencies);
  const apiRoutes = apiRouter.routes();
  const apiMethods = apiRouter.allowedMethods();
  const apiNotFound = notFound();
  const apiBodyParser = bodyParser({
    enableTypes: ['json'], jsonLimit: '256kb',
    onerror(error) {
      if (error.status === 413) {
        throw new ValidationError('请求体不能超过 256 KiB', { status: 413, code: 'payload_too_large' });
      }
      throw new ValidationError('JSON 请求体无效');
    },
  });
  app.use(apiAuthentication(dependencies.apiSettings));
  app.use(async (ctx, next) => {
    if (!isApiPath(ctx.path)) return next();
    await apiBodyParser(ctx, async () => {
      await apiRoutes(ctx, async () => {
        await apiMethods(ctx, () => apiNotFound(ctx));
      });
    });
    if ([405, 501].includes(ctx.status)) {
      ctx.body = { error: 'method_not_allowed', message: '不支持该 HTTP 方法', requestId: ctx.state.requestId };
    }
  });
  app.use(session({
    key: 'sso:sess',
    maxAge: dependencies.config.session.maxAgeMs,
    store: sessionStore,
    renew: true,
    signed: true,
    httpOnly: true,
    sameSite: 'lax',
    secure: dependencies.config.env === 'production',
  }, app));
  app.use(exposeCsrfToken());
  app.use(bodyParser({ enableTypes: ['json', 'form'], jsonLimit: '256kb', formLimit: '256kb' }));
  app.use(csrfProtection());

  const interactionRouter = createInteractionRouter({ ...dependencies, provider });
  const adminRouter = createAdminRouter({ ...dependencies, loginLimiter });
  const healthRouter = createHealthRouter(dependencies);
  for (const router of [interactionRouter, adminRouter, healthRouter]) {
    app.use(router.routes());
    app.use(router.allowedMethods());
  }
  app.use(notFound());

  return {
    app,
    provider,
    async close() {
      sessionStore.close?.();
      if (!overrides.clients && !overrides.providerStore && !overrides.mappings) await closeDb();
    },
  };
}
