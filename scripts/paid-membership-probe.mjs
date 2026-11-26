#!/usr/bin/env node
/**
 * The PAID membership checkout probe.
 *
 *   PROBE_API_URL=… PROBE_API_KEY=… PROBE_BUYER_EMAIL=… node scripts/paid-membership-probe.mjs
 *
 * The plain membership probe (`subscription-checkout-probe.mjs`) pays the first
 * invoice with a good card and cancels; it never sees a decline or a refund.
 * This one, on the same test organization and plan:
 *
 *   start a guest membership → a DECLINED test card is declined on its first
 *   invoice → the same invoice pays with a good test card → the membership
 *   confirms to active → refund the first dues payment through the seller's
 *   refund path (probe-only route) → read the refund back from the payment
 *   provider → cancel the membership at once
 *
 * Reports `membership.declined_retry`, `membership.card_payment` and
 * `membership.refund`.
 *
 * IT CANCELS WHAT IT CREATES. A test-mode subscription stays active until
 * somebody cancels it, so the cancel runs on every path that created one,
 * through the same probe-only cancel the plain probe uses.
 *
 * It buys as its OWN fixed address, the plain probe's with `+paid` before the
 * `@`: both keep the `e2e-subprobe-` prefix the backend's probe routes require,
 * and the two probes never meet each other's membership on the plan.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
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
  readFileSync(path.join(REPO_ROOT, 'scripts/subscription-checkout-probe-fixture.json'), 'utf8'),
);

/** Must keep `SUBSCRIPTION_PROBE_EMAIL_PREFIX` (backend/src/modules/member-billing/subscription-probe.ts). */
const PROBE_EMAIL_PREFIX = 'e2e-subprobe-';
const PLAIN_PROBE_BUYER = process.env.PROBE_BUYER_EMAIL || '';
const BUYER = PLAIN_PROBE_BUYER.replace('@', '+paid@');

const CONFIRM_POLL_ATTEMPTS = 10;
const CONFIRM_POLL_INTERVAL_MS = 3_000;

let subscriptionId = null;
let paid = false;
let cancelled = false;
let failure = null;

async function cancelMembership() {
  const cancel = await api('POST', `/member-billing/subscriptions/${subscriptionId}/probe-cancel`, {
    headers: probeHeaders(),
  });
  // 409: it has already ended, which is what the cancel is for.
  if (cancel.status === 200 || cancel.status === 201 || cancel.status === 409) cancelled = true;
  return cancel;
}

try {
  assertConfigured();
  if (!BUYER.startsWith(PROBE_EMAIL_PREFIX) || !BUYER.includes('+paid@')) {
    fail(`PROBE_BUYER_EMAIL must be the plain probe's fixed ${PROBE_EMAIL_PREFIX}… address`);
  }

  let organization;
  await step('find the probe plan', async () => {
    const preview = await api('GET', `/organizations/${contract.orgSlug}/public-preview/v2`);
    expectStatus(preview, 200);
    organization = preview.json?.organization;
    check(organization?.slug === contract.orgSlug, `served organization "${organization?.slug}", refusing to buy`);
    const plans = preview.json?.membershipPlans ?? [];
    check(plans.some((plan) => plan.id === contract.planId), `plan ${contract.planId} is not listed on the organization`);
    return `plan ${contract.planSlug}`;
  });

  await step('the payment account is a test account', async () => {
    const config = await api('GET', `/payments/config?orgId=${encodeURIComponent(organization.id)}`);
    expectStatus(config, 200);
    assertTestKey('/payments/config', config.json?.publishableKey, config.json?.mode);
    const checkout = await api('GET', `/member-billing/plans/${contract.planId}/checkout-config`);
    expectStatus(checkout, 200);
    check(checkout.json?.config?.payable === true, `the plan is not payable ("${checkout.json?.config?.reason}")`);
    assertTestKey('checkout-config', checkout.json?.config?.publishableKey, checkout.json?.config?.mode);
    check(checkout.json.config.unitAmountCents === contract.unitAmountCents, `the plan costs ${checkout.json.config.unitAmountCents}, not ${contract.unitAmountCents}`);
    return 'test mode, payable';
  });

  let created;
  await step('start a guest membership', async () => {
    const create = await api('POST', '/member-billing/subscriptions', {
      headers: probeHeaders(),
      body: { planId: contract.planId, contact: { email: BUYER } },
    });
    expectStatus(create, 200, 201);
    const subscription = create.json?.subscription;
    subscriptionId = subscription?.subscriptionId ?? null;
    check(!!subscriptionId, `no subscription id came back: ${create.text.slice(0, 200)}`);
    check(!!create.json?.receiptToken, 'the guest create returned no receipt token');
    assertTestKey('the create', subscription.publishableKey, subscription.mode);
    check(!!paymentIntentOf(subscription.clientSecret), 'the create carried no first payment to confirm');
    created = { subscription, receiptToken: create.json.receiptToken };
    return `subscription ${subscriptionId}`;
  });

  await declineThenPay(created.subscription.clientSecret, created.subscription.publishableKey, () => {
    paid = true;
  });

  await step('the membership confirms to active', async () => {
    let last = null;
    for (let attempt = 1; attempt <= CONFIRM_POLL_ATTEMPTS; attempt += 1) {
      last = await api('POST', `/member-billing/subscriptions/${subscriptionId}/confirm`, {
        body: { receiptToken: created.receiptToken },
      });
      if (last.status < 300 && last.json?.subscription?.status === 'active') return `active after ${attempt} confirm call(s)`;
      if (last.status >= 400) break;
      await sleep(CONFIRM_POLL_INTERVAL_MS);
    }
    fail(`the membership did not reach "active" after a successful payment (HTTP ${last?.status}, "${last?.json?.subscription?.status}")`);
  });

  await refundAndReadBack(`/member-billing/subscriptions/${subscriptionId}/probe-refund`);

  await step('the probe membership is cancelled', async () => {
    const cancel = await cancelMembership();
    check(cancelled, `the cancel answered HTTP ${cancel.status}: ${cancel.text.slice(0, 200)}`);
    return `cancelled (${cancel.status})`;
  });
} catch (err) {
  failure = err instanceof ProbeFailure ? err : new ProbeFailure(`unexpected error: ${err?.message || err}`);
} finally {
  if (subscriptionId && !cancelled) {
    const cancel = await cancelMembership().catch(() => null);
    console.log(
      cancelled
        ? `cleanup: cancelled membership ${subscriptionId}`
        : `cleanup: could not cancel membership ${subscriptionId} (HTTP ${cancel?.status}). ` +
            (paid ? 'It is PAID in test mode and stays active until cancelled.' : 'Unpaid, it expires on its own.'),
    );
  }
}

const SETUP = ['find the probe plan', 'the payment account is a test account', 'start a guest membership'];
await finish('paid membership probe', failure, [
  { checkKey: 'membership.declined_retry', names: [...SETUP, ...PAID_STEPS.declined] },
  { checkKey: 'membership.card_payment', names: [...SETUP, ...PAID_STEPS.paid, 'the membership confirms to active'] },
  {
    checkKey: 'membership.refund',
    names: [...SETUP, ...PAID_STEPS.paid, 'the membership confirms to active', ...PAID_STEPS.refund, 'the probe membership is cancelled'],
  },
]);
