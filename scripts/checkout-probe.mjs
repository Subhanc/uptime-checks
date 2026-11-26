#!/usr/bin/env node
/**
 * The synthetic checkout probe — MOT-523.
 *
 *   PROBE_API_KEY=… node scripts/checkout-probe.mjs
 *
 * Drives a real guest checkout against PRODUCTION every ten minutes and fails
 * loudly when it cannot:
 *
 *   resolve the probe SKU  →  create an order  →  re-price it  →  cancel it
 *
 * WHY IT RUNS OUTSIDE THE BACKEND
 * -------------------------------
 * On 2026-08-16 a real customer's checkout died inside a deploy blackout and
 * nothing noticed, because everything that could have noticed was the thing that
 * was down. A backend cannot report its own absence. So this runs on GitHub
 * Actions, on a schedule, from outside — and the backend runs an hourly watchdog
 * (`ProbeWatchdogService`) that alerts when no probe order has appeared, which
 * is the half a GitHub workflow structurally cannot report about itself.
 *
 * WHAT "FAILURE" MEANS HERE
 * -------------------------
 * A non-zero exit. That is the whole alerting contract: the workflow run goes
 * red and GitHub mails the repository owner, with no webhook, no secret and no
 * third-party service required to be configured. If `SLACK_ALERTS_WEBHOOK_URL`
 * happens to be set the same failure is also posted there — an addition, never
 * the mechanism.
 *
 * SAFETY
 * ------
 *  - The org is PINNED in `checkout-probe-fixture.json` and re-asserted against
 *    the API response before anything is created. The workflow separately runs
 *    `assert-test-org.sh` against the same slug before this script is invoked.
 *  - `publishableKey` is checked for the `pk_test_` prefix at create time. That
 *    is not a proxy for `isTestAccount` — it is resolved by the same
 *    `StripeService.isTestAccount(orgId)` call `getStripe` uses to pick the
 *    account, so it proves the account that would have taken the money. The run
 *    aborts and cancels immediately if it ever reads `pk_live_`.
 *  - Every order this creates is cancelled, including on the failure path. An
 *    order it could not cancel is released by the backend's expiry sweep within
 *    15 minutes, and that sweep tags it `isProbe` precisely so a probe that
 *    failed to clean up is visible rather than silent.
 *  - `PROBE_API_KEY` is sent as a header and is never printed, in any branch.
 *    Neither are `clientSecret` or `receiptToken`, both of which are bearer
 *    capabilities over the order.
 *
 * ZERO DEPENDENCIES ON PURPOSE
 * ----------------------------
 * Node's built-in `fetch` and nothing else — no `npm ci`, no `node_modules`, no
 * lockfile to resolve. A monitor whose own install step can fail is a monitor
 * that reports the wrong outage, 144 times a day.
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

/**
 * Per-step deadline. Deliberately well under the workflow's own timeout: a step
 * that hangs must fail as THAT step, so the report names what was slow, rather
 * than being killed anonymously by the job timeout with nothing to read.
 */
const STEP_TIMEOUT_MS = 20_000;

/** The only host Slack serves incoming webhooks from — exact match, never a suffix test. */
const SLACK_WEBHOOK_HOST = 'hooks.slack.com';

const started = Date.now();
const steps = [];

/**
 * The request in flight, by its label. Read once, when a run fails, to name the
 * step in the Reliability report: a request that never completed pushed no
 * timeline entry, so the timeline alone cannot say where a network failure hit.
 */
let currentLabel = null;

class ProbeFailure extends Error {}

function fail(message) {
  throw new ProbeFailure(message);
}

function check(condition, message) {
  if (!condition) fail(message);
}

/**
 * Strip every bearer capability before anything is printed. `clientSecret`
 * confirms the PaymentIntent; `receiptToken` re-prices the order and unlocks its
 * receipt. Both would otherwise land in a public Actions log.
 */
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) =>
        key === 'clientSecret' || key === 'receiptToken'
          ? [key, '[redacted]']
          : [key, redact(inner)],
      ),
    );
  }
  return value;
}

/**
 * The same two capabilities, stripped from RAW text.
 *
 * `redact` only reaches a body that parsed. A response truncated mid-transfer
 * does not parse — and a network fault mid-transfer is exactly the condition
 * this probe exists to catch, so the unparseable body is the one most likely to
 * be printed. Printing it verbatim would put a `receiptToken` (re-prices the
 * order, unlocks its receipt) or a `clientSecret` (confirms the PaymentIntent)
 * into a public Actions log at the precise moment something is going wrong.
 */
function redactText(text) {
  return String(text ?? '').replace(
    /("(?:clientSecret|receiptToken)"\s*:\s*")[^"]*/gi,
    '$1[redacted]',
  );
}

