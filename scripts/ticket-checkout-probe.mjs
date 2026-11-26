#!/usr/bin/env node
/**
 * The synthetic TICKET checkout probe — MOT-711.
 *
 *   PROBE_API_KEY=… node scripts/ticket-checkout-probe.mjs
 *
 * Answers, twice a day, from outside the backend: **could somebody buy a ticket
 * right now?**
 *
 *   resolve the fixture event  →  prove the org still resolves a TEST Stripe
 *   account  →  prove the tier is sellable  →  drive the CREATE path to a clean
 *   refusal on a zero-seat tier  →  BUY a real ticket and cancel it  →  prove
 *   the client-event telemetry route is live
 *
 * WHY IT RUNS OUTSIDE THE BACKEND
 * -------------------------------
 * On 2026-08-16 a real customer's checkout died inside a deploy blackout and
 * nothing noticed, because everything that could have noticed was the thing that
 * was down. A process cannot report its own absence. So this runs on GitHub
 * Actions, on a schedule, from outside.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT CREATES AN ORDER AND CANCELS IT — AND THE HISTORY MATTERS
 * ─────────────────────────────────────────────────────────────────────────────
 * MOT-711 asked for the shop probe's create → cancel shape. When this file was
 * written it could not have it, and the finding MOT-711 asked for was written
 * down here instead:
 *
 *   1. There was no cancel route and no cancellable state — `OrderStatus` had no
 *      CANCELLED member, the orders module had no `isProbe` field, and nothing
 *      moved a PENDING ticket order to a terminal state except the payment
 *      webhooks and the every-minute expiry sweep.
 *   2. The fallback the shop probe leans on — "the expiry sweep releases it
 *      within 15 minutes" — was itself broken for tickets: that sweep credited
 *      the seats back TWICE (MOT-734, reproduced 3/3). A probe that abandoned
 *      one order every twelve hours would have walked the fixture tier's
 *      `soldCount` down by two a day: a monitor manufacturing the exact
 *      inventory corruption the program it belongs to exists to remove.
 *
 * Both are closed. MOT-735 shipped `Order.isProbe` and
 * `POST /v1/orders/:orderId/probe-cancel` — key-gated, `isProbe`-gated, and
 * claiming `PENDING → CANCELLED` inside a single `findOneAndUpdate` so a
 * double-cancel credits exactly once. MOT-734 was root-caused to a second,
 * undeployed process running an older copy of the sweep against the same
 * database, and closed (PRs #948, #951).
 *
 * So step 5 below buys ONE ticket from the sellable tier with the probe key and
 * cancels it, and step 6 asserts the seat came back. That is what upgrades this
 * from "the create path can refuse" to "the create path can SELL": it reaches
 * the reservation `$inc`, the PaymentIntent creation, and the release — the
 * three things a refusal deliberately stops short of. **A backend that can
 * refuse but cannot sell now fails this probe.**
 *
 * EVERY ORDER IT CREATES IS CANCELLED, INCLUDING ON THE FAILURE PATH
 * ------------------------------------------------------------------
 * The `finally` block cancels an order the run created and did not cancel,
 * whatever went wrong. If even that fails, the backend's expiry sweep releases
 * it within ten minutes — and unlike when this file was written, that sweep is
 * now the correct claim-then-release, crediting exactly once.
 *
 * WHAT IT STILL DOES NOT PROVE
 * ----------------------------
 * It does not CONFIRM the PaymentIntent, so `handlePaymentSucceeded`, the
 * webhook path and the COMPLETED transition are not covered — that is
 * `website/e2e/deployed/ticket-checkout/happy-path.spec.ts`'s job, nightly, with
 * a real card in a real browser. A probe that confirmed payments would be a
 * monitor that spends money on a schedule.
 *
 * WHAT "FAILURE" MEANS HERE
 * -------------------------
 * A non-zero exit. That is the whole alerting contract: the workflow run goes
 * red and GitHub mails the repository owner, with no webhook, no secret and no
 * third-party service required. `SLACK_ALERTS_WEBHOOK_URL` is an optional
 * ADDITION, never the mechanism.
 *
 * ZERO DEPENDENCIES ON PURPOSE
 * ----------------------------
 * Node's built-in `fetch` and the fixture JSON. A monitor whose own install step
 * can fail reports the wrong outage.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { reportProbeRun } from './report-reliability-result.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contract = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'scripts/ticket-checkout-probe-fixture.json'), 'utf8'),
);

const API_URL = (process.env.PROBE_API_URL || '').replace(/\/+$/, '');

/**
 * The credential that authorises exactly two things: marking an order `isProbe`
 * at CREATE time, and cancelling one that carries the mark
 * (`backend/src/modules/shop-orders/probe-key.ts`). Never printed, in any
 * branch.
 *
 * Without it the probe refuses to run rather than degrading to the
 * refusal-only shape it had before MOT-735: a monitor that silently tests less
 * than it claims is the failure this whole program keeps finding.
 */
