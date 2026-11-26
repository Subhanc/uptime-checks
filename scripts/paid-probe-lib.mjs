/**
 * The parts every PAID checkout probe shares (ticket, vendor table, membership,
 * course, booking). The shop's own paid probe, `paid-checkout-probe.mjs`, came
 * first and is the model; these probes follow it step for step:
 *
 *   start a checkout → a DECLINED test card is declined and the payment waits
 *   for another → a good test card pays → the purchase completes → refund it
 *   through a probe-only route that takes the seller's own refund path → read
 *   the refund back from the payment provider
 *
 * and each probe reports `<flow>.declined_retry`, `<flow>.card_payment` and
 * `<flow>.refund` to the Reliability page, each judged on its own steps.
 *
 * SAFETY, shared by all of them
 * -----------------------------
 *  - The payment account must say TEST (`pk_test_`, mode `test`) before any
 *    card is used ({@link assertTestKey}); every probe checks it at least twice.
 *  - The cards are the provider's published test payment methods
 *    (`pm_card_chargeDeclined`, `pm_card_visa`). They exist only in test mode;
 *    a live account refuses them.
 *  - Payments are confirmed with the PUBLISHABLE key and the client secret, the
 *    way a buyer's browser does. No secret key is held here.
 *  - Every refund route refuses anything that is not the probe's own purchase
 *    on an organization marked as a test account.
 *  - `PROBE_API_KEY`, client secrets and receipt tokens are never printed.
 *
 * Plain Node, no packages, so it runs in the public probe repository too. It
 * holds no product names or addresses: the API address comes from the
 * environment, and a probe refuses to start without it.
 */
import { reportProbeRun } from './report-reliability-result.mjs';

export const API_URL = (process.env.PROBE_API_URL || '').replace(/\/+$/, '');
export const PROBE_API_KEY = process.env.PROBE_API_KEY;
/** The fixed test buyer every paid probe buys as. Never per run. */
export const BUYER_EMAIL = process.env.PROBE_CUSTOMER_EMAIL || '';

const PROVIDER_API = 'https://api.stripe.com/v1';
export const DECLINED_CARD = 'pm_card_chargeDeclined';
export const GOOD_CARD = 'pm_card_visa';
/** The provider wants somewhere to send a buyer after a redirect method; a card never redirects. */
const RETURN_URL = 'https://example.com/probe-return';

const STEP_TIMEOUT_MS = 20_000;

export class ProbeFailure extends Error {}

export function fail(message) {
  throw new ProbeFailure(message);
}

