#!/usr/bin/env node
/**
 * The PAID checkout probe.
 *
 *   PROBE_API_URL=… PROBE_API_KEY=… node scripts/paid-checkout-probe.mjs
 *
 * The plain shop probe (`checkout-probe.mjs`) creates an order and cancels it;
 * it never takes a payment, so a green run there does not prove a card can be
 * charged. This one goes all the way, in TEST mode, on the same test
 * organization and the same probe-only product:
 *
 *   create order → pay with a card that is DECLINED → the same order pays with
 *   a good test card → the order completes → refund it through the seller's own
 *   refund path → read the refund back from the payment provider
 *
 * and reports four checks to the Reliability page from what it saw:
 *
 *   shop.declined_retry  a declined card left the order payable, and it paid
 *   shop.card_payment    a test card payment went through and completed the order
 *   shop.refund          the refund went through on the shop order
 *   refunds.settled      the provider holds a refund for the full amount
 *
 * SAFETY
 * ------
 *  - The organization is pinned in `checkout-probe-fixture.json`, and the
 *    payment account is checked to be a TEST account (`pk_test_`, mode test)
 *    twice before any card is used: on `/payments/config` and on the order.
 *  - The cards are the payment provider's published test payment methods
 *    (`pm_card_chargeDeclined`, `pm_card_visa`). They only exist in test mode;
 *    a live account refuses them, so a live key could not charge anything here
 *    even if every check above were wrong.
 *  - The payment is confirmed with the PUBLISHABLE key and the order's client
 *    secret, the way a buyer's browser does. No secret key is held here.
 *  - The refund route refuses any order that is not the probe's on a test
 *    organization. An order that completed and could not be refunded is named
 *    in the output; it is test money on a test account.
 *  - `PROBE_API_KEY`, the client secret and the receipt token are never printed.
 *
 * Plain Node, no packages, so it runs in the public probe repository too. It
 * holds no product names or addresses: the API address comes from the
 * environment, and the run refuses to start without it.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { reportProbeRun } from './report-reliability-result.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contract = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'scripts/checkout-probe-fixture.json'), 'utf8'),
);
const spec = contract.product;

const API_URL = (process.env.PROBE_API_URL || '').replace(/\/+$/, '');
const PROBE_API_KEY = process.env.PROBE_API_KEY;
const PROVIDER_API = 'https://api.stripe.com/v1';
const DECLINED_CARD = 'pm_card_chargeDeclined';
const GOOD_CARD = 'pm_card_visa';
/** The provider wants somewhere to send a buyer after a redirect method; a card never redirects. */
const RETURN_URL = 'https://example.com/probe-return';

const STEP_TIMEOUT_MS = 20_000;
const COMPLETE_POLL_MS = 2_000;
const COMPLETE_WITHIN_MS = 45_000;

const started = Date.now();
/** Every step, in order: `{ name, ok, ms, detail }`. */
const steps = [];
let orderId = null;
let paid = false;
let refunded = false;

class ProbeFailure extends Error {}

function fail(message) {
  throw new ProbeFailure(message);
}

function redactText(text) {
  return String(text ?? '')
    .replace(/("(?:clientSecret|client_secret|receiptToken|token)"\s*:\s*")[^"]*/gi, '$1[redacted]')
    .replace(/\bpi_[A-Za-z0-9]+_secret_[A-Za-z0-9]+/g, '[redacted]');
}

