import { Queue, Worker } from 'bullmq';
import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { connectDatabase } from '../config/database.js';
import { processReminders } from '../modules/reminder.service.js';
import { expireCredit } from '../modules/wallet.service.js';
import { WalletTransaction } from '../models/index.js';
import { transaction, logger, assert } from '../utils/core.js';
await connectDatabase();
assert(env.REDIS_URL, 500, 'REDIS_URL is required for the worker');
const redis = new URL(env.REDIS_URL);
const connection = {
  host: redis.hostname,
  port: Number(redis.port || 6379),
  username: redis.username || undefined,
  password: redis.password || undefined,
  db: Number(redis.pathname.slice(1) || 0),
  ...(redis.protocol === 'rediss:' ? { tls: {} } : {}),
};
const queue = new Queue('salon-maintenance', { connection });
await queue.upsertJobScheduler(
  'minute',
  { every: 60000 },
  { name: 'maintenance', opts: { removeOnComplete: 100, removeOnFail: 100 } },
);
const worker = new Worker(
  'salon-maintenance',
  async () => {
    await processReminders();
    const lots = await WalletTransaction.find({
      expiresAt: { $lte: new Date() },
      $or: [{ remainingPaid: { $gt: 0 } }, { remainingBonus: { $gt: 0 } }],
    }).limit(100);
    for (const lot of lots)
      await transaction(async (session) => {
        const { Customer } = await import('../models/index.js');
        await Customer.updateOne(
          { _id: lot.customer },
          { $inc: { bookingVersion: 1 } },
          { session },
        );
        await expireCredit(lot.salon, lot.customer, session);
      });
  },
  { connection, concurrency: 1 },
);
worker.on('failed', (_job, err) => logger.error({ name: err.name }, 'Maintenance job failed'));
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    await worker.close();
    await queue.close();
    await mongoose.disconnect();
    process.exit(0);
  });
logger.info('Maintenance worker started');
