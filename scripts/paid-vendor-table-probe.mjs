#!/usr/bin/env node
/**
 * The PAID vendor table checkout probe.
 *
 *   PROBE_API_URL=… PROBE_API_KEY=… PROBE_CUSTOMER_EMAIL=… node scripts/paid-vendor-table-probe.mjs
 *
 * The plain vendor probe (`vendor-tables-probe.mjs`) reserves a table and
 * cancels it; it never takes a payment. This one goes all the way, in TEST
 * mode, on the same test organization, event and table:
 *
 *   reserve the table → a DECLINED test card is declined → the same order pays
 *   with a good test card → the order completes → refund it through the
 *   seller's refund path (probe-only route), which puts the table back on the
 *   floor → read the refund back from the payment provider
 *
 * Reports `vendor_table.declined_retry`, `vendor_table.card_payment` and
 * `vendor_table.refund`. The workflow runs this and the plain vendor probe in
 * turn, never together: both buy the same pinned table.
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
  readFileSync(path.join(REPO_ROOT, 'scripts/vendor-tables-probe-fixture.json'), 'utf8'),
);

let orderId = null;
let eventId = null;
let paid = false;
let refunded = false;
let failure = null;

async function readTable() {
  const floor = await api('GET', `/events/${eventId}/vendor-tables/public`);
  expectStatus(floor, 200);
  const table = (floor.json?.tables ?? []).find((t) => t.name === contract.sellableTableName);
  check(!!table, `table "${contract.sellableTableName}" is not on the floor plan`);
  return table;
}

try {
  assertConfigured();

  await step('find the probe event and table', async () => {
    const preview = await api('GET', `/events/${contract.eventSlug}/public-preview/v2`);
    expectStatus(preview, 200);
    eventId = preview.json?.event?.id;
    check(!!eventId, 'the event has no id');
    const table = await readTable();
    check(table.status === 'available', `table "${table.name}" is "${table.status}", not available`);
    check(table.price > 0, `table "${table.name}" is free, so there is nothing to pay`);
    return `table ${table.name}, ${table.price} cents`;
  });

  let publishableKey;
  await step('the payment account is a test account', async () => {
    const config = await api('GET', `/payments/config?eventId=${encodeURIComponent(eventId)}`);
    expectStatus(config, 200);
    assertTestKey('/payments/config', config.json?.publishableKey, config.json?.mode);
    publishableKey = config.json.publishableKey;
    return `provider ${config.json?.provider}, test mode`;
  });

  let order;
  await step('start a vendor table order', async () => {
    const table = await readTable();
    const create = await api('POST', `/events/${eventId}/vendor-tables/setup-checkout`, {
      headers: probeHeaders(),
      body: { tableIds: [table._id] },
    });
    expectStatus(create, 200, 201);
    order = create.json ?? {};
    orderId = order.orderId ?? null;
    check(!!orderId, 'no order id came back');
    check(order.isProbe === true, 'the order came back unmarked: the backend did not accept the probe key');
    check(order.currency === contract.expectedCurrency, `the order is in "${order.currency}"`);
    check(order.payment?.clientConfig?.mode === 'test', `the payment was made in mode "${order.payment?.clientConfig?.mode}"`);
    check(!!paymentIntentOf(order.clientSecret) && !!order.receiptToken, 'the order carried no payment to confirm');
    return `order ${orderId}, total ${order.total} ${order.currency}`;
  });

  // A real vendor gives a name, an email and a phone before paying, and the
  // confirmation email goes to that email. Without this the order completes with
  // no address and no receipt is ever sent, so `vendor_table.receipt_email` has
  // nothing to find. The fixed test buyer, never a per-run address, and no
  // phone, so nothing can be texted.
  await step('give the vendor details', async () => {
    const info = await api('PATCH', `/events/${eventId}/vendor-tables/orders/${orderId}/vendor-info`, {
      body: { vendorName: 'Reliability probe', vendorEmail: BUYER_EMAIL, vendorPhone: '' },
    });
    expectStatus(info, 200);
    return 'vendor details saved';
  });

  await declineThenPay(order.clientSecret, publishableKey, () => {
    paid = true;
  });

  await step('the order completes', async () => {
    const confirm = await api('POST', `/events/${eventId}/vendor-tables/orders/${orderId}/confirm`);
    await waitFor('the order being completed', async () => {
      const receipt = await api('GET', `/vendor-tables/orders/${orderId}/receipt?token=${encodeURIComponent(order.receiptToken)}`);
      const status = receipt.json?.status ?? receipt.json?.order?.status;
      return status === 'completed' || status;
    });
    return `completed (confirm answered ${confirm.status})`;
  });

  await refundAndReadBack(`/vendor-tables/orders/${orderId}/probe-refund`, () => {
    refunded = true;
  });

  await step('the refunded table is back on the floor', async () => {
    const table = await readTable();
    check(table.status === 'available', `table "${table.name}" is "${table.status}" after the refund`);
    return 'available';
  });
} catch (err) {
  failure = err instanceof ProbeFailure ? err : new ProbeFailure(`unexpected error: ${err?.message || err}`);
} finally {
  if (orderId && !paid) {
    const cancel = await api('POST', `/events/${eventId}/vendor-tables/orders/${orderId}/cancel`).catch(() => null);
    console.log(
      cancel && cancel.status < 300
        ? `cleanup: cancelled unpaid order ${orderId}`
        : `cleanup: could not cancel ${orderId}; its ten-minute reservation lapses on its own`,
    );
  } else if (orderId && paid && !refunded) {
    console.log(`cleanup: order ${orderId} was paid with a test card and NOT refunded. It is test money on a test account.`);
  }
}

const SETUP = ['find the probe event and table', 'the payment account is a test account', 'start a vendor table order', 'give the vendor details'];
await finish('paid vendor table probe', failure, [
  { checkKey: 'vendor_table.declined_retry', names: [...SETUP, ...PAID_STEPS.declined] },
  { checkKey: 'vendor_table.card_payment', names: [...SETUP, ...PAID_STEPS.paid, 'the order completes'] },
  {
    checkKey: 'vendor_table.refund',
    names: [...SETUP, ...PAID_STEPS.paid, 'the order completes', ...PAID_STEPS.refund, 'the refunded table is back on the floor'],
  },
]);