function short(text, max = 280) {
  const flat = redactText(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Runs one step; a thrown failure is recorded against it and rethrown. */
async function step(name, run) {
  const at = Date.now();
  try {
    const detail = await run();
    steps.push({ name, ok: true, ms: Date.now() - at, detail: detail ?? '' });
  } catch (err) {
    const message = err instanceof ProbeFailure ? err.message : `${err?.name || 'Error'}: ${err?.message || ''}`;
    steps.push({ name, ok: false, ms: Date.now() - at, detail: short(message) });
    throw new ProbeFailure(`${name}: ${message}`);
  }
}

async function api(method, urlPath, { headers = {}, body } = {}) {
  let response;
  try {
    response = await fetch(`${API_URL}${urlPath}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
    });
  } catch (err) {
    fail(`${method} ${urlPath} did not complete (${err?.name === 'TimeoutError' ? 'timed out' : err?.name})`);
  }
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* the text is the diagnostic */
  }
  return { status: response.status, json, text };
}

function expectStatus(result, expected) {
  if (result.status !== expected) fail(`expected HTTP ${expected}, got ${result.status}: ${short(result.text)}`);
}

/** Confirm the order's payment as a buyer's browser does: publishable key plus client secret. */
async function confirmPayment(paymentIntentId, clientSecret, publishableKey, paymentMethod) {
  const form = new URLSearchParams({
    key: publishableKey,
    client_secret: clientSecret,
    payment_method: paymentMethod,
    return_url: RETURN_URL,
  });
  let response;
  try {
    response = await fetch(`${PROVIDER_API}/payment_intents/${paymentIntentId}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
    });
  } catch (err) {
    fail(`the payment provider did not answer (${err?.name})`);
  }
  const json = await response.json().catch(() => null);
  return { status: response.status, json };
}

const probeHeaders = () => ({ 'x-probe-key': PROBE_API_KEY });

let failure = null;
try {
  if (!API_URL) fail('PROBE_API_URL is unset.');
  if (!PROBE_API_KEY) fail('PROBE_API_KEY is unset, so the probe cannot mark, refund or cancel its order.');

  let product;
  let variant;
  let organization;
  await step('find the probe product', async () => {
    const storefront = await api('GET', `/organizations/${contract.orgSlug}/shop/${spec.slug}`);
    expectStatus(storefront, 200);
    organization = storefront.json?.organization;
    product = storefront.json?.product;
    if (organization?.slug !== contract.orgSlug) fail(`served organization "${organization?.slug}", refusing to buy`);
    variant = product?.variants?.[0];
    if (!variant || product.variants.length !== 1) fail('the probe product does not have exactly one variant');
    if (variant.price !== spec.priceCents) fail(`price ${variant.price} is not the fixture's ${spec.priceCents}`);
    if (!(variant.stock > 0)) fail('the probe product is out of stock');
    return `${spec.priceCents} cents, ${variant.stock} in stock`;
  });

  await step('the payment account is a test account', async () => {
    const config = await api('GET', `/payments/config?orgId=${encodeURIComponent(organization.id)}`);
    expectStatus(config, 200);
    const key = config.json?.publishableKey;
    if (!(typeof key === 'string' && key.startsWith('pk_test_') && config.json?.mode === 'test')) {
      fail(`the account is not in test mode (mode "${config.json?.mode}"), refusing to pay`);
    }
    return `provider ${config.json?.provider}, test mode`;
  });

  let order;
  let paymentIntentId;
  let lastDecline = null;
  await step('start a shop order', async () => {
    const create = await api('POST', '/shop-orders', {
      headers: probeHeaders(),
      body: {
        items: [{ productId: product.id, variantId: variant.id, quantity: 1 }],
        customerEmail: process.env.PROBE_CUSTOMER_EMAIL || contract.customerEmail,
        fulfillmentChoice: 'pickup',
      },
    });
    expectStatus(create, 201);
    order = create.json ?? {};
    orderId = order.orderId ?? null;
    if (!orderId) fail('no order id came back');
    if (!(typeof order.publishableKey === 'string' && order.publishableKey.startsWith('pk_test_'))) {
      fail('the order was not created on a test payment account');
    }
    if (order.total !== spec.priceCents) fail(`total ${order.total} is not ${spec.priceCents}`);
    paymentIntentId = String(order.clientSecret ?? '').split('_secret_')[0];
    if (!paymentIntentId.startsWith('pi_') || !order.receiptToken) fail('the order carried no payment to confirm');
    return `order ${orderId}, total ${order.total} cents`;
  });

  await step('a declined card is declined', async () => {
    const declined = await confirmPayment(paymentIntentId, order.clientSecret, order.publishableKey, DECLINED_CARD);
    lastDecline = declined;
    const code = declined.json?.error?.code ?? declined.json?.error?.decline_code;
    if (declined.status < 400 || !/declin/.test(String(code) + String(declined.json?.error?.decline_code))) {
      fail(`expected a decline, got HTTP ${declined.status} (${code ?? declined.json?.status})`);
    }
    return `declined: ${code}`;
  });

  await step('the order can still be paid after the decline', async () => {
    // The receipt only opens once an order is paid, so the provider's own word
    // is read here; the next step paying THIS order is what proves it end to end.
    const status = lastDecline?.json?.error?.payment_intent?.status;
    if (status !== 'requires_payment_method') fail(`after the decline the payment is "${status}", not retryable`);
    return 'the payment is waiting for another card';
  });

  await step('pay with a good test card', async () => {
    const good = await confirmPayment(paymentIntentId, order.clientSecret, order.publishableKey, GOOD_CARD);
    if (good.status !== 200 || good.json?.status !== 'succeeded') {
      fail(`expected the payment to succeed, got HTTP ${good.status} (${good.json?.status ?? good.json?.error?.code})`);
    }
    paid = true;
    return `paid ${good.json?.amount} ${good.json?.currency}`;
  });

  await step('the order completes', async () => {
    const confirm = await api('POST', `/shop-orders/${orderId}/confirm`, { body: { receiptToken: order.receiptToken } });
    if (confirm.status !== 201 && confirm.status !== 200) fail(`confirm answered HTTP ${confirm.status}: ${short(confirm.text)}`);
    const deadline = Date.now() + COMPLETE_WITHIN_MS;
    let status = null;
    while (Date.now() < deadline) {
      const receipt = await api('GET', `/shop-orders/${orderId}/receipt?token=${encodeURIComponent(order.receiptToken)}`);
      status = receipt.json?.status ?? null;
      if (status === 'completed') return 'completed';
      await new Promise((resolve) => setTimeout(resolve, COMPLETE_POLL_MS));
    }
    fail(`the order was still "${status}" ${COMPLETE_WITHIN_MS / 1000}s after a successful payment`);
  });

  let refund;
  await step('refund the order', async () => {
    refund = await api('POST', `/shop-orders/${orderId}/probe-refund`, { headers: probeHeaders() });
    expectStatus(refund, 201);
    if (refund.json?.status !== 'refunded') fail(`the order came back "${refund.json?.status}"`);
    refunded = true;
    return 'refunded';
  });

  await step('the provider holds a refund for the full amount', async () => {
    const refunds = refund.json?.refunds ?? [];
    const total = refunds
      .filter((row) => row.status !== 'refund_failed' && row.status !== 'refund_canceled')
      .reduce((sum, row) => sum + (row.amountCents || 0), 0);
    if (total !== refund.json?.orderTotalCents) {
      fail(`refunds total ${total} cents against an order of ${refund.json?.orderTotalCents} (${refunds.map((r) => r.status).join(', ') || 'none'})`);
    }
    return refunds.map((row) => `${row.amountCents} ${row.currency} ${row.status}`).join('; ');
  });
} catch (err) {
  failure = err instanceof ProbeFailure ? err : new ProbeFailure(`unexpected error: ${err?.message || err}`);
} finally {
  if (orderId && !paid) {
    const cancel = await api('POST', `/shop-orders/${orderId}/cancel`, { headers: probeHeaders() }).catch(() => null);
    console.log(
      cancel?.status === 201
        ? `cleanup: cancelled unpaid order ${orderId}`
        : `cleanup: could not cancel ${orderId}; the expiry sweep releases it within 15 minutes`,
    );
  } else if (orderId && paid && !refunded) {
    console.log(`cleanup: order ${orderId} was paid with a test card and NOT refunded. It is test money on a test account.`);
  }
}

console.log('\n── steps ───────────────────────────────────────────────────');
for (const entry of steps) console.log(`  ${entry.ok ? 'pass' : 'FAIL'} ${String(entry.ms).padStart(6)}ms  ${entry.name}  ${entry.detail}`);

/** The steps a check is judged on, in run order; a check whose steps never ran fails as not reached. */
function slice(names) {
  return steps.filter((entry) => names.includes(entry.name));
}

const SETUP = ['find the probe product', 'the payment account is a test account', 'start a shop order'];
const CHECKS = [
  { checkKey: 'shop.declined_retry', names: [...SETUP, 'a declined card is declined', 'the order can still be paid after the decline', 'pay with a good test card'] },
  { checkKey: 'shop.card_payment', names: [...SETUP, 'pay with a good test card', 'the order completes'] },
  { checkKey: 'shop.refund', names: [...SETUP, 'pay with a good test card', 'the order completes', 'refund the order'] },
  { checkKey: 'refunds.settled', names: [...SETUP, 'pay with a good test card', 'the order completes', 'refund the order', 'the provider holds a refund for the full amount'] },
];

let anyFailed = false;
for (const { checkKey, names } of CHECKS) {
  const own = slice(names);
  const failedStep = own.find((entry) => !entry.ok);
  const missing = names.filter((name) => !own.some((entry) => entry.name === name));
  const passed = !failedStep && missing.length === 0;
  if (!passed) anyFailed = true;
  await reportProbeRun({
    checkKey,
    startedMs: started,
    steps: [...own, ...missing.map((name) => ({ name, ok: false, ms: 0, detail: 'not reached' }))],
    ...(passed
      ? {}
      : {
          failureMessage: failedStep ? `${failedStep.name}: ${failedStep.detail}` : `not reached: ${missing[0]}`,
          failedStep: failedStep ? failedStep.name : missing[0],
        }),
  });
  console.log(`${passed ? 'pass' : 'FAIL'}  ${checkKey}`);
}

if (failure) console.error(`\npaid checkout probe FAILED: ${failure.message}`);
process.exit(anyFailed ? 1 : 0);
