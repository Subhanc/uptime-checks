#!/usr/bin/env node
/**
 * The synthetic VENDOR TABLES checkout probe — MOT-808.
 *
 *   PROBE_API_KEY=… node scripts/vendor-tables-probe.mjs
 *   PROBE_DRY_RUN=1 node scripts/vendor-tables-probe.mjs   # steps 1–4 only, writes NOTHING
 *
 * Answers, twice a day, from outside the backend: **could a vendor buy a table
 * right now?**
 *
 *   resolve the fixture event  ->  prove the org still resolves a TEST Stripe
 *   account  ->  prove a table is AVAILABLE  ->  drive the create path to a
 *   clean refusal on a table that is not  ->  BUY a real table  ->  prove it
 *   left the floor  ->  cancel it  ->  prove it came back
 *
 * NOTHING WATCHED THIS FLOW BEFORE
 * -------------------------------
 * Shop and tickets have each had a twelve-hourly probe since MOT-521 and
 * MOT-711. Vendor tables — a third checkout with its own collection, status
 * enum, reservation model and PaymentIntent — had none. Every finding this
 * program produced about it (428 `failed` rows that were really buyer-initiated
 * teardown, the orphan PaymentIntents, the unsettled denial refunds) was found
 * by a human going to look.
 *
 * WHY IT RUNS OUTSIDE THE BACKEND
 * -------------------------------
 * On 2026-08-16 a real customer's checkout died inside a deploy blackout and
 * nothing noticed, because everything that could have noticed was the thing that
 * was down. A process cannot report its own absence. So this runs on GitHub
 * Actions, on a schedule, from outside.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT BUYS A TABLE AND CANCELS IT, AND THE CANCEL IS WHY THAT IS SAFE
 * ─────────────────────────────────────────────────────────────────────────────
 * The cancel is the EXISTING public `POST .../orders/:orderId/cancel` — the same
 * call the storefront fires on unload and on modal close. No probe-only route
 * was added, because unlike the ticket flow this one already had a cancellable
 * state and a public door to it.
 *
 * Since PR #1055 that route writes SUPERSEDED rather than FAILED. That is not a
 * detail; it is the reason this is safe to run 730 times a year. `FAILED` is the
 * bucket an operator reads as "a live money path is breaking", and before #1055
 * it was absorbing every buyer-initiated teardown — 424 of the 428 rows carrying
 * it in production were exactly that. A monitor whose own traffic landed there
 * would have been manufacturing the signal the program exists to clean up.
 * SUPERSEDED says what actually happened: a checkout was torn down and no money
 * moved.
 *
 * IT CANNOT STARVE THE FIXTURE
 * ----------------------------
 * Vendor tables are finite per event and do not restock, and MOT-800 is a live
 * warning about what that costs: the shop shipping suite is red because its
 * fixture ran out of stock and nothing reseeds it. There is deliberately no
 * seeder here, because there is nothing to reseed:
 *
 *   1. The probe releases what it takes. Step 8 re-reads the storefront and
 *      FAILS if the table did not come back, so a release that silently stopped
 *      working is a red run rather than a slow leak.
 *   2. If the cancel never runs — the process is killed, the runner wedges — the
 *      `finally` block below tries again, and failing that
 *      `releaseExpiredReservations` returns any table whose 10-minute
 *      `reservedUntil` has lapsed, on an every-minute cron.
 *   3. There is no counter to corrupt. A table's availability IS its `status`
 *      field, so unlike a ticket tier's `soldCount` there is no number a
 *      double-credit could walk in either direction.
 *
 * The refusal half runs against a table that is already SOLD and is never
 * written to. `minimumAvailableTables` in the fixture is the early warning for
 * the one way the pool CAN shrink: a human buying on the demo storefront.
 *
 * WHAT IT DOES NOT PROVE
 * ----------------------
 * It does not CONFIRM the PaymentIntent, so `confirmOrder`, the webhook path,
 * the approval flow and the COMPLETED transition are not covered. A probe that
 * confirmed payments would be a monitor that spends money on a schedule.
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
  readFileSync(path.join(REPO_ROOT, 'scripts/vendor-tables-probe-fixture.json'), 'utf8'),
);

const API_URL = (process.env.PROBE_API_URL || '').replace(/\/+$/, '');

/**
 * The credential that authorises exactly one thing here: marking a vendor order
 * `isProbe` at CREATE time
 * (`backend/src/modules/vendor-tables/schemas/vendor-order.schema.ts`). Never
 * printed, in any branch.
 *
 * It does more work on this flow than on the other two. Both vendor create paths
 * are PUBLIC and support guest checkout, so the key is the ONLY thing separating
 * this run's order from a real vendor's application in every surface that counts
 * them. Without it the probe refuses to sell rather than leaving an unlabelled
 * synthetic row in a collection an operator reads for real applications.
 */