const PROBE_API_KEY = process.env.PROBE_API_KEY;

/** The header the backend reads the key from. Lower-case; Node normalises. */
const PROBE_KEY_HEADER = 'x-probe-key';

/**
 * Per-step deadline, well under the workflow's own timeout. A step that hangs
 * must fail as THAT step, so the report names what was slow rather than being
 * killed anonymously by the job timeout with nothing to read.
 */
const STEP_TIMEOUT_MS = 20_000;

/** The only host Slack serves incoming webhooks from — exact match, never a suffix test. */
const SLACK_WEBHOOK_HOST = 'hooks.slack.com';

/** A valid ObjectId that cannot exist, used to reach the telemetry handler without an order. */
const NONEXISTENT_ORDER_ID = '000000000000000000000000';

const started = Date.now();
const steps = [];

/**
 * The order this run created, and whether it has been cancelled.
 *
 * Module scope rather than local to `run()` so the failure path can reach them:
 * an order this probe created and did not cancel is a PENDING order holding a
 * seat, and leaving one behind every twelve hours is the failure mode the whole
 * create → cancel shape exists to avoid.
 */
let createdOrderId = null;
let orderCancelled = false;

class ProbeFailure extends Error {}

function fail(message) {
  throw new ProbeFailure(message);
}

function check(condition, message) {
  if (!condition) fail(message);
}

/**
 * Redact anything that could be a credential before printing.
 *
 * A publishable key is not secret, but its PREFIX is the whole point of step 2,
 * so the prefix is kept and the rest is dropped — enough to read the alert,
 * nothing to paste into a browser.
 */
function redactKey(key) {
  if (typeof key !== 'string') return String(key);
  const match = /^(pk_(?:test|live)_)/.exec(key);
  return match ? `${match[1]}…` : '[unrecognised key shape]';
}

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

