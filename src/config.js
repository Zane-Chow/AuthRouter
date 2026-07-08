import 'dotenv/config';
import crypto from 'crypto';

// ─── Auto-generate session secret (no env var needed) ───────
const sessionSecret = crypto.randomBytes(32).toString('hex');

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