const PROBE_API_KEY = process.env.PROBE_API_KEY;

/** The header the backend reads the key from. Lower-case; Node normalises. */
const PROBE_KEY_HEADER = 'x-probe-key';

/**
 * Steps 1–4 only: resolve, payment config, floor state, refusal.
 *
 * Every one of those is a GET or a create call that throws BEFORE the
 * reservation write and aborts its transaction, so a dry run creates no order,
 * reserves no table and mints no PaymentIntent. It exists so this file can be
 * exercised against PRODUCTION from a laptop while it is being written, without
 * the author having to decide whether a leftover row is acceptable.
 *
 * It is NOT what the workflow runs, and the distinction is the point of the
 * whole program: a dry run proves the create path can REFUSE, which is the
 * shape every earlier probe in this repository was passed by a backend that
 * could not sell.
 */
const DRY_RUN = process.env.PROBE_DRY_RUN === '1';

/**
 * Per-step deadline, well under the workflow's own timeout. A step that hangs
 * must fail as THAT step, so the report names what was slow rather than being
 * killed anonymously by the job timeout with nothing to read.
 */
const STEP_TIMEOUT_MS = 20_000;

/** The only host Slack serves incoming webhooks from — exact match, never a suffix test. */
const SLACK_WEBHOOK_HOST = 'hooks.slack.com';

/*
 * THERE IS DELIBERATELY NO TOTAL ASSERTION HERE, and the absence is worth
 * stating because the ticket probe has one.
 *
 * `setup-checkout` returns `{payment, clientSecret, orderId, currency,
 * receiptToken, discountApplied, addOns}`, plus `isProbe: true` when the
 * backend accepted this probe's key — no subtotal and no total. Vendor
 * checkout quotes the buyer from the floor plan and charges through the
 * PaymentIntent, so the amount is not on any surface an outside prober can
 * read. Writing a bound against a number this response does not carry would
 * mean either asserting `undefined <= something` (a guard that cannot fail) or
 * reaching into the database from a workflow that deliberately holds no
 * production credential.
 *
 * What IS assertable is the denomination and the mode, and step 5 asserts both.
 * A total assertion belongs to whichever change first puts the amount on this
 * response.
 */

const started = Date.now();
const steps = [];

/**
 * The order this run created, and whether it has been cancelled.
 *
 * Module scope rather than local to `run()` so the failure path can reach them:
 * an order this probe created and did not cancel is a PENDING order holding a
 * table off a floor plan.
 */
let createdOrderId = null;
let createdOrderEventId = null;
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

/** The public floor plan, exactly as a vendor's browser sees it. */
async function readFloor(eventId) {
  const url = `${API_URL}/events/${eventId}/vendor-tables/public`;
  const res = await http('GET', url);
  check(
    !String(res.text).includes('Cannot GET'),
    `${url} is not a routed endpoint — the backend is serving a build without it, or the URL ` +
      `lost its /v1 segment.`,
  );
  check(res.status === 200, `${url} returned HTTP ${res.status}: ${res.text.slice(0, 300)}`);
  check(
    Array.isArray(res.json?.tables),
    `${url} returned no tables array. A vendor loading this event sees an empty floor plan and ` +
      `cannot buy anything. Body: ${res.text.slice(0, 300)}`,
  );
  return res.json;
}

