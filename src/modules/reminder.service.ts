import { Customer, Reminder } from '../models/index.js';
import { messagingProvider } from '../services/providers.js';
export async function processReminders() {
  // Recovery after worker death. Provider adapter must deduplicate by reminder ID.
  await Reminder.updateMany(
    { status: 'processing', lockedAt: { $lt: new Date(Date.now() - 5 * 60000) } },
    { $set: { status: 'scheduled' } },
  );
  for (let i = 0; i < 100; i++) {
    const reminder = await Reminder.findOneAndUpdate(
      {
        status: { $in: ['scheduled', 'failed', 'blocked'] },
        dueAt: { $lte: new Date() },
        attempts: { $lt: 5 },
      },
      { $set: { status: 'processing', lockedAt: new Date() }, $inc: { attempts: 1 } },
      { new: true, sort: { dueAt: 1 } },
    );
    if (!reminder) break;
    const customer = await Customer.findOne({ _id: reminder.customer, salon: reminder.salon });
    if (!customer?.consent || !customer.phone) {
      await Reminder.updateOne(
        { _id: reminder._id, status: 'processing' },
        { $set: { status: 'cancelled', error: 'Consent or phone unavailable' } },
      );
      continue;
    }
    if (!messagingProvider.configured) {
      await Reminder.updateOne(
        { _id: reminder._id, status: 'processing' },
        {
          $set: { status: 'blocked', error: 'Messaging provider not configured' },
          $inc: { attempts: -1 },
        },
      );
      break;
    }
    // Check once more immediately before dispatch to respect booking/opt-out cancellation.
    if (!(await Reminder.exists({ _id: reminder._id, status: 'processing' }))) continue;
    try {
      const result = await messagingProvider.send(
        customer.phone,
        customer.channel!,
        `Hello ${customer.name}, your next salon visit is due. Book when convenient.`,
        `reminder:${reminder.id}`,
      );
      await Reminder.updateOne(
        { _id: reminder._id, status: 'processing' },
        {
          $set: {
            status: result.status === 'delivered' ? 'delivered' : 'sent',
            providerId: result.id,
          },
          $unset: { error: 1 },
        },
      );
    } catch {
      await Reminder.updateOne(
        { _id: reminder._id, status: 'processing' },
        {
          $set: {
            status: 'failed',
            error: 'Provider delivery attempt failed',
            dueAt: new Date(Date.now() + 15 * 60000),
          },
        },
      );
    }
  }
}
