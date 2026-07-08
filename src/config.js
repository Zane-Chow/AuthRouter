import 'dotenv/config';

const config = {
  sso: {
    baseUrl: process.env.SSO_BASE_URL || 'https://sso.zhouhaoze.com',
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
    password: process.env.ADMIN_PASSWORD || 'changeme',
  },

  session: {
    secret: process.env.SESSION_SECRET || 'change-me-to-a-random-string',
  },

  dataDir: process.env.DATA_DIR || './data',
};

if (config.db.driver === 'mysql' && (!config.db.mysql.user || !config.db.mysql.database)) {
  console.error('\n❌ DB_DRIVER=mysql requires MYSQL_USER and MYSQL_DATABASE to be set.\n');
  process.exit(1);
}

if (config.session.secret === 'change-me-to-a-random-string') {
  console.warn('⚠️  WARNING: Using default SESSION_SECRET. Please set a secure random value in .env\n');
}

// Upstream Identity Providers are configured entirely through the /admin
// panel and stored in the database — there is no env-var-based provider
// config or startup requirement here. If zero providers are enabled,
// the admin panel surfaces that instead of refusing to start.

export default config;
