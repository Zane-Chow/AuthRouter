import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function parsePort(value, name) {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return port;
}

function normalizeBaseUrl(value) {
  if (!value) return '';
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('SSO_BASE_URL must use http or https');
  }
  url.pathname = url.pathname.replace(/\/$/, '');
  return url.toString().replace(/\/$/, '');
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function loadOrCreateTextSecret({ envValue, filePath, bytes, label }) {
  if (envValue?.trim()) return { value: envValue.trim(), created: false };

  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf8').trim();
    if (existing) return { value: existing, created: false };
  }

  ensureDirectory(path.dirname(filePath));
  const secret = crypto.randomBytes(bytes).toString('base64url');
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, secret, { mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
  console.info(`${label} created at ${filePath}`);
  return { value: secret, created: true };
}

export function createConfig(env = process.env) {
  const dataDir = path.resolve(env.DATA_DIR || 'data');
  const driver = (env.DB_DRIVER || 'sqlite').toLowerCase();
  if (!['sqlite', 'mysql'].includes(driver)) {
    throw new Error('DB_DRIVER must be either sqlite or mysql');
  }

  const sessionSecret = loadOrCreateTextSecret({
    envValue: env.SESSION_SECRET,
    filePath: path.join(dataDir, 'session.key'),
    bytes: 32,
    label: 'Session signing secret',
  });
  const adminPassword = loadOrCreateTextSecret({
    envValue: env.ADMIN_PASSWORD,
    filePath: path.join(dataDir, 'admin.password'),
    bytes: 16,
    label: 'Admin password',
  });

  const config = {
    env: env.NODE_ENV || 'development',
    sso: {
      baseUrl: normalizeBaseUrl(env.SSO_BASE_URL || ''),
      port: parsePort(env.SSO_PORT || '3000', 'SSO_PORT'),
    },
    db: {
      driver,
      mysql: {
        host: env.MYSQL_HOST || 'localhost',
        port: parsePort(env.MYSQL_PORT || '3306', 'MYSQL_PORT'),
        user: env.MYSQL_USER,
        password: env.MYSQL_PASSWORD,
        database: env.MYSQL_DATABASE,
      },
    },
    admin: {
      username: env.ADMIN_USERNAME || 'admin',
      password: adminPassword.value,
      passwordGenerated: adminPassword.created,
    },
    session: {
      secret: sessionSecret.value,
      maxAgeMs: 2 * 60 * 60 * 1000,
    },
    upstream: {
      timeoutMs: Number.parseInt(env.UPSTREAM_TIMEOUT_MS || '10000', 10),
    },
    dataDir,
  };

  config.sso.publicBaseUrl = config.sso.baseUrl || `http://localhost:${config.sso.port}`;

  if (!Number.isInteger(config.upstream.timeoutMs) || config.upstream.timeoutMs < 1000) {
    throw new Error('UPSTREAM_TIMEOUT_MS must be an integer of at least 1000');
  }
  if (driver === 'mysql' && (!config.db.mysql.user || !config.db.mysql.database)) {
    throw new Error('DB_DRIVER=mysql requires MYSQL_USER and MYSQL_DATABASE');
  }
  if (config.env === 'production' && config.sso.baseUrl && !config.sso.baseUrl.startsWith('https://')) {
    throw new Error('SSO_BASE_URL must use https in production');
  }

  return Object.freeze(config);
}

const config = createConfig();

export default config;
