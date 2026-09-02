import { ValidationError } from './errors.js';

const PROVIDER_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,49}$/;
const AUTH_METHODS = new Set(['client_secret_post', 'client_secret_basic', 'none']);
const PROVIDER_TYPES = new Set(['oidc', 'oauth2']);

export function requiredString(value, label, { maxLength = 2048, pattern } = {}) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ValidationError(`${label}不能为空`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new ValidationError(`${label}长度不能超过 ${maxLength}`);
  }
  if (pattern && !pattern.test(normalized)) {
    throw new ValidationError(`${label}格式无效`);
  }
  return normalized;
}

export function optionalString(value, { maxLength = 2048 } = {}) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = String(value).trim();
  if (normalized.length > maxLength) throw new ValidationError(`字段长度不能超过 ${maxLength}`);
  return normalized || null;
}

export function parseRedirectUris(value) {
  const uris = requiredString(value, '回调地址', { maxLength: 8192 })
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);

  if (uris.length === 0 || uris.length > 20) {
    throw new ValidationError('回调地址数量必须在 1 到 20 之间');
  }

  return [...new Set(uris.map((uri) => {
    let parsed;
    try {
      parsed = new URL(uri);
    } catch {
      throw new ValidationError(`回调地址无效: ${uri}`);
    }
    if (!parsed.protocol || parsed.hash) {
      throw new ValidationError(`回调地址必须是绝对地址且不能包含片段: ${uri}`);
    }
    return uri;
  }))];
}

export function parseClientInput(body) {
  const authMethod = body.token_auth_method || 'client_secret_post';
  if (!AUTH_METHODS.has(authMethod)) throw new ValidationError('客户端认证方式无效');
  return {
    clientName: requiredString(body.client_name, '名称', { maxLength: 255 }),
    redirectUris: parseRedirectUris(body.redirect_uris),
    tokenAuthMethod: authMethod,
    scope: requiredString(body.scope || 'openid email profile', 'Scope', { maxLength: 255 }),
    allowedProviderIds: parseProviderIds(body.allowed_providers),
  };
}

export function parseProviderIds(value) {
  if (value === undefined || value === null || value === '') return [];
  const values = Array.isArray(value) ? value : [value];
  if (values.length > 100) throw new ValidationError('上游权限数量不能超过 100');
  return [...new Set(values.map((providerId) => (
    requiredString(providerId, '上游权限', { maxLength: 50, pattern: PROVIDER_ID })
  )))];
}

function parseHttpUrl(value, label, required = false) {
  const normalized = required
    ? requiredString(value, label, { maxLength: 2048 })
    : optionalString(value, { maxLength: 2048 });
  if (!normalized) return null;
  let url;
  try {
    url = new URL(normalized);
  } catch {
    throw new ValidationError(`${label}必须是有效 URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new ValidationError(`${label}必须使用 HTTP 或 HTTPS`);
  return normalized;
}

export function parseProviderInput(body) {
  const type = requiredString(body.type, '类型', { maxLength: 20 });
  if (!PROVIDER_TYPES.has(type)) throw new ValidationError('上游类型只能是 oidc 或 oauth2');

  return {
    providerId: requiredString(body.provider_id, '标识', { maxLength: 50, pattern: PROVIDER_ID }),
    displayName: requiredString(body.display_name, '名称', { maxLength: 255 }),
    type,
    issuer: parseHttpUrl(body.issuer, 'Issuer', type === 'oidc'),
    authorizeUrl: parseHttpUrl(body.authorize_url, 'Authorize URL', type === 'oauth2'),
    tokenUrl: parseHttpUrl(body.token_url, 'Token URL', type === 'oauth2'),
    userinfoUrl: parseHttpUrl(body.userinfo_url, 'UserInfo URL', type === 'oauth2'),
    emailUrl: parseHttpUrl(body.email_url, 'Email URL'),
    clientId: requiredString(body.client_id, 'Client ID', { maxLength: 255 }),
    clientSecret: requiredString(body.client_secret, 'Client Secret', { maxLength: 4096 }),
    scope: type === 'oidc'
      ? requiredString(body.scope || 'openid email profile', 'Scope', { maxLength: 255 })
      : optionalString(body.scope, { maxLength: 255 }) || '',
    fieldId: requiredString(body.field_id || 'sub', 'ID 字段', { maxLength: 64 }),
    fieldEmail: requiredString(body.field_email || 'email', '邮箱字段', { maxLength: 64 }),
    fieldName: requiredString(body.field_name || 'name', '名称字段', { maxLength: 64 }),
    fieldAvatar: requiredString(body.field_avatar || 'picture', '头像字段', { maxLength: 64 }),
    icon: requiredString(body.icon || 'generic', '图标', { maxLength: 32 }),
  };
}

export function parseMappingInput(body) {
  return {
    clientId: requiredString(body.client_id, '客户端', { maxLength: 100 }),
    provider: requiredString(body.provider_type, '上游 IdP', { maxLength: 50, pattern: PROVIDER_ID }),
    providerIdentity: requiredString(body.provider_identity, '来源身份', { maxLength: 190 }).toLowerCase(),
    targetIdentity: requiredString(body.target_identity, '目标身份', { maxLength: 190 }).toLowerCase(),
    displayName: optionalString(body.display_name, { maxLength: 255 }),
  };
}

export function parseNumericId(value, label = 'ID') {
  if (!/^\d+$/.test(String(value))) throw new ValidationError(`${label}无效`);
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new ValidationError(`${label}无效`);
  return id;
}
