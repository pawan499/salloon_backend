import bcrypt from 'bcrypt';
import mongoose from 'mongoose';
import { z } from 'zod';
import { connectDatabase } from './config/database.js';
import { Salon, SalonSettings, Service, Staff, User } from './models/index.js';
import { transaction } from './utils/core.js';
import { email, password } from './validators/index.js';
const config = z
  .object({ SEED_OWNER_EMAIL: email, SEED_OWNER_PASSWORD: password })
  .parse(process.env);
await connectDatabase();
try {
  const passwordHash = await bcrypt.hash(config.SEED_OWNER_PASSWORD, 12);
  await transaction(async (session) => {
    if (await User.exists({ email: config.SEED_OWNER_EMAIL }).session(session)) {
      console.log('Owner exists; no changes made');
      return;
    }
    const [owner] = await User.create(
      [{ name: 'Salon Owner', email: config.SEED_OWNER_EMAIL, passwordHash, role: 'owner' }],
      { session },
    );
    const hours = Array.from({ length: 7 }, (_, i) => ({
      day: i + 1,
      open: '09:00',
      close: '20:00',
      closed: false,
    }));
    const [salon] = await Salon.create(
      [
        {
          name: 'My Salon',
          address: 'Update salon address',
          owner: owner._id,
          hours,
          timezone: 'Asia/Kolkata',
          currency: 'INR',
        },
      ],
      { session },
    );
    owner.salon = salon._id;
    await owner.save({ session });
    await SalonSettings.create(
      [
        {
          salon: salon._id,
          topupBonusPercent: 5,
          referralReward: 5000,
          referralMinimumBill: 20000,
        },
      ],
      { session },
    );
    await Service.create(
      [
        {
          salon: salon._id,
          category: 'Hair',
          name: 'Haircut',
          price: 30000,
          duration: 30,
          reminderDays: 30,
          addons: [{ name: 'Hair wash', price: 10000, duration: 10 }],
        },
      ],
      { session },
    );
    console.log(
      `Salon initialized: ${salon.id}. Sign in as owner, then create staff through POST /api/v1/staff.`,
    );
  });
} finally {
  await mongoose.disconnect();
}
