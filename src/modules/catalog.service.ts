import bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';
import { Customer, Salon, SalonSettings, Service, Staff, User, Reminder } from '../models/index.js';
import { assert, transaction } from '../utils/core.js';
import { audit, type Actor } from '../services/access.js';
export const referralCode = () => randomBytes(8).toString('hex');
export async function joinSalon(actor: Actor, salonId: string) {
  return transaction(async (session) => {
    const salon = await Salon.findOne({ _id: salonId, active: true }).session(session);
    assert(salon, 404, 'Salon not found');
    assert(
      !actor.salon || actor.salon === salonId,
      409,
      'Account already belongs to a different salon',
    );
    const user = await User.findById(actor.id).session(session);
    assert(user, 404, 'User not found');
    const existing = await Customer.findOne({ salon: salonId, user: actor.id }).session(session);
    if (existing) return existing;
    user.salon = salon._id;
    await user.save({ session });
    const [customer] = await Customer.create(
      [
        {
          salon: salonId,
          user: actor.id,
          name: user.name,
          email: user.email,
          phone: user.phone,
          referralCode: referralCode(),
        },
      ],
      { session },
    );
    return customer;
  });
}
export async function createStaff(actor: Actor, input: any) {
  const passwordHash = await bcrypt.hash(input.password, 12);
  return transaction(async (session) => {
    const count = await Service.countDocuments({
      _id: { $in: input.services },
      salon: actor.salon,
    }).session(session);
    assert(count === new Set(input.services).size, 400, 'Invalid service assignments');
    const [user] = await User.create(
      [
        {
          name: input.name,
          email: input.email,
          phone: input.phone,
          passwordHash,
          role: 'staff',
          salon: actor.salon,
        },
      ],
      { session },
    );
    const [staff] = await Staff.create(
      [
        {
          salon: actor.salon,
          user: user._id,
          name: input.name,
          skills: input.skills,
          services: input.services,
          hours: input.hours,
          timeOff: input.timeOff,
        },
      ],
      { session },
    );
    await audit(actor, 'staff.create', 'Staff', staff.id, session);
    return staff;
  });
}
export async function updateCustomer(actor: Actor, customer: any, input: any) {
  return transaction(async (session) => {
    Object.assign(customer, input);
    await customer.save({ session });
    if (input.consent === false)
      await Reminder.updateMany(
        {
          salon: actor.salon,
          customer: customer._id,
          status: { $in: ['scheduled', 'blocked', 'failed', 'processing'] },
        },
        { $set: { status: 'cancelled' } },
        { session },
      );
    await audit(actor, 'customer.update', 'Customer', customer.id, session);
    return customer;
  });
}
