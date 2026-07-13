import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'authrouter-test-'));
process.env.SSO_PORT = '3456';

const { getAuthUrl, handleCallback } = await import('../src/oauth2-auth.js');

const provider = {
  provider_id: 'github',
  authorize_url: 'https://github.example/authorize?audience=internal',
  token_url: 'https://github.example/token',
  userinfo_url: 'https://github.example/user',
  email_url: null,
  client_id: 'client',
  client_secret: 'secret',
  scope: 'read:user user:email',
  field_id: 'id',
  field_email: 'email',
  field_name: 'name',
  field_avatar: 'avatar_url',
};

test('authorization URL preserves provider query parameters and uses an absolute callback', () => {
  const url = new URL(getAuthUrl(provider, 'state-value'));
  assert.equal(url.searchParams.get('audience'), 'internal');
  assert.equal(url.searchParams.get('state'), 'state-value');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:3456/sso/github/callback');
});

test('OAuth2 callback accepts JSON token responses and form-encoded requests', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) {
      return new Response(JSON.stringify({ access_token: 'access-token' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ id: 42, email: 'USER@EXAMPLE.COM', name: 'User' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const profile = await handleCallback(provider, 'code', 'expected', 'expected');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.match(calls[0].options.body.toString(), /grant_type=authorization_code/);
  assert.deepEqual(profile, {
    provider: 'github',
    id: '42',
    email: 'user@example.com',
    name: 'User',
    avatar: '',
  });
});

test('OAuth2 callback rejects mismatched state before making network requests', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let called = false;
  globalThis.fetch = async () => { called = true; };
  await assert.rejects(() => handleCallback(provider, 'code', 'expected', 'wrong'), /State parameter mismatch/);
  assert.equal(called, false);
});
