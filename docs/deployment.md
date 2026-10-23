# Production deployment

1. Use Node.js 22+, MongoDB Atlas or an authenticated replica set, and persistent Redis. Do not expose the local Compose databases publicly; Compose is a development setup. Configure backups and test restores.
2. Provision distinct cryptographically random access/refresh secrets, restricted MongoDB credentials, explicit frontend CORS origins, correct `PUBLIC_APP_URL`, and provider adapter credentials in your secret manager. Never commit `.env`.
3. Run `npm ci && npm run typecheck && npm test && npm run build`. Deploy `dist` and production dependencies, or build the supplied Dockerfile. Start API with `node dist/server.js` and worker separately with `node dist/jobs/worker.js`.
4. Run the seed once with explicit owner email/password. Change the salon address/hours and configure services, staff and policies before accepting bookings. The Docker image includes compiled seed and worker entrypoints.
5. The application creates declared indexes during startup without dropping existing indexes. For large collections, apply the declared indexes in a controlled migration before rolling out the API. All required unique indexes must exist before serving traffic.
6. Terminate TLS at a trusted ingress, restrict application/database network access, enable centralized logs and alerting, and monitor `/health/ready`. The API does not trust forwarded IP headers by default. If deployed behind an ingress, configure Express `trust proxy` to the exact trusted hop/address range rather than `true`.
7. Run the reminder/expiry worker continuously. BullMQ schedules a deduplicated maintenance job every minute. Failed provider sends retain real statuses; inspect `blocked`, `failed`, and exhausted reminders. Observe pending refunds and retry the owner refund endpoint after resolving gateway failures.
8. Readiness checks the database connection; monitor Redis and provider reachability separately for worker/payment readiness. Graceful shutdown closes the HTTP server/database and the worker/queue connections. Prefer a termination grace period exceeding 15 seconds.

The built-in authentication rate limiter is per process. At multiple API replicas, add an ingress-wide authentication rate limit or a shared Redis-backed limiter before scaling; do not assume per-process counters are global. Redis contains scheduling data while MongoDB is the source of truth for reminders and credit expiry.

All API access checks include salon ownership. One account is associated with one salon in this initial version. A future multi-salon membership model should replace `User.salon` before enabling cross-salon accounts. Existing collection indexes already include salon scope where relevant.

Operational limits: no taxes, discounts, partial payments/refunds, overnight shifts or multi-staff appointments are modeled. Prices are final configured service prices. Redis/provider outages do not fabricate job or payment success. Reconcile gateway and cash records against the immutable local financial ledger.
