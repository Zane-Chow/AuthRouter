import { AuthenticationError, ForbiddenError, ValidationError } from './errors.js';

export function isApiPath(path) {
  return path === '/api' || path.startsWith('/api/');
}

export function apiAuthentication(apiSettings) {
  return async (ctx, next) => {
    if (!isApiPath(ctx.path)) return next();
    ctx.set('Cache-Control', 'no-store');
    const match = /^Bearer (\S+)$/i.exec(ctx.get('authorization'));
    const result = await apiSettings.authenticateApiToken(match?.[1]);
    if (result === 'disabled') {
      throw new ForbiddenError('管理 API 未开启', { code: 'api_disabled' });
    }
    if (result !== 'valid') {
      ctx.set('WWW-Authenticate', 'Bearer realm="AuthRouter API"');
      throw new AuthenticationError('API Token 缺失或无效');
    }
    if (['POST', 'PUT', 'PATCH'].includes(ctx.method) && !ctx.is('application/json')) {
      throw new ValidationError('请求体必须使用 application/json', { status: 415, code: 'unsupported_media_type' });
    }
    await next();
  };
}
