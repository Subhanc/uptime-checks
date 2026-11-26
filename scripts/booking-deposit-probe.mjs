#!/usr/bin/env node
/**
 * The booking DEPOSIT probe (Reliability: `booking.deposit`).
 *
 *   PROBE_API_URL=… PROBE_API_KEY=… PROBE_CUSTOMER_EMAIL=… node scripts/booking-deposit-probe.mjs
 *
 * Two runs make one answer, because the balance is charged by a background job
 * (`booking_balance_charge`, every 10 minutes), not by the checkout:
 *
 *   1. The PREVIOUS run's booking: once its balance has been due for longer than
 *      the job needs, the balance must be charged in full. Then both payments are
 *      refunded through the seller's refund path and the booking is cancelled
 *      (probe-only route), and the refunds are read back from the provider.
 *   2. A NEW booking on the probe's own $3 Service, at the first slot a day and a
 *      few minutes ahead: the checkout takes the $1 deposit with a test card and
 *      saves the card, and the $2 balance falls due minutes after this run.
 *
 * `booking.deposit` is reported only when this run checked a previous booking
 * (or something failed): a run that only booked has nothing to say yet.
 *
 * One fixed buyer, every run (`PROBE_CUSTOMER_EMAIL`). Safety is
 * `paid-probe-lib.mjs`'s: test mode asserted before any card, test cards only,
 * publishable key only, and probe routes that refuse anything but the probe's
 * own bookings on a test organization.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BUYER_EMAIL,
  GOOD_CARD,
  ProbeFailure,
  api,
  assertConfigured,
  assertTestKey,
  check,
  confirmPayment,
  expectStatus,
  finish,
  paymentIntentOf,
  probeHeaders,
  step,
  steps,
  waitFor,
} from './paid-probe-lib.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contract = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'scripts/booking-deposit-probe-fixture.json'), 'utf8'),
);

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const balanceCents = contract.priceCents - contract.depositCents;
const dateKeyOf = (ms) => new Date(ms).toISOString().slice(0, 10);

let verified = 0;
let failure = null;
let newBookingId = null;
let newAccessToken = null;
let newPaid = false;

/** Live refunds (not failed or cancelled), summed. */
const liveRefundCents = (refunds) =>
  (refunds ?? [])
    .filter((row) => !/fail|cancel/.test(String(row.status)))
    .reduce((sum, row) => sum + (row.amountCents || 0), 0);

