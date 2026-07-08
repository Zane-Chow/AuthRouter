import 'dotenv/config';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// ─── Session secret: persisted to disk (mirrors keys.js / crypto-util.js) ───
// A secret that changes on every restart invalidates every cookie signed
// with the old one the moment the process restarts (container restart,
// `npm run dev --watch`, OOM, image update, ...) — every logged-in admin
// session and in-flight OIDC interaction gets silently rejected as an
// invalid signature, which surfaces as an intermittent 403 on the very
// next click. Persisting it (like the JWKS and encryption keys already
// are) makes restarts a non-event for existing sessions.
const dataDir = process.env.DATA_DIR || '/app/data';
const SESSION_SECRET_PATH = path.join(dataDir, 'session.key');

function loadOrCreateSessionSecret() {
  if (process.env.SESSION_SECRET) {
    return process.env.SESSION_SECRET.trim();
  }

  if (fs.existsSync(SESSION_SECRET_PATH)) {
    return fs.readFileSync(SESSION_SECRET_PATH, 'utf-8').trim();
  }

  console.log('🔑 Generating new session-signing secret...');
  const secret = crypto.randomBytes(32).toString('hex');

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  fs.writeFileSync(SESSION_SECRET_PATH, secret, { mode: 0o600 });
  console.log(`✅ Session secret saved to ${SESSION_SECRET_PATH}`);

  return secret;
}

const sessionSecret = loadOrCreateSessionSecret();

// ─── Auto-generate admin password if not provided ───────────
const adminPassword = process.env.ADMIN_PASSWORD || crypto.randomBytes(16).toString('base64url');
const adminPasswordGenerated = !process.env.ADMIN_PASSWORD;

const config = {
  sso: {
    baseUrl: process.env.SSO_BASE_URL || '',
    port: parseInt(process.env.SSO_PORT || '3000', 10),
  },

  db: {
    // 'sqlite' (default) or 'mysql' — chosen at deploy time, not switchable at runtime.
    driver: (process.env.DB_DRIVER || 'sqlite').toLowerCase(),
    mysql: {
      host: process.env.MYSQL_HOST || 'localhost',
      port: parseInt(process.env.MYSQL_PORT || '3306', 10),
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD,
      database: process.env.MYSQL_DATABASE,
    },
  },

  admin: {
    username: process.env.ADMIN_USERNAME || 'admin',
    password: adminPassword,
    passwordGenerated: adminPasswordGenerated,
  },

  session: {
    secret: sessionSecret,
  },

  dataDir: process.env.DATA_DIR || '/app/data',
};

if (config.db.driver === 'mysql' && (!config.db.mysql.user || !config.db.mysql.database)) {
  console.error('\n❌ DB_DRIVER=mysql requires MYSQL_USER and MYSQL_DATABASE to be set.\n');
  process.exit(1);
}

// Upstream Identity Providers are configured entirely through the /admin
// panel and stored in the database — there is no env-var-based provider
// config or startup requirement here. If zero providers are enabled,
// the admin panel surfaces that instead of refusing to start.

export default config;