/**
 * One table by name, or a failure that names what IS on the floor.
 *
 * The public read returns raw lean documents, so the id is `_id` and not `id`.
 */
function tableNamed(floor, name, role) {
  const table = floor.tables.find((candidate) => candidate.name === name);
  check(
    !!table,
    `table "${name}" — the fixture's ${role} — is not on this event's floor plan. Present: ` +
      `[${floor.tables.map((t) => t.name).join(', ')}]. The fixture has been edited; see the ` +
      `_comment in scripts/vendor-tables-probe-fixture.json for what each pinned table has to be.`,
  );
  return table;
}

// ─── The probe ───────────────────────────────────────────────────────────────

async function run() {
  // Not an assertion about production — a misconfigured probe, and said so.
  // Failing here rather than silently skipping steps 5–8 matters more than it
  // looks: a key-less run that quietly degraded to the refusal-only shape would
  // be a monitor reporting green on strictly less than it claims, which is the
  // exact failure this program keeps finding.
  if (!PROBE_API_KEY && !DRY_RUN) {
    fail(
      'PROBE_API_KEY is unset. The probe cannot mark its own order `isProbe` at create time, so ' +
        'it would either skip the sale half or leave an UNLABELLED synthetic order in a ' +
        'collection an operator reads for real vendor applications. Generate one with ' +
        '`openssl rand -hex 32`, set it on Railway (`railway variables --service <backend> ' +
        '--set PROBE_API_KEY=…`) and here (`gh secret set PROBE_API_KEY`). ' +
        'Both sides must hold the SAME value. To exercise steps 1–4 without a key, set ' +
        'PROBE_DRY_RUN=1 — but understand that a dry run proves only that the create path can ' +
        'REFUSE.',
    );
  }

  console.log(`Vendor tables checkout probe → ${API_URL}${DRY_RUN ? '  [DRY RUN — steps 1–4]' : ''}`);
  console.log(`  org=${contract.orgSlug} event=${contract.eventSlug}\n`);

  // 1. The event is reachable, published, and still selling tables at all.
  const event = await step('resolve the fixture event', async () => {
    const url = `${API_URL}/events/${contract.eventSlug}/public-preview/v2`;
    const res = await http('GET', url);
    check(
      !String(res.text).includes('Cannot GET'),
      `${url} is not a routed endpoint — the backend is serving a build without it, or the URL ` +
        `lost its /v1 segment.`,
    );
    check(res.status === 200, `${url} returned HTTP ${res.status}: ${res.text.slice(0, 300)}`);
    const body = res.json?.event;
    check(!!body?.id, `${url} returned no event body.`);
    // The fixture is a PAIR — an org and an event — and only the org half is
    // safety-checked in step 2. If the event moved to a different org, every
    // later assertion would be about a floor plan nobody meant to point at.
    check(
      body.organizationSlug === contract.orgSlug,
      `the fixture event now belongs to "${body.organizationSlug}", not "${contract.orgSlug}". ` +
        `The probe is about to exercise an org nobody chose.`,
    );
    check(
      body.vendorTablesEnabled === true,
      `the fixture event has vendorTablesEnabled=${body.vendorTablesEnabled}. Vendor table sales ` +
        `are CLOSED on it, so every create call below would be refused by a switch rather than by ` +
        `a defect.`,
    );
    const endsIn = Math.floor((new Date(body.endTime).getTime() - Date.now()) / 86_400_000);
    check(
      endsIn > 0,
      `the fixture event ended ${-endsIn} days ago. A probe pointed at a finished show is ` +
        `measuring a page no vendor would ever load. Point the fixture at a live event, or move ` +
        `this one's endTime.`,
    );
    console.log(`      "${body.title}" runway=${endsIn}d`);
    return body;
  });

  // 2. The payment account. Loudest possible failure, in BOTH directions.
  //
  //    This is the check that keeps the probe off `trade-river-cards`, whether
  //    or not anybody remembers why the fixture names a demo org.
  await step('the org still resolves a TEST Stripe account', async () => {
    const url = `${API_URL}/payments/config?eventId=${event.id}`;
    const res = await http('GET', url);
    check(res.status === 200, `${url} returned HTTP ${res.status}: ${res.text.slice(0, 300)}`);
    const key = res.json?.publishableKey;
    check(
      typeof key === 'string' && key.length > 0,
      `${url} returned no publishableKey — the vendor's browser has nothing to mount the payment ` +
        `element with, so vendor checkout is DOWN even though the floor plan will render.`,
    );
    check(
      key.startsWith('pk_test_'),
      `PRODUCTION PAYMENT-CONFIG INCIDENT: ${contract.orgSlug} resolved ${redactKey(key)} — a ` +
        `LIVE-mode account. Only a live account does that, so this fixture org has lost ` +
        `isTestAccount: true and every order placed against it takes REAL MONEY, including the ` +
        `one this probe is about to create. Check it before anything else: ` +
        `db.organizations.findOne({ slug: '${contract.orgSlug}' }, { isTestAccount: 1, updatedAt: 1 })`,
    );
    check(
      res.json?.mode === 'test',
      `the payment provider reported mode="${res.json?.mode}" for a pk_test_ key — the two halves ` +
        `of the config disagree, which means one of them is stale.`,
    );
    console.log(`      provider=${res.json?.provider} mode=${res.json?.mode} key=${redactKey(key)}`);
  });

  // 3. The floor plan a vendor would actually look at.
  const floorBefore = await step('a table is AVAILABLE, and one is not', async () => {
    const floor = await readFloor(event.id);

    check(
      floor.currency === contract.expectedCurrency,
      `the floor plan quotes prices in "${floor.currency}" but the fixture expects ` +
        `"${contract.expectedCurrency}". A currency that moved under a storefront is a vendor ` +
        `billed in a denomination they were never quoted.`,
    );

    const sellable = tableNamed(floor, contract.sellableTableName, 'sellable table');
    check(
      sellable.status === 'available',
      `table "${sellable.name}" reads "${sellable.status}", not "available". Either a human bought ` +
        `it on the demo storefront, or a previous run of this probe failed to release it — the ` +
        `10-minute reservation lease should have expired by now, so check the sweep before the ` +
        `fixture.`,
    );
    check(
      typeof sellable.price === 'number' && sellable.price > 0,
      `table "${sellable.name}" is priced ${sellable.price}. A table that costs nothing is not a ` +
        `checkout, and the sale half below would prove nothing about the money path.`,
    );

    const unavailable = tableNamed(floor, contract.unavailableTableName, 'refusal table');
    // SOLD specifically, never merely "not available". A RESERVED table becomes
    // available again within ten minutes, and step 4 pointed at one would
    // eventually BUY it as a side effect of asking whether the guard refuses.
    check(
      unavailable.status === 'sold',
      `table "${unavailable.name}" reads "${unavailable.status}", not "sold". This is the table ` +
        `step 4 drives the create path against WITHOUT reserving anything, and it is only safe ` +
        `while it is permanently unavailable — a RESERVED table frees itself within ten minutes ` +
        `and step 4 would then buy it by accident.`,
    );

    const available = floor.tables.filter((table) => table.status === 'available');
    check(
      available.length >= contract.minimumAvailableTables,
      `only ${available.length} of ${floor.tables.length} tables are still available, below the ` +
        `floor of ${contract.minimumAvailableTables}. This probe does not consume tables — it ` +
        `cancels — so somebody has been buying on the demo storefront. This is the MOT-800 ` +
        `warning arriving while there is still headroom: free some tables before ` +
        `"${contract.sellableTableName}" goes and the probe starts reporting an outage that is ` +
        `really a spent fixture.`,
    );

    console.log(
      `      "${sellable.name}" ${sellable.price}¢ available=${available.length}/${floor.tables.length} ` +
        `refusal="${unavailable.name}" (${unavailable.status})`,
    );
    return { floor, sellable, unavailable };
  });

  // 4. The CREATE path, driven to a clean refusal against a table that is SOLD.
  //
  //    Reaches routing, the DTO, the event load, the org gate, the table lookup
  //    and the availability guard — and reserves nothing, because the guard
  //    throws before the reservation write and the transaction aborts.
  await step('the checkout create path answers, and refuses cleanly', async () => {
    const url = `${API_URL}/events/${event.id}/vendor-tables/setup-checkout`;
    const res = await http('POST', url, { tableIds: [floorBefore.unavailable._id] });

    check(
      !String(res.text).includes('Cannot POST'),
      `${url} is not a routed endpoint. The vendor checkout API is not deployed — NOBODY can buy ` +
        `a table right now.`,
    );
    check(
      res.status !== 200 && res.status !== 201,
      `a SOLD table was sold again (HTTP ${res.status}). Two vendors now hold the same table. ` +
        `Body: ${res.text.slice(0, 300)}`,
    );
    check(
      res.status < 500,
      `the create path answered HTTP ${res.status} — a crash, not a refusal. A vendor sees ` +
        `"something went wrong" instead of "that table is taken". Body: ${res.text.slice(0, 300)}`,
    );

    // ── THE DISCRIMINATOR, ANCHORED ─────────────────────────────────────────
    // A status check alone cannot do this job on this flow. `setupCheckout`
    // raises `BadRequestException` for the availability guard AND for
    // "One or more tables not found for this event" one branch above it, and
    // the global pipe answers 400 for a malformed body too — three different
    // facts behind one status code. So the assertion is on the exact SENTENCE,
    // compared by equality rather than by substring: the table's own name is
    // interpolated into it, which is what let the ticket probe's regex match a
    // refusal from anywhere until MOT-743 B2.
    const expectedRefusal =
      `The following tables are no longer available: ${floorBefore.unavailable.name}`;
    check(
      res.status === 400,
      `a sold table was refused with HTTP ${res.status}, not the availability guard's 400. ` +
        `Body: ${res.text.slice(0, 300)}`,
    );
    check(
      res.json?.message === expectedRefusal,
      `a sold table was refused 400 with ${JSON.stringify(res.json?.message)} rather than ` +
        `"${expectedRefusal}". A 400 that is not that sentence is a DIFFERENT guard on a ` +
        `different line — "One or more tables not found for this event" means the fixture id no ` +
        `longer resolves, and an array-valued message means the request body was rejected by the ` +
        `validation pipe before any of this was reached.`,
    );
    console.log(`      HTTP ${res.status} ${res.json?.message}`);
  });

  if (DRY_RUN) {
    console.log('\n  [DRY RUN] stopping before the sale. Nothing was created.');
    return;
  }

  // 5. THE SALE. Create a real vendor order against the available table.
  //
  //    Steps 1–4 prove the create path can REFUSE. This is the half that proves
  //    it can SELL: it reaches the reservation write, the order document and the
  //    PaymentIntent. A backend that could refuse but not sell passes every
  //    refusal-only probe.
  const sale = await step('a real vendor table order is created', async () => {
    const url = `${API_URL}/events/${event.id}/vendor-tables/setup-checkout`;
    const res = await http(
      'POST',
      url,
      { tableIds: [floorBefore.sellable._id] },
      { [PROBE_KEY_HEADER]: PROBE_API_KEY },
    );

    check(
      res.status === 200 || res.status === 201,
      `creating a vendor table order answered HTTP ${res.status}. NOBODY can buy a table right ` +
        `now. Body: ${res.text.slice(0, 300)}`,
    );
    const orderId = res.json?.orderId;
    check(
      typeof orderId === 'string' && orderId.length > 0,
      `the create call succeeded but returned no orderId, so nothing can be cancelled and a ` +
        `PENDING order may be holding a table. Body: ${res.text.slice(0, 300)}`,
    );
    createdOrderId = orderId;
    createdOrderEventId = event.id;

    // THE MARK WAS ACCEPTED — asserted, not assumed.
    //
    // Until this line the probe presented `x-probe-key` and never learned
    // whether the backend agreed with it. `isValidProbeKey` fails CLOSED, and
    // the workflow's `Guard — PROBE_API_KEY is set` only checks its own secret
    // is non-empty — never that it holds the same value as Railway's. So a
    // drifted key (or an unset variable on the backend) produced a GREEN run
    // that had just written an UNLABELLED synthetic order into `vendororders`,
    // indistinguishable from a real vendor's application, while the liveness
    // read reported `never` forever. That is verbatim the harm the key guard at
    // the top of `run()` says it prevents, and it did not prevent it.
    //
    // The order exists either way — a create-time mark cannot be applied after
    // the fact — so what this buys is DETECTION: the run goes red, names the
    // drift, and the cleanup below cancels the row. The alternative was for the
    // pollution to be silent and twice-daily.
    check(
      res.json?.isProbe === true,
      `the order was created but came back UNMARKED (isProbe=${JSON.stringify(res.json?.isProbe)}). ` +
        `The backend did not accept x-probe-key, so this run has just left a synthetic order in ` +
        `vendororders that every operator surface will read as a real vendor's application, and ` +
        `the probe-liveness read will never see this flow's heartbeat. The two sides hold ` +
        `DIFFERENT values, or Railway's PROBE_API_KEY is unset: compare ` +
        `\`railway variables --service <backend> | grep PROBE_API_KEY\` ` +
        `against \`gh secret list\`, and re-set both from one value.`,
    );

    // The money. This response deliberately carries no total — vendor checkout
    // quotes the buyer from the floor plan and the PaymentIntent — so what can
    // be asserted from outside is the DENOMINATION and the MODE, and both are
    // real money failures rather than proxies for one.
    check(
      res.json?.currency === contract.expectedCurrency,
      `the order was denominated in "${res.json?.currency}" while the floor plan quoted ` +
        `"${floorBefore.floor.currency}". The vendor is being charged in a currency the ` +
        `storefront never showed them.`,
    );
    const payment = res.json?.payment ?? {};
    const clientToken = payment.clientToken ?? res.json?.clientSecret ?? null;
    check(
      typeof clientToken === 'string' && clientToken.length > 0,
      `the order was created with no payment client token, so the vendor's browser has nothing ` +
        `to mount the payment element with — checkout renders and cannot take money. Keys: ` +
        `[${Object.keys(res.json ?? {}).join(', ')}]`,
    );
    // Equality, not `!== 'setup'`. `kind` is non-optional in
    // `PaymentSessionResponse`, so a check written as a negation would also pass
    // on a response that stopped carrying the field at all — a guard that goes
    // quiet exactly when the contract it guards changes.
    check(
      payment.kind === 'payment',
      `the create path minted a "${payment.kind}" session rather than a payment. A setup intent ` +
        `collects a card and charges nothing, so this vendor would hold a table nobody billed ` +
        `them for.`,
    );
    check(
      payment.clientConfig?.mode !== 'live',
      `PRODUCTION PAYMENT-CONFIG INCIDENT: the PaymentIntent this probe just created was minted ` +
        `in LIVE mode on ${contract.orgSlug}. The org has lost isTestAccount: true and every ` +
        `order against it takes REAL money.`,
    );
    // No discount code and no add-ons were sent, so any that came back were
    // invented by the pricing path.
    check(
      !res.json?.discountApplied,
      `the order came back carrying discount ${JSON.stringify(res.json?.discountApplied)} on a ` +
        `create call that sent no code. A vendor is being given money nobody offered them.`,
    );
    console.log(`      order ${orderId} ${res.json?.currency} kind=${payment.kind}`);
    return res.json;
  });

  // 6. The table actually LEFT the floor.
  //
  //    This is what separates "the create call returned an id" from "the create
  //    call took the table". Without it, step 8's "the table is available" would
  //    pass vacuously against a create that reserved nothing — the shape MOT-734
  //    was filed over, where 29 green tests counted release CALLS while the
  //    number was wrong.
  await step('the bought table left the floor plan', async () => {
    const floor = await readFloor(event.id);
    const table = tableNamed(floor, contract.sellableTableName, 'sellable table');
    check(
      table.status === 'reserved',
      `after a successful create, "${table.name}" still reads "${table.status}". The order exists ` +
        `and the table was never taken off the floor, so a second vendor can buy it right now — ` +
        `and this probe's release assertion below would pass having released nothing.`,
    );
    // The lease, not a decrement. Its presence is what guarantees the table
    // comes back even if every cancel below fails.
    check(
      !!table.reservedUntil && new Date(table.reservedUntil).getTime() > Date.now(),
      `"${table.name}" is reserved with reservedUntil=${table.reservedUntil}. Without a future ` +
        `lease the every-minute sweep will never release it, so a failed cancel would hold this ` +
        `table forever.`,
    );
  });

  // 7. The cancel — the buyer's own teardown route, not a probe-only one.
  await step('the probe order is cancelled', async () => {
    const res = await cancelCreatedOrder();
    check(
      res !== null,
      `cancelling the probe order failed at the transport. The table is held until its 10-minute ` +
        `lease expires.`,
    );
    check(
      !String(res.text).includes('Cannot POST'),
      `the public cancel route is not deployed, so this probe has just created an order it ` +
        `cannot tear down — and so has every vendor who closes the checkout modal.`,
    );
    check(
      res.status === 200 || res.status === 201 || res.status === 204,
      `cancelling the probe order answered HTTP ${res.status}. This is the same route the ` +
        `storefront fires on unload, so a failure here means every abandoned vendor checkout in ` +
        `production is also holding its table until the sweep catches it. ` +
        `Body: ${res.text.slice(0, 300)}`,
    );
    orderCancelled = true;

    // A SECOND cancel, which is a thing that genuinely happens: the storefront
    // fires this on unload AND on modal close, and this probe's own `finally`
    // may fire it again.
    //
    // Deliberately NOT asserted to be a 409, unlike the ticket probe's
    // probe-cancel. This route is a `navigator.sendBeacon` target and answering
    // a browser tearing down a page with a conflict would be noise nobody reads;
    // `cancelOrder` returns early when the order is no longer PENDING, so the
    // second call is a clean no-op by design. What matters is that it stays one:
    // a version of this route that released unconditionally would hand back a
    // table a DIFFERENT vendor had since reserved.
    const again = await http(
      'POST',
      `${API_URL}/events/${createdOrderEventId}/vendor-tables/orders/${createdOrderId}/cancel`,
    );
    check(
      again.status < 400,
      `a SECOND cancel of the same order answered HTTP ${again.status}. It is supposed to be a ` +
        `no-op — the storefront fires this route twice routinely — so an error here means an ` +
        `ordinary vendor closing their tab produces a failure. Body: ${again.text.slice(0, 300)}`,
    );
  });

  // 8. The table came back. The state, not the call count.
  await step('the cancelled order put the table back on the floor', async () => {
    const floor = await readFloor(event.id);
    const table = tableNamed(floor, contract.sellableTableName, 'sellable table');
    check(
      table.status === 'available',
      `after a create and a cancel, "${table.name}" reads "${table.status}" rather than ` +
        `"available". The release did not happen, so every vendor who abandons a checkout takes a ` +
        `table off the floor until the sweep catches it — and this fixture loses a table a day.`,
    );
    const stillAvailable = floor.tables.filter((t) => t.status === 'available').length;
    console.log(`      "${table.name}" reserved → available (${stillAvailable} free)`);
  });
}

