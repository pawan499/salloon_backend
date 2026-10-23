import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { DateTime } from 'luxon';
import { app } from '../src/app.js';
import {
  models,
  User,
  Salon,
  SalonSettings,
  Customer,
  Service,
  Staff,
  Booking,
  Payment,
  WalletTransaction,
  Referral,
  Visit,
  Reminder,
} from '../src/models/index.js';
import { createBooking, changeBookingStatus } from '../src/modules/booking.service.js';
import {
  adjustWallet,
  recordPayment,
  refundPayment,
  walletBalance,
  claimReferral,
  reverseTopup,
} from '../src/modules/wallet.service.js';
import { register, login, refresh } from '../src/modules/auth.service.js';
import { processReminders } from '../src/modules/reminder.service.js';
import { paymentProvider } from '../src/services/providers.js';
import { hash } from '../src/utils/core.js';
let repl: MongoMemoryReplSet;
let owner: any,
  customerActor: any,
  otherActor: any,
  salon: any,
  customer: any,
  other: any,
  staff: any,
  service: any,
  start: string;
beforeAll(async () => {
  repl = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    ...(process.env.MONGOMS_SYSTEM_BINARY
      ? { binary: { systemBinary: process.env.MONGOMS_SYSTEM_BINARY } }
      : {}),
  });
  await mongoose.connect(repl.getUri());
  for (const m of Object.values(models)) await m.createIndexes();
});
afterAll(async () => {
  await mongoose.disconnect();
  await repl?.stop();
});
beforeEach(async () => {
  vi.restoreAllMocks();
  for (const m of Object.values(models)) await m.deleteMany({});
  const u = await User.create({
    name: 'Owner',
    email: 'owner@example.com',
    passwordHash: 'unused',
    role: 'owner',
  });
  const hours = Array.from({ length: 7 }, (_, i) => ({
    day: i + 1,
    open: '00:00',
    close: '23:59',
    closed: false,
  }));
  salon = await Salon.create({
    name: 'Salon',
    address: 'Address',
    owner: u._id,
    hours,
    timezone: 'Asia/Kolkata',
  });
  u.salon = salon._id;
  await u.save();
  await SalonSettings.create({
    salon: salon._id,
    topupBonusPercent: 10,
    referralReward: 1000,
    referralMinimumBill: 1000,
    cancellationHours: 0,
  });
  const c = await User.create({
    name: 'Customer',
    email: 'customer@example.com',
    passwordHash: 'unused',
    salon: salon._id,
  });
  const o = await User.create({
    name: 'Other',
    email: 'other@example.com',
    passwordHash: 'unused',
    salon: salon._id,
  });
  customer = await Customer.create({
    salon: salon._id,
    user: c._id,
    name: 'Customer',
    phone: '+919999999999',
    consent: true,
    referralCode: '1111111111111111',
  });
  other = await Customer.create({
    salon: salon._id,
    user: o._id,
    name: 'Other',
    referralCode: '2222222222222222',
  });
  service = await Service.create({
    salon: salon._id,
    name: 'Haircut',
    category: 'Hair',
    price: 3000,
    duration: 30,
  });
  const su = await User.create({
    name: 'Staff',
    email: 'staff@example.com',
    passwordHash: 'unused',
    role: 'staff',
    salon: salon._id,
  });
  staff = await Staff.create({
    salon: salon._id,
    user: su._id,
    name: 'Staff',
    services: [service._id],
    hours,
  });
  owner = { id: u.id, role: 'owner', salon: salon.id, sessionId: '' };
  customerActor = { id: c.id, role: 'customer', salon: salon.id, sessionId: '' };
  otherActor = { id: o.id, role: 'customer', salon: salon.id, sessionId: '' };
  start = DateTime.now()
    .setZone('Asia/Kolkata')
    .plus({ days: 1 })
    .set({ hour: 10, minute: 0, second: 0, millisecond: 0 })
    .toISO()!;
});
const book = (actor = customerActor, cid?: string) =>
  createBooking(actor, {
    staffId: staff.id,
    customerId: cid,
    items: [{ serviceId: service.id, addonIds: [] }],
    start,
    source: 'online',
  });
