import test from 'node:test';
import assert from 'node:assert/strict';
import { LoginRateLimiter, ensureCsrfToken, secureCompare } from '../src/security.js';

test('constant-time credential comparison handles different lengths', () => {
  assert.equal(secureCompare('secret', 'secret'), true);
  assert.equal(secureCompare('secret', 'different-length-secret'), false);
  assert.equal(secureCompare(undefined, ''), true);
});

test('CSRF tokens are stable within one session', () => {
  const session = {};
  const first = ensureCsrfToken(session);
  assert.equal(first, ensureCsrfToken(session));
  assert.ok(first.length >= 32);
});

test('login limiter resets after its window', () => {
  let now = 0;
  const limiter = new LoginRateLimiter({ limit: 2, windowMs: 1000, now: () => now });
  assert.equal(limiter.check('ip'), true);
  limiter.fail('ip');
  limiter.fail('ip');
  assert.equal(limiter.check('ip'), false);
  now = 1001;
  assert.equal(limiter.check('ip'), true);
});
