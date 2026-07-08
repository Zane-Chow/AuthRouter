import 'dotenv/config';

const config = {
  sso: {
    baseUrl: process.env.SSO_BASE_URL || 'https://sso.zhouhaoze.com',
    port: parseInt(process.env.SSO_PORT || '3000', 10),
  },

  // Upstream Identity Providers
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    issuer: 'https://accounts.google.com',
  },

  github: {
    clientId: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
    authorizeUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userApiUrl: 'https://api.github.com/user',
    userEmailsApiUrl: 'https://api.github.com/user/emails',
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

// Validate: at least one upstream IdP must be configured
const hasGoogle = config.google.clientId && config.google.clientSecret;
const hasGithub = config.github.clientId && config.github.clientSecret;

if (!hasGoogle && !hasGithub) {
  console.error('\n❌ No upstream Identity Provider configured.');
  console.error('   Please configure at least one of:');
  console.error('   - GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET');
  console.error('   - GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET\n');
  console.error('   Copy .env.example to .env and fill in the values.\n');
  process.exit(1);
}

if (config.session.secret === 'change-me-to-a-random-string') {
  console.warn('⚠️  WARNING: Using default SESSION_SECRET. Please set a secure random value in .env\n');
}

// Export which providers are available
config.enabledProviders = [];
if (hasGoogle) config.enabledProviders.push('google');
if (hasGithub) config.enabledProviders.push('github');

export default config;