async function http(method, url, body, extraHeaders) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STEP_TIMEOUT_MS);
  try {
    const headers = { ...(body ? { 'Content-Type': 'application/json' } : {}), ...extraHeaders };
    const res = await fetch(url, {
      method,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON — the raw text is what the caller needs to read */
    }
    return { status: res.status, text, json };
  } catch (error) {
    if (error.name === 'AbortError') {
      fail(`${method} ${url} did not answer within ${STEP_TIMEOUT_MS}ms.`);
    }
    fail(`${method} ${url} failed at the transport: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function postSlack(text) {
  const url = process.env.SLACK_ALERTS_WEBHOOK_URL;
  if (!url) return;
  let host;
  try {
    host = new URL(url).host;
  } catch {
    return;
  }
  // Exact match, never `endsWith`: `hooks.slack.com.evil.test` ends with the
  // suffix and is not Slack.
  if (host !== SLACK_WEBHOOK_HOST) return;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  }).catch(() => {});
}

// ─── The probe ───────────────────────────────────────────────────────────────

async function run() {
  // Not an assertion about production — a misconfigured probe, and said so.
  // Failing here rather than silently skipping steps 5–6 matters more than it
  // looks: this probe spent its first life proving only that the create path
  // could REFUSE, and a key-less run that quietly degraded back to that shape
  // would be a monitor reporting green on strictly less than it claims. That is
  // the exact failure this program keeps finding.
  if (!PROBE_API_KEY) {
    fail(
      'PROBE_API_KEY is unset. The probe cannot mark its own order `isProbe` at create time, ' +
        'and therefore cannot cancel it afterwards — so it would either skip the sale half or ' +
        'strand a PENDING order holding a seat. Generate one with `openssl rand -hex 32`, set ' +
        'it on Railway (`railway variables --service <backend> --set ' +
        'PROBE_API_KEY=…`) and here (`gh secret set PROBE_API_KEY`). Both sides must hold the ' +
        'SAME value.',
    );
  }

  console.log(`Ticket checkout probe → ${API_URL}`);
  console.log(`  org=${contract.orgSlug} event=${contract.eventSlug}\n`);

  // 1. The event is reachable, published and sellable at all.
  const event = await step('resolve the fixture event', async () => {
    const url = `${API_URL}/events/${contract.eventSlug}/public-preview/v2`;
    const res = await http('GET', url);
    check(
      !String(res.text).includes('Cannot GET'),
      `${url} is not a routed endpoint — the backend is serving a build without it, or the ` +
        `URL lost its /v1 segment.`,
    );
    check(res.status === 200, `${url} returned HTTP ${res.status}: ${res.text.slice(0, 300)}`);
    const body = res.json?.event;
    check(!!body?.id, `${url} returned no event body.`);
    return body;
  });

  // 2. The payment account. Loudest possible failure, in BOTH directions.
  await step('the org still resolves a TEST Stripe account', async () => {
    const url = `${API_URL}/payments/config?eventId=${event.id}`;
    const res = await http('GET', url);
    check(res.status === 200, `${url} returned HTTP ${res.status}: ${res.text.slice(0, 300)}`);
    const key = res.json?.publishableKey;
    check(
      typeof key === 'string' && key.length > 0,
      `${url} returned no publishableKey — the buyer's browser has nothing to mount Stripe with, ` +
        `so ticket checkout is DOWN even though the page will render.`,
    );
    check(
      key.startsWith('pk_test_'),
      `PRODUCTION PAYMENT-CONFIG INCIDENT: ${contract.orgSlug} resolved ${redactKey(key)} — a ` +
        `LIVE-mode account. Only a live account does that, so this fixture org has lost ` +
        `isTestAccount: true and every order placed against it takes REAL MONEY, including the ` +
        `nightly E2E suite's. Check it before anything else: ` +
        `db.organizations.findOne({ slug: '${contract.orgSlug}' }, { isTestAccount: 1, updatedAt: 1 })`,
    );
    check(
      res.json?.mode === 'test',
      `the payment provider reported mode="${res.json?.mode}" for a pk_test_ key — the two halves ` +
        `of the config disagree, which means one of them is stale.`,
    );
    console.log(`      provider=${res.json?.provider} mode=${res.json?.mode} key=${redactKey(key)}`);
  });

  // 3. The tier a buyer would actually pick.
  await step('the sellable tier is on sale', async () => {
    const tier = (event.ticketTypes ?? []).find((t) => t.name === contract.sellableTierName);
    check(
      !!tier,
      `tier "${contract.sellableTierName}" is not on the published event. Present: ` +
        `[${(event.ticketTypes ?? []).map((t) => t.name).join(', ')}]. ` +
        `Reseed: node scripts/seed-ticket-checkout-fixtures.mjs --apply`,
    );
    check(tier.isActive !== false, `tier "${tier.name}" is not active — nobody can buy it.`);
    check(
      tier.availableCount === null || tier.availableCount > 0,
      `tier "${tier.name}" reports ${tier.availableCount} seats. Nobody can buy a ticket to this ` +
        `event right now. Reseed: node scripts/seed-ticket-checkout-fixtures.mjs --apply`,
    );
    const endsIn = Math.floor((new Date(event.endTime).getTime() - Date.now()) / 86_400_000);
    check(
      endsIn > 0,
      `the fixture event ended ${-endsIn} days ago. createOrder refuses a sale on an ended event, ` +
        `so this probe and the E2E suite are both about to fail on a DATE rather than a defect. ` +
        `Reseed: node scripts/seed-ticket-checkout-fixtures.mjs --apply`,
    );
    console.log(`      "${tier.name}" ${tier.price}¢ seats=${tier.availableCount} runway=${endsIn}d`);
  });

  // 4. The CREATE path, driven to a clean refusal against a tier with no seats.
  await step('the order create path answers, and refuses cleanly', async () => {
    const tier = (event.ticketTypes ?? []).find((t) => t.name === contract.zeroSeatTierName);
    check(
      !!tier,
      `tier "${contract.zeroSeatTierName}" is not on the event. It is the zero-seat tier this ` +
        `probe drives the create path against WITHOUT reserving anything; without it the probe ` +
        `has no non-mutating way to reach createOrder's availability guard. ` +
        `Reseed: node scripts/seed-ticket-checkout-fixtures.mjs --apply`,
    );
    check(
      tier.availableCount === 0,
      `tier "${tier.name}" reports ${tier.availableCount} seats available. It is supposed to be AT ` +
        `its limit — with a seat free this step would BUY one as a side effect of asking whether ` +
        `the guard refuses. Refusing to run. ` +
        `Reseed: node scripts/seed-ticket-checkout-fixtures.mjs --apply`,
    );
    // MOT-743 G3. `global-setup.ts` checks this and the probe did not, and the
    // two guards are not interchangeable: an INACTIVE tier is refused by
    // `${name} is not available` about sixty lines BEFORE the availability
    // guard, so without this the probe would report "the guard was reached"
    // having never reached it. The exact-sentence check below would now catch
    // that too, but a named precondition fails with a message somebody can act
    // on rather than as a puzzling status mismatch.
    check(
      tier.isActive !== false,
      `tier "${tier.name}" is not active. An inactive tier is refused by the isActive guard, ` +
        `~60 lines before the availability guard this step exists to reach, so this step would ` +
        `prove nothing. Reseed: node scripts/seed-ticket-checkout-fixtures.mjs --apply`,
    );

    const url = `${API_URL}/events/${event.id}/orders`;
    const res = await http('POST', url, {
      items: [{ ticketTypeId: tier.id, quantity: 1 }],
      customerEmail: 'ticket-checkout-probe@example.com',
    });

    check(
      !String(res.text).includes('Cannot POST'),
      `${url} is not a routed endpoint. The ticket order API is not deployed — NOBODY can buy a ` +
        `ticket right now.`,
    );
    check(
      res.status !== 200 && res.status !== 201,
      `a tier with ZERO seats sold a ticket (HTTP ${res.status}). That is an oversell. ` +
        `Body: ${res.text.slice(0, 300)}`,
    );
    check(
      res.status < 500,
      `the create path answered HTTP ${res.status} — a crash, not a refusal. A buyer sees ` +
        `"something went wrong" instead of "sold out". Body: ${res.text.slice(0, 300)}`,
    );

    // ── THE DISCRIMINATOR, ANCHORED — MOT-743 B2 ────────────────────────────
    // This was `/available|sold out|not enough|remaining/i.test(res.text)`, and
    // it could not fail. `createOrder` interpolates the tier's own name into
    // EVERY refusal it raises — `${name} is not available`,
    // `Maximum n ${name} tickets per order`, `Sales for ${name} have ended` —
    // and the tier was called `E2E Sold Out`, so the substring the regex hunted
    // for was in all of them. Deactivate the tier and the probe still reported
    // "the availability guard refused". Verified by execution.
    //
    // Anchored on the STATUS and the SENTENCE instead. The availability guard
    // throws `ConflictException` (409); every refusal above it in `createOrder`
    // throws `BadRequestException` (400) or `NotFoundException` (404), so the
    // status alone already separates them, and the sentence separates this 409
    // from the reservation predicate's own ("… tickets no longer available")
    // and from the partial-availability one ("Only n … available").
    const expectedRefusal = `${tier.name} is sold out`;
    check(
      res.status === 409,
      `a zero-seat tier was refused with HTTP ${res.status}, not the availability guard's 409. ` +
        `Every guard ABOVE it — inactive tier, closed sales window, per-order cap, missing ` +
        `event — answers 400 or 404, so something upstream is answering and this step proved ` +
        `much less than it looks like it did. Body: ${res.text.slice(0, 300)}`,
    );
    check(
      String(res.text).includes(expectedRefusal),
      `a zero-seat tier was refused 409 with "${res.text.slice(0, 200)}" rather than ` +
        `"${expectedRefusal}". A 409 that is not that sentence is the reservation predicate ` +
        `losing a race, which is a different guard on a different line.`,
    );
    console.log(`      HTTP ${res.status} ${(res.json?.message ?? res.text).toString().slice(0, 80)}`);
  });

  // 5. THE SALE. Create a real ticket order, then cancel it (MOT-735).
  //
  //    Steps 1–4 prove the create path can REFUSE. This is the half that proves
  //    it can SELL: it reaches the reservation `$inc`, the PaymentIntent
  //    creation and the release. A backend that could refuse but not sell
  //    passed every earlier version of this probe.
  const sellableBefore = (event.ticketTypes ?? []).find(
    (t) => t.name === contract.sellableTierName,
  );
  await step('a real ticket order is created', async () => {
    const url = `${API_URL}/events/${event.id}/orders`;
    const res = await http(
      'POST',
      url,
      {
        items: [{ ticketTypeId: sellableBefore.id, quantity: 1 }],
        customerEmail: 'ticket-checkout-probe@example.com',
      },
      { [PROBE_KEY_HEADER]: PROBE_API_KEY },
    );

    check(
      res.status === 200 || res.status === 201,
      `creating a ticket order answered HTTP ${res.status}. NOBODY can buy a ticket right now. ` +
        `Body: ${res.text.slice(0, 300)}`,
    );
    const orderId = res.json?.orderId;
    check(
      typeof orderId === 'string' && orderId.length > 0,
      `the create call succeeded but returned no orderId, so nothing can be cancelled and a ` +
        `PENDING order may be holding a seat. Body: ${res.text.slice(0, 300)}`,
    );
    createdOrderId = orderId;

    // The money the buyer would be charged. `total === subtotal` for tickets
    // (fees come out of org revenue), so this is exactly the tier price — and a
    // wrong total is a pricing bug that no refusal-only probe could ever see.
    check(
      res.json?.total === sellableBefore.price,
      `the order priced 1 × "${sellableBefore.name}" at ${res.json?.total}¢, but the published ` +
        `tier costs ${sellableBefore.price}¢. A buyer is being quoted a price the storefront ` +
        `does not show.`,
    );
    // A PaymentIntent must exist, or "an order was created" means a row that can
    // never be paid. `paymentSession`/`clientSecret` is what the browser mounts
    // Stripe with, so its absence is a checkout that renders and cannot charge.
    //
    // BOTH spellings, because MOT-692 Phase 5 deliberately emits the neutral
    // `payment.clientToken` alongside the legacy `clientSecret` until the
    // installed iOS base has rolled over, and this probe must not go red on the
    // release that finally drops the old key.
    const clientToken = res.json?.payment?.clientToken ?? res.json?.clientSecret ?? null;
    check(
      typeof clientToken === 'string' && clientToken.length > 0,
      `the order was created with no payment client token, so the buyer's browser has nothing ` +
        `to mount the payment element with — checkout renders and cannot take money. Keys: ` +
        `[${Object.keys(res.json ?? {}).join(', ')}]`,
    );
    check(
      res.json?.payment?.clientConfig?.mode !== 'live',
      `PRODUCTION PAYMENT-CONFIG INCIDENT: the PaymentIntent this probe just created was minted ` +
        `in LIVE mode on ${contract.orgSlug}. The org has lost isTestAccount: true and every ` +
        `order against it takes REAL money.`,
    );
    console.log(`      order ${orderId} at ${res.json?.total}¢`);
  });

  await step('the probe order is cancelled, exactly once', async () => {
    const url = `${API_URL}/orders/${createdOrderId}/probe-cancel`;
    const res = await http('POST', url, undefined, { [PROBE_KEY_HEADER]: PROBE_API_KEY });

    check(
      !String(res.text).includes('Cannot POST'),
      `${url} is not a routed endpoint. MOT-735's probe-cancel route is not deployed, so this ` +
        `probe has just created an order it cannot cancel.`,
    );
    check(
      res.status === 200,
      `cancelling the probe order answered HTTP ${res.status}. The status codes are a contract: ` +
        `403 = bad key or an order the probe did not create, 404 = no such order, 409 = the ` +
        `order was no longer PENDING (or a capture was refused on it). ` +
        `Body: ${res.text.slice(0, 300)}`,
    );
    check(
      res.json?.status === 'cancelled',
      `the cancel returned status "${res.json?.status}", expected "cancelled". ` +
        `Body: ${res.text.slice(0, 200)}`,
    );
    orderCancelled = true;

    // Cancelling twice must credit ONCE. `cancelProbeOrder` claims
    // PENDING → CANCELLED inside the `findOneAndUpdate` filter, so the loser
    // gets a 409 rather than releasing the seats a second time — which is the
    // double-credit shape MOT-734 was filed over, reintroduced through a new
    // door. Two overlapping probe runs would otherwise do exactly this.
    const again = await http('POST', url, undefined, { [PROBE_KEY_HEADER]: PROBE_API_KEY });
    check(
      again.status === 409,
      `a SECOND cancel of the same order answered HTTP ${again.status}, not 409. Only the caller ` +
        `that wins the PENDING transition may release, and a second winner credits the seats ` +
        `twice. Body: ${again.text.slice(0, 300)}`,
    );
  });

  // 6. The seat came back. The arithmetic, not the call count.
  //
  //    MOT-734 exists because 29 green tests counted release CALLS while the
  //    counter was wrong. This reads the number.
  await step('the cancelled order gave its seat back — exactly one', async () => {
    if (sellableBefore.availableCount === null) {
      fail(
        `the sellable tier "${sellableBefore.name}" is uncapped, so availableCount is null and ` +
          `this probe cannot observe whether the seat came back. Cap the tier: ` +
          `node scripts/seed-ticket-checkout-fixtures.mjs --apply`,
      );
    }
    const res = await http('GET', `${API_URL}/events/${contract.eventSlug}/public-preview/v2`);
    check(res.status === 200, `re-reading the event answered HTTP ${res.status}`);
    const after = (res.json?.event?.ticketTypes ?? []).find(
      (t) => t.name === contract.sellableTierName,
    );
    check(!!after, `tier "${contract.sellableTierName}" vanished mid-run`);
    check(
      after.availableCount === sellableBefore.availableCount,
      `the tier had ${sellableBefore.availableCount} seats before this run and has ` +
        `${after.availableCount} after a create + cancel. A shortfall of one means the cancel ` +
        `did not release; a SURPLUS means it released twice, which is the double-credit ` +
        `MOT-734 was filed over and every abandoned checkout would then manufacture a phantom ` +
        `seat. (Concurrency note: this probe runs behind a concurrency group, but a nightly ` +
        `E2E run or a human on the demo storefront buying in the same window produces the same ` +
        `red. Re-run before escalating.)`,
    );
    console.log(`      seats ${sellableBefore.availableCount} → ${after.availableCount}`);
  });

  // 7. The telemetry route a client-side failure reports through.
  await step('the client-event telemetry route is live', async () => {
    const url = `${API_URL}/orders/${NONEXISTENT_ORDER_ID}/client-event`;
    const res = await http('POST', url, { event: 'probe_liveness', token: 'irrelevant' });
    check(
      !String(res.text).includes('Cannot POST'),
      `${url} is not routed. Every checkout failure that dies in the buyer's browser — every ` +
        `wallet handoff that never opened — is invisible until this is back.`,
    );
    check(
      res.status === 404,
      `the telemetry route answered HTTP ${res.status} for an order id that cannot exist. A 2xx ` +
        `would mean it accepts writes against arbitrary ids. Body: ${res.text.slice(0, 200)}`,
    );
  });
}