function truncate(text, max = 400) {
  const flat = redactText(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

async function request(label, method, urlPath, { headers = {}, body } = {}) {
  const url = `${API_URL}${urlPath}`;
  const at = Date.now();
  currentLabel = label;
  let response;
  try {
    response = await fetch(url, {
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
    const reason = err?.name === 'TimeoutError' ? `no response in ${STEP_TIMEOUT_MS}ms` : err?.name;
    // A network-level failure here is the exact shape of the incident this
    // probe exists to catch, so it is reported as the step it happened on.
    fail(`${label}: ${method} ${urlPath} did not complete — ${reason || 'network error'}`);
  }

  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* a non-JSON body is itself the diagnostic; `text` is reported below */
  }

  const ms = Date.now() - at;
  steps.push({ label, method, path: urlPath, status: response.status, ms });
  return { status: response.status, json, text, ms };
}

function expectStatus(label, result, expected) {
  if (result.status !== expected) {
    fail(
      `${label}: expected HTTP ${expected}, got ${result.status}. ` +
        `Body: ${truncate(result.json ? JSON.stringify(redact(result.json)) : result.text)}`,
    );
  }
}

/**
 * Post the failure to Slack, if and only if a webhook is configured AND it is
 * genuinely Slack's.
 *
 * This mirrors `backend/src/common/alerts/slack-alert.ts` rather than importing
 * it — that module is TypeScript inside the backend package, and this script's
 * whole point is to run with no build and no install. The rule is small enough
 * to state twice and is stated identically in both places: https only, host
 * `hooks.slack.com` exactly, never a suffix match, URL never logged.
 */
async function postSlack(text) {
  const configured = process.env.SLACK_ALERTS_WEBHOOK_URL;
  if (!configured || !configured.trim()) return 'not_configured';

  let url;
  try {
    url = new URL(configured.trim());
  } catch {
    return 'refused: value is not a valid URL';
  }
  if (url.protocol !== 'https:' || url.hostname !== SLACK_WEBHOOK_HOST) {
    // The host is the diagnostic; the path is the secret.
    return `refused: ${url.protocol}//${url.hostname} is not https://${SLACK_WEBHOOK_HOST}`;
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok ? 'posted' : `slack responded ${response.status}`;
  } catch (err) {
    return err?.name || 'UnknownError';
  }
}

function printTimeline() {
  console.log('\n── timeline ─────────────────────────────────────────────────');
  for (const step of steps) {
    console.log(`  ${String(step.status).padEnd(4)} ${String(step.ms).padStart(6)}ms  ${step.label}`);
  }
  console.log(`  total ${Date.now() - started}ms`);
  console.log('─────────────────────────────────────────────────────────────');
}

// ── run ────────────────────────────────────────────────────────────────────

let orderId = null;
let cancelled = false;
let failure = null;
let failedLabel = null;

try {
  if (!PROBE_API_KEY) {
    // Not an assertion failure about production — a misconfigured probe. Said
    // in its own words so nobody reads a red run as "checkout is broken".
    fail('PROBE_API_KEY is unset. The probe cannot mark or cancel its own orders without it.');
  }

  console.log(`checkout probe → ${API_URL}`);
  console.log(`org: ${contract.orgSlug}   sku: ${spec.slug}`);

  // ── 1. Resolve the probe SKU from the PUBLIC storefront ──────────────────
  // The same read a buyer's browser does. Resolving from the database instead
  // would test a path no buyer takes.
  const storefront = await request(
    'resolve probe SKU',
    'GET',
    `/organizations/${contract.orgSlug}/shop/${spec.slug}`,
  );
  expectStatus('resolve probe SKU', storefront, 200);

  const organization = storefront.json?.organization;
  const product = storefront.json?.product;
  check(product, 'resolve probe SKU: response carried no product');

  // The org is pinned in the contract; this asserts the API agrees. A slug that
  // silently resolved elsewhere is the one way this probe could write to an org
  // nobody vetted.
  check(
    organization?.slug === contract.orgSlug,
    `resolve probe SKU: served org "${organization?.slug}", expected "${contract.orgSlug}" — refusing to order`,
  );
  check(
    product.slug === spec.slug,
    `resolve probe SKU: served product "${product.slug}", expected "${spec.slug}"`,
  );
  check(
    Array.isArray(product.variants) && product.variants.length === 1,
    `resolve probe SKU: expected exactly 1 active variant, found ${product.variants?.length ?? 0}. ` +
      'Reseed with: node scripts/seed-checkout-probe-fixture.mjs --apply',
  );

  const variant = product.variants[0];
  check(
    variant.price === spec.priceCents,
    `resolve probe SKU: storefront price ${variant.price} != fixture ${spec.priceCents}. ` +
      'Reseed, or update checkout-probe-fixture.json if the change was deliberate.',
  );
  check(
    variant.stock > 0,
    `resolve probe SKU: variant stock is ${variant.stock} — the probe cannot reserve a unit. ` +
      'Reseed with: node scripts/seed-checkout-probe-fixture.mjs --apply',
  );
  check(
    product.shippingPriceCents === spec.shippingPriceCents,
    `resolve probe SKU: storefront ships at ${product.shippingPriceCents}, fixture says ` +
      `${spec.shippingPriceCents}. If this is 'undefined', SHOP_SHIPPING_ENABLED is off and the ` +
      're-price step below cannot be exercised.',
  );

  // ── 1b. Prove the org pays into a TEST Stripe account, BEFORE reserving ──
  // This replaced the workflow's Mongo pre-flight (assert-test-org.sh), which
  // needed a production database credential from backend/.env — a file that
  // left git on 2026-08-30, so the pre-flight failed every run and this probe
  // never executed. `/payments/config` is resolved by the same provider call
  // `getStripe` uses, so it reads the ACCOUNT rather than the flag that picks
  // it — the same check the ticket and vendor probes already rely on. orgId is
  // always sent: without it the endpoint falls back to the platform account,
  // and a missing id must fail here rather than pass on someone else's key.
  check(organization?.id, 'resolve probe SKU: response carried no organization.id — refusing to order');
  const config = await request(
    'payment account is TEST',
    'GET',
    `/payments/config?orgId=${encodeURIComponent(organization.id)}`,
  );
  expectStatus('payment account is TEST', config, 200);
  check(
    typeof config.json?.publishableKey === 'string' &&
      config.json.publishableKey.startsWith('pk_test_') &&
      config.json?.mode === 'test',
    `payment account is TEST: ${contract.orgSlug} resolved "${String(config.json?.publishableKey).slice(0, 8)}…" ` +
      `mode="${config.json?.mode}". The probe org is on a LIVE payment account (has it lost ` +
      'isTestAccount: true?) — refusing to create an order.',
  );
  console.log(`payment account: ${config.json.provider} mode=${config.json.mode}`);

  // ── 2. Create the order ──────────────────────────────────────────────────
  const create =await request('create order', 'POST', '/shop-orders', {
    headers: { 'x-probe-key': PROBE_API_KEY },
    body: {
      items: [{ productId: product.id, variantId: variant.id, quantity: 1 }],
      customerEmail: process.env.PROBE_CUSTOMER_EMAIL || contract.customerEmail,
      fulfillmentChoice: 'pickup',
    },
  });
  expectStatus('create order', create, 201);

  const order = create.json ?? {};
  orderId = order.orderId ?? null;
  check(orderId, 'create order: response carried no orderId');
  console.log(`created order ${orderId}`);

  // Proof of which Stripe account would have taken the money — resolved
  // server-side from the org's `isTestAccount`, the same read `getStripe` makes.
  check(
    typeof order.publishableKey === 'string' && order.publishableKey.startsWith('pk_test_'),
    `create order: Stripe publishable key is "${String(order.publishableKey).slice(0, 8)}…", not a ` +
      'test key. The probe org is on the LIVE Stripe account — cancelling and stopping.',
  );
  check(order.receiptToken, 'create order: response carried no receiptToken, so it cannot be re-priced');
  check(
    order.total === spec.priceCents,
    `create order: total ${order.total} != expected ${spec.priceCents} (one unit, pickup, no shipping)`,
  );
  check(
    order.fulfillmentType === 'pickup',
    `create order: fulfillmentType "${order.fulfillmentType}", expected "pickup"`,
  );

  // ── 3. Re-price it ───────────────────────────────────────────────────────
  // The step the 2026-08-16 incident actually died on: the buyer's pickup/ship
  // toggle re-prices the order AND its PaymentIntent, and a create that works
  // while a re-price does not is a checkout that fails after the buyer has
  // committed.
  const expectedShipTotal = spec.priceCents + spec.shippingPriceCents;
  const reprice = await request(
    're-price to shipping',
    'PATCH',
    `/shop-orders/${orderId}/fulfillment-choice`,
    { body: { fulfillmentChoice: 'shipping', token: order.receiptToken } },
  );
  expectStatus('re-price to shipping', reprice, 200);

  const repriced = reprice.json ?? {};
  check(
    repriced.fulfillmentType === 'shipping',
    `re-price: fulfillmentType came back "${repriced.fulfillmentType}", expected "shipping". ` +
      'SHOP_SHIPPING_ENABLED off collapses every line to pickup — check that before checkout.',
  );
  check(
    repriced.shippingCost === spec.shippingPriceCents,
    `re-price: shippingCost ${repriced.shippingCost} != expected ${spec.shippingPriceCents}`,
  );
  check(
    repriced.total === expectedShipTotal,
    `re-price: total ${repriced.total} != expected ${expectedShipTotal} ` +
      `(${spec.priceCents} goods + ${spec.shippingPriceCents} shipping)`,
  );

  // ── 4. Cancel it ─────────────────────────────────────────────────────────
  const cancel = await request('cancel order', 'POST', `/shop-orders/${orderId}/cancel`, {
    headers: { 'x-probe-key': PROBE_API_KEY },
  });
  expectStatus('cancel order', cancel, 201);
  check(
    cancel.json?.status === 'cancelled',
    `cancel order: status came back "${cancel.json?.status}", expected "cancelled"`,
  );
  cancelled = true;
  console.log(`cancelled order ${orderId} — stock released, PaymentIntent cancelled`);

  // ── 5. Prove the transition is one-shot ──────────────────────────────────
  // Two probe runs overlapping (a delayed dispatch landing on top of the next
  // one) must not both release the same unit — the transition is enforced
  // INSIDE the `findOneAndUpdate` filter and the loser gets a 409. Exercising
  // it here means the race is tested every ten minutes rather than reasoned
  // about once.
  const again = await request('re-cancel (expect 409)', 'POST', `/shop-orders/${orderId}/cancel`, {
    headers: { 'x-probe-key': PROBE_API_KEY },
  });
  expectStatus('re-cancel (expect 409)', again, 409);
} catch (err) {
  failure = err;
  // Captured HERE, before the cleanup below issues a request of its own.
  failedLabel = currentLabel;
} finally {
  // Best effort, and only when the order was created and never cancelled. A
  // leaked PENDING order holds one unit of a 100,000-unit SKU until the expiry
  // sweep releases it, so this is tidiness rather than a correctness
  // requirement — but a monitor that litters is one nobody keeps running.
  if (orderId && !cancelled) {
    try {
      const rescue = await request('cleanup cancel', 'POST', `/shop-orders/${orderId}/cancel`, {
        headers: { 'x-probe-key': PROBE_API_KEY },
      });
      console.log(
        rescue.status === 201
          ? `cleanup: cancelled orphaned order ${orderId}`
          : `cleanup: could not cancel ${orderId} (HTTP ${rescue.status}); the expiry sweep will release it within 15 minutes`,
      );
    } catch {
      console.log(
        `cleanup: could not cancel ${orderId}; the expiry sweep will release it within 15 minutes`,
      );
    }
  }
}

printTimeline();

/**
 * The timeline, in the Reliability page's shape (`shop.probe`).
 *
 * Every entry is a request that got an answer. On a failed run the entry for
 * the failing request is marked, or one is added when the request never
 * completed. Only labels, timings and HTTP statuses go out: no body, no order
 * id, no token.
 */
function reliabilitySteps() {
  const list = steps.map((step) => ({
    name: step.label,
    ok: true,
    ms: step.ms,
    detail: `HTTP ${step.status}`,
  }));
  if (!failure) return list;
  const name = failedLabel ?? 'start the probe';
  let at = -1;
  for (let i = 0; i < list.length; i++) if (list[i].name === name) at = i;
  if (at >= 0) list[at].ok = false;
  else list.push({ name, ok: false, detail: 'no answer' });
  return list;
}

if (!failure) {
  await reportProbeRun({ checkKey: 'shop.probe', startedMs: started, steps: reliabilitySteps() });
  console.log('\n✓ checkout probe PASSED — create, re-price and cancel all behaved.');
  process.exit(0);
}

const summary =
  failure instanceof ProbeFailure ? failure.message : `unexpected error: ${failure?.stack || failure}`;

console.error(`\n✗ checkout probe FAILED\n  ${summary}`);
if (orderId) console.error(`  order: ${orderId}`);

await reportProbeRun({
  checkKey: 'shop.probe',
  startedMs: started,
  steps: reliabilitySteps(),
  failureMessage: summary,
  failedStep: failedLabel ?? 'start the probe',
});

const delivery = await postSlack(
  `:rotating_light: Checkout probe FAILED against ${API_URL}\n` +
    `org \`${contract.orgSlug}\`, sku \`${spec.slug}\`${orderId ? `, order \`${orderId}\`` : ''}\n` +
    `> ${summary}`,
);
console.error(`  slack: ${delivery}`);
console.error(
  '\n  A single red run is not proof production checkout is down — re-run this workflow and\n' +
    '  confirm the SAME step fails the SAME way before escalating. Check, in order:\n' +
    '   1. was the backend mid-deploy (Railway deployment list)\n' +
    '   2. is the probe SKU still on the storefront (the resolve step says so above)\n' +
    '   3. is the org still isTestAccount:true (assert-test-org.sh, run by the workflow)',
);
process.exit(1);
