import crypto from 'node:crypto';
import { render } from './render.js';
import { isApiPath } from './api-auth.js';

function wantsJson(ctx) {
  return isApiPath(ctx.path) || ctx.accepts('json', 'html') === 'json';
}

export function requestContext(logger) {
  return async (ctx, next) => {
    const requestId = ctx.get('x-request-id') || crypto.randomUUID();
    const startedAt = Date.now();
    ctx.state.requestId = requestId;
    ctx.set('X-Request-Id', requestId);
    try {
      await next();
    } finally {
      logger.info('request completed', {
        requestId,
        method: ctx.method,
        path: ctx.path,
        status: ctx.status,
        durationMs: Date.now() - startedAt,
      });
    }
  };
}

export function errorHandler({ config, logger }) {
  return async (ctx, next) => {
    try {
      await next();
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 500;
      const publicMessage = error.expose ? error.message : '服务器内部错误';
      logger.error('request failed', {
        requestId: ctx.state.requestId,
        method: ctx.method,
        path: ctx.path,
        status,
        code: error.code || 'internal_error',
        error: error.message,
        stack: config.env === 'production' ? undefined : error.stack,
      });

      if (ctx.headerSent) return;
      ctx.status = status;
      if (wantsJson(ctx)) {
        ctx.body = {
          error: error.code || 'internal_error',
          message: publicMessage,
          requestId: ctx.state.requestId,
        };
        return;
      }

      await render(ctx, 'error', {
        message: publicMessage,
        hint: config.env === 'production' ? undefined : error.message,
      });
    }
  };
}

export function notFound() {
  return async (ctx) => {
    ctx.status = 404;
    if (wantsJson(ctx)) {
      ctx.body = { error: 'not_found', message: 'Not found', requestId: ctx.state.requestId };
      return;
    }
    await render(ctx, 'error', { message: '页面不存在' });
  };
}