describe('authentication and isolation', () => {
  it('registers only customers, hashes passwords, rotates and revokes tokens', async () => {
    const injection = await request(app).post('/api/v1/auth/register').send({
      name: 'New',
      email: 'new@example.com',
      password: 'StrongPassword123',
      role: 'owner',
    });
    expect(injection.status).toBe(400);
    const result = await register({
      name: 'New',
      email: 'new@example.com',
      password: 'StrongPassword123',
    });
    expect(result.user.role).toBe('customer');
    expect(JSON.stringify(result.user)).not.toContain('passwordHash');
    const user = await User.findById(result.user._id).select('+passwordHash');
    expect(user!.passwordHash).not.toBe('StrongPassword123');
    const rotated = await refresh(result.refreshToken);
    await expect(refresh(result.refreshToken)).rejects.toMatchObject({ status: 401 });
    expect(
      (await request(app).get('/api/v1/auth/me').auth(result.accessToken, { type: 'bearer' }))
        .status,
    ).toBe(401);
    expect(
      (await request(app).post('/api/v1/auth/logout').auth(rotated.accessToken, { type: 'bearer' }))
        .status,
    ).toBe(200);
    expect(
      (await request(app).get('/api/v1/auth/me').auth(rotated.accessToken, { type: 'bearer' }))
        .status,
    ).toBe(401);
  });
  it('rejects unauthenticated access and customer owner routes', async () => {
    expect((await request(app).get('/api/v1/bookings')).status).toBe(401);
    const result = await register({
      name: 'New',
      email: 'new@example.com',
      password: 'StrongPassword123',
    });
    await User.updateOne({ _id: result.user._id }, { $set: { salon: salon._id } });
    expect(
      (await request(app).get('/api/v1/reports').auth(result.accessToken, { type: 'bearer' }))
        .status,
    ).toBe(403);
  });
  it('cannot book for another customer or read another salon customer', async () => {
    await expect(book(customerActor, other.id)).rejects.toMatchObject({ status: 404 });
    const foreign = { ...owner, salon: new mongoose.Types.ObjectId().toString() };
    await expect(book(foreign, customer.id)).rejects.toMatchObject({ status: 404 });
  });
});
describe('appointments', () => {
  it('serializes concurrent overlapping bookings', async () => {
    const results = await Promise.allSettled([book(), book(otherActor)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await Booking.countDocuments()).toBe(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { status: 409 } });
  });
  it('allows adjacent slots but blocks staff leave', async () => {
    await book();
    const later = DateTime.fromISO(start).plus({ minutes: 30 }).toISO()!;
    await createBooking(otherActor, {
      staffId: staff.id,
      items: [{ serviceId: service.id, addonIds: [] }],
      start: later,
      source: 'online',
    });
    await Staff.updateOne(
      { _id: staff._id },
      {
        $set: {
          timeOff: [
            {
              start: new Date(DateTime.fromISO(start).plus({ days: 1 }).toISO()!),
              end: new Date(DateTime.fromISO(start).plus({ days: 2 }).toISO()!),
            },
          ],
        },
      },
    );
    await expect(
      createBooking(customerActor, {
        staffId: staff.id,
        items: [{ serviceId: service.id, addonIds: [] }],
        start: DateTime.fromISO(start).plus({ days: 1 }).toISO()!,
        source: 'online',
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('requires payment and prevents completing future visits', async () => {
    const b = await book();
    await expect(changeBookingStatus(owner, b.id, 'completed')).rejects.toMatchObject({
      status: 409,
    });
    await Booking.updateOne(
      { _id: b._id },
      { $set: { start: new Date(Date.now() - 3600000), end: new Date(Date.now() - 1800000) } },
    );
    await expect(changeBookingStatus(owner, b.id, 'completed')).rejects.toMatchObject({
      status: 409,
    });
  });
});
describe('store credit and payments', () => {
  it('rejects client cash verification and fails closed without payment provider', async () => {
    await expect(
      recordPayment(customerActor, {
        amount: 1000,
        purpose: 'topup',
        method: 'cash',
        idempotencyKey: 'cash-topup-1',
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      recordPayment(customerActor, {
        amount: 1000,
        purpose: 'topup',
        method: 'provider',
        reference: 'fake',
        idempotencyKey: 'fake-provider-1',
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(await Payment.countDocuments()).toBe(0);
  });
  it('deduplicates topups and rejects key reuse for another amount', async () => {
    const data = {
      customerId: customer.id,
      amount: 10000,
      purpose: 'topup' as const,
      method: 'cash' as const,
      idempotencyKey: 'topup-test-1',
    };
    const results = await Promise.all([recordPayment(owner, data), recordPayment(owner, data)]);
    expect(results[0].id).toBe(results[1].id);
    expect(await walletBalance(customerActor)).toMatchObject({ paid: 10000, bonus: 1000 });
    await expect(recordPayment(owner, { ...data, amount: 20000 })).rejects.toMatchObject({
      status: 409,
    });
  });
  it('prevents credit overspending under concurrency', async () => {
    await adjustWallet(owner, {
      customerId: customer.id,
      amount: 3000,
      direction: 'credit',
      bucket: 'paid',
      reason: 'Opening balance',
      idempotencyKey: 'opening-1',
    });
    const input = {
      customerId: customer.id,
      amount: 2500,
      direction: 'debit' as const,
      bucket: 'paid' as const,
      reason: 'Owner debit',
    };
    const r = await Promise.allSettled([
      adjustWallet(owner, { ...input, idempotencyKey: 'debit-111' }),
      adjustWallet(owner, { ...input, idempotencyKey: 'debit-222' }),
    ]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(await walletBalance(customerActor)).toMatchObject({ paid: 500, bonus: 0 });
  });
  it('refunds credit once and restores paid/bonus composition', async () => {
    await recordPayment(owner, {
      customerId: customer.id,
      amount: 10000,
      purpose: 'topup',
      method: 'cash',
      idempotencyKey: 'topup-refund-1',
    });
    const b = await book();
    const p = await recordPayment(customerActor, {
      bookingId: b.id,
      amount: 3000,
      purpose: 'booking',
      method: 'credit',
      idempotencyKey: 'booking-payment-1',
    });
    expect(await walletBalance(customerActor)).toMatchObject({ paid: 8000, bonus: 0 });
    await refundPayment(owner, p.id, 'Service cancelled');
    await refundPayment(owner, p.id, 'Service cancelled');
    expect(await walletBalance(customerActor)).toMatchObject({ paid: 10000, bonus: 1000 });
    expect(await WalletTransaction.countDocuments({ type: 'refund' })).toBe(1);
  });
  it('expires credit with a ledger entry and only reverses unused topups', async () => {
    const p = await recordPayment(owner, {
      customerId: customer.id,
      amount: 1000,
      purpose: 'topup',
      method: 'cash',
      idempotencyKey: 'expiry-topup-1',
    });
    await WalletTransaction.updateOne(
      { payment: p._id },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    expect(await walletBalance(customerActor)).toMatchObject({ paid: 0, bonus: 0 });
    expect(await WalletTransaction.countDocuments({ type: 'expiry' })).toBe(1);
    await expect(reverseTopup(owner, p.id, 'Reverse expired')).rejects.toMatchObject({
      status: 409,
    });
  });
});
describe('referral and reminder integration', () => {
  it('rejects self and duplicate claims; releases one reward after paid first visit', async () => {
    await expect(claimReferral(customerActor, customer.referralCode)).rejects.toMatchObject({
      status: 400,
    });
    await claimReferral(customerActor, other.referralCode);
    await expect(claimReferral(customerActor, other.referralCode)).rejects.toMatchObject({
      code: 11000,
    });
    const b = await book();
    await recordPayment(owner, {
      customerId: customer.id,
      bookingId: b.id,
      amount: 3000,
      purpose: 'booking',
      method: 'cash',
      idempotencyKey: 'paid-first-visit',
    });
    expect(await WalletTransaction.countDocuments({ type: 'reward' })).toBe(0);
    await Booking.updateOne(
      { _id: b._id },
      { $set: { start: new Date(Date.now() - 3600000), end: new Date(Date.now() - 1800000) } },
    );
    await changeBookingStatus(owner, b.id, 'completed');
    await changeBookingStatus(owner, b.id, 'completed');
    expect(await Visit.countDocuments()).toBe(1);
    expect(await WalletTransaction.countDocuments({ type: 'reward' })).toBe(1);
    expect(await walletBalance(otherActor)).toMatchObject({ bonus: 1000 });
    expect(await Reminder.countDocuments({ status: 'scheduled' })).toBe(1);
  });
  it('does not reward credit-funded first visits and does not invent delivery', async () => {
    await claimReferral(customerActor, other.referralCode);
    await adjustWallet(owner, {
      customerId: customer.id,
      amount: 3000,
      direction: 'credit',
      bucket: 'paid',
      reason: 'Opening balance',
      idempotencyKey: 'first-credit',
    });
    const b = await book();
    await recordPayment(customerActor, {
      bookingId: b.id,
      amount: 3000,
      purpose: 'booking',
      method: 'credit',
      idempotencyKey: 'first-credit-payment',
    });
    await Booking.updateOne({ _id: b._id }, { $set: { start: new Date(Date.now() - 3600000) } });
    await changeBookingStatus(owner, b.id, 'completed');
    expect(await WalletTransaction.countDocuments({ type: 'reward' })).toBe(0);
    await Reminder.updateMany({}, { $set: { dueAt: new Date(Date.now() - 1000) } });
    await processReminders();
    expect(await Reminder.countDocuments({ status: 'blocked' })).toBe(1);
    expect(await Reminder.countDocuments({ status: 'delivered' })).toBe(0);
  });
});
describe('HTTP modules and provider recovery', () => {
  it('integrates owner catalog, staff creation, search and reports', async () => {
    const credentials = await register({
      name: 'API Owner',
      email: 'api-owner@example.com',
      password: 'StrongPassword123',
    });
    await User.updateOne(
      { _id: credentials.user._id },
      { $set: { role: 'owner', salon: salon._id } },
    );
    const token = credentials.accessToken;
    const created = await request(app)
      .post('/api/v1/services')
      .auth(token, { type: 'bearer' })
      .send({
        name: 'Shave',
        category: 'Beard',
        price: 1000,
        duration: 15,
        addons: [{ name: 'Mask', price: 500, duration: 10 }],
      });
    expect(created.status).toBe(201);
    const staffResponse = await request(app)
      .post('/api/v1/staff')
      .auth(token, { type: 'bearer' })
      .send({
        name: 'New Staff',
        email: 'new-staff@example.com',
        password: 'StaffPassword123',
        services: [created.body.data._id],
        hours: [{ day: 1, open: '09:00', close: '18:00' }],
      });
    expect(staffResponse.status).toBe(201);
    expect((await login('new-staff@example.com', 'StaffPassword123')).user.role).toBe('staff');
    expect(
      (
        await request(app)
          .patch(`/api/v1/services/${created.body.data._id}`)
          .auth(token, { type: 'bearer' })
          .send({ active: false })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .get('/api/v1/customers?search=Customer&sort=-lastVisitAt')
          .auth(token, { type: 'bearer' })
      ).body.data,
    ).toHaveLength(1);
    const settings = await request(app)
      .patch('/api/v1/settings')
      .auth(token, { type: 'bearer' })
      .send({ topupBonusPercent: 20 });
    expect(settings.status).toBe(200);
    expect(settings.body.data.topupBonusPercent).toBe(20);
    const b = await book();
    await recordPayment(owner, {
      customerId: customer.id,
      bookingId: b.id,
      amount: 3000,
      purpose: 'booking',
      method: 'cash',
      idempotencyKey: 'report-payment',
    });
    await Booking.updateOne({ _id: b._id }, { $set: { start: new Date(Date.now() - 3600000) } });
    await changeBookingStatus(owner, b.id, 'completed');
    const reports = await request(app).get('/api/v1/reports').auth(token, { type: 'bearer' });
    expect(reports.status).toBe(200);
    expect(reports.body.data).toMatchObject({
      completedRevenue: 3000,
      completedBookings: 1,
      newCustomers: 1,
      averageBill: 3000,
    });
    expect(
      (await request(app).get('/api/v1/audit-logs').auth(token, { type: 'bearer' })).body.data
        .length,
    ).toBeGreaterThan(3);
  });
  it('persists pending refunds after provider failure and safely resumes', async () => {
    const b = await book();
    vi.spyOn(paymentProvider, 'verify').mockResolvedValue({
      reference: 'real-reference',
      status: 'paid',
      amount: 3000,
      currency: 'INR',
      customerId: customer.id,
      salonId: salon.id,
      purpose: 'booking',
      bookingId: b.id,
    });
    const p = await recordPayment(customerActor, {
      bookingId: b.id,
      amount: 3000,
      purpose: 'booking',
      method: 'provider',
      reference: 'real-reference',
      idempotencyKey: 'provider-booking-1',
    });
    const provider = vi
      .spyOn(paymentProvider, 'refund')
      .mockRejectedValueOnce(new Error('Gateway timeout'))
      .mockResolvedValue({ reference: 'real-reference', status: 'refunded', amount: 3000 });
    await expect(refundPayment(owner, p.id, 'Cancelled appointment')).rejects.toThrow(
      'Gateway timeout',
    );
    expect((await Payment.findById(p._id))!.status).toBe('refund-pending');
    expect((await Booking.findById(b._id))!.paymentStatus).toBe('refund-pending');
    await refundPayment(owner, p.id, 'Cancelled appointment');
    await refundPayment(owner, p.id, 'Cancelled appointment');
    expect(provider).toHaveBeenCalledTimes(2);
    expect(provider.mock.calls[0][2]).toBe(provider.mock.calls[1][2]);
    expect((await Payment.findById(p._id))!.status).toBe('refunded');
  });
  it('claws back referral rewards after qualifying visit refund', async () => {
    await claimReferral(customerActor, other.referralCode);
    const b = await book();
    const p = await recordPayment(owner, {
      customerId: customer.id,
      bookingId: b.id,
      amount: 3000,
      purpose: 'booking',
      method: 'cash',
      idempotencyKey: 'reward-refund-payment',
    });
    await Booking.updateOne({ _id: b._id }, { $set: { start: new Date(Date.now() - 3600000) } });
    await changeBookingStatus(owner, b.id, 'completed');
    expect(await walletBalance(otherActor)).toMatchObject({ bonus: 1000 });
    await refundPayment(owner, p.id, 'Refund qualifying visit');
    expect(await walletBalance(otherActor)).toMatchObject({ paid: 0, bonus: 0 });
    expect(await WalletTransaction.countDocuments({ type: 'reversal' })).toBe(1);
  });
  it('one-use password reset invalidates all sessions', async () => {
    const auth = await register({
      name: 'Reset User',
      email: 'reset@example.com',
      password: 'OriginalPassword123',
    });
    const resetToken = 'a'.repeat(64);
    await User.updateOne(
      { _id: auth.user._id },
      { $set: { resetHash: hash(resetToken), resetExpires: new Date(Date.now() + 60000) } },
    );
    expect(
      (
        await request(app)
          .post('/api/v1/auth/reset-password')
          .send({ token: resetToken, password: 'ChangedPassword123' })
      ).status,
    ).toBe(200);
    expect(
      (await request(app).get('/api/v1/auth/me').auth(auth.accessToken, { type: 'bearer' })).status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .post('/api/v1/auth/reset-password')
          .send({ token: resetToken, password: 'AnotherPassword123' })
      ).status,
    ).toBe(400);
    expect((await login('reset@example.com', 'ChangedPassword123')).user.id).toBe(auth.user.id);
  });
  it('cancels relevant pending reminders after a new booking', async () => {
    const b = await book();
    await recordPayment(owner, {
      customerId: customer.id,
      bookingId: b.id,
      amount: 3000,
      purpose: 'booking',
      method: 'cash',
      idempotencyKey: 'reminder-paid',
    });
    await Booking.updateOne({ _id: b._id }, { $set: { start: new Date(Date.now() - 3600000) } });
    await changeBookingStatus(owner, b.id, 'completed');
    expect(await Reminder.countDocuments({ status: 'scheduled' })).toBe(1);
    await book();
    expect(await Reminder.countDocuments({ status: 'cancelled' })).toBe(1);
  });
});
describe('mobile integration endpoints', () => {
  async function tokenForCustomer() {
    const r = await register({
      name: 'Mobile',
      email: 'mobile@example.com',
      password: 'MobilePassword123',
    });
    await User.updateOne({ _id: r.user._id }, { $set: { salon: salon._id } });
    await Customer.create({
      salon: salon._id,
      user: r.user._id,
      name: 'Mobile',
      referralCode: '3333333333333333',
    });
    return r.accessToken;
  }
  it('keeps salon discovery public and exposes only safe provider capabilities', async () => {
    expect((await request(app).get('/api/v1/salons')).status).toBe(200);
    const token = await tokenForCustomer();
    const r = await request(app).get('/api/v1/mobile-config').auth(token, { type: 'bearer' });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({
      paymentVerification: false,
      messaging: false,
      referralReward: 1000,
    });
    expect(JSON.stringify(r.body)).not.toContain('TOKEN');
  });
  it('offers genuine free slots, excludes overlapping bookings and respects service duration', async () => {
    const token = await tokenForCustomer();
    const date = DateTime.fromISO(start).toISODate();
    const payload = { staffId: staff.id, date, items: [{ serviceId: service.id, addonIds: [] }] };
    const before = await request(app)
      .post('/api/v1/availability')
      .auth(token, { type: 'bearer' })
      .send(payload);
    expect(before.status).toBe(200);
    expect(before.body.data.duration).toBe(30);
    expect(
      before.body.data.slots.some(
        (s: string) => new Date(s).getTime() === new Date(start).getTime(),
      ),
    ).toBe(true);
    await book();
    const after = await request(app)
      .post('/api/v1/availability')
      .auth(token, { type: 'bearer' })
      .send(payload);
    expect(after.status).toBe(200);
    expect(
      after.body.data.slots.some(
        (s: string) => new Date(s).getTime() === new Date(start).getTime(),
      ),
    ).toBe(false);
    expect(
      after.body.data.slots.some(
        (s: string) => new Date(s).getTime() === new Date(start).getTime() + 30 * 60000,
      ),
    ).toBe(true);
  });
  it('does not allow another customer to inspect a booking for rescheduling', async () => {
    const token = await tokenForCustomer();
    const booking = await book();
    const result = await request(app)
      .post('/api/v1/availability')
      .auth(token, { type: 'bearer' })
      .send({
        staffId: staff.id,
        date: DateTime.fromISO(start).toISODate(),
        bookingId: booking.id,
      });
    expect(result.status).toBe(404);
  });
});
