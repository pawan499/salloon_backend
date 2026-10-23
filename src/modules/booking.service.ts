import { DateTime } from 'luxon';
import { z } from 'zod';
import type { ClientSession } from 'mongoose';
import {
  Booking,
  Customer,
  Payment,
  Reminder,
  Salon,
  SalonSettings,
  Service,
  Staff,
  Visit,
} from '../models/index.js';
import { assert, transaction } from '../utils/core.js';
import { bookingInput } from '../validators/index.js';
import { audit, bookingAccess, customerAccess, type Actor } from '../services/access.js';
import { releaseReward } from './wallet.service.js';
export function fitsHours(start: Date, end: Date, timezone: string, hours: any[]) {
  const a = DateTime.fromJSDate(start).setZone(timezone),
    b = DateTime.fromJSDate(end).setZone(timezone);
  if (a.toISODate() !== b.toISODate()) return false;
  const h = hours.find((h) => h.day === a.weekday && !h.closed);
  return Boolean(
    h && a.toFormat('HH:mm') >= h.open && b.toFormat('HH:mm') <= h.close && b.second === 0,
  );
}
async function availability(
  salonId: string,
  staffId: string,
  customerId: string,
  items: any[],
  start: Date,
  session: ClientSession,
  exclude?: string,
) {
  // Every appointment mutation writes these shared documents. Concurrent transactions
  // retry against fresh snapshots, serializing overlapping interval checks without time-slot rounding.
  const staff = await Staff.findOneAndUpdate(
    { _id: staffId, salon: salonId, active: true },
    { $inc: { bookingVersion: 1 } },
    { session, new: true },
  );
  const customer = await Customer.findOneAndUpdate(
    { _id: customerId, salon: salonId },
    { $inc: { bookingVersion: 1 } },
    { session },
  );
  const salon = await Salon.findOne({ _id: salonId, active: true }).session(session);
  assert(staff && customer && salon, 404, 'Salon, staff or customer not found');
  assert(
    items.every((i) => staff.services.some((s) => s.toString() === i.service.toString())),
    400,
    'Staff is not assigned to all requested services',
  );
  const duration = items.reduce(
    (n, i) => n + i.duration + i.addons.reduce((m: number, a: any) => m + a.duration, 0),
    0,
  );
  const end = new Date(start.getTime() + duration * 60000);
  assert(
    duration <= 1440 &&
      start > new Date() &&
      start.getSeconds() === 0 &&
      start.getMilliseconds() === 0,
    400,
    'Booking must start in the future at a whole minute',
  );
  assert(
    fitsHours(start, end, salon.timezone!, salon.hours) &&
      fitsHours(start, end, salon.timezone!, staff.hours),
    400,
    'Outside salon or staff working hours',
  );
  assert(!staff.timeOff.some((t) => t.start! < end && t.end! > start), 409, 'Staff is on leave');
  const conflict = await Booking.exists({
    salon: salonId,
    ...(exclude ? { _id: { $ne: exclude } } : {}),
    $or: [{ staff: staffId }, { customer: customerId }],
    status: { $in: ['pending', 'confirmed'] },
    start: { $lt: end },
    end: { $gt: start },
  }).session(session);
  assert(!conflict, 409, 'Time overlaps another booking', 'BOOKING_CONFLICT');
  return end;
}
export async function createBooking(actor: Actor, input: z.infer<typeof bookingInput>) {
  return transaction(async (session) => {
    const customer = await customerAccess(actor, input.customerId, session);
    assert(actor.role !== 'customer' || input.source !== 'walk-in', 403, 'Walk-ins require staff');
    const items: any[] = [];
    for (const requested of input.items) {
      const service = await Service.findOne({
        _id: requested.serviceId,
        salon: actor.salon,
        active: true,
      }).session(session);
      assert(service, 404, 'Active service not found');
      assert(
        new Set(requested.addonIds).size === requested.addonIds.length,
        400,
        'Duplicate add-ons',
      );
      const addons = requested.addonIds.map((aid) => {
        const a = service.addons.id(aid);
        assert(a?.active, 400, 'Invalid or disabled add-on');
        return { addonId: a._id, name: a.name, price: a.price, duration: a.duration };
      });
      items.push({
        service: service._id,
        name: service.name,
        price: service.price,
        duration: service.duration,
        reminderDays: service.reminderDays,
        addons,
      });
    }
    let reminder;
    if (input.source === 'reminder') {
      assert(input.reminderId, 400, 'reminderId is required');
      reminder = await Reminder.findOne({
        _id: input.reminderId,
        salon: actor.salon,
        customer: customer._id,
        status: { $in: ['sent', 'delivered'] },
      }).session(session);
      assert(
        reminder && items.some((i) => i.service.toString() === reminder!.service.toString()),
        400,
        'Invalid reminder attribution',
      );
    } else assert(!input.reminderId, 400, 'reminderId requires reminder source');
    const start = new Date(input.start);
    const end = await availability(actor.salon!, input.staffId, customer.id, items, start, session);
    const total = items.reduce(
      (n, i) => n + i.price + i.addons.reduce((m: number, a: any) => m + a.price, 0),
      0,
    );
    const [booking] = await Booking.create(
      [
        {
          salon: actor.salon,
          customer: customer._id,
          staff: input.staffId,
          items,
          start,
          end,
          total,
          source: input.source,
          reminder: reminder?._id,
          createdBy: actor.id,
        },
      ],
      { session },
    );
    await Reminder.updateMany(
      {
        salon: actor.salon,
        customer: customer._id,
        service: { $in: items.map((i) => i.service) },
        status: { $in: ['scheduled', 'blocked', 'failed', 'processing'] },
      },
      { $set: { status: 'cancelled' } },
      { session },
    );
    await audit(actor, 'booking.create', 'Booking', booking.id, session);
    return booking;
  });
}
export async function reschedule(actor: Actor, id: string, start: string) {
  return transaction(async (session) => {
    const booking = await Booking.findOne({ _id: id, salon: actor.salon }).session(session);
    await bookingAccess(actor, booking, session);
    assert(
      booking && ['pending', 'confirmed'].includes(booking.status!),
      409,
      'Booking cannot be rescheduled',
    );
    if (actor.role === 'customer') await checkCancellationWindow(booking, session);
    booking.end = await availability(
      actor.salon!,
      booking.staff.toString(),
      booking.customer.toString(),
      booking.items,
      new Date(start),
      session,
      booking.id,
    );
    booking.start = new Date(start);
    await booking.save({ session });
    await audit(actor, 'booking.reschedule', 'Booking', booking.id, session);
    return booking;
  });
}
async function checkCancellationWindow(booking: any, session: ClientSession) {
  const settings = await SalonSettings.findOne({ salon: booking.salon }).session(session);
  assert(
    booking.start.getTime() - Date.now() >= (settings?.cancellationHours ?? 2) * 3600000,
    409,
    'Cancellation window has closed',
  );
}
export async function changeBookingStatus(
  actor: Actor,
  id: string,
  status: string,
  reason?: string,
) {
  return transaction(async (session) => {
    const booking = await Booking.findOne({ _id: id, salon: actor.salon }).session(session);
    await bookingAccess(actor, booking, session);
    assert(booking, 404, 'Booking not found');
    if (booking.status === status) return booking;
    assert(['pending', 'confirmed'].includes(booking.status!), 409, 'Booking is already final');
    if (actor.role === 'customer') {
      assert(status === 'cancelled', 403, 'Customers may only cancel bookings');
      await checkCancellationWindow(booking, session);
    }
    if (status === 'completed') {
      assert(booking.start <= new Date(), 409, 'Future booking cannot be completed');
      assert(
        booking.paymentStatus === 'paid' || booking.total === 0,
        409,
        'Verified payment required',
      );
      const [visit] = await Visit.create(
        [
          {
            salon: actor.salon,
            booking: booking._id,
            customer: booking.customer,
            staff: booking.staff,
            total: booking.total,
            completedAt: new Date(),
          },
        ],
        { session },
      );
      const customer = await Customer.findOneAndUpdate(
        { _id: booking.customer, salon: actor.salon },
        {
          $set: {
            lastVisitAt: visit.completedAt,
            lastService: booking.items[booking.items.length - 1].service,
          },
          $inc: { visitCount: 1, bookingVersion: 1 },
        },
        { session, new: true },
      );
      if (customer?.consent)
        for (const item of booking.items) {
          const upcoming = await Booking.exists({
            salon: actor.salon,
            customer: booking.customer,
            _id: { $ne: booking._id },
            status: { $in: ['pending', 'confirmed'] },
            start: { $gt: new Date() },
            'items.service': item.service,
          }).session(session);
          if (!upcoming)
            await Reminder.create(
              [
                {
                  salon: actor.salon,
                  customer: booking.customer,
                  service: item.service,
                  visit: visit._id,
                  dueAt: new Date(Date.now() + (item.reminderDays || 30) * 86400000),
                },
              ],
              { session },
            );
        }
      await releaseReward(booking, session);
    } else {
      await Staff.updateOne({ _id: booking.staff }, { $inc: { bookingVersion: 1 } }, { session });
      await Customer.updateOne(
        { _id: booking.customer },
        { $inc: { bookingVersion: 1 } },
        { session },
      );
      if (status === 'no-show')
        assert(booking.start <= new Date(), 409, 'Future booking cannot be marked no-show');
    }
    booking.status = status as any;
    if (reason) booking.cancellationReason = reason;
    await booking.save({ session });
    await audit(actor, `booking.${status}`, 'Booking', booking.id, session, reason);
    return booking;
  });
}
