import Router from '@koa/router';
import { AuthenticationError } from '../errors.js';

function requireAdmin(ctx) {
  if (!ctx.session?.isAdmin) throw new AuthenticationError();
}

export function createApiRouter({ clients, mappings, upstream }) {
  const router = new Router();

  router.get('/api/clients', async (ctx) => {
    requireAdmin(ctx);
    ctx.body = (await clients.getAllClients()).map((client) => ({
      ...client,
      client_secret: '••••••••',
    }));
  });

  router.get('/api/mappings', async (ctx) => {
    requireAdmin(ctx);
    ctx.body = await mappings.getAllMappings(ctx.query.client_id || undefined);
  });

  router.get('/health', async (ctx) => {
    const providers = await upstream.getEnabledProviders();
    ctx.body = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      providers: providers.map((item) => item.id),
    };
  });

  return router;
}