/**
 * Cancel the order this run created, through the public storefront route.
 *
 * Returns the HTTP status, or `null` if the request itself failed. Shared by the
 * happy path and the cleanup path so there is one spelling of the URL — a
 * cleanup that posts to a slightly different path is a cleanup that silently
 * never runs.
 */
async function cancelCreatedOrder() {
  if (!createdOrderId || !createdOrderEventId) return null;
  const url = `${API_URL}/events/${createdOrderEventId}/vendor-tables/orders/${createdOrderId}/cancel`;
  try {
    return await http('POST', url);
  } catch {
    // Only the TRANSPORT is swallowed, and only here. An earlier version caught
    // its own `fail()` too, so a cancel route that had been removed entirely
    // was reported as a network blip — the wrong outage, from the one function
    // whose job is to say what went wrong.
    return null;
  }
}

/**
 * Release a table this run took and did not give back.
 *
 * Best effort, and only on the failure path — the happy path has already
 * cancelled. A table left RESERVED is off the floor plan for ten minutes and is
 * then returned by `releaseExpiredReservations`, so nothing is lost permanently;
 * but leaving one behind every twelve hours is still the shape this probe exists
 * not to have, so it is worth one more request.
 */
async function releaseOrphanedTable() {
  if (!createdOrderId || orderCancelled) return;
  const res = await cancelCreatedOrder();
  console.error(
    res !== null && res.status < 400
      ? `  cleanup: cancelled orphaned order ${createdOrderId}`
      : `  cleanup: could not cancel ${createdOrderId} (HTTP ${res?.status ?? 'no response'}); ` +
          `the every-minute sweep releases the table when its 10-minute lease expires`,
  );
}

