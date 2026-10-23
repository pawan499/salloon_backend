import { DateTime } from 'luxon';
import { Types } from 'mongoose';
import {
  Booking,
  Customer,
  Payment,
  Referral,
  Salon,
  Visit,
  WalletTransaction,
} from '../models/index.js';
import { assert } from '../utils/core.js';
export async function report(
  salonId: string,
  from?: string,
  to?: string,
  group: 'day' | 'month' = 'day',
) {
  const salon = await Salon.findById(salonId);
  assert(salon, 404, 'Salon not found');
  const zone = salon.timezone!;
  const start = from
    ? DateTime.fromISO(from, { zone }).startOf('day')
    : DateTime.now().setZone(zone).startOf('day');
  const end = to
    ? DateTime.fromISO(to, { zone }).plus({ days: 1 }).startOf('day')
    : start.plus({ days: 1 });
  assert(
    start.isValid && end.isValid && end > start && end.diff(start, 'days').days <= 366,
    400,
    'Invalid date range (maximum 366 days)',
  );
  const salonObject = new Types.ObjectId(salonId),
    range = { $gte: start.toJSDate(), $lt: end.toJSDate() };
  const visits = await Visit.find({ salon: salonId, completedAt: range });
  const bookings = await Booking.find({ salon: salonId, start: range });
  const ids = visits.map((v) => v.booking);
  const completed = await Booking.find({ _id: { $in: ids }, salon: salonId });
  const revenueBookings = completed.filter((b) => b.paymentStatus === 'paid' || b.total === 0);
  const revenue = revenueBookings.reduce((n, b) => n + b.total, 0);
  const customers = new Set(visits.map((v) => v.customer.toString()));
  let newCustomers = 0;
  for (const cid of customers) {
    const earlier = await Visit.exists({
      salon: salonId,
      customer: cid,
      completedAt: { $lt: start.toJSDate() },
    });
    if (!earlier) newCustomers++;
  }
  const services: Record<string, { name: string; count: number; revenue: number }> = {},
    addons: typeof services = {},
    staff: Record<string, { completedBookings: number; services: number; revenue: number }> = {},
    periods: Record<string, { completedBookings: number; revenue: number }> = {};
  for (const b of completed) {
    const counted = revenueBookings.some((r) => r.id === b.id);
    const sid = b.staff.toString();
    staff[sid] ??= { completedBookings: 0, services: 0, revenue: 0 };
    staff[sid].completedBookings++;
    staff[sid].services += b.items.length;
    staff[sid].revenue += counted ? b.total : 0;
    const visit = visits.find((v) => v.booking.equals(b._id))!;
    const period = DateTime.fromJSDate(visit.completedAt)
      .setZone(zone)
      .toFormat(group === 'day' ? 'yyyy-MM-dd' : 'yyyy-MM');
    periods[period] ??= { completedBookings: 0, revenue: 0 };
    periods[period].completedBookings++;
    periods[period].revenue += counted ? b.total : 0;
    for (const item of b.items) {
      const key = item.service.toString();
      services[key] ??= { name: item.name!, count: 0, revenue: 0 };
      services[key].count++;
      services[key].revenue += counted ? item.price : 0;
      for (const a of item.addons) {
        const key = `${item.service}:${a.addonId}`;
        addons[key] ??= { name: a.name!, count: 0, revenue: 0 };
        addons[key].count++;
        addons[key].revenue += counted ? a.price : 0;
      }
    }
  }
  const topups = await Payment.find({
    salon: salonId,
    purpose: 'topup',
    status: 'verified',
    createdAt: range,
  });
  const outstanding = await WalletTransaction.aggregate([
    { $match: { salon: salonObject, expiresAt: { $gt: new Date() } } },
    { $group: { _id: null, paid: { $sum: '$remainingPaid' }, bonus: { $sum: '$remainingBonus' } } },
  ]);
  return {
    currency: salon.currency,
    timezone: zone,
    from: start.toISO(),
    toExclusive: end.toISO(),
    completedRevenue: revenue,
    completedBookings: visits.length,
    bookings: bookings.length,
    averageBill: revenueBookings.length ? Math.round(revenue / revenueBookings.length) : 0,
    newCustomers,
    repeatCustomers: customers.size - newCustomers,
    popularServices: services,
    popularAddons: addons,
    staff,
    periods,
    walletCreditsCollected: topups.reduce((n, p) => n + p.amount, 0),
    outstandingCredit: { paid: outstanding[0]?.paid ?? 0, bonus: outstanding[0]?.bonus ?? 0 },
    reminderBookings: bookings.filter((b) => b.source === 'reminder').length,
    cancellations: bookings.filter((b) => b.status === 'cancelled').length,
    noShows: bookings.filter((b) => b.status === 'no-show').length,
    referrals: await Referral.countDocuments({ salon: salonId, createdAt: range }),
    rewardsReleased: await Referral.countDocuments({
      salon: salonId,
      rewardedAt: range,
      status: 'rewarded',
    }),
  };
}
