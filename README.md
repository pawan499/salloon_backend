# Salon Management Backend

Node.js 22+, Express 5, TypeScript ESM, Mongoose/MongoDB, JWT sessions, Zod, Pino, BullMQ/Redis, and Swagger. All monetary amounts are integer minor units: `30000` means ₹300.00 with INR.

## Run locally

```bash
cd backend
npm ci
cp .env.example .env
# Edit .env: set two different random JWT secrets and a strong seed owner password.
# Generate each secret with: openssl rand -hex 32
docker compose up -d
npm run seed
npm run dev
```

The Compose file runs MongoDB and Redis for an API running on your host. Wait for MongoDB's replica-set health check before seeding. If you already run MongoDB on port 27017, use a separate port and adjust the replica-set advertised hostname/port and `MONGODB_URI`, or use MongoDB Atlas.

In a second terminal:

```bash
cd backend
npm run worker
```

- API: http://localhost:4000/api/v1
- Swagger: http://localhost:4000/docs
- OpenAPI JSON: http://localhost:4000/api/v1/openapi.json
- Liveness: `/health/live`; readiness: `/health/ready`
- Login with `SEED_OWNER_EMAIL` / `SEED_OWNER_PASSWORD`. Seed is explicit, transactional and repeat-safe. It does not reset an existing owner's password.
- Create staff as owner, then register customers and join the seeded salon. Registration always creates a customer. Owner bootstrapping only happens through the seed script.

MongoDB must be a replica set or sharded cluster. Startup checks this and refuses standalone databases. Booking, visit, payment, wallet, referral and audit updates use transactions. See [MongoDB transaction requirements](https://www.mongodb.com/docs/manual/core/transactions-production-consideration/) and [Mongoose transactions](https://mongoosejs.com/docs/transactions.html).

## Commands

```bash
npm run typecheck
npm run build
npm test
npm start
# Optional: use an installed MongoDB binary for isolated test replica sets:
MONGOMS_SYSTEM_BINARY=/usr/bin/mongod npm test
# Production worker after build:
node dist/jobs/worker.js
# Production seed after build, with explicit SEED_OWNER_* env values:
node dist/seed.js
```

Tests use an isolated temporary MongoDB replica set, never your configured application database. Without `MONGOMS_SYSTEM_BINARY`, mongodb-memory-server downloads its own binary; network access is needed on the first run. Integration tests require permission to bind loopback ports.

## Structure

```text
backend/
├── src/
│   ├── config/       # validated environment, DB initialization, OpenAPI
│   ├── models/       # 14 domain models plus persisted authentication sessions
│   ├── modules/      # HTTP controllers and domain services
│   ├── middleware/   # JWT/session authentication, RBAC, validation, errors
│   ├── routes/       # API composition
│   ├── services/     # salon/ownership checks, audit and external adapters
│   ├── validators/   # strict Zod request schemas
│   ├── utils/        # transactions, response envelopes, logging, pagination
│   ├── jobs/         # Redis-backed reminder and credit-expiry worker
│   ├── types/        # request actor typing
│   ├── app.ts
│   ├── server.ts
│   └── seed.ts
├── tests/            # rule tests and real MongoDB/Supertest integration tests
├── docs/             # workflows, provider contracts, deployment
├── .env.example
├── docker-compose.yml
└── Dockerfile
```

[API workflows and metrics](docs/API.md) · [Provider adapter contracts](docs/providers.md) · [Deployment](docs/deployment.md)

## Consistency rules

- Each booking mutation writes a shared staff and customer document in its transaction before checking exact interval overlap. MongoDB write conflicts cause retries against a new snapshot, so simultaneous requests cannot both book the same staff/customer. Adjacent appointments are permitted. Working hours use the salon's IANA timezone, Monday=1 through Sunday=7; overnight shifts are not supported. Start times must be future, whole-minute timestamps with an explicit offset.
- Bookings snapshot prices, duration and add-ons. Later catalog edits do not rewrite bills. Rescheduling retains the snapshot.
- Wallet credit is salon-specific and cannot be withdrawn. Credits are lots with separate paid/bonus balances. Debits spend earliest-expiring lots and their bonus first. Financial entries are never deleted through the API. Only lot remainder fields change; original amounts remain immutable. Expiry, reversal and refund each create new entries.
- Cash receipts require staff/owner action. Online payment amounts and ownership are verified server-to-server. Store-credit payments cannot fund top-ups or qualify referrals.
- Owner adjustments require reasons. A debit consumes available lots; its `bucket` only chooses the destination for positive adjustments. Refunds restore the original paid/bonus mix and original expiry. Already-expired credit refunds expire immediately with an auditably separate entry.
- Full booking refunds are supported. Provider refunds reserve a durable `refund-pending` payment before calling an idempotent external adapter; retry the same endpoint after provider timeout or process failure. Cash refund records are owner attestations of cash returned. Credit refunds restore store credit. Partial refunds are not supported.
- Top-up reversal is permitted only for a wholly unused, unexpired lot. It reverses credit and bonus, and **does not refund external money**; the owner must separately reconcile any monetary refund in their payment provider/dashboard. The payment remains a historical verified collection.
- Referral rewards remain pending until an externally paid eligible first completed visit. One claim per referred customer and one ledger reward per referral. Refunds claw back a released reward; if the referrer's spendable balance cannot cover the clawback, the refund is rejected before contacting the external provider and requires owner reconciliation.
- Reminders respect customer consent and relevant future bookings. Missing messaging configuration produces `blocked`, never fabricated delivery. The worker processes 100 reminders and up to 100 expired lots per tick. Provider idempotency is required for safe retries. Opt-out/booking cancels pending dispatches; an external send already in flight cannot be recalled.
