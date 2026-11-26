#!/usr/bin/env node
/**
 * The synthetic SUBSCRIPTION (membership dues) checkout probe.
 *
 *   PROBE_API_KEY=… node scripts/subscription-checkout-probe.mjs
 *
 * Answers, twice a day, from outside the backend: **could a guest buy a
 * membership right now?** It takes the exact path a signed-out buyer takes on
 * the web checkout, on the TEST-mode demo org, and pays with Stripe's test card:
 *
 *   resolve the org and plan  →  prove the org is on a TEST payment account  →
 *   checkout-config is payable  →  create a guest subscription (key-marked
 *   `isProbe`)  →  confirm its PaymentIntent with the publishable key and
 *   `tok_visa`  →  confirm the subscription until it is `active`  →  read the
 *   guest receipt  →  cancel it immediately through the probe-only route, and
 *   prove a second cancel is refused
 *
 * WHY IT RUNS OUTSIDE THE BACKEND: a process cannot report its own absence
 * (the 2026-08-16 incident). Same reasoning as `ticket-checkout-probe.mjs`.
 *
 * IT PAYS — IN TEST MODE ONLY, AND ONLY AFTER THREE INDEPENDENT CHECKS
 * --------------------------------------------------------------------
 * `/payments/config?orgId=`, `checkout-config` and the create's own answer must
 * each say `pk_test_` / `mode: 'test'` before the card is confirmed. Any one of
 * them saying live aborts the run without paying. The backend's probe-cancel
 * route independently refuses anything but an `isProbe`, test-mode row on an
 * `isTestAccount` org whose payer is an `e2e-subprobe-` address.
 *
 * EVERY SUBSCRIPTION IT CREATES IS CANCELLED, INCLUDING ON THE FAILURE PATH
 * -------------------------------------------------------------------------
 * The cleanup cancels a subscription this run created and did not cancel,
 * whatever went wrong (an `incomplete` row is cancellable too). If even that
 * fails, an unpaid `incomplete` subscription expires on Stripe's side in 23h;
 * a PAID one stays active until somebody cancels it, which the failure message
 * names.
 *
 * `PROBE_STOP_BEFORE_PAYMENT=1` stops after the create (an unpaid `incomplete`
 * row that Stripe expires on its own). It exists for verifying the script
 * against a backend that predates the probe-cancel route; never set it in the
 * workflow — a monitor that skips the payment proves much less than it claims.
 *
 * WHAT "FAILURE" MEANS: a non-zero exit. The workflow goes red and GitHub mails
 * the owner; `SLACK_ALERTS_WEBHOOK_URL` is an optional addition that names the
 * failed step.
 *
 * ZERO DEPENDENCIES: Node's built-in `fetch` and the fixture JSON.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { reportProbeRun } from './report-reliability-result.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contract = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'scripts/subscription-checkout-probe-fixture.json'), 'utf8'),
);

const API_URL = (process.env.PROBE_API_URL || '').replace(/\/+$/, '');
const STRIPE_API_URL = 'https://api.stripe.com/v1';

/** Marks the create `isProbe` and authorises the probe-only cancel. Never printed. */
const PROBE_API_KEY = process.env.PROBE_API_KEY;
const PROBE_KEY_HEADER = 'x-probe-key';
const STOP_BEFORE_PAYMENT = process.env.PROBE_STOP_BEFORE_PAYMENT === '1';

/** Must match `SUBSCRIPTION_PROBE_EMAIL_PREFIX` in backend/src/modules/member-billing/subscription-probe.ts. */
const PROBE_EMAIL_PREFIX = 'e2e-subprobe-';
const PROBE_BUYER_EMAIL = process.env.PROBE_BUYER_EMAIL || '';

/** Per-request deadline, well under the workflow timeout, so a hang fails as its step. */
const STEP_TIMEOUT_MS = 20_000;

/** `confirm` may answer `processing` while Stripe's invoice.paid lands: poll. */
const CONFIRM_POLL_ATTEMPTS = 8;
const CONFIRM_POLL_INTERVAL_MS = 3_000;

/** Stripe's test-mode card token. Only valid against a pk_test_ key. */
const STRIPE_TEST_CARD_TOKEN = 'tok_visa';

const SLACK_WEBHOOK_HOST = 'hooks.slack.com';

const started = Date.now();
const steps = [];

/** Module scope so the failure path can cancel what this run created. */
let createdSubscriptionId = null;
let subscriptionCancelled = false;
let subscriptionPaid = false;

class ProbeFailure extends Error {}

function fail(message) {
  throw new ProbeFailure(message);
}

function check(condition, message) {
  if (!condition) fail(message);
}

