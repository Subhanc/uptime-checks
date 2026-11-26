#!/usr/bin/env node
/**
 * The PAID course checkout probe.
 *
 *   PROBE_API_URL=… PROBE_API_KEY=… PROBE_CUSTOMER_EMAIL=… node scripts/paid-course-probe.mjs
 *
 * A guest buys the fixture course in TEST mode, the way the web checkout does:
 *
 *   start a guest course checkout → a DECLINED test card is declined → the
 *   same payment pays with a good test card → the checkout confirms to
 *   enrolled → refund it through the seller's refund path (probe-only route),
 *   which also ends the course access → read the refund back from the payment
 *   provider
 *
 * Reports `course.declined_retry`, `course.card_payment` and `course.refund`.
 *
 * One fixed buyer, every run (`PROBE_CUSTOMER_EMAIL`). The refund leaves its
 * enrollment refunded, and the next run's checkout opens a new charge on it.
 * A run that paid and could not refund leaves the buyer enrolled, and the next
 * run is answered "already enrolled": that is named in the failure, and it is
 * test money on a test account.
 *
 * Safety is `paid-probe-lib.mjs`'s: test mode asserted before any card, test
 * cards only, publishable key only, and a refund route that refuses anything
 * but the probe's own enrollment on a test organization.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BUYER_EMAIL,
  PAID_STEPS,
  ProbeFailure,
  api,
  assertConfigured,
  assertTestKey,
  check,
  declineThenPay,
  expectStatus,
  fail,
  finish,
  paymentIntentOf,
  probeHeaders,
  refundAndReadBack,
  sleep,
  step,
} from './paid-probe-lib.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contract = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'scripts/paid-course-probe-fixture.json'), 'utf8'),
);

const CONFIRM_POLL_ATTEMPTS = 10;
const CONFIRM_POLL_INTERVAL_MS = 3_000;

let purchaseId = null;
let paid = false;
let refunded = false;
let failure = null;

try {
  assertConfigured();

  let organization;
  await step('find the probe course', async () => {
    const preview = await api('GET', `/organizations/${contract.orgSlug}/public-preview/v2`);
    expectStatus(preview, 200);
    organization = preview.json?.organization;
    check(organization?.slug === contract.orgSlug, `served organization "${organization?.slug}", refusing to buy`);
    return `course ${contract.courseId}`;
  });

  let publishableKey;
  await step('the payment account is a test account', async () => {
    const config = await api('GET', `/payments/config?orgId=${encodeURIComponent(organization.id)}`);
    expectStatus(config, 200);
    assertTestKey('/payments/config', config.json?.publishableKey, config.json?.mode);
    publishableKey = config.json.publishableKey;
    return `provider ${config.json?.provider}, test mode`;
  });

  // One request id per run is right: it is the checkout's own idempotency key,
  // never an identity, and a retried run must open a new attempt.
  const checkoutRequestId = randomUUID();
  let checkout;
  await step('start a guest course checkout', async () => {
    const create = await api('POST', `/courses/${contract.courseId}/checkout`, {
      headers: probeHeaders(),
      body: { checkoutRequestId, contact: { email: BUYER_EMAIL } },
    });
    if (create.status === 409 && /already/i.test(create.text)) {
      fail('the probe buyer is still enrolled: an earlier run paid and was not refunded (test money on a test account). Refund that enrollment on the course\'s Customers page.');
    }
    expectStatus(create, 200, 201);
    checkout = create.json ?? {};
    purchaseId = checkout.purchaseId ?? null;
    check(!!purchaseId, 'no purchase id came back');
    check(checkout.status === 'requires_payment', `the checkout answered "${checkout.status}", not a payment`);
    check(checkout.totalCents === contract.priceCents, `total ${checkout.totalCents} is not the fixture's ${contract.priceCents}`);
    check(checkout.currency === contract.currency, `the checkout is in "${checkout.currency}"`);
    // The checkout carries the key only on some surfaces; the account's is the same one.
    publishableKey = checkout.payment?.clientConfig?.publishableKey || publishableKey;
    assertTestKey('the checkout', publishableKey, checkout.payment?.clientConfig?.mode);
    check(!!paymentIntentOf(checkout.payment?.clientToken) && !!checkout.receiptToken, 'the checkout carried no payment to confirm');
    return `purchase ${purchaseId}, ${checkout.totalCents} ${checkout.currency}`;
  });

  await declineThenPay(checkout.payment.clientToken, publishableKey, () => {
    paid = true;
  });

  await step('the checkout confirms to enrolled', async () => {
    let last = null;
    for (let attempt = 1; attempt <= CONFIRM_POLL_ATTEMPTS; attempt += 1) {
      last = await api('POST', `/courses/${contract.courseId}/checkout/confirm`, {
        body: { checkoutRequestId, receiptToken: checkout.receiptToken },
      });
      if (last.status < 300 && last.json?.status === 'enrolled') return `enrolled after ${attempt} confirm call(s)`;
      if (last.status >= 400) break;
      await sleep(CONFIRM_POLL_INTERVAL_MS);
    }
    fail(`the checkout did not reach "enrolled" after a successful payment (HTTP ${last?.status}, "${last?.json?.status}")`);
  });

  await refundAndReadBack(`/course-enrollments/${purchaseId}/probe-refund`, () => {
    refunded = true;
  });
} catch (err) {
  failure = err instanceof ProbeFailure ? err : new ProbeFailure(`unexpected error: ${err?.message || err}`);
} finally {
  if (purchaseId && paid && !refunded) {
    // Once more, in case the payment had not reached the row when the refund
    // step gave up: a paid enrollment left behind blocks the next run.
    const retry = await api('POST', `/course-enrollments/${purchaseId}/probe-refund`, { headers: probeHeaders() }).catch(() => null);
    console.log(
      retry?.status === 200
        ? `cleanup: refunded purchase ${purchaseId}`
        : `cleanup: purchase ${purchaseId} was paid with a test card and NOT refunded (HTTP ${retry?.status}). It is test money on a test account.`,
    );
  } else if (purchaseId && !paid) {
    console.log(`cleanup: purchase ${purchaseId} was never paid; its open payment holds no money.`);
  }
}

const SETUP = ['find the probe course', 'the payment account is a test account', 'start a guest course checkout'];
await finish('paid course probe', failure, [
  { checkKey: 'course.declined_retry', names: [...SETUP, ...PAID_STEPS.declined] },
  { checkKey: 'course.card_payment', names: [...SETUP, ...PAID_STEPS.paid, 'the checkout confirms to enrolled'] },
  { checkKey: 'course.refund', names: [...SETUP, ...PAID_STEPS.paid, 'the checkout confirms to enrolled', ...PAID_STEPS.refund] },
]);
