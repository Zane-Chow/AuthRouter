import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'authrouter-app-test-'));
process.env.SSO_PORT = '3199';
process.env.NODE_ENV = 'development';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'integration-password';

const { createApplication } = await import('../src/app.js');

function mergeCookies(response, previous = '') {
  const cookies = new Map(previous.split('; ').filter(Boolean).map((part) => part.split(/=(.*)/s).slice(0, 2)));
  for (const header of response.headers.getSetCookie()) {
    const [name, value] = header.split(';', 1)[0].split(/=(.*)/s).slice(0, 2);
    cookies.set(name, value);
  }
  return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
}

test('application serves OIDC discovery and protects the admin session', async (t) => {
  const silentLogger = { info() {}, warn() {}, error() {} };
  const application = await createApplication({ logger: silentLogger });
  const server = application.app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await application.close();
  });

  const { port } = server.address();
  const baseUrl = `http://localhost:${port}`;
  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, 'ok');

  const discovery = await fetch(`${baseUrl}/.well-known/openid-configuration`);
  assert.equal(discovery.status, 200);
  assert.equal((await discovery.json()).issuer, 'http://localhost:3199');

  const adminPage = await fetch(`${baseUrl}/admin`);
  const html = await adminPage.text();
  const csrf = html.match(/name="_csrf" value="([^"]+)"/)?.[1];
  assert.ok(csrf);
  let cookies = mergeCookies(adminPage);

  const missingCsrf = await fetch(`${baseUrl}/admin/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: cookies, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'admin', password: 'integration-password' }),
  });
  assert.equal(missingCsrf.status, 403);

  const login = await fetch(`${baseUrl}/admin/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: cookies, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ _csrf: csrf, username: 'admin', password: 'integration-password' }),
  });
  assert.equal(login.status, 302);
  assert.equal(login.headers.get('location'), '/admin');
  cookies = mergeCookies(login, cookies);

  const authenticatedAdminPage = await fetch(`${baseUrl}/admin`, { headers: { cookie: cookies } });
  assert.equal(authenticatedAdminPage.status, 200);
  assert.match(await authenticatedAdminPage.text(), /允许使用的上游 IdP/);

  const clients = await fetch(`${baseUrl}/api/clients`, { headers: { cookie: cookies } });
  assert.equal(clients.status, 200);
  assert.deepEqual(await clients.json(), []);
});
