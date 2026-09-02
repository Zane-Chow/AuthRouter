import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClientInput, parseMappingInput, parseProviderIds, parseProviderInput, parseRedirectUris } from '../src/validation.js';

test('redirect URI parsing normalizes, deduplicates, and accepts custom schemes', () => {
  assert.deepEqual(parseRedirectUris('https://app.example/callback, https://app.example/callback\ncom.example.app:/oauth'), [
    'https://app.example/callback',
    'com.example.app:/oauth',
  ]);
  assert.throws(() => parseRedirectUris('https://app.example/callback#fragment'), /不能包含片段/);
});

test('client input keeps supported downstream authentication methods', () => {
  assert.deepEqual(parseClientInput({
    client_name: ' Wiki ',
    redirect_uris: 'https://wiki.example/oidc/callback',
    token_auth_method: 'client_secret_basic',
    scope: 'openid email profile',
  }), {
    clientName: 'Wiki',
    redirectUris: ['https://wiki.example/oidc/callback'],
    tokenAuthMethod: 'client_secret_basic',
    scope: 'openid email profile',
    allowedProviderIds: [],
  });
});

test('client upstream permissions accept form scalars and arrays', () => {
  assert.deepEqual(parseProviderIds(undefined), []);
  assert.deepEqual(parseProviderIds('google'), ['google']);
  assert.deepEqual(parseProviderIds(['google', 'github', 'google']), ['google', 'github']);
  assert.throws(() => parseProviderIds('../invalid'), /格式无效/);
});

test('provider input enforces URL-safe IDs and type-specific endpoints', () => {
  const oidc = parseProviderInput({
    provider_id: 'company-sso',
    display_name: 'Company SSO',
    type: 'oidc',
    issuer: 'https://id.example/realms/main/',
    client_id: 'client',
    client_secret: 'secret',
  });
  assert.equal(oidc.issuer, 'https://id.example/realms/main/');
  assert.throws(() => parseProviderInput({
    provider_id: '../bad',
    display_name: 'Bad',
    type: 'oidc',
    issuer: 'https://id.example',
    client_id: 'client',
    client_secret: 'secret',
  }), /格式无效/);
});

test('mapping input normalizes identities without changing provider ID', () => {
  assert.deepEqual(parseMappingInput({
    client_id: 'client-a',
    provider_type: 'GitHub',
    provider_identity: 'User@Example.COM ',
    target_identity: 'Admin@Example.COM',
    display_name: ' Admin ',
  }), {
    clientId: 'client-a',
    provider: 'GitHub',
    providerIdentity: 'user@example.com',
    targetIdentity: 'admin@example.com',
    displayName: 'Admin',
  });
});
