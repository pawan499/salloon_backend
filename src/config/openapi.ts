// Executable OpenAPI specification shared by Swagger UI and /openapi.json.
const id = { type: 'string', pattern: '^[a-fA-F0-9]{24}$' };
const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required,
});
const str = { type: 'string' },
  amount = { type: 'integer', minimum: 0, description: 'Minor currency units (paise for INR)' };
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const paths: Record<string, any> = {};
function add(
  path: string,
  method: string,
  summary: string,
  options: {
    schema?: unknown;
    public?: boolean;
    params?: any[];
    tag?: string;
    created?: boolean;
  } = {},
) {
  const params = [
    ...Array.from(path.matchAll(/\{(\w+)\}/g), (m) => ({
      name: m[1],
      in: 'path',
      required: true,
      schema: id,
    })),
    ...(options.params || []),
  ];
  paths[path] ??= {};
  paths[path][method] = {
    summary,
    tags: [options.tag || path.split('/')[1]],
    security: options.public ? [] : [{ bearerAuth: [] }],
    ...(params.length ? { parameters: params } : {}),
    ...(options.schema
      ? {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: options.schema } },
          },
        }
      : {}),
    responses: {
      [options.created ? '201' : '200']: {
        description: 'Success envelope: { success: true, data, meta? }',
        content: { 'application/json': { schema: ref('Success') } },
      },
      '400': { description: 'Validation error' },
      '401': { description: 'Authentication required' },
      '403': { description: 'Forbidden' },
      '404': { description: 'Not found' },
      '409': { description: 'Conflict or idempotency mismatch' },
      '503': { description: 'Required provider unavailable' },
    },
  };
}
const paging = [
  { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1 } },
  { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
];
const customerParam = { name: 'customerId', in: 'query', schema: id };
add('/auth/register', 'post', 'Register customer', {
  public: true,
  schema: ref('Register'),
  created: true,
});
add('/auth/login', 'post', 'Login', {
  public: true,
  schema: object({ email: { type: 'string', format: 'email' }, password: str }, [
    'email',
    'password',
  ]),
});
add('/auth/refresh', 'post', 'Rotate one-use refresh token', {
  public: true,
  schema: object({ refreshToken: str }, ['refreshToken']),
});
for (const name of ['logout', 'logout-all']) add(`/auth/${name}`, 'post', name);
add('/auth/forgot-password', 'post', 'Send reset link using configured SMS adapter', {
  public: true,
  schema: object({ email: str }, ['email']),
});
add('/auth/reset-password', 'post', 'Reset password and invalidate sessions', {
  public: true,
  schema: object({ token: str, password: { type: 'string', minLength: 12, maxLength: 72 } }, [
    'token',
    'password',
  ]),
});
add('/auth/me', 'get', 'Current profile');
add('/auth/me', 'patch', 'Update profile', { schema: object({ name: str, phone: str }) });
add('/salons', 'get', 'List active salons', { public: true, params: paging });
add('/salons/{id}/join', 'post', 'Join salon as customer');
add('/salons/{id}/services', 'get', 'List active services', { public: true, params: paging });
add('/salons/{id}/staff', 'get', 'List public staff profiles', { public: true });
add('/salon', 'get', 'Salon profile');
add('/salon', 'patch', 'Owner: update salon', { schema: ref('Salon') });
for (const resource of ['services', 'staff', 'customers']) {
  add(`/${resource}`, 'get', `List ${resource}`, { params: paging });
  add(`/${resource}`, 'post', `Create ${resource}`, {
    schema: ref(resource === 'services' ? 'Service' : resource === 'staff' ? 'Staff' : 'Customer'),
    created: true,
  });
  add(`/${resource}/{id}`, 'patch', `Update ${resource}`, {
    schema: ref(
      resource === 'services'
        ? 'ServicePatch'
        : resource === 'staff'
          ? 'StaffPatch'
          : 'CustomerPatch',
    ),
  });
}
add('/customers/me', 'get', 'Current customer');
add('/customers/me', 'patch', 'Update own contact and consent', {
  schema: ref('CustomerSelfPatch'),
});
add('/customers/{id}', 'get', 'Customer details');
add('/customers/{id}/visits', 'get', 'Visit history', { params: paging });
add('/bookings', 'post', 'Create online, reminder or walk-in appointment', {
  schema: ref('Booking'),
  created: true,
});
add('/bookings', 'get', 'List accessible bookings', {
  params: [
    ...paging,
    ...['from', 'to', 'status'].map((name) => ({ name, in: 'query', schema: str })),
  ],
});
add('/bookings/{id}', 'get', 'Booking details');
add('/bookings/{id}/reschedule', 'patch', 'Reschedule appointment', {
  schema: object({ start: { type: 'string', format: 'date-time' } }, ['start']),
});
add('/bookings/{id}/status', 'patch', 'Confirm, cancel, complete or mark no-show', {
  schema: object(
    {
      status: { type: 'string', enum: ['confirmed', 'completed', 'cancelled', 'no-show'] },
      reason: str,
    },
    ['status'],
  ),
});
add('/wallet', 'get', 'Available paid and bonus store credit', { params: [customerParam] });
add('/wallet/transactions', 'get', 'Immutable financial history', {
  params: [customerParam, ...paging],
});
add('/wallet/adjustments', 'post', 'Owner adjustment with reason', {
  schema: object(
    {
      customerId: id,
      amount,
      direction: { type: 'string', enum: ['credit', 'debit'] },
      bucket: { type: 'string', enum: ['paid', 'bonus'] },
      reason: str,
      idempotencyKey: str,
    },
    ['customerId', 'amount', 'direction', 'bucket', 'reason', 'idempotencyKey'],
  ),
  created: true,
});
add('/payments', 'get', 'Payment history', { params: [customerParam, ...paging] });
add('/payments', 'post', 'Verify payment and settle booking or top-up', {
  schema: ref('Payment'),
  created: true,
});
for (const name of ['refund', 'reverse-topup'])
  add(`/payments/{id}/${name}`, 'post', `Owner: ${name}`, {
    schema: object({ reason: str }, ['reason']),
  });
