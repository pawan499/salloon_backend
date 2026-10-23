import { createHash, randomBytes } from 'node:crypto';
import type { Response } from 'express';
import mongoose, { type ClientSession } from 'mongoose';
import pino from 'pino';
export const logger = pino({
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'password',
      'passwordHash',
      'accessToken',
      'refreshToken',
      'token',
      'secret',
    ],
    censor: '[REDACTED]',
  },
});
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = 'REQUEST_FAILED',
  ) {
    super(message);
  }
}
export function assert(
  condition: unknown,
  status: number,
  message: string,
  code?: string,
): asserts condition {
  if (!condition) throw new ApiError(status, message, code);
}
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const randomToken = () => randomBytes(32).toString('hex');
export const ok = (res: Response, data: unknown, status = 200, meta?: unknown) =>
  res.status(status).json({ success: true, data, ...(meta ? { meta } : {}) });
export async function transaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  return mongoose.connection.transaction(fn, {
    readConcern: { level: 'snapshot' },
    writeConcern: { w: 'majority' },
  }) as Promise<T>;
}
export const page = (q: Record<string, unknown>) => {
  const current = Math.max(1, Math.min(100000, Number(q.page) || 1));
  const limit = Math.max(1, Math.min(100, Number(q.limit) || 20));
  return { current, limit, skip: (current - 1) * limit };
};
export const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
