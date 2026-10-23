# API workflows

Base URL: `http://localhost:4000/api/v1`. Send JSON. Protected endpoints require `Authorization: Bearer <accessToken>`.

Success:

```json
{
  "success": true,
  "data": { "_id": "..." },
  "meta": { "current": 1, "limit": 20, "skip": 0, "total": 1 }
}
```

Error:

```json
{
  "success": false,
  "error": { "code": "BOOKING_CONFLICT", "message": "Time overlaps another booking" },
  "requestId": "..."
}
```

Lists accept `page` (default 1) and `limit` (default 20, max 100) where documented in Swagger. A total is supplied for customer and booking search. Other lists provide page metadata. All financial amounts are integer minor currency units.

## First workflow

1. Seed owner and salon using `npm run seed`.
2. `POST /auth/login` as owner:
   ```json
   { "email": "owner@example.com", "password": "your-configured-seed-password" }
   ```
   Response data includes sanitized `user`, `accessToken`, `refreshToken`, `expiresIn: 900`.
3. `GET /salons` obtains the salon ID; `GET /services` obtains service/add-on IDs.
4. Owner creates a staff account through `POST /staff`:
   ```json
   {
     "name": "Ravi",
     "email": "ravi@example.com",
     "password": "ExampleStrongPassword123",
     "skills": ["Hair"],
     "services": ["<service-id>"],
     "hours": [
       { "day": 1, "open": "09:00", "close": "20:00", "closed": false },
       { "day": 2, "open": "09:00", "close": "20:00", "closed": false },
       { "day": 3, "open": "09:00", "close": "20:00", "closed": false },
       { "day": 4, "open": "09:00", "close": "20:00", "closed": false },
       { "day": 5, "open": "09:00", "close": "20:00", "closed": false },
       { "day": 6, "open": "09:00", "close": "20:00", "closed": false },
       { "day": 7, "open": "09:00", "close": "20:00", "closed": false }
     ]
   }
   ```
5. `POST /auth/register` as customer with name, email, password and optional phone. Customers cannot choose a role. `POST /salons/<salon-id>/join` associates the customer account with this salon. After joining, `GET /customers/me` obtains the customer ID and referral code. `PATCH /customers/me` enables messaging consent:
   ```json
   { "phone": "+919999999999", "consent": true, "channel": "whatsapp" }
   ```
6. `POST /bookings` as customer:
   ```json
   {
     "staffId": "<staff-id>",
     "items": [{ "serviceId": "<service-id>", "addonIds": [] }],
     "start": "2026-11-02T10:00:00+05:30",
     "source": "online"
   }
   ```
   Use a future date within both salon and staff working hours. Response includes server-calculated `end`, `total`, item snapshots, `status: confirmed` and `paymentStatus: unpaid`. Staff can supply `customerId` and `source: walk-in` for a manually created customer. Dates must have a timezone offset and start at a whole minute.
7. Record a verified payment via `POST /payments`. Cash is recorded by staff/owner:
   ```json
   {
     "customerId": "<customer-id>",
     "bookingId": "<booking-id>",
     "amount": 30000,
     "purpose": "booking",
     "method": "cash",
     "idempotencyKey": "cash-booking-unique-001"
   }
   ```
   Customer online payments require method `provider`, a real `reference`, and a configured verification adapter. Store-credit payment uses method `credit`. The amount must match the full booking total.
8. After appointment start, assigned staff/owner completes it with `PATCH /bookings/<id>/status`:
   ```json
   { "status": "completed" }
   ```
   This transaction creates a visit, updates customer history, schedules consented reminders, and releases any eligible referral reward. A future or unpaid booking cannot complete. Free appointments complete without a payment but cannot qualify referrals.

## Services, customers and staff

- Owner: `POST/PATCH /services[/<id>]`, `POST/PATCH /staff[/<id>]`, `PATCH /salon`, `GET/PATCH /settings`, `GET /audit-logs`.
- Service categories are names on services. Service add-ons are embedded catalog entries with their own IDs. Use `active: false` to disable a service or individual add-on. Updating `addons` replaces the array; preserve `_id` values for existing add-ons.
- Staff accepts skills, assigned service IDs, hours, time-off ranges and active status. Disabling staff revokes their authentication sessions through token-version invalidation.
- Owner/staff: `GET/POST /customers`, `GET/PATCH /customers/<id>`, `GET /customers/<id>/visits`.
- Customer list supports `search` across literal name/phone, `consent=true|false`, and `sort=name|-createdAt|-lastVisitAt`.
- Customers: `GET/PATCH /customers/me`, own visits, own wallet, own booking/payment/reminder lists.
- Booking list supports `status`, ISO offset `from`, `to` and pagination. Staff sees assigned bookings; customers see their own bookings.

## Reschedule and cancellation

`PATCH /bookings/<id>/reschedule`:

```json
{ "start": "2026-11-03T11:00:00+05:30" }
```

`PATCH /bookings/<id>/status`:

```json
{ "status": "cancelled", "reason": "Customer requested cancellation" }
```

Customers may cancel only before the configured cancellation window. Staff may confirm, complete, cancel or mark no-show for assigned bookings. Owner has salon-wide access. Completion/cancellation/no-show are terminal. Cancellation does not silently refund money: owner explicitly records the full refund through `POST /payments/<id>/refund` with a mandatory reason. No-show requires that the appointment has started.

## Store credit

