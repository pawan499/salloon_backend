import mongoose from 'mongoose';
import { app } from './app.js';
import { connectDatabase } from './config/database.js';
import { env } from './config/env.js';
import { logger } from './utils/core.js';
try {
  await connectDatabase();
  const server = app.listen(env.PORT, () => logger.info({ port: env.PORT }, 'Salon API started'));
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    logger.info('Shutting down');
    const timeout = setTimeout(() => process.exit(1), 15000);
    timeout.unref();
    server.close(() => {
      void mongoose.disconnect().then(() => process.exit(0));
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
} catch (err) {
  logger.fatal(
    { name: err instanceof Error ? err.name : 'Error' },
    'Startup failed; check database replica set and environment configuration',
  );
  process.exit(1);
}
