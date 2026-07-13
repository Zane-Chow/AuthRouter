import config from './config.js';
import { createApplication } from './app.js';
import { getEnabledProviders } from './upstream-providers.js';
import { logger } from './logger.js';

function listen(app, port) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => resolve(server));
    server.once('error', reject);
  });
}

export async function startServer() {
  const application = await createApplication();
  const server = await listen(application.app, config.sso.port);
  const issuer = config.sso.publicBaseUrl;
  const providers = await getEnabledProviders();

  logger.info('AuthRouter started', {
    port: config.sso.port,
    issuer,
    database: config.db.driver,
    providers: providers.map((item) => item.id),
    adminUrl: `${issuer}/admin`,
  });
  if (config.admin.passwordGenerated) {
    logger.warn('admin password generated and persisted', {
      username: config.admin.username,
      password: config.admin.password,
      path: `${config.dataDir}/admin.password`,
      instruction: 'Set ADMIN_PASSWORD to manage this credential explicitly',
    });
  }

  let closing = false;
  return {
    server,
    async close() {
      if (closing) return;
      closing = true;
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await application.close();
      logger.info('AuthRouter stopped');
    },
  };
}
