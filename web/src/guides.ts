import type { Severity } from './api';

/**
 * What each finding code means and how to fix it. The engine's finding
 * message says what happened in this run; a guide says why it matters and
 * what to change. Kept next to the dashboard (not in the API) because it is
 * documentation, versioned with the UI that shows it.
 */
export interface Guide {
  code: string;
  severity: Severity;
  title: string;
  /** One sentence: what goes wrong for the business. */
  impact: string;
  /** Why it happens. */
  cause: string;
  /** Concrete steps, in order. */
  fix: string[];
  /** A short example of the fix, in TypeScript against the REST API. */
  example?: string;
}

const UUID_EXAMPLE = `// One id per business operation, created before the first attempt
// and reused on every retry of that operation.
const requestId = crypto.randomUUID();   // or derive it from your own order/refund row id
await db.refunds.update(refundRow.id, { paypal_request_id: requestId });

for (let attempt = 0; ; attempt++) {
  try {
    return await paypal.post(\`/v2/payments/captures/\${captureId}/refund\`, body, {
      headers: { 'PayPal-Request-Id': requestId },   // same id every attempt
      timeout: 10_000,
    });
  } catch (err) {
    if (!isRetryable(err) || attempt >= 4) throw err;
    await sleep(Math.min(200 * 2 ** attempt, 5_000) * (0.5 + Math.random()));
  }
}`;