- Top up through `POST /payments` with `purpose: topup`, `method: cash|provider`, amount, customerId (for staff), reference (provider only), and unique idempotencyKey. No bookingId. Verification happens before crediting. Settings determine bonus percentage and expiry.
- `GET /wallet?customerId=<id>` returns paid and bonus balances after expiring old lots. Customer omits customerId. `GET /wallet/transactions` returns ledger history with the same scope and pagination.
- Owner: `POST /wallet/adjustments`:
  ```json
  {
    "customerId": "<id>",
    "amount": 1000,
    "direction": "credit",
    "bucket": "bonus",
    "reason": "Customer service recovery",
    "idempotencyKey": "adjustment-unique-001"
  }
  ```
  Direction debit consumes available lots in expiry order, bonus first; bucket selects the credit destination only. Retries must reuse an identical request. Different inputs with an existing key return 409.
- `POST /payments/<id>/refund` refunds a full booking payment. Reason required. Retrying an already refunded payment has no effect. A provider outage leaves durable `refund-pending`, visible in `/payments`; retry after recovery.
- `POST /payments/<id>/reverse-topup` reverses unused store credit and bonus with a reason. This does not report a monetary refund; reconcile external funds separately.

## Referrals and reminders

- Customer: `GET /referrals/me` returns code, registration link, and reward statuses. `POST /referrals/claim` with `{"code":"<16-character-code>"}` before first completed visit. No self-referrals, duplicate claims or repeat rewards.
- Owner: `GET /referrals` lists salon referrals. Set `referralReward` and `referralMinimumBill` in minor units through `/settings`.
- An externally paid first completed visit of at least the minimum triggers the reward as bonus credit. Subsequent visits and credit-funded visits do not qualify. Full refunds claw back the reward.
- `GET /reminders` lists real statuses. A future reminder is calculated as completion time plus the service's `reminderDays`. Worker dispatch begins at `dueAt`. Booking a relevant service or opting out cancels pending reminders.
- A booking with `source: reminder` must provide `reminderId` belonging to this customer and one of the selected services, with a prior sent/delivered status. Attribution is validated rather than accepted as an arbitrary client flag.

## Reports and metric definitions

Owner: `GET /reports?from=2026-11-01&to=2026-11-30&group=day` (or `month`). `to` is inclusive local calendar date; the returned `toExclusive` is the next local midnight. Without dates, reports show today in the salon timezone. Maximum range 366 days.

| Field                           | Definition                                                                                                                                                                                                     |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| completedRevenue                | Sum of final bills for visits completed in the range with paid booking status; refunded/refund-pending bills excluded. Includes redeemed store credit; this is recognized service revenue, not cash collected. |
| completedBookings               | Visit count by completion timestamp, including subsequently refunded visits.                                                                                                                                   |
| bookings                        | Bookings with scheduled start in the range, all statuses.                                                                                                                                                      |
| averageBill                     | Rounded revenue / count of non-refunded completed bookings.                                                                                                                                                    |
| newCustomers                    | Distinct completed-visit customers with no completed visit before the range.                                                                                                                                   |
| repeatCustomers                 | Distinct completed-visit customers who had a prior completed visit.                                                                                                                                            |
| popularServices / popularAddons | Counts from completed visit snapshots, with non-refunded snapshot item revenue. Add-on revenue is separate from base service revenue.                                                                          |
| staff                           | Completed appointment count, service count and non-refunded full bill totals by staff ID.                                                                                                                      |
| periods                         | Completed counts and non-refunded revenue grouped by completion date/month.                                                                                                                                    |
| walletCreditsCollected          | Gross verified top-up payments created in the range; unused-credit reversals do not change historical cash collection.                                                                                         |
| outstandingCredit               | Current unexpired remaining paid and bonus credit, irrespective of report range.                                                                                                                               |
| reminderBookings                | Validated reminder-attributed bookings starting in the range, all statuses.                                                                                                                                    |
| referrals / rewardsReleased     | Referrals created / currently rewarded referrals released in the range.                                                                                                                                        |
| cancellations / noShows         | Current cancellation/no-show status for bookings whose scheduled start is in the range.                                                                                                                        |

Reports use live database records. They represent current status and may change after a later refund; they are not immutable accounting period closures. Customer `lastVisitAt`, `lastService` and `visitCount` represent completed visit history, including visits refunded later.

## Authentication lifecycle

Access JWTs expire after 15 minutes. Refresh JWTs expire after 30 days and rotate once through `POST /auth/refresh`. Logout revokes the session immediately, including unexpired access JWTs; logout-all and reset-password invalidate every session. Refresh tokens are returned in JSON: the consuming application must protect them (for browsers, use a trusted backend or equivalent secure storage; this API does not set authentication cookies).

Forgot-password and reset-password use a real messaging adapter. Neither passwords nor reset/refresh token hashes are exposed in user responses. Body fields are strict and unknown role/salon fields are rejected.

## Mobile capabilities and available slots

`GET /mobile-config` is authenticated and salon-scoped. It returns `paymentVerification`, `messaging`, and customer-visible credit/referral/cancellation settings. It never returns provider URLs or credentials.

`POST /availability`:

```json
{ "staffId": "<id>", "date": "2026-11-02", "items": [{ "serviceId": "<id>", "addonIds": [] }] }
```

Staff/owner supplies `customerId`. For rescheduling, supply the authorized `bookingId` instead of items. Response data is `{date, timezone, duration, slots: ["2026-11-02T10:00:00.000+05:30", ...]}`. Slots use real working hours, leave and overlapping staff/customer bookings. Empty means no available start times. Suggestions are spaced every 15 minutes; appointment duration remains exact. Dates may extend at most 180 days. Availability is advisory; booking creation transactionally rechecks conflicts.

`GET /bookings` also accepts `staffId` and `sort=start|-start` (default `-start`). Staff can filter only their own schedule. Customer data remains restricted to that customer's appointments.
