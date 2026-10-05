import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'authrouter-api-test-'));
process.env.SSO_PORT = '3499';
process.env.SSO_BASE_URL = 'http://localhost:3499';
process.env.NODE_ENV = 'development';
process.env.DB_DRIVER = 'sqlite';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'api-integration-password';

const { createApplication } = await import('../src/app.js');
const apiSettings = await import('../src/api-settings.js');
const providerStore = await import('../src/upstream-providers-db.js');
const clients = await import('../src/clients.js');
const { getDb, closeDb } = await import('../src/db/index.js');

function cookiesFrom(response, previous = '') {
  const cookies = new Map(previous.split('; ').filter(Boolean).map((part) => part.split(/=(.*)/s).slice(0, 2)));
  for (const header of response.headers.getSetCookie()) {
    const [name, value] = header.split(';', 1)[0].split(/=(.*)/s).slice(0, 2);
    cookies.set(name, value);
  }
  return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
}

test('admin-controlled token API manages providers, clients and mappings securely', async (t) => {
  const events = [];
  const application = await createApplication({
    logger: { info(...args) { events.push(args); }, warn(...args) { events.push(args); }, error(...args) { events.push(args); } },
  });
  const server = application.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await application.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookies = '';
  let csrf;
  let token;

  async function adminPage() {
    const response = await fetch(`${base}/admin`, { headers: { cookie: cookies } });
    cookies = cookiesFrom(response, cookies);
    const html = await response.text();
    csrf = html.match(/name="_csrf" value="([^"]+)"/)?.[1];
    return { response, html };
  }

  async function adminPost(route, fields = {}, withCsrf = true) {
    const response = await fetch(`${base}${route}`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie: cookies, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...(withCsrf ? { _csrf: csrf } : {}), ...fields }),
    });
    cookies = cookiesFrom(response, cookies);
    return response;
  }

  async function api(method, route, body, credentials = token) {
    const response = await fetch(`${base}${route}`, {
      method, redirect: 'manual',
      headers: {
        ...(credentials ? { authorization: `Bearer ${credentials}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('set-cookie'), null);
    const data = response.status === 204 ? null : await response.json();
    return { response, status: response.status, data };
  }

  await t.test('default disabled and admin controls require session plus CSRF', async () => {
    assert.deepEqual(await apiSettings.getApiSettings(), { enabled: false, hasToken: false, tokenCreatedAt: null });
    assert.equal((await api('GET', '/api/clients')).data.error, 'api_disabled');
    assert.equal((await api('POST', '/api/clients', {})).status, 403);
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/.well-known/openid-configuration`)).status, 200);
    await adminPage();
    const anonymous = await adminPost('/admin/api/token');
    assert.equal(anonymous.status, 302);
    assert.match(anonymous.headers.get('location'), /^\/admin\?error=/);
    assert.equal((await apiSettings.getApiSettings()).hasToken, false);
    assert.equal((await adminPost('/admin/login', { username: 'admin', password: 'api-integration-password' }, false)).status, 403);
    assert.equal((await adminPost('/admin/login', { username: 'admin', password: 'api-integration-password' })).status, 302);
    const page = await adminPage();
    assert.match(page.html, /管理 API/);
    assert.equal(page.response.headers.get('cache-control'), 'no-store');
    const premature = await adminPost('/admin/api/settings', { enabled: '1' });
    assert.match(premature.headers.get('location'), /^\/admin\?error=/);
    assert.equal((await adminPost('/admin/api/token', {}, false)).status, 403);
    const generated = await adminPost('/admin/api/token');
    const html = await generated.text();
    token = html.match(/id="api-token" value="([^"]+)"/)?.[1];
    assert.match(token, /^ar_[A-Za-z0-9_-]{43}$/);
    assert.equal(generated.headers.get('cache-control'), 'no-store');
    assert.equal((await apiSettings.getApiSettings()).enabled, false);
    assert.ok(!(await adminPage()).html.includes(token));
    assert.equal((await adminPost('/admin/api/settings', { enabled: '1' })).status, 302);
  });

  await t.test('only the header Token authenticates API requests', async () => {
    assert.equal((await api('GET', '/api/clients', undefined, null)).status, 401);
    assert.equal((await api('GET', '/api/clients', undefined, 'wrong')).status, 401);
    assert.equal((await fetch(`${base}/api/clients`, { headers: { cookie: cookies } })).status, 401);
    assert.equal((await fetch(`${base}/api/clients?token=${token}`)).status, 401);
    const good = await api('GET', '/api/clients');
    assert.equal(good.status, 200);
    assert.deepEqual(good.data, []);
    const form = await fetch(`${base}/api/clients`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: new URLSearchParams({ client_name: 'Bad' }) });
    assert.equal(form.status, 415);
    assert.equal((await form.json()).error, 'unsupported_media_type');
    const wrongCsrf = await fetch(`${base}/admin/api/settings`, { method: 'POST', headers: { authorization: `Bearer ${token}`, cookie: cookies }, body: new URLSearchParams({ enabled: '0' }) });
    assert.equal(wrongCsrf.status, 403);
    assert.equal((await apiSettings.getApiSettings()).enabled, true);
    assert.equal((await api('GET', '/api/no-such-route')).status, 404);
    const method = await api('PUT', '/api/clients', {});
    assert.equal(method.status, 405);
    assert.equal(method.data.error, 'method_not_allowed');
    assert.equal((await api('POST', '/api/clients', [])).status, 400);
    const malformed = await fetch(`${base}/api/clients`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{' });
    assert.equal(malformed.status, 400);
    assert.match(malformed.headers.get('content-type'), /application\/json/);
  });

  const oidc = { provider_id: 'google', display_name: 'Google', type: 'oidc', issuer: 'https://accounts.example.com', client_id: 'upstream-id', client_secret: 'upstream-secret' };
  let googleId;
  let githubId;
  let clientId;
  let originalClientSecret;
  let mappingId;

  await t.test('upstream CRUD retains secrets and uses explicit enabled state', async () => {
    const created = await api('POST', '/api/upstream-providers', oidc);
    assert.equal(created.status, 201);
    googleId = created.data.id;
    assert.equal(created.response.headers.get('location'), `/api/upstream-providers/${googleId}`);
    assert.equal(created.data.enabled, true);
    assert.equal(created.data.client_secret, undefined);
    assert.equal((await api('POST', '/api/upstream-providers', oidc)).status, 409);
    const github = await api('POST', '/api/upstream-providers', {
      provider_id: 'github', display_name: 'GitHub', type: 'oauth2', authorize_url: 'https://example.com/auth', token_url: 'https://example.com/token', userinfo_url: 'https://example.com/user', client_id: 'github-id', client_secret: 'github-secret', field_id: 'id', enabled: false,
    });
    assert.equal(github.status, 201);
    githubId = github.data.id;
    assert.equal(github.data.enabled, false);
    assert.equal((await api('GET', '/api/upstream-providers')).data.length, 2);
    const storedSecret = (await providerStore.getProviderById(googleId)).client_secret;
    const updated = await api('PATCH', `/api/upstream-providers/${googleId}`, { display_name: 'Updated Google' });
    assert.equal(updated.status, 200);
    assert.equal(updated.data.client_secret, undefined);
    assert.equal((await providerStore.getProviderById(googleId)).client_secret, storedSecret);
    assert.equal((await api('PATCH', `/api/upstream-providers/${googleId}`, { client_secret: 'new-upstream-secret' })).status, 200);
    assert.equal((await providerStore.getProviderConfig('google')).client_secret, 'new-upstream-secret');
    assert.equal((await api('PATCH', `/api/upstream-providers/${googleId}`, { provider_id: 'renamed' })).status, 400);
    for (let i = 0; i < 2; i += 1) assert.equal((await api('PATCH', `/api/upstream-providers/${googleId}`, { enabled: false })).data.enabled, false);
    assert.equal((await api('PATCH', `/api/upstream-providers/${googleId}`, { enabled: 'false' })).status, 400);
    assert.equal((await api('PATCH', `/api/upstream-providers/${googleId}`, { enabled: true })).status, 200);
    assert.equal((await api('GET', '/api/upstream-providers/not-a-number')).status, 400);
    assert.equal((await api('GET', '/api/upstream-providers/999999')).status, 404);
  });

  await t.test('client CRUD preserves omitted whitelist and only reveals new secrets', async () => {
    const created = await api('POST', '/api/clients', { client_name: 'Wiki', redirect_uris: ['https://wiki.example.com/callback'], allowed_providers: ['google'] });
    assert.equal(created.status, 201);
    clientId = created.data.client_id;
    originalClientSecret = created.data.client_secret;
    assert.ok(originalClientSecret);
    assert.deepEqual(created.data.redirect_uris, ['https://wiki.example.com/callback']);
    assert.equal(created.data.enabled, true);
    assert.equal((await clients.getOidcClient(clientId)).client_secret, originalClientSecret);
    const fetched = await api('GET', `/api/clients/${clientId}`);
    assert.equal(fetched.data.client_secret, undefined);
    const updated = await api('PATCH', `/api/clients/${clientId}`, { client_name: 'Renamed Wiki' });
    assert.equal(updated.status, 200);
    assert.deepEqual(updated.data.allowed_providers, ['google']);
    assert.deepEqual(updated.data.redirect_uris, ['https://wiki.example.com/callback']);
    assert.equal((await clients.getOidcClient(clientId)).client_secret, originalClientSecret);
    assert.equal((await api('PATCH', `/api/clients/${clientId}`, { allowed_providers: ['unknown'] })).status, 400);
    assert.equal((await api('PATCH', `/api/clients/${clientId}`, { enabled: false })).data.enabled, false);
    assert.equal(await clients.getOidcClient(clientId), null);
    assert.equal((await api('PATCH', `/api/clients/${clientId}`, { enabled: true })).status, 200);
    const reset = await api('POST', `/api/clients/${clientId}/reset-secret`, {});
    assert.equal(reset.status, 200);
    assert.notEqual(reset.data.client_secret, originalClientSecret);
    assert.equal((await clients.getOidcClient(clientId)).client_secret, reset.data.client_secret);
    assert.equal((await api('GET', '/api/clients')).data[0].client_secret, undefined);
    assert.equal((await api('POST', '/api/clients', { client_name: 'Bad', redirect_uris: ['not-url'] })).status, 400);
    assert.equal((await api('GET', '/api/clients/not-exists')).status, 404);
  });

  await t.test('mapping CRUD enforces provider permissions and uniqueness', async () => {
    const input = { client_id: clientId, provider: 'google', provider_identity: ' Alice@Gmail.com ', target_identity: ' Alice@Example.com ', display_name: 'Alice' };
    const forbidden = await api('POST', '/api/mappings', { ...input, provider: 'github' });
    assert.equal(forbidden.status, 400);
    const created = await api('POST', '/api/mappings', input);
    assert.equal(created.status, 201);
    mappingId = created.data.id;
    assert.equal(created.data.provider_identity, 'alice@gmail.com');
    assert.equal(created.data.target_identity, 'alice@example.com');
    assert.equal((await api('POST', '/api/mappings', input)).status, 409);
    const second = await api('POST', '/api/mappings', { ...input, target_identity: 'other@example.com' });
    assert.equal(second.status, 201);
    assert.equal((await api('PATCH', `/api/mappings/${second.data.id}`, { target_identity: 'alice@example.com' })).status, 409);
    const updated = await api('PATCH', `/api/mappings/${mappingId}`, { display_name: 'Alice Wiki' });
    assert.equal(updated.status, 200);
    assert.equal(updated.data.display_name, 'Alice Wiki');
    assert.equal(updated.data.provider_identity, 'alice@gmail.com');
    assert.equal((await api('GET', `/api/mappings?client_id=${clientId}`)).data.length, 2);
    assert.deepEqual((await api('GET', '/api/mappings?client_id=other')).data, []);
    assert.equal((await api('DELETE', `/api/mappings/${second.data.id}`)).status, 204);
    assert.equal((await api('GET', `/api/mappings/${second.data.id}`)).status, 404);
  });

  await t.test('rotation and disable take effect immediately and survive database reopen', async () => {
    const oldToken = token;
    const generated = await adminPost('/admin/api/token');
    token = (await generated.text()).match(/id="api-token" value="([^"]+)"/)?.[1];
    assert.notEqual(token, oldToken);
    assert.equal((await api('GET', '/api/clients', undefined, oldToken)).status, 401);
    const settings = await (await getDb()).get('SELECT * FROM api_settings WHERE id = 1');
    assert.equal(settings.token_hash, crypto.createHash('sha256').update(token).digest('hex'));
    assert.ok(!JSON.stringify(settings).includes(token));
    await closeDb();
    assert.equal((await api('GET', '/api/clients')).status, 200);
    assert.equal((await adminPost('/admin/api/settings', { enabled: '0' })).status, 302);
    assert.equal((await api('GET', '/api/clients')).data.error, 'api_disabled');
    assert.equal((await api('DELETE', `/api/clients/${clientId}`)).status, 403);
    assert.ok(await clients.getClientById(clientId));
    await closeDb();
    assert.equal((await apiSettings.getApiSettings()).enabled, false);
    assert.equal((await adminPost('/admin/api/settings', { enabled: '1' })).status, 302);
    assert.equal((await api('GET', '/api/clients')).status, 200);
    const serializedEvents = JSON.stringify(events);
    assert.ok(!serializedEvents.includes(token));
    assert.ok(!serializedEvents.includes(oldToken));
    assert.ok(!serializedEvents.includes(originalClientSecret));
  });

  await t.test('deletion returns JSON errors for missing records and cascades client mappings', async () => {
    assert.equal((await api('DELETE', `/api/upstream-providers/${googleId}`)).status, 204);
    assert.deepEqual((await api('GET', `/api/clients/${clientId}`)).data.allowed_providers, ['google']);
    const renamed = await api('PATCH', `/api/clients/${clientId}`, { client_name: 'Renamed after upstream deletion' });
    assert.equal(renamed.status, 200);
    assert.deepEqual(renamed.data.allowed_providers, ['google']);
    assert.equal((await api('GET', `/api/mappings/${mappingId}`)).status, 200);
    assert.equal((await api('DELETE', `/api/upstream-providers/${googleId}`)).status, 404);
    assert.equal((await api('DELETE', `/api/clients/${clientId}`)).status, 204);
    assert.deepEqual((await api('GET', '/api/mappings')).data, []);
    assert.equal((await api('DELETE', `/api/clients/${clientId}`)).status, 404);
    assert.equal((await api('DELETE', `/api/mappings/${mappingId}`)).status, 404);
    assert.equal((await api('DELETE', `/api/upstream-providers/${githubId}`)).status, 204);
    const logout = await adminPost('/admin/logout');
    assert.equal(logout.status, 302);
    assert.equal((await api('GET', '/api/clients')).status, 200);
    const anonymous = await adminPage();
    assert.ok(!anonymous.html.includes('id="api-token"'));
  });
});
