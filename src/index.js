import { startServer } from './server.js';
import { logger } from './logger.js';

const runtime = await startServer();

async function shutdown(signal) {
  logger.info('shutdown requested', { signal });
  try {
    await runtime.close();
    process.exitCode = 0;
  } catch (error) {
    logger.error('shutdown failed', { signal, error: error.message });
    process.exitCode = 1;
  }
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
