#!/usr/bin/env node
/**
 * The PAID ticket checkout probe.
 *
 *   PROBE_API_URL=… PROBE_API_KEY=… PROBE_CUSTOMER_EMAIL=… node scripts/paid-ticket-probe.mjs
 *
 * The plain ticket probe (`ticket-checkout-probe.mjs`) creates an order and
 * cancels it; it never takes a payment. This one goes all the way, in TEST
 * mode, on the same test organization, event and tier:
 *
 *   start a ticket order → a DECLINED test card is declined → the same order
 *   pays with a good test card → the order completes → refund it through the
 *   seller's refund path (probe-only route) → read the refund back from the
 *   payment provider
 *
 * Reports `ticket.declined_retry`, `ticket.card_payment` and `ticket.refund`.
 * The full refund releases the seat, so the tier ends the run where it began;
 * the workflow runs this and the plain ticket probe in turn, never together,
 * because the plain probe counts that tier's seats before and after.
 *
 * Safety is `paid-probe-lib.mjs`'s: test mode asserted before any card, test
 * cards only, publishable key only, and a refund route that refuses anything
 * but the probe's own order on a test organization.
 */
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
  readFileSync(path.join(REPO_ROOT, 'scripts/ticket-checkout-probe-fixture.json'), 'utf8'),
);

let orderId = null;
let paid = false;
let refunded = false;
let failure = null;

try {
  assertConfigured();

  const { event, tier } = await step('find the probe event and tier', async () => {
    const preview = await api('GET', `/events/${contract.eventSlug}/public-preview/v2`);
    expectStatus(preview, 200);
    const found = preview.json?.event;
    const sellable = (found?.ticketTypes ?? []).find((t) => t.name === contract.sellableTierName);
    check(!!sellable, `tier "${contract.sellableTierName}" is not on the event`);
    check(sellable.price > 0, `tier "${sellable.name}" is free, so there is nothing to pay`);
    check(sellable.availableCount === null || sellable.availableCount > 0, 'the tier has no seats');
    return { event: found, tier: sellable };
  });

  let publishableKey;
  await step('the payment account is a test account', async () => {
    const config = await api('GET', `/payments/config?eventId=${encodeURIComponent(event.id)}`);
    expectStatus(config, 200);
    assertTestKey('/payments/config', config.json?.publishableKey, config.json?.mode);
    publishableKey = config.json.publishableKey;
    return `provider ${config.json?.provider}, test mode`;
  });

  let order;
  await step('start a ticket order', async () => {
    const create = await api('POST', `/events/${event.id}/orders`, {
      headers: probeHeaders(),
      body: { items: [{ ticketTypeId: tier.id, quantity: 1 }], customerEmail: BUYER_EMAIL },
    });
    expectStatus(create, 200, 201);
    order = create.json ?? {};
    orderId = order.orderId ?? null;
    check(!!orderId, 'no order id came back');
    check(order.total === tier.price, `total ${order.total} is not the tier's ${tier.price}`);
    check(order.payment?.clientConfig?.mode === 'test', `the payment was made in mode "${order.payment?.clientConfig?.mode}"`);
    check(!!paymentIntentOf(order.clientSecret) && !!order.receiptToken, 'the order carried no payment to confirm');
    return `order ${orderId}, total ${order.total} ${order.currency}`;
  });

  await declineThenPay(order.clientSecret, publishableKey, () => {
    paid = true;
  });

  await step('the order completes', async () => {
    // The buyer's browser calls this after paying; the webhook is the source of
    // truth either way, so its answer is recorded and the receipt is what decides.
    const confirm = await api('POST', `/orders/${orderId}/confirm`);
    await waitFor('the order being completed', async () => {
      const receipt = await api('GET', `/orders/${orderId}/receipt?token=${encodeURIComponent(order.receiptToken)}`);
      return receipt.json?.status === 'completed' || receipt.json?.status;
    });
    return `completed (confirm answered ${confirm.status})`;
  });

  await refundAndReadBack(`/orders/${orderId}/probe-refund`, () => {
    refunded = true;
  });
} catch (err) {
  failure = err instanceof ProbeFailure ? err : new ProbeFailure(`unexpected error: ${err?.message || err}`);
} finally {
  if (orderId && !paid) {
    const cancel = await api('POST', `/orders/${orderId}/probe-cancel`, { headers: probeHeaders() }).catch(() => null);
    console.log(
      cancel?.status === 200
        ? `cleanup: cancelled unpaid order ${orderId}`
        : `cleanup: could not cancel ${orderId}; the expiry sweep releases it within ten minutes`,
    );
  } else if (orderId && paid && !refunded) {
    console.log(`cleanup: order ${orderId} was paid with a test card and NOT refunded. It is test money on a test account.`);
  }
}

const SETUP = ['find the probe event and tier', 'the payment account is a test account', 'start a ticket order'];
await finish('paid ticket probe', failure, [
  { checkKey: 'ticket.declined_retry', names: [...SETUP, ...PAID_STEPS.declined] },
  { checkKey: 'ticket.card_payment', names: [...SETUP, ...PAID_STEPS.paid, 'the order completes'] },
  { checkKey: 'ticket.refund', names: [...SETUP, ...PAID_STEPS.paid, 'the order completes', ...PAID_STEPS.refund] },
]);
