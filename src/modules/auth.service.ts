import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { AuthSession, User } from '../models/index.js';
import { assert, hash, randomToken, transaction } from '../utils/core.js';
import { messagingProvider } from '../services/providers.js';
import type { ClientSession } from 'mongoose';
async function tokens(user: any, session?: ClientSession) {
  const sid = new (await import('mongoose')).Types.ObjectId();
  const refreshToken = jwt.sign(
    { sid: sid.toString(), nonce: randomToken(), ver: user.tokenVersion },
    env.JWT_REFRESH_SECRET,
    {
      subject: user.id,
      expiresIn: '30d',
      issuer: 'salon-api',
      audience: 'salon-refresh',
      algorithm: 'HS256',
    },
  );
  await AuthSession.create(
    [
      {
        _id: sid,
        user: user._id,
        tokenHash: hash(refreshToken),
        expiresAt: new Date(Date.now() + 30 * 86400000),
      },
    ],
    { session },
  );
  const accessToken = jwt.sign(
    { sid: sid.toString(), ver: user.tokenVersion },
    env.JWT_ACCESS_SECRET,
    {
      subject: user.id,
      expiresIn: '15m',
      issuer: 'salon-api',
      audience: 'salon-client',
      algorithm: 'HS256',
    },
  );
  return { user, accessToken, refreshToken, expiresIn: 900 };
}
export async function register(input: {
  name: string;
  email: string;
  password: string;
  phone?: string;
}) {
  const passwordHash = await bcrypt.hash(input.password, 12);
  return transaction(async (session) => {
    const [user] = await User.create(
      [
        {
          name: input.name,
          email: input.email,
          phone: input.phone,
          passwordHash,
          role: 'customer',
        },
      ],
      { session },
    );
    return tokens(user, session);
  });
}
export async function login(email: string, password: string) {
  const user = await User.findOne({ email, active: true }).select('+passwordHash');
  // Fixed-cost comparison also performed for unknown accounts.
  const fallback = '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6Ttx5NMOfPbcCOFXKcdv3pP1UQZ.K';
  const valid = await bcrypt.compare(password, user?.passwordHash || fallback);
  assert(user && valid, 401, 'Invalid email or password');
  return tokens(user);
}
export async function refresh(token: string) {
  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(token, env.JWT_REFRESH_SECRET, {
      algorithms: ['HS256'],
      issuer: 'salon-api',
      audience: 'salon-refresh',
    }) as jwt.JwtPayload;
  } catch {
    assert(false, 401, 'Invalid refresh token');
  }
  return transaction(async (session) => {
    const old = await AuthSession.findOneAndUpdate(
      {
        _id: payload.sid,
        tokenHash: hash(token),
        user: payload.sub,
        revokedAt: null,
        expiresAt: { $gt: new Date() },
      },
      { $set: { revokedAt: new Date() } },
      { session },
    );
    const user = await User.findOne({
      _id: payload.sub,
      active: true,
      tokenVersion: payload.ver,
    }).session(session);
    assert(old && user, 401, 'Refresh token already used or revoked');
    return tokens(user, session);
  });
}
export async function forgot(email: string) {
  assert(
    messagingProvider.configured,
    503,
    'Password recovery messaging unavailable; contact salon owner',
  );
  const user = await User.findOne({ email, active: true });
  if (!user?.phone) return;
  const token = randomToken();
  await User.updateOne(
    { _id: user._id },
    { $set: { resetHash: hash(token), resetExpires: new Date(Date.now() + 30 * 60000) } },
  );
  await messagingProvider.send(
    user.phone,
    'sms',
    `Reset your password: ${env.PUBLIC_APP_URL}/reset-password?token=${token}`,
    `reset:${hash(token)}`,
  );
}
export async function reset(token: string, password: string) {
  const passwordHash = await bcrypt.hash(password, 12);
  await transaction(async (session) => {
    const user = await User.findOneAndUpdate(
      { resetHash: hash(token), resetExpires: { $gt: new Date() } },
      {
        $set: { passwordHash },
        $unset: { resetHash: 1, resetExpires: 1 },
        $inc: { tokenVersion: 1 },
      },
      { session },
    );
    assert(user, 400, 'Invalid or expired reset token');
    await AuthSession.updateMany(
      { user: user._id, revokedAt: null },
      { $set: { revokedAt: new Date() } },
      { session },
    );
  });
}