export function check(condition, message) {
  if (!condition) fail(message);
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function redactText(text) {
  return String(text ?? '')
    .replace(/("(?:clientSecret|client_secret|clientToken|receiptToken|accessToken|claimToken|token)"\s*:\s*")[^"]*/gi, '$1[redacted]')
    .replace(/\b(?:pi|seti)_[A-Za-z0-9]+_secret_[A-Za-z0-9]+/g, '[redacted]');
}

export function short(text, max = 280) {
  const flat = redactText(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Every step, in order: `{ name, ok, ms, detail }`. */
export const steps = [];
const started = Date.now();

/** Runs one step; a thrown failure is recorded against it and rethrown. */
export async function step(name, run) {
  const at = Date.now();
  try {
    const result = await run();
    const detail = typeof result === 'string' ? result : '';
    steps.push({ name, ok: true, ms: Date.now() - at, detail });
    return result;
  } catch (err) {
    const message = err instanceof ProbeFailure ? err.message : `${err?.name || 'Error'}: ${err?.message || ''}`;
    steps.push({ name, ok: false, ms: Date.now() - at, detail: short(message) });
    throw new ProbeFailure(`${name}: ${message}`);
  }
}

export async function api(method, urlPath, { headers = {}, body } = {}) {
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
    fail(`${method} ${urlPath.split('?')[0]} did not complete (${err?.name === 'TimeoutError' ? 'timed out' : err?.name})`);
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

export function expectStatus(result, ...expected) {
  if (!expected.includes(result.status)) {
    fail(`expected HTTP ${expected.join(' or ')}, got ${result.status}: ${short(result.text)}`);
  }
}

export const probeHeaders = () => ({ 'x-probe-key': PROBE_API_KEY });

/** Refuses to go on unless the payment account is a TEST account. */
export function assertTestKey(where, key, mode) {
  if (!(typeof key === 'string' && key.startsWith('pk_test_') && mode === 'test')) {
    fail(`${where}: the account is not in test mode (mode "${mode}"), refusing to pay`);
  }
}

/** The PaymentIntent id inside a client secret, or '' when it is not one. */
export function paymentIntentOf(clientSecret) {
  const id = String(clientSecret ?? '').split('_secret_')[0];
  return id.startsWith('pi_') ? id : '';
}

/** Confirm a payment as a buyer's browser does: publishable key plus client secret. */
export async function confirmPayment(clientSecret, publishableKey, paymentMethod) {
  const paymentIntentId = paymentIntentOf(clientSecret);
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

/**
 * The decline and the retry, as three steps: the declined card is declined, the
 * payment is left waiting for another card, and a good card pays the SAME
 * payment. Returns once the payment has succeeded; `onPaid` runs the moment it
 * has, so the caller's cleanup knows money moved even if a later step fails.
 */
export async function declineThenPay(clientSecret, publishableKey, onPaid) {
  let declined;
  await step('a declined card is declined', async () => {
    declined = await confirmPayment(clientSecret, publishableKey, DECLINED_CARD);
    const code = declined.json?.error?.code ?? declined.json?.error?.decline_code;
    if (declined.status < 400 || !/declin/.test(String(code) + String(declined.json?.error?.decline_code))) {
      fail(`expected a decline, got HTTP ${declined.status} (${code ?? declined.json?.status})`);
    }
    return `declined: ${code}`;
  });

  await step('the payment can still be paid after the decline', async () => {
    const status = declined?.json?.error?.payment_intent?.status;
    if (status !== 'requires_payment_method') fail(`after the decline the payment is "${status}", not retryable`);
    return 'the payment is waiting for another card';
  });

  await step('pay with a good test card', async () => {
    const good = await confirmPayment(clientSecret, publishableKey, GOOD_CARD);
    if (good.status !== 200 || good.json?.status !== 'succeeded') {
      fail(`expected the payment to succeed, got HTTP ${good.status} (${good.json?.status ?? good.json?.error?.code})`);
    }
    if (good.json?.livemode !== false) fail('the payment reports livemode, STOP: this is not a test payment');
    onPaid?.();
    return `paid ${good.json?.amount} ${good.json?.currency}`;
  });
}

/** Polls `read` until it answers true, or fails with `what`. */
export async function waitFor(what, read, { withinMs = 45_000, everyMs = 2_000 } = {}) {
  const deadline = Date.now() + withinMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await read();
    if (last === true) return;
    await sleep(everyMs);
  }
  fail(`${what} was still not true ${withinMs / 1000}s after a successful payment (${last})`);
}

/**
 * Calls a probe-refund route until the purchase is refundable, then checks what
 * the provider holds. A 409 means the payment has not landed on the row yet,
 * so it is asked again for a while; anything else is the answer.
 */
export async function refundAndReadBack(refundPath, onRefunded) {
  let refund;
  await step('refund it through the seller refund path', async () => {
    const deadline = Date.now() + 45_000;
    for (;;) {
      refund = await api('POST', refundPath, { headers: probeHeaders() });
      if (refund.status !== 409 || Date.now() > deadline) break;
      await sleep(3_000);
    }
    expectStatus(refund, 200, 201);
    if (refund.json?.status !== 'refunded') fail(`the purchase came back "${refund.json?.status}"`);
    onRefunded?.();
    return 'refunded';
  });

  await step('the provider holds a refund for the full amount', async () => {
    const refunds = refund.json?.refunds ?? [];
    const total = refunds
      .filter((row) => row.status !== 'refund_failed' && row.status !== 'refund_canceled' && row.status !== 'failed' && row.status !== 'canceled')
      .reduce((sum, row) => sum + (row.amountCents || 0), 0);
    if (!(total > 0) || total !== refund.json?.orderTotalCents) {
      fail(`refunds total ${total} cents against a payment of ${refund.json?.orderTotalCents} (${refunds.map((r) => r.status).join(', ') || 'none'})`);
    }
    return refunds.map((row) => `${row.amountCents} ${row.currency} ${row.status}`).join('; ');
  });
}

/** The step names the three paid checks are judged on, after a probe's own setup steps. */
export const PAID_STEPS = {
  declined: ['a declined card is declined', 'the payment can still be paid after the decline', 'pay with a good test card'],
  paid: ['pay with a good test card'],
  refund: ['refund it through the seller refund path', 'the provider holds a refund for the full amount'],
};

/**
 * Prints the steps, reports each check from its own steps (a check whose steps
 * never ran fails as not reached), and exits non-zero if any check failed.
 */
export async function finish(label, failure, checks) {
  console.log('\n── steps ───────────────────────────────────────────────────');
  for (const entry of steps) console.log(`  ${entry.ok ? 'pass' : 'FAIL'} ${String(entry.ms).padStart(6)}ms  ${entry.name}  ${entry.detail}`);

  let anyFailed = false;
  for (const { checkKey, names } of checks) {
    const own = steps.filter((entry) => names.includes(entry.name));
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

  if (failure) console.error(`\n${label} FAILED: ${failure.message}`);
  process.exit(anyFailed || failure ? 1 : 0);
}

/** Refuses to run without the address and the key, before anything is written. */
export function assertConfigured() {
  if (!API_URL) fail('PROBE_API_URL is unset.');
  if (!PROBE_API_KEY) fail('PROBE_API_KEY is unset, so the probe cannot mark, refund or cancel what it buys.');
  if (!BUYER_EMAIL) fail('PROBE_CUSTOMER_EMAIL is unset: the probes buy as one fixed test buyer.');
}