async function refundAndCancel(bookingId) {
  let refund;
  const deadline = Date.now() + 45_000;
  for (;;) {
    refund = await api('POST', `/bookings/${bookingId}/probe-refund`, { headers: probeHeaders() });
    if (refund.status !== 409 || Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  return refund;
}

try {
  assertConfigured();

  let organization;
  await step('the probe organization is served and its payments are in test mode', async () => {
    const preview = await api('GET', `/organizations/${contract.orgSlug}/public-preview/v2`);
    expectStatus(preview, 200);
    organization = preview.json?.organization;
    check(organization?.slug === contract.orgSlug, `served organization "${organization?.slug}", refusing to book`);
    const config = await api('GET', `/payments/config?orgId=${encodeURIComponent(organization.id)}`);
    expectStatus(config, 200);
    assertTestKey('/payments/config', config.json?.publishableKey, config.json?.mode);
    return `provider ${config.json?.provider}, test mode`;
  });

  // ── 1. The previous run's booking ────────────────────────────────────────
  let outstanding = 0;
  let due = [];
  await step('read the earlier probe bookings', async () => {
    const list = await api('GET', `/bookables/${contract.bookableId}/probe-deposits`, { headers: probeHeaders() });
    expectStatus(list, 200);
    const confirmed = (list.json?.bookings ?? []).filter((row) => row.status === 'confirmed');
    const graceMs = contract.graceMinutesAfterDue * MINUTE_MS;
    due = confirmed.filter((row) => !row.balance?.dueAt || Date.parse(row.balance.dueAt) + graceMs <= Date.now());
    outstanding = confirmed.length - due.length;
    return `${due.length} due to check, ${outstanding} not due yet`;
  });

  let verifyFailure = null;
  for (const row of due) {
    try {
      await step('the balance job charged the earlier booking\'s balance', async () => {
        check(row.depositCents === contract.depositCents, `booking ${row.id} took a deposit of ${row.depositCents}, not ${contract.depositCents}`);
        check(!!row.balance, `booking ${row.id} has no balance arranged`);
        const paidDeposit = row.deposits.filter((leg) => leg.status === 'succeeded').reduce((s, leg) => s + leg.amountCents, 0);
        check(paidDeposit === contract.depositCents, `booking ${row.id}'s deposit paid ${paidDeposit}, expected ${contract.depositCents}`);
        const paidBalance = row.balances.filter((leg) => leg.status === 'succeeded').reduce((s, leg) => s + leg.amountCents, 0);
        check(
          !!row.balance.paidAt && paidBalance === balanceCents,
          `booking ${row.id}'s balance was due at ${row.balance.dueAt} and is not charged ` +
            `(paid ${paidBalance} of ${balanceCents}, ${row.balance.attempts} attempts, last failure ${row.balance.lastFailureCode ?? 'none'})`,
        );
        return `booking ${row.id}: deposit ${paidDeposit} + balance ${paidBalance} charged ${row.balance.paidAt}`;
      });
    } catch (err) {
      verifyFailure ??= err;
    }
    // Refund and cancel whatever was charged, verified or not, so nothing piles up.
    try {
      await step('the earlier booking is refunded in full and cancelled', async () => {
        const refund = await refundAndCancel(row.id);
        expectStatus(refund, 200, 201);
        check(refund.json?.status === 'refunded', `the booking came back "${refund.json?.status}"`);
        const total = liveRefundCents(refund.json?.refunds);
        check(
          total > 0 && total === refund.json?.orderTotalCents,
          `refunds total ${total} against payments of ${refund.json?.orderTotalCents}`,
        );
        return `refunded ${total} of ${refund.json?.orderTotalCents}`;
      });
    } catch (err) {
      verifyFailure ??= err;
    }
    verified += 1;
  }

  // ── 2. A new booking for the next run ────────────────────────────────────
  if (outstanding === 0) {
    let startAt;
    await step('find a slot just past the balance window', async () => {
      const earliest = Date.now() + contract.balanceDueDaysBeforeStart * DAY_MS + contract.leadMinutesPastBalanceWindow * MINUTE_MS;
      const from = dateKeyOf(earliest);
      const to = dateKeyOf(earliest + DAY_MS);
      const open = await api('GET', `/bookables/${contract.bookableId}/open-times?from=${from}&to=${to}`);
      expectStatus(open, 200);
      check(open.json?.timezone === 'UTC', `the service keeps time in "${open.json?.timezone}", not UTC`);
      const slots = (open.json?.days ?? []).flatMap((day) =>
        (day.startTimes ?? []).map((time) => `${day.dateKey}T${time}:00.000Z`),
      );
      startAt = slots.find((iso) => Date.parse(iso) >= earliest);
      check(!!startAt, `no open slot after ${new Date(earliest).toISOString()}`);
      return startAt;
    });

    let checkout;
    await step('check out with a deposit and the balance due later', async () => {
      const create = await api('POST', `/bookables/${contract.bookableId}/checkout`, {
        headers: probeHeaders(),
        body: { requestId: randomUUID(), requestedStartAt: startAt, contact: { email: BUYER_EMAIL } },
      });
      expectStatus(create, 200, 201);
      checkout = create.json ?? {};
      newBookingId = checkout.booking?.id ?? null;
      newAccessToken = checkout.accessToken ?? null;
      check(!!newBookingId && !!newAccessToken, 'no booking id or access token came back');
      const quote = checkout.booking?.quote;
      check(quote?.totalCents === contract.priceCents, `total ${quote?.totalCents} is not ${contract.priceCents}`);
      check(quote?.depositCents === contract.depositCents, `deposit ${quote?.depositCents} is not ${contract.depositCents}: the balance was not left for later`);
      check(quote?.currency === contract.currency, `the booking is in "${quote?.currency}"`);
      check(checkout.payment?.clientConfig?.mode === 'test', `the payment was made in mode "${checkout.payment?.clientConfig?.mode}"`);
      check(!!paymentIntentOf(checkout.payment?.clientToken), 'the checkout carried no payment to confirm');
      return `booking ${newBookingId}, deposit ${quote.depositCents} of ${quote.totalCents} ${quote.currency}`;
    });

    await step('pay the deposit with a good test card', async () => {
      const publishableKey = checkout.payment.clientConfig.publishableKey;
      assertTestKey('checkout', publishableKey, checkout.payment.clientConfig.mode);
      const paid = await confirmPayment(checkout.payment.clientToken, publishableKey, GOOD_CARD);
      check(paid.status === 200 && paid.json?.status === 'succeeded', `the deposit did not succeed (HTTP ${paid.status}, ${paid.json?.status ?? paid.json?.error?.code})`);
      check(paid.json?.livemode === false, 'the payment reports livemode, STOP: this is not a test payment');
      check(paid.json?.amount === contract.depositCents, `the provider charged ${paid.json?.amount}, not the deposit`);
      newPaid = true;
      return `paid ${paid.json.amount} ${paid.json.currency}`;
    });

    await step('the booking confirms with its balance still owed', async () => {
      await api('POST', `/bookings/${newBookingId}/confirm`, { body: { token: newAccessToken } });
      await waitFor('the booking being confirmed', async () => {
        const read = await api('GET', `/bookings/${newBookingId}`, { headers: { 'x-booking-access-token': newAccessToken } });
        const status = read.json?.booking?.status ?? read.json?.status;
        return status === 'confirmed' || status;
      });
      const list = await api('GET', `/bookables/${contract.bookableId}/probe-deposits`, { headers: probeHeaders() });
      expectStatus(list, 200);
      const mine = (list.json?.bookings ?? []).find((row) => row.id === newBookingId);
      check(!!mine?.balance?.dueAt && !mine.balance.paidAt, `the new booking has no balance owed later (${JSON.stringify(mine?.balance ?? null)})`);
      return `balance of ${balanceCents} due ${mine.balance.dueAt}`;
    });
  }

  if (verifyFailure) throw verifyFailure;
} catch (err) {
  failure = err instanceof ProbeFailure ? err : new ProbeFailure(`unexpected error: ${err?.message || err}`);
} finally {
  if (newBookingId && !newPaid) {
    const cancel = await api('POST', `/bookings/${newBookingId}/cancel`, { body: { token: newAccessToken } }).catch(() => null);
    console.log(
      cancel?.status === 200
        ? `cleanup: cancelled unpaid booking ${newBookingId}`
        : `cleanup: could not cancel ${newBookingId}; an unpaid hold lapses on its own`,
    );
  }
}

// Reported only when a previous booking was checked, or something went wrong.
const report = verified > 0 || failure !== null;
if (!report) console.log('nothing due to check yet: booked for the next run, booking.deposit not reported');
await finish('booking deposit probe', failure, report ? [{ checkKey: 'booking.deposit', names: [...new Set(steps.map((s) => s.name))] }] : []);
