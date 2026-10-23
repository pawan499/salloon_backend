import { Router } from 'express';
import { z } from 'zod';
import { Booking, Customer, Staff } from '../models/index.js';
import { authenticate, requireSalon, validate } from '../middleware/http.js';
import { bookingInput, id } from '../validators/index.js';
import { assert, ok, page } from '../utils/core.js';
import { bookingAccess, customerAccess } from '../services/access.js';
import { createBooking, reschedule, changeBookingStatus } from './booking.service.js';
export const bookingRouter = Router();
bookingRouter.use(authenticate, requireSalon);
bookingRouter.post('/', validate(bookingInput), async (req, res) =>
  ok(res, await createBooking(req.actor, req.body), 201),
);
bookingRouter.get('/', async (req, res) => {
  const p = page(req.query);
  const filter: any = { salon: req.actor.salon };
  if (req.actor.role === 'customer') filter.customer = (await customerAccess(req.actor))._id;
  if (req.actor.role === 'staff') {
    const staff = await Staff.findOne({ salon: req.actor.salon, user: req.actor.id });
    assert(staff, 403, 'Staff profile missing');
    filter.staff = staff._id;
  }
  if (req.query.staffId) {
    const requestedStaff = id.parse(req.query.staffId);
    if (req.actor.role === 'staff')
      assert(
        filter.staff.toString() === requestedStaff,
        403,
        'Only your own schedule is available',
      );
    filter.staff = requestedStaff;
  }
  const sort = z.enum(['start', '-start']).default('-start').parse(req.query.sort);
  if (req.query.status)
    filter.status = z
      .enum(['pending', 'confirmed', 'completed', 'cancelled', 'no-show'])
      .parse(req.query.status);
  if (req.query.from || req.query.to) {
    filter.start = {};
    if (req.query.from)
      filter.start.$gte = new Date(z.string().datetime({ offset: true }).parse(req.query.from));
    if (req.query.to)
      filter.start.$lt = new Date(z.string().datetime({ offset: true }).parse(req.query.to));
  }
  ok(res, await Booking.find(filter).sort(sort).skip(p.skip).limit(p.limit), 200, {
    ...p,
    total: await Booking.countDocuments(filter),
  });
});
bookingRouter.get('/:id', async (req, res) => {
  id.parse(req.params.id);
  const booking = await Booking.findOne({
    _id: id.parse(req.params.id),
    salon: req.actor.salon,
  });
  await bookingAccess(req.actor, booking);
  ok(res, booking);
});
bookingRouter.patch(
  '/:id/reschedule',
  validate(z.object({ start: z.string().datetime({ offset: true }) }).strict()),
  async (req, res) => {
    id.parse(req.params.id);
    ok(res, await reschedule(req.actor, id.parse(req.params.id), req.body.start));
  },
);
bookingRouter.patch(
  '/:id/status',
  validate(
    z
      .object({
        status: z.enum(['confirmed', 'completed', 'cancelled', 'no-show']),
        reason: z.string().trim().min(3).max(500).optional(),
      })
      .strict()
      .refine((v) => v.status !== 'cancelled' || Boolean(v.reason), 'Cancellation reason required'),
  ),
  async (req, res) => {
    id.parse(req.params.id);
    ok(
      res,
      await changeBookingStatus(
        req.actor,
        id.parse(req.params.id),
        req.body.status,
        req.body.reason,
      ),
    );
  },
);
