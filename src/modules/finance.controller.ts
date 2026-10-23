import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireSalon, roles, validate } from '../middleware/http.js';
import { Payment, Referral, WalletTransaction } from '../models/index.js';
import { amount, id, key } from '../validators/index.js';
import { env } from '../config/env.js';
import { customerAccess } from '../services/access.js';
import { ok, page } from '../utils/core.js';
import {
  adjustWallet,
  claimReferral,
  recordPayment,
  refundPayment,
  reverseTopup,
  walletBalance,
} from './wallet.service.js';
export const financeRouter = Router();
financeRouter.use(authenticate, requireSalon);
financeRouter.get('/wallet', async (req, res) => {
  const cid = id.optional().parse(req.query.customerId);
  ok(res, await walletBalance(req.actor, cid));
});
financeRouter.get('/wallet/transactions', async (req, res) => {
  const customer = await customerAccess(req.actor, id.optional().parse(req.query.customerId));
  const p = page(req.query);
  ok(
    res,
    await WalletTransaction.find({ salon: req.actor.salon, customer: customer._id })
      .sort({ createdAt: -1 })
      .skip(p.skip)
      .limit(p.limit),
    200,
    p,
  );
});
financeRouter.post(
  '/wallet/adjustments',
  roles('owner'),
  validate(
    z
      .object({
        customerId: id,
        amount: amount.positive(),
        direction: z.enum(['credit', 'debit']),
        bucket: z.enum(['paid', 'bonus']),
        reason: z.string().trim().min(5).max(500),
        idempotencyKey: key,
      })
      .strict(),
  ),
  async (req, res) => ok(res, await adjustWallet(req.actor, req.body), 201),
);
financeRouter.post(
  '/payments',
  validate(
    z
      .object({
        customerId: id.optional(),
        bookingId: id.optional(),
        amount: amount.positive(),
        purpose: z.enum(['booking', 'topup']),
        method: z.enum(['cash', 'provider', 'credit']),
        reference: z.string().min(1).max(200).optional(),
        idempotencyKey: key,
      })
      .strict()
      .refine(
        (v) => (v.method === 'provider' ? Boolean(v.reference) : !v.reference),
        'Reference required only for provider payments',
      ),
  ),
  async (req, res) => ok(res, await recordPayment(req.actor, req.body), 201),
);
financeRouter.get('/payments', async (req, res) => {
  const p = page(req.query);
  let filter: any = { salon: req.actor.salon };
  if (req.actor.role === 'customer' || req.query.customerId)
    filter.customer = (
      await customerAccess(req.actor, id.optional().parse(req.query.customerId))
    )._id;
  ok(res, await Payment.find(filter).sort({ createdAt: -1 }).skip(p.skip).limit(p.limit), 200, p);
});
financeRouter.post(
  '/payments/:id/refund',
  roles('owner'),
  validate(z.object({ reason: z.string().trim().min(5).max(500) }).strict()),
  async (req, res) => {
    id.parse(req.params.id);
    ok(res, await refundPayment(req.actor, id.parse(req.params.id), req.body.reason));
  },
);
financeRouter.post(
  '/payments/:id/reverse-topup',
  roles('owner'),
  validate(z.object({ reason: z.string().trim().min(5).max(500) }).strict()),
  async (req, res) => {
    id.parse(req.params.id);
    ok(res, await reverseTopup(req.actor, id.parse(req.params.id), req.body.reason));
  },
);
financeRouter.get('/referrals/me', roles('customer'), async (req, res) => {
  const c = await customerAccess(req.actor);
  const p = page(req.query);
  ok(res, {
    code: c.referralCode,
    link: `${env.PUBLIC_APP_URL}/register?ref=${c.referralCode}`,
    referrals: await Referral.find({ salon: req.actor.salon, referrer: c._id })
      .select('status reward rewardedAt createdAt')
      .skip(p.skip)
      .limit(p.limit),
  });
});
financeRouter.post(
  '/referrals/claim',
  roles('customer'),
  validate(z.object({ code: z.string().regex(/^[a-f\d]{16}$/) }).strict()),
  async (req, res) => ok(res, await claimReferral(req.actor, req.body.code), 201),
);
financeRouter.get('/referrals', roles('owner'), async (req, res) => {
  const p = page(req.query);
  ok(
    res,
    await Referral.find({ salon: req.actor.salon })
      .sort({ createdAt: -1 })
      .skip(p.skip)
      .limit(p.limit),
    200,
    p,
  );
});
