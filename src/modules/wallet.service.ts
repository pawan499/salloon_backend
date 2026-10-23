import type { ClientSession } from 'mongoose';
import {
  Booking,
  Customer,
  Payment,
  Referral,
  Salon,
  SalonSettings,
  Visit,
  WalletTransaction,
} from '../models/index.js';
import { assert, transaction } from '../utils/core.js';
import { audit, bookingAccess, customerAccess, type Actor } from '../services/access.js';
import { paymentProvider } from '../services/providers.js';
async function lockCustomer(salon: any, customer: any, session: ClientSession) {
  const doc = await Customer.findOneAndUpdate(
    { _id: customer, salon },
    { $inc: { bookingVersion: 1 } },
    { session },
  );
  assert(doc, 404, 'Customer not found');
}
export async function expireCredit(salon: any, customer: any, session: ClientSession) {
  const lots = await WalletTransaction.find({
    salon,
    customer,
    expiresAt: { $lte: new Date() },
    $or: [{ remainingPaid: { $gt: 0 } }, { remainingBonus: { $gt: 0 } }],
  }).session(session);
  for (const lot of lots) {
    await WalletTransaction.create(
      [
        {
          salon,
          customer,
          type: 'expiry',
          paid: -lot.remainingPaid,
          bonus: -lot.remainingBonus,
          original: lot._id,
          reason: 'Credit expired',
          idempotencyKey: `expiry:${lot.id}`,
        },
      ],
      { session },
    );
    lot.remainingPaid = 0;
    lot.remainingBonus = 0;
    await lot.save({ session });
  }
}
async function credit(
  salon: any,
  customer: any,
  paid: number,
  bonus: number,
  type: string,
  key: string,
  reason: string,
  session: ClientSession,
  extra: Record<string, unknown> = {},
) {
  const settings = await SalonSettings.findOne({ salon }).session(session);
  const [entry] = await WalletTransaction.create(
    [
      {
        salon,
        customer,
        type,
        paid,
        bonus,
        remainingPaid: paid,
        remainingBonus: bonus,
        expiresAt: new Date(Date.now() + (settings?.creditExpiryDays ?? 365) * 86400000),
        idempotencyKey: key,
        reason,
        ...extra,
      },
    ],
    { session },
  );
  return entry;
}
async function debit(
  salon: any,
  customer: any,
  amount: number,
  key: string,
  reason: string,
  session: ClientSession,
  type = 'debit',
) {
  await expireCredit(salon, customer, session);
  const lots = await WalletTransaction.find({
    salon,
    customer,
    $or: [{ remainingPaid: { $gt: 0 } }, { remainingBonus: { $gt: 0 } }],
  })
    .sort({ expiresAt: 1, _id: 1 })
    .session(session);
  assert(
    lots.reduce((n, l) => n + l.remainingPaid + l.remainingBonus, 0) >= amount,
    409,
    'Insufficient store credit',
  );
  let remaining = amount,
    paid = 0,
    bonus = 0;
  const allocations: any[] = [];
  for (const lot of lots) {
    if (!remaining) break;
    const b = Math.min(lot.remainingBonus, remaining);
    remaining -= b;
    const p = Math.min(lot.remainingPaid, remaining);
    remaining -= p;
    lot.remainingBonus -= b;
    lot.remainingPaid -= p;
    paid += p;
    bonus += b;
    allocations.push({ lot: lot._id, paid: p, bonus: b, expiresAt: lot.expiresAt });
    await lot.save({ session });
  }
  const [entry] = await WalletTransaction.create(
    [
      {
        salon,
        customer,
        type,
        paid: -paid,
        bonus: -bonus,
        reason,
        idempotencyKey: key,
        allocations,
      },
    ],
    { session },
  );
  return entry;
}
export async function walletBalance(actor: Actor, customerId?: string) {
  return transaction(async (session) => {
    const customer = await customerAccess(actor, customerId, session);
    await lockCustomer(actor.salon, customer._id, session);
    await expireCredit(actor.salon, customer._id, session);
    const lots = await WalletTransaction.find({
      salon: actor.salon,
      customer: customer._id,
      $or: [{ remainingPaid: { $gt: 0 } }, { remainingBonus: { $gt: 0 } }],
    }).session(session);
    return {
      customerId: customer.id,
      paid: lots.reduce((n, l) => n + l.remainingPaid, 0),
      bonus: lots.reduce((n, l) => n + l.remainingBonus, 0),
    };
  });
}
export async function adjustWallet(
  actor: Actor,
  input: {
    customerId: string;
    amount: number;
    direction: 'credit' | 'debit';
    bucket: 'paid' | 'bonus';
    reason: string;
    idempotencyKey: string;
  },
) {
  return transaction(async (session) => {
    await customerAccess(actor, input.customerId, session);
    await lockCustomer(actor.salon, input.customerId, session);
    const existing = await WalletTransaction.findOne({
      salon: actor.salon,
      idempotencyKey: input.idempotencyKey,
    }).session(session);
    if (existing) {
      assert(
        existing.customer.toString() === input.customerId &&
          existing.type === 'adjustment' &&
          Math.abs(existing.paid + existing.bonus) === input.amount &&
          existing.reason === input.reason &&
          (input.direction === 'debit' ||
            (input.bucket === 'paid' ? existing.bonus === 0 : existing.paid === 0)) &&
          existing.paid + existing.bonus > 0 === (input.direction === 'credit'),
        409,
        'Idempotency key reused with different request',
      );
      return existing;
    }
    const entry =
      input.direction === 'credit'
        ? await credit(
            actor.salon,
            input.customerId,
            input.bucket === 'paid' ? input.amount : 0,
            input.bucket === 'bonus' ? input.amount : 0,
            'adjustment',
            input.idempotencyKey,
            input.reason,
            session,
          )
        : await debit(
            actor.salon,
            input.customerId,
            input.amount,
            input.idempotencyKey,
            input.reason,
            session,
            'adjustment',
          );
    await audit(actor, 'wallet.adjustment', 'WalletTransaction', entry.id, session, input.reason);
    return entry;
  });
}
export async function recordPayment(
  actor: Actor,
  input: {
    customerId?: string;
    bookingId?: string;
    amount: number;
    purpose: 'booking' | 'topup';
    method: 'cash' | 'provider' | 'credit';
    reference?: string;
    idempotencyKey: string;
  },
) {
  // Provider verification is read-only. Never make external mutations in a retryable transaction.
  let verified;
  if (input.method === 'provider') {
    assert(input.reference, 400, 'Provider reference required');
    verified = await paymentProvider.verify(input.reference);
  }
  return transaction(async (session) => {
    const customer = await customerAccess(actor, input.customerId, session);
    await lockCustomer(actor.salon, customer._id, session);
    const existing = await Payment.findOne({
      salon: actor.salon,
      idempotencyKey: input.idempotencyKey,
    }).session(session);
    if (existing) {
      assert(
        existing.customer.equals(customer._id) &&
          existing.amount === input.amount &&
          existing.purpose === input.purpose &&
          existing.method === input.method &&
          (existing.booking?.toString() || undefined) === input.bookingId &&
          existing.providerReference === input.reference,
        409,
        'Idempotency key reused with different request',
      );
      return existing;
    }
    const salon = await Salon.findById(actor.salon).session(session);
    assert(salon, 404, 'Salon not found');
    assert(
      input.method !== 'cash' || actor.role !== 'customer',
      403,
      'Cash receipt requires staff verification',
    );
    assert(
      input.purpose !== 'topup' || input.method !== 'credit',
      400,
      'Store credit cannot top up itself',
    );
    if (verified)
      assert(
        verified.reference === input.reference &&
          verified.amount === input.amount &&
          verified.currency === salon.currency &&
          verified.customerId === customer.id &&
          verified.salonId === salon.id &&
          verified.purpose === input.purpose &&
          verified.bookingId === input.bookingId,
        409,
        'Provider payment does not match this purchase',
      );
    let booking;
    if (input.purpose === 'booking') {
      assert(input.bookingId, 400, 'Booking required');
      booking = await Booking.findOne({
        _id: input.bookingId,
        salon: actor.salon,
        customer: customer._id,
      }).session(session);
      await bookingAccess(actor, booking, session);
      assert(
        booking &&
          ['pending', 'confirmed'].includes(booking.status!) &&
          booking.paymentStatus === 'unpaid',
        409,
        'Booking cannot accept payment',
      );
      assert(booking.total === input.amount, 400, 'Amount must equal the booking total');
    } else assert(!input.bookingId, 400, 'Top-up cannot reference booking');
    let entry;
    if (input.method === 'credit')
      entry = await debit(
        actor.salon,
        customer._id,
        input.amount,
        `payment:${input.idempotencyKey}`,
        'Booking payment',
        session,
      );
    const [payment] = await Payment.create(
      [
        {
          salon: actor.salon,
          customer: customer._id,
          booking: booking?._id,
          amount: input.amount,
          currency: salon.currency,
          purpose: input.purpose,
          method: input.method,
          status: 'verified',
          providerReference: input.reference,
          idempotencyKey: input.idempotencyKey,
          paidPart: entry ? -entry.paid : input.amount,
          bonusPart: entry ? -entry.bonus : 0,
        },
      ],
      { session },
    );
    if (entry) {
      entry.payment = payment._id;
      await entry.save({ session });
    }
    if (input.purpose === 'topup') {
      const settings = await SalonSettings.findOne({ salon: actor.salon }).session(session);
      await credit(
        actor.salon,
        customer._id,
        input.amount,
        Math.floor((input.amount * (settings?.topupBonusPercent ?? 0)) / 100),
        'topup',
        `topup:${payment.id}`,
        'Verified top-up',
        session,
        { payment: payment._id },
      );
    }
    if (booking) {
      booking.paymentStatus = 'paid';
      await booking.save({ session });
    }
    await audit(actor, 'payment.verified', 'Payment', payment.id, session);
    return payment;
  });
}
async function reverseReferralReward(payment: any, session: ClientSession) {
  const referral = await Referral.findOne({
    salon: payment.salon,
    qualifyingBooking: payment.booking,
    status: 'rewarded',
  }).session(session);
  if (!referral) return;
  await lockCustomer(payment.salon, referral.referrer, session);
  if (referral.reward > 0)
    await debit(
      payment.salon,
      referral.referrer,
      referral.reward,
      `reward-reversal:${referral.id}`,
      'Qualifying visit refunded',
      session,
      'reversal',
    );
  referral.status = 'pending';
  referral.set('qualifyingBooking', undefined);
  referral.rewardedAt = undefined;
  await referral.save({ session });
}
export async function refundPayment(actor: Actor, paymentId: string, reason: string) {
  // Reserve the refund and any referral clawback before touching the external provider.
  // A crash/timeout leaves a durable refund-pending payment; retry the same endpoint.
  const reserved = await transaction(async (session) => {
    const payment = await Payment.findOne({ _id: paymentId, salon: actor.salon }).session(session);
    assert(payment, 404, 'Payment not found');
    assert(payment.purpose === 'booking', 400, 'Use top-up reversal for store-credit purchases');
    if (payment.status === 'refunded' || payment.status === 'refund-pending') return payment;
    assert(payment.status === 'verified', 409, 'Payment not verified');
    await lockCustomer(actor.salon, payment.customer, session);
    await reverseReferralReward(payment, session);
    payment.status = 'refund-pending';
    payment.refundReason = reason;
    await payment.save({ session });
    // No further completion/payment may occur while the refund is pending.
    await Booking.updateOne(
      { _id: payment.booking, salon: actor.salon },
      { $set: { paymentStatus: 'refund-pending' } },
      { session },
    );
    await audit(actor, 'payment.refund-requested', 'Payment', payment.id, session, reason);
    return payment;
  });
  if (reserved.status === 'refunded') return reserved;
  if (reserved.method === 'provider') {
    const result = await paymentProvider.refund(
      reserved.providerReference!,
      reserved.amount,
      `refund:${reserved.id}`,
    );
    assert(
      result.reference === reserved.providerReference && result.amount === reserved.amount,
      502,
      'Provider refund mismatch',
    );
  }
  return transaction(async (session) => {
    const payment = await Payment.findOne({ _id: paymentId, salon: actor.salon }).session(session);
    assert(payment, 404, 'Payment not found');
    if (payment.status === 'refunded') return payment;
    assert(payment.status === 'refund-pending', 409, 'Refund not reserved');
    await lockCustomer(actor.salon, payment.customer, session);
    if (payment.method === 'credit') {
      const source = await WalletTransaction.findOne({
        payment: payment._id,
        type: 'debit',
        salon: actor.salon,
      }).session(session);
      assert(source, 409, 'Original debit missing');
      for (const [index, a] of source.allocations.entries())
        await WalletTransaction.create(
          [
            {
              salon: actor.salon,
              customer: payment.customer,
              type: 'refund',
              paid: a.paid,
              bonus: a.bonus,
              remainingPaid: a.paid,
              remainingBonus: a.bonus,
              expiresAt: a.expiresAt,
              original: source._id,
              payment: payment._id,
              reason: payment.refundReason,
              idempotencyKey: `refund:${payment.id}:${index}`,
            },
          ],
          { session },
        );
      await expireCredit(actor.salon, payment.customer, session);
    }
    payment.status = 'refunded';
    await payment.save({ session });
    await Booking.updateOne(
      { _id: payment.booking, salon: actor.salon },
      { $set: { paymentStatus: 'refunded' } },
      { session },
    );
    await audit(
      actor,
      'payment.refund',
      'Payment',
      payment.id,
      session,
      payment.refundReason ?? undefined,
    );
    return payment;
  });
}
export async function reverseTopup(actor: Actor, paymentId: string, reason: string) {
  // Reversal moves unused store credit out of circulation. Provider cash refund follows
  // separately through provider's dashboard; this endpoint never claims money was returned.
  return transaction(async (session) => {
    const payment = await Payment.findOne({
      _id: paymentId,
      salon: actor.salon,
      purpose: 'topup',
    }).session(session);
    assert(payment, 404, 'Top-up not found');
    await lockCustomer(actor.salon, payment.customer, session);
    const key = `topup-reversal:${payment.id}`;
    const prior = await WalletTransaction.findOne({
      salon: actor.salon,
      idempotencyKey: key,
    }).session(session);
    if (prior) return prior;
    const lot = await WalletTransaction.findOne({ payment: payment._id, type: 'topup' }).session(
      session,
    );
    assert(
      lot && lot.remainingPaid === lot.paid && lot.remainingBonus === lot.bonus,
      409,
      'Only wholly unused, unexpired top-ups can be reversed',
    );
    assert(!lot.expiresAt || lot.expiresAt > new Date(), 409, 'Top-up expired');
    const [entry] = await WalletTransaction.create(
      [
        {
          salon: actor.salon,
          customer: payment.customer,
          type: 'reversal',
          paid: -lot.paid,
          bonus: -lot.bonus,
          original: lot._id,
          payment: payment._id,
          reason,
          idempotencyKey: key,
        },
      ],
      { session },
    );
    lot.remainingPaid = 0;
    lot.remainingBonus = 0;
    await lot.save({ session });
    await audit(actor, 'wallet.topup-reversal', 'WalletTransaction', entry.id, session, reason);
    return entry;
  });
}
export async function claimReferral(actor: Actor, code: string) {
  return transaction(async (session) => {
    const customer = await customerAccess(actor, undefined, session);
    await lockCustomer(actor.salon, customer._id, session);
    const referrer = await Customer.findOne({ salon: actor.salon, referralCode: code }).session(
      session,
    );
    assert(referrer && referrer.id !== customer.id, 400, 'Invalid or self referral');
    assert(
      !(await Visit.exists({ salon: actor.salon, customer: customer._id }).session(session)),
      409,
      'Referral must be claimed before first completed visit',
    );
    const [referral] = await Referral.create(
      [{ salon: actor.salon, referrer: referrer._id, referred: customer._id, code }],
      { session },
    );
    return referral;
  });
}
export function eligibleReward(
  visitCount: number,
  amount: number,
  minimum: number,
  method: string,
) {
  return visitCount === 1 && amount > 0 && amount >= minimum && method !== 'credit';
}
export async function releaseReward(booking: any, session: ClientSession) {
  const referral = await Referral.findOne({
    salon: booking.salon,
    referred: booking.customer,
    status: 'pending',
  }).session(session);
  if (!referral) return;
  const settings = await SalonSettings.findOne({ salon: booking.salon }).session(session);
  const payment = await Payment.findOne({
    booking: booking._id,
    salon: booking.salon,
    status: 'verified',
  }).session(session);
  const visits = await Visit.countDocuments({
    salon: booking.salon,
    customer: booking.customer,
  }).session(session);
  if (
    !payment ||
    !eligibleReward(visits, payment.amount, settings?.referralMinimumBill ?? 0, payment.method)
  )
    return;
  await lockCustomer(booking.salon, referral.referrer, session);
  const reward = settings?.referralReward ?? 0;
  if (reward > 0)
    await credit(
      booking.salon,
      referral.referrer,
      0,
      reward,
      'reward',
      `referral:${referral.id}`,
      'Eligible paid first visit',
      session,
    );
  referral.status = 'rewarded';
  referral.reward = reward;
  referral.qualifyingBooking = booking._id;
  referral.rewardedAt = new Date();
  await referral.save({ session });
}
