import crypto from 'node:crypto';
import { ForbiddenError } from './errors.js';

export function secureCompare(left, right) {
  const leftDigest = crypto.createHash('sha256').update(String(left ?? '')).digest();
  const rightDigest = crypto.createHash('sha256').update(String(right ?? '')).digest();
  return crypto.timingSafeEqual(leftDigest, rightDigest);
}

export function ensureCsrfToken(session) {
  if (!session.csrfToken) session.csrfToken = crypto.randomBytes(24).toString('base64url');
  return session.csrfToken;
}

export function securityHeaders() {
  return async (ctx, next) => {
    ctx.set('X-Content-Type-Options', 'nosniff');
    ctx.set('X-Frame-Options', 'DENY');
    ctx.set('Referrer-Policy', 'no-referrer');
    ctx.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    await next();
  };
}

export function exposeCsrfToken() {
  return async (ctx, next) => {
    if (ctx.session) ctx.state.csrfToken = ensureCsrfToken(ctx.session);
    await next();
  };
}

export function csrfProtection() {
  return async (ctx, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(ctx.method)) {
      const received = ctx.get('x-csrf-token') || ctx.request.body?._csrf;
      const expected = ctx.session?.csrfToken;
      if (!received || !expected || !secureCompare(received, expected)) {
        throw new ForbiddenError('请求验证失败，请刷新页面后重试');
      }
    }
    await next();
  };
}

export class LoginRateLimiter {
  #attempts = new Map();

  constructor({ limit = 5, windowMs = 15 * 60 * 1000, now = Date.now } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
  }

  check(key) {
    const record = this.#attempts.get(key);
    if (!record || record.resetAt <= this.now()) return true;
    return record.count < this.limit;
  }

  fail(key) {
    const current = this.now();
    const record = this.#attempts.get(key);
    if (!record || record.resetAt <= current) {
      this.#attempts.set(key, { count: 1, resetAt: current + this.windowMs });
      return;
    }
    record.count += 1;
  }

  reset(key) {
    this.#attempts.delete(key);
  }
}
