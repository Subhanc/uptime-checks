#!/usr/bin/env node
/**
 * The PAID booking checkout probe.
 *
 *   PROBE_API_URL=… PROBE_API_KEY=… PROBE_CUSTOMER_EMAIL=… node scripts/paid-booking-probe.mjs
 *
 * A guest books the probe's own Service in TEST mode, the way the web checkout
 * does:
 *
 *   pick an open time → check out (booking + payment in one call) → a DECLINED
 *   test card is declined → the same payment pays with a good test card → the
 *   booking confirms → refund the deposit through the seller's refund path and
 *   cancel the booking, so the date is free again (probe-only route) → read the
 *   refund back from the payment provider
 *
 * Reports `booking.declined_retry`, `booking.card_payment` and `booking.refund`.
 *
 * One fixed buyer, every run (`PROBE_CUSTOMER_EMAIL`). Safety is
 * `paid-probe-lib.mjs`'s: test mode asserted before any card, test cards only,
 * publishable key only, and a refund route that refuses anything but the
 * probe's own booking on a test organization.
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
  finish,
  paymentIntentOf,
  probeHeaders,
  refundAndReadBack,
  step,
  waitFor,
} from './paid-probe-lib.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contract = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'scripts/paid-booking-probe-fixture.json'), 'utf8'),
);

const DAY_MS = 86_400_000;
const DATES_TO_TRY = 14;

let bookingId = null;
let accessToken = null;
let paid = false;
let refunded = false;
let failure = null;

const dateKeyOf = (ms) => new Date(ms).toISOString().slice(0, 10);

try {
  assertConfigured();

  let organization;
  let startAt;
  await step('find the probe service and an open time', async () => {
    const preview = await api('GET', `/organizations/${contract.orgSlug}/public-preview/v2`);
    expectStatus(preview, 200);
    organization = preview.json?.organization;
    check(organization?.slug === contract.orgSlug, `served organization "${organization?.slug}", refusing to book`);
    const from = dateKeyOf(Date.now() + contract.daysAhead * DAY_MS);
    const to = dateKeyOf(Date.now() + (contract.daysAhead + DATES_TO_TRY) * DAY_MS);
    const open = await api('GET', `/bookables/${contract.bookableId}/open-times?from=${from}&to=${to}`);
    expectStatus(open, 200);
    check(open.json?.timezone === 'UTC', `the service keeps time in "${open.json?.timezone}", not UTC`);
    const day = (open.json?.days ?? []).find((entry) => (entry.startTimes ?? []).length > 0);
    check(!!day, `no open time between ${from} and ${to}`);
    startAt = `${day.dateKey}T${day.startTimes[0]}:00.000Z`;
    return startAt;
  });

  let publishableKey;
  await step('the payment account is a test account', async () => {
    const config = await api('GET', `/payments/config?orgId=${encodeURIComponent(organization.id)}`);
    expectStatus(config, 200);
    assertTestKey('/payments/config', config.json?.publishableKey, config.json?.mode);
    publishableKey = config.json.publishableKey;
    return `provider ${config.json?.provider}, test mode`;
  });

  let checkout;
  await step('check out a booking', async () => {
    // One request id per run: the checkout's idempotency key, never an identity.
    const create = await api('POST', `/bookables/${contract.bookableId}/checkout`, {
      headers: probeHeaders(),
      body: { requestId: randomUUID(), requestedStartAt: startAt, contact: { email: BUYER_EMAIL } },
    });
    expectStatus(create, 200, 201);
    checkout = create.json ?? {};
    bookingId = checkout.booking?.id ?? null;
    accessToken = checkout.accessToken ?? null;
    check(!!bookingId && !!accessToken, 'no booking id or access token came back');
    const quote = checkout.booking?.quote;
    check(quote?.totalCents === contract.priceCents, `total ${quote?.totalCents} is not the fixture's ${contract.priceCents}`);
    check(quote?.currency === contract.currency, `the booking is in "${quote?.currency}"`);
    check(checkout.payment?.clientConfig?.mode === 'test', `the payment was made in mode "${checkout.payment?.clientConfig?.mode}"`);
    publishableKey = checkout.payment?.clientConfig?.publishableKey || publishableKey;
    check(!!paymentIntentOf(checkout.payment?.clientToken), 'the checkout carried no payment to confirm');
    return `booking ${bookingId}, ${quote.totalCents} ${quote.currency}`;
  });

  await declineThenPay(checkout.payment.clientToken, publishableKey, () => {
    paid = true;
  });

  await step('the booking confirms', async () => {
    const confirm = await api('POST', `/bookings/${bookingId}/confirm`, { body: { token: accessToken } });
    await waitFor('the booking being confirmed', async () => {
      const read = await api('GET', `/bookings/${bookingId}`, { headers: { 'x-booking-access-token': accessToken } });
      const status = read.json?.booking?.status ?? read.json?.status;
      return status === 'confirmed' || status;
    });
    return `confirmed (confirm answered ${confirm.status})`;
  });

  await refundAndReadBack(`/bookings/${bookingId}/probe-refund`, () => {
    refunded = true;
  });

  await step('the booking is cancelled and its date is free', async () => {
    const read = await api('GET', `/bookings/${bookingId}`, { headers: { 'x-booking-access-token': accessToken } });
    const status = read.json?.booking?.status ?? read.json?.status;
    check(status === 'cancelled', `the booking is "${status}" after the refund`);
    return 'cancelled';
  });
} catch (err) {
  failure = err instanceof ProbeFailure ? err : new ProbeFailure(`unexpected error: ${err?.message || err}`);
} finally {
  if (bookingId && !paid) {
    const cancel = await api('POST', `/bookings/${bookingId}/cancel`, { body: { token: accessToken } }).catch(() => null);
    console.log(
      cancel?.status === 200
        ? `cleanup: cancelled unpaid booking ${bookingId}`
        : `cleanup: could not cancel ${bookingId}; an unpaid hold lapses on its own`,
    );
  } else if (bookingId && paid && !refunded) {
    const retry = await api('POST', `/bookings/${bookingId}/probe-refund`, { headers: probeHeaders() }).catch(() => null);
    console.log(
      retry?.status === 200
        ? `cleanup: refunded and cancelled booking ${bookingId}`
        : `cleanup: booking ${bookingId} was paid with a test card and NOT refunded (HTTP ${retry?.status}). It is test money on a test account.`,
    );
  }
}

const SETUP = ['find the probe service and an open time', 'the payment account is a test account', 'check out a booking'];
await finish('paid booking probe', failure, [
  { checkKey: 'booking.declined_retry', names: [...SETUP, ...PAID_STEPS.declined] },
  { checkKey: 'booking.card_payment', names: [...SETUP, ...PAID_STEPS.paid, 'the booking confirms'] },
  {
    checkKey: 'booking.refund',
    names: [...SETUP, ...PAID_STEPS.paid, 'the booking confirms', ...PAID_STEPS.refund, 'the booking is cancelled and its date is free'],
  },
]);
