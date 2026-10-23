import { z } from 'zod';
import { DateTime, IANAZone } from 'luxon';
export const id = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid object ID');
export const amount = z.number().int().nonnegative().max(100000000);
export const password = z
  .string()
  .min(12)
  .max(72)
  .refine((v) => Buffer.byteLength(v) <= 72, 'Password must be at most 72 bytes');
export const email = z
  .string()
  .email()
  .max(254)
  .transform((v) => v.toLowerCase());
export const name = z.string().trim().min(1).max(120);
export const phone = z.string().regex(/^\+?[\d ()-]{7,25}$/);
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const hours = z
  .array(
    z
      .object({
        day: z.number().int().min(1).max(7),
        open: clock,
        close: clock,
        closed: z.boolean().default(false),
      })
      .strict()
      .refine((v) => v.closed || v.open < v.close, 'Closing must follow opening'),
  )
  .min(1)
  .max(7)
  .refine((v) => new Set(v.map((h) => h.day)).size === v.length, 'Duplicate weekday');
export const salonInput = z
  .object({
    name,
    address: z.string().min(1).max(500),
    phone: phone.optional(),
    email: email.optional(),
    timezone: z
      .string()
      .refine((v) => IANAZone.isValidZone(v))
      .default('Asia/Kolkata'),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .default('INR'),
    hours,
  })
  .strict();
export const addonInput = z
  .object({
    _id: id.optional(),
    name,
    price: amount,
    duration: z.number().int().min(0).max(360),
    active: z.boolean().default(true),
  })
  .strict();
export const serviceInput = z
  .object({
    name,
    category: name,
    description: z.string().max(2000).optional(),
    price: amount,
    duration: z.number().int().min(1).max(720),
    reminderDays: z.number().int().min(1).max(730).default(30),
    active: z.boolean().default(true),
    addons: z.array(addonInput).max(30).default([]),
  })
  .strict();
export const customerInput = z
  .object({
    name,
    phone: phone.optional(),
    email: email.optional(),
    notes: z.string().max(2000).optional(),
    consent: z.boolean().default(false),
    channel: z.enum(['sms', 'whatsapp']).default('sms'),
  })
  .strict();
export const staffInput = z
  .object({
    name,
    email,
    password,
    phone: phone.optional(),
    skills: z.array(name).max(50).default([]),
    services: z.array(id).min(1).max(100),
    hours,
    timeOff: z
      .array(
        z
          .object({
            start: z.string().datetime({ offset: true }),
            end: z.string().datetime({ offset: true }),
          })
          .strict()
          .refine((v) => DateTime.fromISO(v.start) < DateTime.fromISO(v.end)),
      )
      .max(100)
      .default([]),
  })
  .strict();
export const bookingInput = z
  .object({
    customerId: id.optional(),
    staffId: id,
    items: z
      .array(z.object({ serviceId: id, addonIds: z.array(id).max(30).default([]) }).strict())
      .min(1)
      .max(20),
    start: z.string().datetime({ offset: true }),
    source: z.enum(['online', 'walk-in', 'reminder']).default('online'),
    reminderId: id.optional(),
  })
  .strict()
  .refine(
    (v) => new Set(v.items.map((i) => i.serviceId)).size === v.items.length,
    'Duplicate services',
  );
export const settingsInput = z
  .object({
    topupBonusPercent: z.number().min(0).max(100),
    creditExpiryDays: z.number().int().min(1).max(3650),
    referralReward: amount,
    referralMinimumBill: amount,
    cancellationHours: z.number().min(0).max(168),
  })
  .strict();
export const key = z
  .string()
  .min(8)
  .max(120)
  .regex(/^[a-zA-Z0-9:_-]+$/);
