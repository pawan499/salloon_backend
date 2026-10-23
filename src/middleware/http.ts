import type { RequestHandler, ErrorRequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { ZodError, type ZodTypeAny } from 'zod';
import { env } from '../config/env.js';
import { AuthSession, User } from '../models/index.js';
import { ApiError, assert, logger } from '../utils/core.js';
export const validate =
  (schema: ZodTypeAny): RequestHandler =>
  (req, _res, next) => {
    req.body = schema.parse(req.body);
    next();
  };
export const authenticate: RequestHandler = async (req, _res, next) => {
  const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  assert(token, 401, 'Authentication required');
  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      algorithms: ['HS256'],
      issuer: 'salon-api',
      audience: 'salon-client',
    }) as jwt.JwtPayload;
  } catch {
    throw new ApiError(401, 'Invalid or expired access token');
  }
  const user = await User.findOne({ _id: payload.sub, active: true });
  const session = await AuthSession.findOne({
    _id: payload.sid,
    user: payload.sub,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  });
  assert(user && session && user.tokenVersion === payload.ver, 401, 'Session invalidated');
  req.actor = {
    id: user.id,
    role: user.role as Express.Request['actor']['role'],
    salon: user.salon?.toString(),
    sessionId: session.id,
  };
  next();
};
export const roles =
  (...allowed: string[]): RequestHandler =>
  (req, _res, next) => {
    assert(allowed.includes(req.actor.role), 403, 'Insufficient permissions');
    next();
  };
export const requireSalon: RequestHandler = (req, _res, next) => {
  assert(req.actor.salon, 403, 'Join a salon first');
  next();
};
export const errors: ErrorRequestHandler = (err, req, res, _next) => {
  let status = 500,
    message = 'Internal server error',
    code = 'INTERNAL_ERROR',
    details: unknown;
  if (err instanceof ApiError) {
    status = err.status;
    message = err.message;
    code = err.code;
  } else if (err instanceof ZodError) {
    status = 400;
    message = 'Invalid request';
    code = 'VALIDATION_ERROR';
    details = err.issues;
  } else if (
    err instanceof mongoose.Error.ValidationError ||
    err instanceof mongoose.Error.CastError ||
    err instanceof mongoose.Error.StrictModeError
  ) {
    status = 400;
    message = 'Invalid data';
    code = 'VALIDATION_ERROR';
  } else if (err?.code === 11000) {
    status = 409;
    message = 'Record already exists or request conflicts';
    code = 'CONFLICT';
  } else if (err?.status === 400 || err?.status === 413) {
    status = err.status;
    message = 'Invalid request body';
    code = 'INVALID_BODY';
  }
  if (status === 500)
    logger.error(
      { err: { name: err?.name, code: err?.code }, requestId: req.id },
      'Request failed',
    );
  res.status(status).json({
    success: false,
    error: { code, message, ...(details ? { details } : {}) },
    requestId: req.id,
  });
};
