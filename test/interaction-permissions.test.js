import test from 'node:test';
import assert from 'node:assert/strict';
import { createInteractionRouter } from '../src/routes/interaction-routes.js';

function routeHandler(router, path, method) {
  return router.stack.find((layer) => layer.path === path && layer.methods.includes(method)).stack[0];
}

function dependencies(overrides = {}) {
  return {
    provider: {
      interactionDetails: async () => ({
        prompt: { name: 'login' },
        params: { client_id: 'client-b' },
      }),
    },
    upstream: {},
    mappings: {},
    render: async () => {},
    logger: { info() {} },
    ...overrides,
  };
}

test('login interaction requests providers for the downstream client', async () => {
  let queriedClientId;
  let rendered;
  const router = createInteractionRouter(dependencies({
    upstream: {
      getEnabledProviders: async (clientId) => {
        queriedClientId = clientId;
        return [
          { id: 'google', name: 'Google', icon: 'google' },
          { id: 'github', name: 'GitHub', icon: 'github' },
        ];
      },
    },
    render: async (_ctx, view, data) => { rendered = { view, data }; },
  }));
  const ctx = { params: { uid: 'uid-1' }, req: {}, res: {}, session: {} };

  await routeHandler(router, '/interaction/:uid', 'GET')(ctx);

  assert.equal(queriedClientId, 'client-b');
  assert.equal(ctx.session.oidcFlow.clientId, 'client-b');
  assert.equal(rendered.view, 'login-selector');
  assert.deepEqual(rendered.data.providers.map((provider) => provider.id), ['google', 'github']);
});

test('provider selection rejects an upstream outside the client whitelist', async () => {
  let checked;
  const router = createInteractionRouter(dependencies({
    upstream: {
      isProviderAllowedForClient: async (providerId, clientId) => {
        checked = { providerId, clientId };
        return false;
      },
    },
  }));
  const ctx = {
    params: { uid: 'uid-2' },
    request: { body: { provider: 'internal' } },
    session: { oidcFlow: { uid: 'uid-2', clientId: 'client-b' } },
  };

  await assert.rejects(
    () => routeHandler(router, '/interaction/:uid/select-idp', 'POST')(ctx),
    /不支持的登录方式/,
  );
  assert.deepEqual(checked, { providerId: 'internal', clientId: 'client-b' });
});

test('automatic redirect carries the client ID into the authorization check', async () => {
  let authArgs;
  const router = createInteractionRouter(dependencies({
    upstream: {
      getEnabledProviders: async () => [{ id: 'google', name: 'Google', icon: 'google' }],
      getAuthUrl: async (...args) => {
        authArgs = args;
        return 'https://accounts.example.com/authorize';
      },
    },
  }));
  const ctx = {
    params: { uid: 'uid-3' },
    req: {},
    res: {},
    session: {},
    redirect(url) { this.redirectedTo = url; },
  };

  await routeHandler(router, '/interaction/:uid', 'GET')(ctx);

  assert.equal(authArgs[0], 'google');
  assert.equal(authArgs[3], 'client-b');
  assert.equal(ctx.redirectedTo, 'https://accounts.example.com/authorize');
});
