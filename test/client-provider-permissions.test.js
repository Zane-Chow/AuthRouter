import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'authrouter-permissions-test-'));
process.env.SSO_PORT = '3460';

const clients = await import('../src/clients.js');
const providerStore = await import('../src/upstream-providers-db.js');
const upstream = await import('../src/upstream-providers.js');
const { closeDb } = await import('../src/db/index.js');

const providerDefaults = {
  type: 'oidc',
  issuer: 'https://accounts.example.com',
  clientId: 'upstream-client',
  clientSecret: 'upstream-secret',
  scope: 'openid email profile',
};

test('clients can use all upstreams or a configured whitelist', async (t) => {
  t.after(async () => closeDb());

  await providerStore.addProvider({
    ...providerDefaults,
    providerId: 'google',
    displayName: 'Google',
  });
  await providerStore.addProvider({
    ...providerDefaults,
    providerId: 'github',
    displayName: 'GitHub',
  });
  await providerStore.addProvider({
    ...providerDefaults,
    providerId: 'internal',
    displayName: 'Internal',
  });

  await clients.addClient({
    clientId: 'client-a',
    clientSecret: 'secret-a',
    clientName: 'Client A',
    redirectUris: ['https://a.example/callback'],
  });
  await clients.addClient({
    clientId: 'client-b',
    clientSecret: 'secret-b',
    clientName: 'Client B',
    redirectUris: ['https://b.example/callback'],
    allowedProviderIds: ['google', 'github'],
  });

  assert.deepEqual(
    (await upstream.getEnabledProviders('client-a')).map((provider) => provider.id).sort(),
    ['github', 'google', 'internal'],
  );
  assert.deepEqual(
    (await upstream.getEnabledProviders('client-b')).map((provider) => provider.id).sort(),
    ['github', 'google'],
  );
  assert.equal(await upstream.isProviderAllowedForClient('internal', 'client-a'), true);
  assert.equal(await upstream.isProviderAllowedForClient('internal', 'client-b'), false);
  assert.equal(await upstream.isProviderAllowedForClient('github', 'client-b'), true);

  const listed = await clients.getAllClients();
  assert.deepEqual(listed.find((client) => client.client_id === 'client-a').allowed_providers, []);
  assert.deepEqual(listed.find((client) => client.client_id === 'client-b').allowed_providers, ['github', 'google']);

  await clients.updateClient('client-b', {
    clientName: 'Client B renamed',
    redirectUris: ['https://b.example/callback'],
  });
  assert.deepEqual(await clients.getAllowedProviderIds('client-b'), ['github', 'google']);

  await clients.updateClient('client-b', {
    clientName: 'Client B',
    redirectUris: ['https://b.example/callback'],
    allowedProviderIds: ['internal'],
  });
  assert.deepEqual((await upstream.getEnabledProviders('client-b')).map((provider) => provider.id), ['internal']);

  await providerStore.removeProvider((await providerStore.getAllProviders()).find((provider) => provider.provider_id === 'internal').id);
  assert.deepEqual(await clients.getAllowedProviderIds('client-b'), ['internal']);
  assert.deepEqual(await upstream.getEnabledProviders('client-b'), []);
});
