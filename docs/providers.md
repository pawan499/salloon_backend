# External provider contracts

The backend includes HTTP adapters. Implement these contracts in your trusted gateway to Razorpay/Stripe/Twilio/WhatsApp or adapt `src/services/providers.ts` to your chosen provider's SDK. URLs and bearer credentials are environment-only. No payment/messaging provider is configured by default. These adapters make actual network calls; they do not simulate success.

Use HTTPS in production, short timeouts, provider-side authorization and durable idempotency. Do not forward arbitrary customer-supplied URLs. Gateway metadata must originate in a trusted checkout/session creation flow. The API verifies reference, exact amount, currency, salon, customer, purpose and booking before crediting any funds. Never allow the browser to set authoritative purchase metadata after payment.

## Verify payment

`POST ${PAYMENT_PROVIDER_URL}/verify`, `Authorization: Bearer ${PAYMENT_PROVIDER_TOKEN}`

Request:

```json
{ "reference": "provider-payment-123" }
```

Response for a settled payment:

```json
{
  "reference": "provider-payment-123",
  "status": "paid",
  "amount": 30000,
  "currency": "INR",
  "salonId": "<salon-id>",
  "customerId": "<customer-id>",
  "purpose": "booking",
  "bookingId": "<booking-id>"
}
```

For top-ups, purpose is `topup` and `bookingId` must be absent. Pending, failed and incorrectly matched payments are rejected. A provider reference can be consumed once globally. There is no public webhook that trusts a client `paid` flag.

## Refund payment

`POST ${PAYMENT_PROVIDER_URL}/refund`, same authorization. Header `Idempotency-Key: refund:<payment-id>`.

```json
{ "reference": "provider-payment-123", "amount": 30000 }
```

```json
{ "reference": "provider-payment-123", "status": "refunded", "amount": 30000 }
```

The gateway must return the same confirmed result on repeated calls for the same key. Return `refunded` only after provider confirmation, not when a refund is merely queued. On failure, API payment state remains `refund-pending`. Owner retries `POST /payments/:id/refund`; the key stays unchanged. This also handles a crash after provider success but before local finalization.

## Messaging

`POST ${MESSAGE_PROVIDER_URL}/messages`, bearer token `MESSAGE_PROVIDER_TOKEN`, header `Idempotency-Key`.

```json
{ "to": "+919999999999", "channel": "whatsapp", "message": "Your next salon visit is due..." }
```

```json
{ "id": "message-123", "status": "accepted" }
```

The API stores `accepted` as `sent`. Only an explicitly confirmed `delivered` response becomes `delivered`. If a gateway only reports acceptance, reminders remain `sent`; there is no unsupported delivery claim or unauthenticated status callback. Use approved templates and opt-out handling in the actual gateway. Failed reminders retry with a 15-minute backoff, at most five attempts. A stale processing claim is recovered after five minutes with the same idempotency key.

Password reset uses SMS through this adapter, a random 30-minute token, a hashed database token and `PUBLIC_APP_URL/reset-password?token=...`. Reset tokens are never returned by the API. Password recovery returns 503 when the messaging adapter is unavailable. Existing accounts without a phone receive no reset message; the response remains generic.