function redactKey(key) {
  if (typeof key !== 'string') return String(key);
  const match = /^(pk_(?:test|live)_)/.exec(key);
  return match ? `${match[1]}…` : '[unrecognised key shape]';
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function step(name, fn) {
  const at = Date.now();
  try {
    const result = await fn();
    steps.push({ name, ms: Date.now() - at, ok: true });
    console.log(`  ✓ ${name} (${Date.now() - at}ms)`);
    return result;
  } catch (error) {
    steps.push({ name, ms: Date.now() - at, ok: false });
    console.log(`  ✗ ${name} (${Date.now() - at}ms)`);
    throw error;
  }
}

async function http(method, url, { body, form, headers } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STEP_TIMEOUT_MS);
  try {
    const allHeaders = { ...headers };
    let payload;
    if (body !== undefined) {
      allHeaders['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    } else if (form !== undefined) {
      allHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
      payload = new URLSearchParams(form).toString();
    }
    const res = await fetch(url, { method, headers: allHeaders, body: payload, signal: controller.signal });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON — the raw text is what the caller reads */
    }
    return { status: res.status, text, json };
  } catch (error) {
    if (error.name === 'AbortError') fail(`${method} ${url} did not answer within ${STEP_TIMEOUT_MS}ms.`);
    fail(`${method} ${url} failed at the transport: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Never echo a receipt token into a log line. */
const redactUrl = (url) => url.replace(/token=[^&]+/, 'token=[REDACTED]');

async function postSlack(text) {
  const url = process.env.SLACK_ALERTS_WEBHOOK_URL;
  if (!url) return;
  let host;
  try {
    host = new URL(url).host;
  } catch {
    return;
  }
  if (host !== SLACK_WEBHOOK_HOST) return;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  }).catch(() => {});
}

function assertTestKey(where, key, mode) {
  check(
    typeof key === 'string' && key.startsWith('pk_test_') && mode === 'test',
    `PRODUCTION PAYMENT-CONFIG INCIDENT: ${where} answered ${redactKey(key)} mode="${mode}" for ` +
      `${contract.orgSlug}. The probe org is on a LIVE payment account (has it lost ` +
      `isTestAccount: true?) — refusing to pay. Check it before anything else.`,
  );
}

// ─── The probe ───────────────────────────────────────────────────────────────

async function run() {
  if (!PROBE_API_KEY) {
    fail(
      'PROBE_API_KEY is unset. The probe cannot mark its subscription `isProbe` at create time, ' +
        'so it could not cancel it afterwards and every run would leave an active test membership ' +
        'behind. Set the repository secret (same value as the production backend on Railway).',
    );
  }

  console.log(`Subscription checkout probe → ${API_URL}`);
  console.log(`  org=${contract.orgSlug} plan=${contract.planSlug} (${contract.planId})\n`);

  // 1. The org, and the plan as the org's public page lists it.
  const organization = await step('resolve the org and its plan', async () => {
    const url = `${API_URL}/organizations/${contract.orgSlug}/public-preview/v2`;
    const res = await http('GET', url);
    check(res.status === 200, `${url} returned HTTP ${res.status}: ${res.text.slice(0, 300)}`);
    const org = res.json?.organization;
    check(
      org?.slug === contract.orgSlug && typeof org?.id === 'string',
      `${url} served org "${org?.slug}", expected "${contract.orgSlug}" — refusing to buy.`,
    );
    const plans = res.json?.membershipPlans ?? [];
    check(
      plans.some((plan) => plan.id === contract.planId),
      `plan ${contract.planId} is not listed on ${contract.orgSlug}'s public page ` +
        `(listed: [${plans.map((plan) => `${plan.slug}:${plan.id}`).join(', ')}]). It was archived, ` +
        `unpublished, or the fixture names a plan of another org — refusing to buy.`,
    );
    return org;
  });

  // 2. The payment account, read from the account rather than the flag.
  await step('the org resolves a TEST payment account', async () => {
    const url = `${API_URL}/payments/config?orgId=${encodeURIComponent(organization.id)}`;
    const res = await http('GET', url);
    check(res.status === 200, `${url} returned HTTP ${res.status}: ${res.text.slice(0, 300)}`);
    assertTestKey('/payments/config', res.json?.publishableKey, res.json?.mode);
    console.log(`      provider=${res.json?.provider} mode=${res.json?.mode}`);
  });

  // 3. What the web checkout reads before rendering Pay.
  await step('checkout-config is payable in test mode', async () => {
    const url = `${API_URL}/member-billing/plans/${contract.planId}/checkout-config`;
    const res = await http('GET', url);
    check(res.status === 200, `${url} returned HTTP ${res.status}: ${res.text.slice(0, 300)}`);
    const config = res.json?.config;
    check(
      config?.payable === true,
      `the plan is not payable (reason "${config?.reason}") — NOBODY can buy this membership. ` +
        `Body: ${res.text.slice(0, 300)}`,
    );
    assertTestKey('checkout-config', config?.publishableKey, config?.mode);
    check(
      config?.unitAmountCents === contract.unitAmountCents,
      `checkout-config prices the plan at ${config?.unitAmountCents}¢, fixture says ` +
        `${contract.unitAmountCents}¢. Update the fixture if the demo plan was re-priced on purpose.`,
    );
    console.log(`      ${config.unitAmountCents}¢ ${config.currency} first charge ${config.firstChargeCents}¢`);
  });

  // 4. The guest create.
  // ONE fixed buyer, every run. A per-run address mints a new guest User in production
  // each time (scripts/check-stable-test-identities.mjs fails CI on that).
  const email = PROBE_BUYER_EMAIL;
  const created = await step('a guest subscription is created', async () => {
    const url = `${API_URL}/member-billing/subscriptions`;
    const res = await http('POST', url, {
      body: { planId: contract.planId, contact: { email } },
      headers: { [PROBE_KEY_HEADER]: PROBE_API_KEY },
    });
    check(
      res.status === 200 || res.status === 201,
      `creating a guest subscription answered HTTP ${res.status}. A signed-out buyer cannot ` +
        `start a membership right now. Body: ${res.text.slice(0, 300)}`,
    );
    const subscription = res.json?.subscription;
    const receiptToken = res.json?.receiptToken;
    check(
      typeof subscription?.subscriptionId === 'string',
      `the create returned no subscriptionId. Body: ${res.text.slice(0, 300)}`,
    );
    createdSubscriptionId = subscription.subscriptionId;
    check(typeof receiptToken === 'string' && receiptToken.length > 0, 'the guest create returned no receiptToken');
    assertTestKey('the create', subscription.publishableKey, subscription.mode);
    check(
      typeof subscription.clientSecret === 'string' && subscription.clientSecret.includes('_secret_'),
      `the create returned no PaymentIntent client secret, so the buyer's browser has nothing to ` +
        `pay with. Keys: [${Object.keys(subscription).join(', ')}]`,
    );
    console.log(`      subscription ${subscription.subscriptionId}`);
    return { subscription, receiptToken };
  });

  if (STOP_BEFORE_PAYMENT) {
    console.log('\n  PROBE_STOP_BEFORE_PAYMENT=1 — stopping before payment (verification mode).');
    return;
  }

  // 5. Pay, exactly as Stripe.js would: the publishable key and a test card.
  await step('the PaymentIntent confirms with the test card', async () => {
    const { clientSecret, publishableKey } = created.subscription;
    const paymentIntentId = clientSecret.slice(0, clientSecret.indexOf('_secret_'));
    const res = await http('POST', `${STRIPE_API_URL}/payment_intents/${paymentIntentId}/confirm`, {
      headers: { Authorization: `Basic ${Buffer.from(`${publishableKey}:`).toString('base64')}` },
      form: {
        client_secret: clientSecret,
        'payment_method_data[type]': 'card',
        'payment_method_data[card][token]': STRIPE_TEST_CARD_TOKEN,
      },
    });
    check(
      res.status === 200 && res.json?.status === 'succeeded',
      `Stripe answered HTTP ${res.status} status="${res.json?.status}" confirming the first ` +
        `invoice's PaymentIntent. Error: ${JSON.stringify(res.json?.error ?? null).slice(0, 300)}`,
    );
    check(res.json?.livemode === false, 'the PaymentIntent reports livemode=true — STOP, this is a real charge.');
    subscriptionPaid = true;
  });

  // 6. The guest confirm: the only place the row is moved to paid.
  await step('the subscription confirms to active', async () => {
    const url = `${API_URL}/member-billing/subscriptions/${createdSubscriptionId}/confirm`;
    let last = null;
    for (let attempt = 1; attempt <= CONFIRM_POLL_ATTEMPTS; attempt += 1) {
      last = await http('POST', url, { body: { receiptToken: created.receiptToken } });
      const status = last.json?.subscription?.status;
      if ((last.status === 200 || last.status === 201) && status === 'active') {
        console.log(`      active after ${attempt} confirm call(s)`);
        return;
      }
      if (last.status >= 400) break;
      await sleep(CONFIRM_POLL_INTERVAL_MS);
    }
    fail(
      `the subscription did not reach "active" after a succeeded payment (HTTP ${last?.status}, ` +
        `status "${last?.json?.subscription?.status}"). A buyer was charged and holds no ` +
        `membership. Body: ${last?.text.slice(0, 300)}`,
    );
  });

  // 7. The guest receipt.
  await step('the guest receipt renders', async () => {
    const url = `${API_URL}/member-billing/subscriptions/${createdSubscriptionId}/receipt?token=${encodeURIComponent(created.receiptToken)}`;
    const res = await http('GET', url);
    check(
      res.status === 200,
      `${redactUrl(url)} returned HTTP ${res.status}: ${res.text.slice(0, 300)}`,
    );
  });

  // 8. Cancel it now, through the probe-only route; a second cancel must lose.
  await step('the probe subscription is cancelled, exactly once', async () => {
    const url = `${API_URL}/member-billing/subscriptions/${createdSubscriptionId}/probe-cancel`;
    const res = await http('POST', url, { headers: { [PROBE_KEY_HEADER]: PROBE_API_KEY } });
    check(
      !String(res.text).includes('Cannot POST'),
      `${url} is not routed — the probe-cancel route is not deployed, so this run just bought a ` +
        `membership it cannot cancel.`,
    );
    check(
      res.status === 200 || res.status === 201,
      `cancelling the probe subscription answered HTTP ${res.status} (403 = bad key or a row the ` +
        `probe may not cancel, 404 = no such row, 409 = already ended). Body: ${res.text.slice(0, 300)}`,
    );
    check(
      res.json?.status === 'canceled',
      `the cancel returned status "${res.json?.status}", expected "canceled". Body: ${res.text.slice(0, 200)}`,
    );
    subscriptionCancelled = true;

    const again = await http('POST', url, { headers: { [PROBE_KEY_HEADER]: PROBE_API_KEY } });
    check(
      again.status === 409,
      `a SECOND cancel answered HTTP ${again.status}, not 409. Body: ${again.text.slice(0, 300)}`,
    );
  });
}