export const GUIDES: Guide[] = [
  {
    code: 'UNSAFE_RETRY_AFTER_LOST_RESPONSE',
    severity: 'HIGH',
    title: 'Retry created a duplicate payment',
    impact: 'The buyer was charged, refunded or paid out twice for one operation.',
    cause:
      'PayPal processed the first request, but its response never reached your code. The retry carried no PayPal-Request-Id, or a new one, so PayPal treated it as a new request and did it again.',
    fix: [
      'Generate one PayPal-Request-Id per business operation (a UUID, or your own order or refund id) before the first attempt.',
      'Persist it with the operation so a retry from another process or a job re-run uses the same id.',
      'Send that same id on every retry. PayPal then returns the resource the first attempt created instead of creating another.',
    ],
    example: UUID_EXAMPLE,
  },
  {
    code: 'UNSAFE_RETRY_FAILED_THIS_TIME',
    severity: 'MEDIUM',
    title: 'Retry would have created a duplicate',
    impact: 'No duplicate this time only because the retry happened to fail. Next time it may succeed.',
    cause: 'Same pattern as an unsafe retry: the original committed, its response was lost, and the retry used no id or a different id.',
    fix: [
      'Treat this exactly like UNSAFE_RETRY_AFTER_LOST_RESPONSE: one PayPal-Request-Id per operation, reused on every attempt.',
    ],
    example: UUID_EXAMPLE,
  },
  {
    code: 'COMMITTED_BUT_REPORTED_AS_FAILED',
    severity: 'MEDIUM',
    title: 'Payment succeeded but your app thinks it failed',
    impact: 'The money moved, but your records say it did not: support tickets, manual refunds, or a customer asked to pay again.',
    cause: 'The request committed upstream, the client got an error or no response, and it neither retried with the same id nor looked the resource up.',
    fix: [
      'Treat timeouts, connection resets and 5xx as "unknown", not "failed".',
      'Retry with the same PayPal-Request-Id, which safely returns the original result, or GET the resource to learn its state.',
      'Reconcile from webhooks (PAYMENT.CAPTURE.COMPLETED and similar) as a backstop.',
    ],
  },
  {
    code: 'ALREADY_CAPTURED_NOT_RECONCILED',
    severity: 'MEDIUM',
    title: '"Already captured" treated as a failure',
    impact: 'PayPal blocked the duplicate, but your app probably recorded a failed payment that actually succeeded.',
    cause: 'A retried capture got 422 ORDER_ALREADY_CAPTURED (or ..._AUTHORIZED), and the client never fetched the order to read the capture.',
    fix: [
      'On 422 ORDER_ALREADY_CAPTURED, GET /v2/checkout/orders/{id} and read purchase_units[].payments.captures[].',
      'Record that capture as the successful result of the operation.',
    ],
    example: `if (err.status === 422 && err.issue === 'ORDER_ALREADY_CAPTURED') {
  const order = await paypal.get(\`/v2/checkout/orders/\${orderId}\`);
  const capture = order.purchase_units[0].payments.captures[0];
  return markPaid(orderId, capture.id);   // success, not failure
}`,
  },
  {
    code: 'TOKEN_NOT_REFRESHED',
    severity: 'MEDIUM',
    title: 'Expired access token reused',
    impact: 'Every call fails until the process restarts, so payments stall during token expiry.',
    cause: 'After a 401 invalid_token the client retried with the same bearer token.',
    fix: [
      'On 401, fetch a new token from /v1/oauth2/token, then retry once.',
      'Cache tokens with their expires_in and refresh a little early.',
    ],
  },
  {
    code: 'NEW_REQUEST_ID_AFTER_INDETERMINATE_ERROR',
    severity: 'MEDIUM',
    title: 'New request id after an unclear outcome',
    impact: 'A 5xx, 409 or timeout may have taken effect; a new id can start a second operation.',
    cause: 'The retry generated a fresh PayPal-Request-Id instead of reusing the original one.',
    fix: ['Keep the id for the lifetime of the business operation, not the HTTP attempt.', 'Only start a new id once you know the previous operation definitely failed.'],
    example: UUID_EXAMPLE,
  },
  {
    code: 'REQUEST_ID_REUSED_WITH_DIFFERENT_BODY',
    severity: 'MEDIUM',
    title: 'One request id used for two different requests',
    impact: "PayPal answers with the first request's resource, so the second request's changes are silently ignored.",
    cause: 'The id is derived from something too coarse (a customer id, a cart id) or reused across operations.',
    fix: ['Derive the id from the specific operation (order row, refund row), not from the customer or session.'],
  },
  {
    code: 'MISSING_REQUEST_ID',
    severity: 'MEDIUM',
    title: 'Money-moving request without PayPal-Request-Id',
    impact: 'Any retry of this request, by your code or a proxy, can create a duplicate.',
    cause: 'The request did not send the PayPal-Request-Id header on an endpoint that honours it.',
    fix: ['Add PayPal-Request-Id to every create order, capture, authorize, refund and payout call.'],
    example: UUID_EXAMPLE,
  },
  {
    code: 'REQUEST_ID_TOO_LONG',
    severity: 'LOW',
    title: 'Request id longer than 38 characters',
    impact: 'PayPal may reject or truncate it, which defeats idempotency.',
    cause: 'The id concatenates several values or uses a long format.',
    fix: ['Use a UUID (36 characters), or hash a longer key down to one.'],
  },
  {
    code: 'RETRY_WITHOUT_BACKOFF',
    severity: 'LOW',
    title: 'Retried too quickly',
    impact: 'Hammering a rate-limited or failing API prolongs the outage and can get the account throttled.',
    cause: 'The retry followed a 429 or 5xx faster than the minimum backoff.',
    fix: ['Use exponential backoff with jitter (for example 200 ms, 400 ms, 800 ms… capped), and honour Retry-After when present.'],
  },
  {
    code: 'TRUNCATED_SUCCESS_NOT_RETRIED',
    severity: 'LOW',
    title: 'Success with an unreadable body',
    impact: 'The client has a 2xx but cannot read the created resource id, so its records are incomplete.',
    cause: 'The body was cut short and the client neither retried with the same id nor fetched the resource.',
    fix: ['If the body cannot be parsed, retry with the same PayPal-Request-Id (it returns the same resource) or GET it.'],
  },
];

const byCode = new Map(GUIDES.map((g) => [g.code, g]));

export function guideFor(code: string): Guide | undefined {
  return byCode.get(code);
}
