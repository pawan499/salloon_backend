import { mobileRouter } from '../modules/mobile.controller.js';
import { Router } from 'express';
import { z } from 'zod';
import { authRouter } from '../modules/auth.controller.js';
import { catalogRouter } from '../modules/catalog.controller.js';
import { bookingRouter } from '../modules/booking.controller.js';
import { financeRouter } from '../modules/finance.controller.js';
import { authenticate, requireSalon, roles } from '../middleware/http.js';
import { Reminder } from '../models/index.js';
import { customerAccess } from '../services/access.js';
import { report } from '../modules/reports.service.js';
import { ok, page } from '../utils/core.js';
export const router = Router();
router.use('/auth', authRouter);
router.use(catalogRouter);
router.use(mobileRouter);
router.use('/bookings', bookingRouter);
router.use(financeRouter);
router.get('/reminders', authenticate, requireSalon, async (req, res) => {
  const p = page(req.query);
  const filter: any = { salon: req.actor.salon };
  if (req.actor.role === 'customer') filter.customer = (await customerAccess(req.actor))._id;
  ok(res, await Reminder.find(filter).sort({ dueAt: -1 }).skip(p.skip).limit(p.limit), 200, p);
});
router.get('/reports', authenticate, requireSalon, roles('owner'), async (req, res) => {
  const date = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional();
  ok(
    res,
    await report(
      req.actor.salon!,
      date.parse(req.query.from),
      date.parse(req.query.to),
      z.enum(['day', 'month']).default('day').parse(req.query.group),
    ),
  );
});
