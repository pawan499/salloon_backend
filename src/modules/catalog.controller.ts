import { Router } from 'express';
import { z } from 'zod';
import {
  Customer,
  Salon,
  Service,
  Staff,
  User,
  Visit,
  SalonSettings,
  AuditLog,
  Booking,
} from '../models/index.js';
import { authenticate, requireSalon, roles, validate } from '../middleware/http.js';
import {
  customerInput,
  hours,
  id,
  name,
  salonInput,
  serviceInput,
  settingsInput,
  staffInput,
} from '../validators/index.js';
import { assert, escapeRegex, ok, page, transaction } from '../utils/core.js';
import { audit, customerAccess } from '../services/access.js';
import { createStaff, joinSalon, referralCode, updateCustomer } from './catalog.service.js';
export const catalogRouter = Router();
catalogRouter.get('/salons', async (req, res) => {
  const p = page(req.query);
  ok(res, await Salon.find({ active: true }).select('-owner').skip(p.skip).limit(p.limit), 200, p);
});
catalogRouter.get('/salons/:id/services', async (req, res) => {
  id.parse(req.params.id);
  const p = page(req.query);
  ok(
    res,
    await Service.find({ salon: id.parse(req.params.id), active: true })
      .skip(p.skip)
      .limit(p.limit),
    200,
    p,
  );
});
catalogRouter.get('/salons/:id/staff', async (req, res) => {
  id.parse(req.params.id);
  ok(
    res,
    await Staff.find({ salon: id.parse(req.params.id), active: true }).select(
      'name skills services hours',
    ),
  );
});
catalogRouter.use(authenticate);
catalogRouter.post('/salons/:id/join', roles('customer'), async (req, res) => {
  id.parse(req.params.id);
  ok(res, await joinSalon(req.actor, id.parse(req.params.id)), 201);
});
catalogRouter.use(requireSalon);
catalogRouter.get('/salon', async (req, res) => ok(res, await Salon.findById(req.actor.salon)));
catalogRouter.patch('/salon', roles('owner'), validate(salonInput.partial()), async (req, res) =>
  ok(
    res,
    await transaction(async (session) => {
      const salon = await Salon.findByIdAndUpdate(
        req.actor.salon,
        { $set: req.body },
        { session, new: true, runValidators: true },
      );
      await audit(req.actor, 'salon.update', 'Salon', req.actor.salon!, session);
      return salon;
    }),
  ),
);
catalogRouter.get('/services', async (req, res) => {
  const p = page(req.query);
  ok(
    res,
    await Service.find({
      salon: req.actor.salon,
      ...(req.actor.role === 'customer' ? { active: true } : {}),
    })
      .sort({ name: 1 })
      .skip(p.skip)
      .limit(p.limit),
    200,
    p,
  );
});
catalogRouter.post('/services', roles('owner'), validate(serviceInput), async (req, res) =>
  ok(
    res,
    await transaction(async (session) => {
      const [service] = await Service.create([{ ...req.body, salon: req.actor.salon }], {
        session,
      });
      await audit(req.actor, 'service.create', 'Service', service.id, session);
      return service;
    }),
    201,
  ),
);
catalogRouter.patch(
  '/services/:id',
  roles('owner'),
  validate(serviceInput.partial()),
  async (req, res) => {
    id.parse(req.params.id);
    ok(
      res,
      await transaction(async (session) => {
        const service = await Service.findOneAndUpdate(
          { _id: id.parse(req.params.id), salon: req.actor.salon },
          { $set: req.body },
          { session, new: true, runValidators: true },
        );
        assert(service, 404, 'Service not found');
        await audit(req.actor, 'service.update', 'Service', service.id, session);
        return service;
      }),
    );
  },
);
catalogRouter.get('/staff', async (req, res) =>
  ok(
    res,
    await Staff.find({ salon: req.actor.salon }).select(
      req.actor.role === 'customer' ? 'name skills services hours active' : '-__v',
    ),
  ),
);
catalogRouter.post('/staff', roles('owner'), validate(staffInput), async (req, res) =>
  ok(res, await createStaff(req.actor, req.body), 201),
);
catalogRouter.patch(
  '/staff/:id',
  roles('owner'),
  validate(
    z
      .object({
        name: name.optional(),
        skills: z.array(name).max(50).optional(),
        services: z.array(id).min(1).max(100).optional(),
        hours: hours.optional(),
        timeOff: staffInput.shape.timeOff.optional(),
        active: z.boolean().optional(),
      })
      .strict(),
  ),
  async (req, res) => {
    id.parse(req.params.id);
    ok(
      res,
      await transaction(async (session) => {
        if (req.body.services) {
          const n = await Service.countDocuments({
            _id: { $in: req.body.services },
            salon: req.actor.salon,
          }).session(session);
          assert(n === new Set(req.body.services).size, 400, 'Invalid service assignments');
        }
        const staff = await Staff.findOneAndUpdate(
          { _id: id.parse(req.params.id), salon: req.actor.salon },
          { $set: req.body, $inc: { bookingVersion: 1 } },
          { session, new: true, runValidators: true },
        );
        assert(staff, 404, 'Staff not found');
        if (req.body.active !== undefined)
          await User.updateOne(
            { _id: staff.user, salon: req.actor.salon },
            { $set: { active: req.body.active }, $inc: { tokenVersion: 1 } },
            { session },
          );
        await audit(req.actor, 'staff.update', 'Staff', staff.id, session);
        return staff;
      }),
    );
  },
);
catalogRouter.get('/customers/me', roles('customer'), async (req, res) =>
  ok(res, await customerAccess(req.actor)),
);
catalogRouter.patch(
  '/customers/me',
  roles('customer'),
  validate(customerInput.omit({ notes: true }).partial()),
  async (req, res) =>
    ok(res, await updateCustomer(req.actor, await customerAccess(req.actor), req.body)),
);
catalogRouter.get('/customers', roles('owner', 'staff'), async (req, res) => {
  const p = page(req.query);
  const search = z.string().max(100).optional().parse(req.query.search);
  const consent = z.enum(['true', 'false']).optional().parse(req.query.consent);
  const sort = z.enum(['name', '-createdAt', '-lastVisitAt']).default('name').parse(req.query.sort);
  const filter = {
    salon: req.actor.salon,
    ...(consent ? { consent: consent === 'true' } : {}),
    ...(search
      ? {
          $or: [
            { name: { $regex: escapeRegex(search), $options: 'i' } },
            { phone: { $regex: escapeRegex(search) } },
          ],
        }
      : {}),
  };
  ok(res, await Customer.find(filter).sort(sort).skip(p.skip).limit(p.limit), 200, {
    ...p,
    total: await Customer.countDocuments(filter),
  });
});
catalogRouter.post(
  '/customers',
  roles('owner', 'staff'),
  validate(customerInput),
  async (req, res) =>
    ok(
      res,
      await transaction(async (session) => {
        const [customer] = await Customer.create(
          [{ ...req.body, salon: req.actor.salon, referralCode: referralCode() }],
          { session },
        );
        await audit(req.actor, 'customer.create', 'Customer', customer.id, session);
        return customer;
      }),
      201,
    ),
);
catalogRouter.get('/customers/:id', async (req, res) => {
  id.parse(req.params.id);
  ok(res, await customerAccess(req.actor, id.parse(req.params.id)));
});
catalogRouter.patch(
  '/customers/:id',
  roles('owner', 'staff'),
  validate(customerInput.partial()),
  async (req, res) => {
    id.parse(req.params.id);
    ok(
      res,
      await updateCustomer(
        req.actor,
        await customerAccess(req.actor, id.parse(req.params.id)),
        req.body,
      ),
    );
  },
);
catalogRouter.get('/customers/:id/visits', async (req, res) => {
  id.parse(req.params.id);
  const customer = await customerAccess(req.actor, id.parse(req.params.id));
  const p = page(req.query);
  ok(
    res,
    await Visit.find({ salon: req.actor.salon, customer: customer._id })
      .populate('booking')
      .sort({ completedAt: -1 })
      .skip(p.skip)
      .limit(p.limit),
    200,
    p,
  );
});
catalogRouter.get('/settings', roles('owner'), async (req, res) =>
  ok(res, await SalonSettings.findOne({ salon: req.actor.salon })),
);
catalogRouter.patch(
  '/settings',
  roles('owner'),
  validate(settingsInput.partial()),
  async (req, res) =>
    ok(
      res,
      await transaction(async (session) => {
        const settings = await SalonSettings.findOneAndUpdate(
          { salon: req.actor.salon },
          { $set: req.body },
          { session, new: true, runValidators: true },
        );
        await audit(req.actor, 'settings.update', 'SalonSettings', settings!.id, session);
        return settings;
      }),
    ),
);
catalogRouter.get('/audit-logs', roles('owner'), async (req, res) => {
  const p = page(req.query);
  ok(
    res,
    await AuditLog.find({ salon: req.actor.salon })
      .sort({ createdAt: -1 })
      .skip(p.skip)
      .limit(p.limit),
    200,
    p,
  );
});
