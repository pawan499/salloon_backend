import { Schema, model } from 'mongoose';
const O = Schema.Types.ObjectId;
const ref = (name: string, required = true) => ({ type: O, ref: name, required });
const money = { type: Number, min: 0, validate: Number.isSafeInteger, required: true };
const options = { timestamps: true, strict: 'throw' as const };
const hours = new Schema(
  {
    day: { type: Number, min: 1, max: 7, required: true },
    open: { type: String, required: true },
    close: { type: String, required: true },
    closed: { type: Boolean, default: false },
  },
  { _id: false },
);
const user = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, lowercase: true, trim: true, unique: true },
    phone: String,
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ['customer', 'owner', 'staff'], default: 'customer' },
    salon: ref('Salon', false),
    active: { type: Boolean, default: true },
    tokenVersion: { type: Number, default: 0 },
    resetHash: { type: String, select: false },
    resetExpires: { type: Date, select: false },
  },
  options,
);
user.set('toJSON', {
  transform(_doc, ret: Record<string, unknown>) {
    delete ret.passwordHash;
    delete ret.resetHash;
    delete ret.resetExpires;
    delete ret.__v;
    return ret;
  },
});
export const User = model('User', user);
export const Salon = model(
  'Salon',
  new Schema(
    {
      name: { type: String, required: true },
      address: { type: String, required: true },
      phone: String,
      email: String,
      timezone: { type: String, default: 'Asia/Kolkata' },
      currency: { type: String, default: 'INR' },
      hours: [hours],
      owner: ref('User'),
      active: { type: Boolean, default: true },
    },
    options,
  ),
);
const customer = new Schema(
  {
    salon: ref('Salon'),
    user: ref('User', false),
    name: { type: String, required: true },
    phone: String,
    email: String,
    notes: String,
    consent: { type: Boolean, default: false },
    channel: { type: String, enum: ['sms', 'whatsapp'], default: 'sms' },
    referralCode: { type: String, required: true, unique: true },
    lastVisitAt: Date,
    lastService: ref('Service', false),
    visitCount: { type: Number, default: 0 },
    bookingVersion: { type: Number, default: 0 },
  },
  options,
);
customer.index(
  { salon: 1, user: 1 },
  { unique: true, partialFilterExpression: { user: { $type: 'objectId' } } },
);
customer.index({ salon: 1, name: 1 });
customer.index({ salon: 1, phone: 1 });
export const Customer = model('Customer', customer);
const addon = new Schema({
  name: { type: String, required: true },
  price: money,
  duration: { type: Number, min: 0, required: true },
  active: { type: Boolean, default: true },
});
export const Service = model(
  'Service',
  new Schema(
    {
      salon: ref('Salon'),
      category: { type: String, required: true },
      name: { type: String, required: true },
      description: String,
      price: money,
      duration: { type: Number, min: 1, max: 720, required: true },
      reminderDays: { type: Number, min: 1, default: 30 },
      active: { type: Boolean, default: true },
      addons: [addon],
    },
    options,
  ).index({ salon: 1, active: 1 }),
);
export const Staff = model(
  'Staff',
  new Schema(
    {
      salon: ref('Salon'),
      user: { ...ref('User'), unique: true },
      name: { type: String, required: true },
      skills: [String],
      services: [ref('Service')],
      hours: [hours],
      timeOff: [{ start: { type: Date, required: true }, end: { type: Date, required: true } }],
      active: { type: Boolean, default: true },
      bookingVersion: { type: Number, default: 0 },
    },
    options,
  ).index({ salon: 1, active: 1 }),
);
const item = new Schema(
  {
    service: ref('Service'),
    name: String,
    price: money,
    duration: { type: Number, required: true },
    reminderDays: Number,
    addons: [{ addonId: O, name: String, price: money, duration: Number }],
  },
  { _id: false },
);
const booking = new Schema(
  {
    salon: ref('Salon'),
    customer: ref('Customer'),
    staff: ref('Staff'),
    items: [item],
    start: { type: Date, required: true },
    end: { type: Date, required: true },
    total: money,
    status: {
      type: String,
      enum: ['pending', 'confirmed', 'completed', 'cancelled', 'no-show'],
      default: 'confirmed',
    },
    paymentStatus: {
      type: String,
      enum: ['unpaid', 'paid', 'refund-pending', 'refunded'],
      default: 'unpaid',
    },
    source: { type: String, enum: ['online', 'walk-in', 'reminder'], default: 'online' },
    reminder: ref('Reminder', false),
    createdBy: ref('User'),
    cancellationReason: String,
  },
  options,
);
booking.index({ salon: 1, staff: 1, status: 1, start: 1, end: 1 });
booking.index({ salon: 1, customer: 1, start: -1 });
export const Booking = model('Booking', booking);
export const Visit = model(
  'Visit',
  new Schema(
    {
      salon: ref('Salon'),
      booking: { ...ref('Booking'), unique: true },
      customer: ref('Customer'),
      staff: ref('Staff'),
      total: money,
      completedAt: { type: Date, required: true },
    },
    options,
  ).index({ salon: 1, completedAt: 1 }),
);
const payment = new Schema(
  {
    salon: ref('Salon'),
    customer: ref('Customer'),
    booking: ref('Booking', false),
    amount: money,
    currency: { type: String, required: true },
    purpose: { type: String, enum: ['booking', 'topup'], required: true },
    method: { type: String, enum: ['cash', 'provider', 'credit'], required: true },
    status: {
      type: String,
      enum: ['pending', 'verified', 'refund-pending', 'refunded'],
      default: 'pending',
    },
    providerReference: String,
    idempotencyKey: { type: String, required: true },
    refundReason: String,
    paidPart: Number,
    bonusPart: Number,
  },
  options,
);
payment.index({ salon: 1, idempotencyKey: 1 }, { unique: true });
payment.index(
  { providerReference: 1 },
  { unique: true, partialFilterExpression: { providerReference: { $type: 'string' } } },
);
payment.index(
  { booking: 1 },
  { unique: true, partialFilterExpression: { purpose: 'booking', status: 'verified' } },
);
export const Payment = model('Payment', payment);
const wallet = new Schema(
  {
    salon: ref('Salon'),
    customer: ref('Customer'),
    type: {
      type: String,
      enum: ['topup', 'debit', 'refund', 'reversal', 'adjustment', 'reward', 'expiry'],
      required: true,
    },
    paid: { type: Number, required: true, validate: Number.isSafeInteger },
    bonus: { type: Number, required: true, validate: Number.isSafeInteger },
    remainingPaid: { type: Number, default: 0, min: 0 },
    remainingBonus: { type: Number, default: 0, min: 0 },
    expiresAt: Date,
    status: { type: String, enum: ['posted'], default: 'posted' },
    payment: ref('Payment', false),
    original: ref('WalletTransaction', false),
    allocations: [{ lot: ref('WalletTransaction'), paid: Number, bonus: Number, expiresAt: Date }],
    reason: { type: String, required: true },
    idempotencyKey: { type: String, required: true },
  },
  options,
);
wallet.index({ salon: 1, idempotencyKey: 1 }, { unique: true });
wallet.index({ salon: 1, customer: 1, expiresAt: 1 });
export const WalletTransaction = model('WalletTransaction', wallet);
export const Referral = model(
  'Referral',
  new Schema(
    {
      salon: ref('Salon'),
      referrer: ref('Customer'),
      referred: ref('Customer'),
      code: { type: String, required: true },
      status: { type: String, enum: ['pending', 'rewarded'], default: 'pending' },
      qualifyingBooking: ref('Booking', false),
      reward: { type: Number, default: 0 },
      rewardedAt: Date,
    },
    options,
  ).index({ salon: 1, referred: 1 }, { unique: true }),
);
export const Reminder = model(
  'Reminder',
  new Schema(
    {
      salon: ref('Salon'),
      customer: ref('Customer'),
      service: ref('Service'),
      visit: ref('Visit'),
      dueAt: { type: Date, required: true },
      status: {
        type: String,
        enum: ['scheduled', 'processing', 'sent', 'delivered', 'failed', 'blocked', 'cancelled'],
        default: 'scheduled',
      },
      attempts: { type: Number, default: 0 },
      lockedAt: Date,
      providerId: String,
      error: String,
    },
    options,
  )
    .index({ visit: 1, service: 1 }, { unique: true })
    .index({ status: 1, dueAt: 1 }),
);
export const SalonSettings = model(
  'SalonSettings',
  new Schema(
    {
      salon: { ...ref('Salon'), unique: true },
      topupBonusPercent: { type: Number, default: 0, min: 0, max: 100 },
      creditExpiryDays: { type: Number, default: 365, min: 1 },
      referralReward: { type: Number, default: 0, min: 0 },
      referralMinimumBill: { type: Number, default: 0, min: 0 },
      cancellationHours: { type: Number, default: 2, min: 0 },
    },
    options,
  ),
);
export const AuditLog = model(
  'AuditLog',
  new Schema(
    {
      salon: ref('Salon', false),
      actor: ref('User'),
      action: { type: String, required: true },
      entity: { type: String, required: true },
      entityId: { type: String, required: true },
      reason: String,
    },
    options,
  ).index({ salon: 1, createdAt: -1 }),
);
export const AuthSession = model(
  'AuthSession',
  new Schema(
    {
      user: ref('User'),
      tokenHash: { type: String, required: true, unique: true },
      expiresAt: { type: Date, required: true },
      revokedAt: Date,
    },
    options,
  ).index({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
);
export const models = {
  User,
  Salon,
  Customer,
  Service,
  Staff,
  Booking,
  Visit,
  Payment,
  WalletTransaction,
  Referral,
  Reminder,
  SalonSettings,
  AuditLog,
  AuthSession,
};