add('/referrals/me', 'get', 'Own code and referrals');
add('/referrals', 'get', 'Owner referral list', { params: paging });
add('/referrals/claim', 'post', 'Claim before first completed visit', {
  schema: object({ code: str }, ['code']),
  created: true,
});
add('/reminders', 'get', 'Reminder status history', { params: paging });
add('/settings', 'get', 'Owner settings');
add('/settings', 'patch', 'Update salon policies', { schema: ref('Settings') });
add('/audit-logs', 'get', 'Owner audit trail', { params: paging });
add('/reports', 'get', 'Owner dashboard and daily/monthly reports', {
  params: ['from', 'to', 'group'].map((name) => ({ name, in: 'query', schema: str })),
});
const hours = {
  type: 'array',
  items: object(
    {
      day: { type: 'integer', minimum: 1, maximum: 7 },
      open: { type: 'string', example: '09:00' },
      close: { type: 'string', example: '20:00' },
      closed: { type: 'boolean' },
    },
    ['day', 'open', 'close'],
  ),
};
const customerProps = {
  name: str,
  phone: str,
  email: { type: 'string', format: 'email' },
  notes: str,
  consent: { type: 'boolean' },
  channel: { type: 'string', enum: ['sms', 'whatsapp'] },
};
const serviceProps = {
  name: str,
  category: str,
  description: str,
  price: amount,
  duration: { type: 'integer', minimum: 1, maximum: 720 },
  reminderDays: { type: 'integer', minimum: 1 },
  active: { type: 'boolean' },
  addons: {
    type: 'array',
    items: object(
      {
        _id: id,
        name: str,
        price: amount,
        duration: { type: 'integer', minimum: 0 },
        active: { type: 'boolean' },
      },
      ['name', 'price', 'duration'],
    ),
  },
};
const staffProps = {
  name: str,
  email: str,
  password: { type: 'string', minLength: 12, maxLength: 72 },
  phone: str,
  skills: { type: 'array', items: str },
  services: { type: 'array', items: id },
  hours,
  timeOff: {
    type: 'array',
    items: object(
      {
        start: { type: 'string', format: 'date-time' },
        end: { type: 'string', format: 'date-time' },
      },
      ['start', 'end'],
    ),
  },
};
add('/mobile-config', 'get', 'Safe mobile provider capabilities and customer-visible salon rules');
add(
  '/availability',
  'post',
  'Real available start suggestions; booking creation revalidates atomically',
  {
    schema: object(
      {
        staffId: id,
        date: { type: 'string', format: 'date' },
        customerId: id,
        bookingId: id,
        items: {
          type: 'array',
          items: object({ serviceId: id, addonIds: { type: 'array', items: id } }, ['serviceId']),
        },
      },
      ['staffId', 'date'],
    ),
  },
);
export const openapi = {
  openapi: '3.0.3',
  info: {
    title: 'Salon Management API',
    version: '1.0.0',
    description:
      'Amounts are minor currency units. Access is role and salon scoped. All times use ISO 8601 offsets; working hours use salon timezone. See docs/API.md for workflows and metrics.',
  },
  servers: [{ url: '/api/v1' }],
  paths,
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    schemas: {
      Success: object({ success: { type: 'boolean' }, data: {}, meta: { type: 'object' } }, [
        'success',
        'data',
      ]),
      Register: object(
        {
          name: str,
          email: { type: 'string', format: 'email' },
          password: { type: 'string', minLength: 12, maxLength: 72 },
          phone: str,
        },
        ['name', 'email', 'password'],
      ),
      Salon: object({
        name: str,
        address: str,
        phone: str,
        email: str,
        timezone: str,
        currency: str,
        hours,
      }),
      Customer: object(customerProps, ['name']),
      CustomerPatch: object(customerProps),
      CustomerSelfPatch: object({
        name: str,
        phone: str,
        email: customerProps.email,
        consent: customerProps.consent,
        channel: customerProps.channel,
      }),
      Service: object(serviceProps, ['name', 'category', 'price', 'duration']),
      ServicePatch: object(serviceProps),
      Staff: object(staffProps, ['name', 'email', 'password', 'services', 'hours']),
      StaffPatch: object({
        name: str,
        skills: staffProps.skills,
        services: staffProps.services,
        hours,
        timeOff: staffProps.timeOff,
        active: { type: 'boolean' },
      }),
      Booking: object(
        {
          customerId: id,
          staffId: id,
          items: {
            type: 'array',
            minItems: 1,
            items: object({ serviceId: id, addonIds: { type: 'array', items: id } }, ['serviceId']),
          },
          start: { type: 'string', format: 'date-time' },
          source: { type: 'string', enum: ['online', 'walk-in', 'reminder'] },
          reminderId: id,
        },
        ['staffId', 'items', 'start'],
      ),
      Payment: object(
        {
          customerId: id,
          bookingId: id,
          amount,
          purpose: { type: 'string', enum: ['booking', 'topup'] },
          method: { type: 'string', enum: ['cash', 'provider', 'credit'] },
          reference: str,
          idempotencyKey: str,
        },
        ['amount', 'purpose', 'method', 'idempotencyKey'],
      ),
      Settings: object({
        topupBonusPercent: { type: 'number', minimum: 0, maximum: 100 },
        creditExpiryDays: { type: 'integer', minimum: 1 },
        referralReward: amount,
        referralMinimumBill: amount,
        cancellationHours: { type: 'number', minimum: 0 },
      }),
    },
  },
};
