import { z } from 'zod';
import { env } from '../config/env.js';
import { ApiError, assert } from '../utils/core.js';
async function post(url: string, token: string, body: unknown, idempotencyKey?: string) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
    redirect: 'error',
  });
  if (!response.ok) throw new ApiError(502, 'Provider request failed');
  return response.json();
}
export const paymentProvider = {
  async verify(reference: string) {
    assert(
      env.PAYMENT_PROVIDER_URL && env.PAYMENT_PROVIDER_TOKEN,
      503,
      'Payment verification provider not configured',
    );
    return z
      .object({
        reference: z.string(),
        status: z.literal('paid'),
        amount: z.number().int().positive(),
        currency: z.string(),
        customerId: z.string(),
        salonId: z.string(),
        purpose: z.enum(['booking', 'topup']),
        bookingId: z.string().optional(),
      })
      .parse(
        await post(`${env.PAYMENT_PROVIDER_URL}/verify`, env.PAYMENT_PROVIDER_TOKEN, { reference }),
      );
  },
  async refund(reference: string, amount: number, idempotencyKey: string) {
    assert(
      env.PAYMENT_PROVIDER_URL && env.PAYMENT_PROVIDER_TOKEN,
      503,
      'Payment provider not configured',
    );
    return z
      .object({ reference: z.string(), status: z.literal('refunded'), amount: z.number().int() })
      .parse(
        await post(
          `${env.PAYMENT_PROVIDER_URL}/refund`,
          env.PAYMENT_PROVIDER_TOKEN,
          { reference, amount },
          idempotencyKey,
        ),
      );
  },
};
export const messagingProvider = {
  get configured() {
    return Boolean(env.MESSAGE_PROVIDER_URL && env.MESSAGE_PROVIDER_TOKEN);
  },
  async send(to: string, channel: string, message: string, idempotencyKey: string) {
    assert(
      env.MESSAGE_PROVIDER_URL && env.MESSAGE_PROVIDER_TOKEN,
      503,
      'Messaging provider not configured',
    );
    return z
      .object({ id: z.string(), status: z.enum(['accepted', 'delivered']) })
      .parse(
        await post(
          `${env.MESSAGE_PROVIDER_URL}/messages`,
          env.MESSAGE_PROVIDER_TOKEN,
          { to, channel, message },
          idempotencyKey,
        ),
      );
  },
};
