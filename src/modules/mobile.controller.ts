import { Router } from 'express';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { env } from '../config/env.js';
import { authenticate, requireSalon, validate } from '../middleware/http.js';
import { Booking, Salon, SalonSettings, Service, Staff } from '../models/index.js';
import { id } from '../validators/index.js';
import { assert, ok } from '../utils/core.js';
import { bookingAccess, customerAccess } from '../services/access.js';
import { fitsHours } from './booking.service.js';
export const mobileRouter = Router();
mobileRouter.use(authenticate, requireSalon);
mobileRouter.get('/mobile-config', async (req, res) => {
  const settings = await SalonSettings.findOne({ salon: req.actor.salon });
  ok(res, {
    paymentVerification: Boolean(env.PAYMENT_PROVIDER_URL && env.PAYMENT_PROVIDER_TOKEN),
    messaging: Boolean(env.MESSAGE_PROVIDER_URL && env.MESSAGE_PROVIDER_TOKEN),
    referralReward: settings?.referralReward ?? 0,
    referralMinimumBill: settings?.referralMinimumBill ?? 0,
    topupBonusPercent: settings?.topupBonusPercent ?? 0,
    creditExpiryDays: settings?.creditExpiryDays ?? 365,
    cancellationHours: settings?.cancellationHours ?? 2,
  });
});
mobileRouter.post(
  '/availability',
  validate(
    z
      .object({
        staffId: id,
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        items: z
          .array(z.object({ serviceId: id, addonIds: z.array(id).default([]) }).strict())
          .min(1)
          .max(20)
          .optional(),
        bookingId: id.optional(),
        customerId: id.optional(),
      })
      .strict(),
  ),
  async (req, res) => {
    const salon = await Salon.findOne({ _id: req.actor.salon, active: true });
    const staff = await Staff.findOne({
      _id: req.body.staffId,
      salon: req.actor.salon,
      active: true,
    });
    assert(salon && staff, 404, 'Salon or staff not found');
    let duration = 0;
    let customerId: string;
    let exclude: string | undefined;
    if (req.body.bookingId) {
      const booking = await Booking.findOne({ _id: req.body.bookingId, salon: req.actor.salon });
      await bookingAccess(req.actor, booking);
      assert(
        booking && ['pending', 'confirmed'].includes(booking.status!),
        409,
        'Booking cannot be rescheduled',
      );
      assert(booking.staff.toString() === staff.id, 400, 'Rescheduling retains assigned staff');
      duration = booking.items.reduce(
        (n, i) => n + i.duration + i.addons.reduce((m, a) => m + (a.duration ?? 0), 0),
        0,
      );
      customerId = booking.customer.toString();
      exclude = booking.id;
    } else {
      const customer = await customerAccess(req.actor, req.body.customerId);
      customerId = customer.id;
      assert(req.body.items?.length, 400, 'Choose a service');
      assert(
        new Set(req.body.items.map((i: any) => i.serviceId)).size === req.body.items.length,
        400,
        'Duplicate services',
      );
      for (const item of req.body.items) {
        const service = await Service.findOne({
          _id: item.serviceId,
          salon: req.actor.salon,
          active: true,
        });
        assert(service, 404, 'Service unavailable');
        assert(
          staff.services.some((s) => s.toString() === service.id),
          400,
          'Staff is not assigned to this service',
        );
        assert(new Set(item.addonIds).size === item.addonIds.length, 400, 'Duplicate add-ons');
        duration += service.duration;
        for (const aid of item.addonIds) {
          const addon = service.addons.id(aid);
          assert(addon?.active, 400, 'Add-on unavailable');
          duration += addon.duration;
        }
      }
    }
    const day = DateTime.fromISO(req.body.date, { zone: salon.timezone! }).startOf('day');
    assert(day.isValid, 400, 'Invalid date');
    assert(
      day >= DateTime.now().setZone(salon.timezone!).startOf('day') &&
        day <= DateTime.now().setZone(salon.timezone!).plus({ days: 180 }),
      400,
      'Choose a date within the next 180 days',
    );
    const bookings = await Booking.find({
      salon: req.actor.salon,
      ...(exclude ? { _id: { $ne: exclude } } : {}),
      status: { $in: ['pending', 'confirmed'] },
      $or: [{ staff: staff._id }, { customer: customerId }],
      start: { $lt: day.plus({ days: 1 }).toJSDate() },
      end: { $gt: day.toJSDate() },
    }).select('start end');
    const slots: string[] = [];
    for (let t = day; t < day.plus({ days: 1 }); t = t.plus({ minutes: 15 })) {
      const end = t.plus({ minutes: duration });
      const a = t.toJSDate(),
        b = end.toJSDate();
      if (
        a <= new Date() ||
        !fitsHours(a, b, salon.timezone!, salon.hours) ||
        !fitsHours(a, b, salon.timezone!, staff.hours)
      )
        continue;
      if (
        staff.timeOff.some((v) => v.start! < b && v.end! > a) ||
        bookings.some((v) => v.start < b && v.end > a)
      )
        continue;
      slots.push(t.toISO()!);
    }
    ok(res, { date: req.body.date, timezone: salon.timezone, duration, slots });
  },
);