/** Cancel a subscription this run created and did not cancel. Best effort. */
async function cleanupOrphanedSubscription() {
  if (!createdSubscriptionId || subscriptionCancelled || !PROBE_API_KEY || STOP_BEFORE_PAYMENT) return;
  try {
    const res = await http(
      'POST',
      `${API_URL}/member-billing/subscriptions/${createdSubscriptionId}/probe-cancel`,
      { headers: { [PROBE_KEY_HEADER]: PROBE_API_KEY } },
    );
    if (res.status === 200 || res.status === 201) {
      console.error(`  cleanup: cancelled subscription ${createdSubscriptionId}`);
      return;
    }
    console.error(`  cleanup: could not cancel ${createdSubscriptionId} (HTTP ${res.status})`);
  } catch {
    console.error(`  cleanup: could not cancel ${createdSubscriptionId}`);
  }
  console.error(
    subscriptionPaid
      ? `  cleanup: ${createdSubscriptionId} is PAID and still running on ${contract.orgSlug} (test ` +
          `mode) — cancel it from the org's member-subscriptions page.`
      : `  cleanup: ${createdSubscriptionId} was never paid; Stripe expires it within 23h.`,
  );
}

try {
  await run();
  console.log(`\n✓ subscription checkout probe OK in ${Date.now() - started}ms`);
  // Verification mode stops before payment, so a green run is not the check
  // the Reliability page lists and must not be reported as it.
  if (!STOP_BEFORE_PAYMENT) {
    await reportProbeRun({ checkKey: 'membership.probe', startedMs: started, steps });
  }
  process.exit(0);
} catch (error) {
  await cleanupOrphanedSubscription();
  const failedStep = steps.find((s) => !s.ok)?.name ?? '(before the first step)';
  const summary = steps.map((s) => `${s.ok ? '✓' : '✗'} ${s.name}`).join(' → ');
  const message =
    error instanceof ProbeFailure ? error.message : `unexpected error: ${error?.stack ?? error?.message ?? error}`;

  console.error(`\n✗ SUBSCRIPTION CHECKOUT PROBE FAILED after ${Date.now() - started}ms`);
  console.error(`  failed step: ${failedStep}`);
  console.error(`  steps: ${summary}`);
  console.error(`  ${message}`);
  console.error(
    `\n  Triage order, most likely first:\n` +
      `    1. Was the backend mid-deploy? Re-run before escalating — one red run is not an outage.\n` +
      `    2. Did the demo plan change (archived, re-priced, trial added)? Check ${contract.orgSlug}'s plans.\n` +
      `    3. Is the org still isTestAccount:true? That failure has its own message and outranks everything else.`,
  );
  if (!STOP_BEFORE_PAYMENT) {
    await reportProbeRun({
      checkKey: 'membership.probe',
      startedMs: started,
      steps,
      failureMessage: message,
      failedStep: steps.find((s) => !s.ok)?.name ?? 'start the probe',
    });
  }
  await postSlack(
    `:rotating_light: Subscription checkout probe FAILED at step "${failedStep}" — ${message.slice(0, 500)}`,
  );
  process.exit(1);
}
