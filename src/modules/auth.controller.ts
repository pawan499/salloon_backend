import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { authenticate, validate } from '../middleware/http.js';
import { email, name, password, phone } from '../validators/index.js';
import { ok } from '../utils/core.js';
import * as auth from './auth.service.js';
import { AuthSession, User } from '../models/index.js';
export const authRouter = Router();
authRouter.use(
  rateLimit({
    windowMs: 15 * 60000,
    limit: 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: {
      success: false,
      error: { code: 'RATE_LIMITED', message: 'Too many authentication requests' },
    },
  }),
);
authRouter.post(
  '/register',
  validate(z.object({ name, email, password, phone: phone.optional() }).strict()),
  async (req, res) => ok(res, await auth.register(req.body), 201),
);
authRouter.post(
  '/login',
  validate(z.object({ email, password: z.string().min(1).max(200) }).strict()),
  async (req, res) => ok(res, await auth.login(req.body.email, req.body.password)),
);
authRouter.post(
  '/refresh',
  validate(z.object({ refreshToken: z.string().max(2000) }).strict()),
  async (req, res) => ok(res, await auth.refresh(req.body.refreshToken)),
);
authRouter.post('/logout', authenticate, async (req, res) => {
  await AuthSession.updateOne(
    { _id: req.actor.sessionId, user: req.actor.id },
    { $set: { revokedAt: new Date() } },
  );
  ok(res, { loggedOut: true });
});
authRouter.post('/logout-all', authenticate, async (req, res) => {
  await User.updateOne({ _id: req.actor.id }, { $inc: { tokenVersion: 1 } });
  await AuthSession.updateMany(
    { user: req.actor.id, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );
  ok(res, { loggedOut: true });
});
authRouter.post('/forgot-password', validate(z.object({ email }).strict()), async (req, res) => {
  await auth.forgot(req.body.email);
  ok(res, {
    message: 'If recovery is available for this account, reset instructions have been sent',
  });
});
authRouter.post(
  '/reset-password',
  validate(z.object({ token: z.string().length(64), password }).strict()),
  async (req, res) => {
    await auth.reset(req.body.token, req.body.password);
    ok(res, { reset: true });
  },
);
authRouter.get('/me', authenticate, async (req, res) => ok(res, await User.findById(req.actor.id)));
authRouter.patch(
  '/me',
  authenticate,
  validate(z.object({ name: name.optional(), phone: phone.optional() }).strict()),
  async (req, res) =>
    ok(
      res,
      await User.findByIdAndUpdate(
        req.actor.id,
        { $set: req.body },
        { new: true, runValidators: true },
      ),
    ),
);
