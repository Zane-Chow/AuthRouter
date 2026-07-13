import config from './config.js';
import { UpstreamError, ValidationError } from './errors.js';

function callbackUrl(row) {
  return `${config.sso.publicBaseUrl}/sso/${encodeURIComponent(row.provider_id)}/callback`;
}

function withTimeout() {
  return AbortSignal.timeout(config.upstream.timeoutMs);
}

async function parseResponse(response) {
  const body = await response.text();
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(body);
    } catch {
      throw new UpstreamError('上游返回了无效的 JSON 响应');
    }
  }
  return Object.fromEntries(new URLSearchParams(body));
}

export function getAuthUrl(row, state) {
  const url = new URL(row.authorize_url);
  url.searchParams.set('client_id', row.client_id);
  url.searchParams.set('redirect_uri', callbackUrl(row));
  url.searchParams.set('scope', row.scope || '');
  url.searchParams.set('state', state);
  return url.toString();
}

async function exchangeCodeForToken(row, code) {
  const body = new URLSearchParams({
    client_id: row.client_id,
    client_secret: row.client_secret,
    code,
    redirect_uri: callbackUrl(row),
    grant_type: 'authorization_code',
  });
  let response;
  try {
    response = await fetch(row.token_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
      signal: withTimeout(),
    });
  } catch (error) {
    throw new UpstreamError(`${row.provider_id} token endpoint 请求失败`, { cause: error });
  }

  const data = await parseResponse(response);
  if (!response.ok || data.error) {
    throw new UpstreamError(`${row.provider_id} token exchange failed: ${data.error_description || data.error || response.status}`);
  }
  if (!data.access_token) throw new UpstreamError(`${row.provider_id} 未返回 access_token`);
  return data.access_token;
}

async function fetchUserProfile(row, accessToken) {
  let response;
  try {
    response = await fetch(row.userinfo_url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'User-Agent': 'AuthRouter' },
      signal: withTimeout(),
    });
  } catch (error) {
    throw new UpstreamError(`${row.provider_id} userinfo 请求失败`, { cause: error });
  }
  if (!response.ok) throw new UpstreamError(`${row.provider_id} userinfo API error: ${response.status} ${response.statusText}`);
  return parseResponse(response);
}

async function fetchFallbackEmail(row, accessToken) {
  if (!row.email_url) return null;
  let response;
  try {
    response = await fetch(row.email_url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'User-Agent': 'AuthRouter' },
      signal: withTimeout(),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const emails = await parseResponse(response);
  if (!Array.isArray(emails)) return null;
  const primary = emails.find((email) => email.primary && email.verified);
  const verified = emails.find((email) => email.verified);
  return (primary || verified)?.email || null;
}

export async function handleCallback(row, code, expectedState, receivedState) {
  if (!receivedState || receivedState !== expectedState) {
    throw new ValidationError('State parameter mismatch — possible CSRF attack');
  }
  const accessToken = await exchangeCodeForToken(row, code);
  const profile = await fetchUserProfile(row, accessToken);
  const rawId = profile[row.field_id];
  if (rawId === undefined || rawId === null || String(rawId).trim() === '') {
    throw new UpstreamError(`${row.provider_id} 未返回配置的身份字段 ${row.field_id}`);
  }
  const id = String(rawId);
  const email = profile[row.field_email] || await fetchFallbackEmail(row, accessToken);
  return {
    provider: row.provider_id,
    id,
    email: email ? String(email).trim().toLowerCase() : `${id}@${row.provider_id}`,
    name: profile[row.field_name] ? String(profile[row.field_name]) : id,
    avatar: profile[row.field_avatar] ? String(profile[row.field_avatar]) : '',
  };
}