/**
 * Cancel an order this run created and did not cancel.
 *
 * Best effort, and only on the failure path — the happy path has already
 * cancelled. An order left PENDING holds a seat for ten minutes and then goes
 * through the expiry sweep, which since MOT-734 credits exactly once; but
 * leaving one behind every twelve hours is still the shape this probe exists
 * not to have, so it is worth one more request.
 */
async function cleanupOrphanedOrder() {
  if (!createdOrderId || orderCancelled || !PROBE_API_KEY) return;
  try {
    const res = await http(
      'POST',
      `${API_URL}/orders/${createdOrderId}/probe-cancel`,
      undefined,
      { [PROBE_KEY_HEADER]: PROBE_API_KEY },
    );
    console.error(
      res.status === 200
        ? `  cleanup: cancelled orphaned order ${createdOrderId}`
        : `  cleanup: could not cancel ${createdOrderId} (HTTP ${res.status}); the expiry sweep ` +
            `releases it within ten minutes`,
    );
  } catch {
    console.error(
      `  cleanup: could not cancel ${createdOrderId}; the expiry sweep releases it within ten ` +
        `minutes`,
    );
  }
}

try {
  await run();
  console.log(`\n✓ ticket checkout probe OK in ${Date.now() - started}ms`);
  await reportProbeRun({ checkKey: 'ticket.probe', startedMs: started, steps });
  process.exit(0);
} catch (error) {
  await cleanupOrphanedOrder();
  const summary = steps.map((s) => `${s.ok ? '✓' : '✗'} ${s.name}`).join(' → ');
  const message =
    error instanceof ProbeFailure
      ? error.message
      : `unexpected error: ${error?.stack ?? error?.message ?? error}`;

  console.error(`\n✗ TICKET CHECKOUT PROBE FAILED after ${Date.now() - started}ms`);
  console.error(`  steps: ${summary}`);
  console.error(`  ${message}`);
  console.error(
    `\n  Triage order, most likely first:\n` +
      `    1. Was the backend mid-deploy? Re-run before escalating — one red run is not an outage.\n` +
      `    2. Has the fixture rotted? node scripts/seed-ticket-checkout-fixtures.mjs (dry run) prints the whole state.\n` +
      `    3. Is the org still isTestAccount:true? That failure has its own message and outranks everything else.`,
  );
  await reportProbeRun({
    checkKey: 'ticket.probe',
    startedMs: started,
    steps,
    failureMessage: message,
    failedStep: steps.find((s) => !s.ok)?.name ?? 'start the probe',
  });
  await postSlack(`:rotating_light: Ticket checkout probe FAILED — ${message.slice(0, 500)}`);
  process.exit(1);
}