try {
  await run();
  console.log(`\n✓ vendor tables checkout probe OK in ${Date.now() - started}ms`);
  // A dry run stops before the sale, so a green one is not the check the
  // Reliability page lists and must not be reported as it.
  if (!DRY_RUN) {
    await reportProbeRun({ checkKey: 'vendor_table.probe', startedMs: started, steps });
  }
  process.exit(0);
} catch (error) {
  await releaseOrphanedTable();
  const summary = steps.map((s) => `${s.ok ? '✓' : '✗'} ${s.name}`).join(' → ');
  const message =
    error instanceof ProbeFailure
      ? error.message
      : `unexpected error: ${error?.stack ?? error?.message ?? error}`;

  console.error(`\n✗ VENDOR TABLES CHECKOUT PROBE FAILED after ${Date.now() - started}ms`);
  console.error(`  steps: ${summary}`);
  console.error(`  ${message}`);
  console.error(
    `\n  Triage order, most likely first:\n` +
      `    1. Was the backend mid-deploy? Re-run before escalating — one red run is not an outage.\n` +
      `    2. Has the fixture rotted? scripts/vendor-tables-probe-fixture.json names every property each pinned table has to have, and why.\n` +
      `    3. Is the org still isTestAccount:true? That failure has its own message and outranks everything else.`,
  );
  if (!DRY_RUN) {
    await reportProbeRun({
      checkKey: 'vendor_table.probe',
      startedMs: started,
      steps,
      failureMessage: message,
      failedStep: steps.find((s) => !s.ok)?.name ?? 'start the probe',
    });
  }
  await postSlack(`:rotating_light: Vendor tables checkout probe FAILED — ${message.slice(0, 500)}`);
  process.exit(1);
}
