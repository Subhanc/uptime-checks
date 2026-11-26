#!/usr/bin/env node
/**
 * Tell the Reliability page how one check went.
 *
 * Posts ONE result to `POST <api>/reliability/results` with the probe key in
 * the `x-probe-key` header. Used two ways:
 *
 *   1. Imported by the probe scripts, which hand over their real step list:
 *
 *        import { reportProbeRun } from './report-reliability-result.mjs';
 *        await reportProbeRun({ checkKey: 'ticket.probe', startedMs, steps, failure });
 *
 *   2. Run from a workflow step, for the browser suites, which only know whether
 *      the job passed:
 *
 *        node scripts/report-reliability-result.mjs \
 *          --check shop.suite_matrix --status ${{ job.status }} --started <iso>
 *
 * REPORTING IS BEST EFFORT, AND THAT IS THE WHOLE DESIGN
 * ------------------------------------------------------
 * A report that is refused, times out or cannot be built must never change the
 * outcome of the check it describes. Nothing in this file throws to its caller
 * and the command line always exits 0. When a report is not accepted, exactly
 * one plain line says so. The probe's own exit code stays the alerting
 * contract; this is an addition to it.
 *
 * WHAT IS NEVER SENT OR PRINTED
 * -----------------------------
 * The probe key is sent as a header and never printed, in any branch. Before a
 * step name, a detail or an error leaves this process it is scrubbed of email
 * addresses, payment keys, client secrets, bearer tokens and long opaque
 * strings, and the literal value of the probe key. Probe failure messages quote
 * response bodies, so this scrub is the last thing between a client secret and
 * a stored row.
 *
 * ZERO DEPENDENCIES ON PURPOSE
 * ----------------------------
 * Node's built-in `fetch` and nothing else, the same rule the probes follow.
 * This file is also copied into the public monitor repository
 * (`scripts/sync-monitor-repo.sh`), where there is no `node_modules` at all.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DEFAULT_API_URL = '';
export const PROBE_KEY_HEADER = 'x-probe-key';

/** The contract's size limits. Longer values are cut, never refused. */
export const LIMITS = { steps: 40, name: 120, detail: 300, error: 500 };

/** One report may cost a run this long and no longer. */
const REPORT_TIMEOUT_MS = 8_000;

/** The only branch whose workflow runs describe what is deployed. */
const REPORTING_REF = 'refs/heads/main';

// ── text safety ────────────────────────────────────────────────────────────

const REDACTED = '[redacted]';

/** JSON members whose VALUE is a credential, whatever it looks like. */
const SECRET_FIELDS =
  /("(?:clientSecret|client_secret|clientToken|receiptToken|token|accessToken|access_token|refreshToken|refresh_token|password|secret|authorization|apiKey|api_key)"\s*:\s*")[^"]*/gi;

/**
 * Remove anything that could be a credential or a person's address.
 *
 * Order matters: named JSON members first (their values can be short), then
 * the recognisable shapes, then anything long and opaque that is left.
 */
export function scrub(text, secrets = []) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    // A short value would match ordinary words; a real key is long.
    if (typeof secret === 'string' && secret.length >= 8) out = out.split(secret).join(REDACTED);
  }
  return out
    .replace(SECRET_FIELDS, `$1${REDACTED}`)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\b[a-z]{2,6}_[A-Za-z0-9]+_secret_[A-Za-z0-9]+/g, REDACTED)
    .replace(/\b((?:sk|pk|rk)_(?:test|live)_)[A-Za-z0-9]+/g, '$1…')
    .replace(/\bwhsec_[A-Za-z0-9]+/g, REDACTED)
    .replace(/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, REDACTED)
    .replace(/\b(Bearer)\s+[^\s"',]+/gi, `$1 ${REDACTED}`)
    .replace(/\b[a-f0-9]{32,}\b/gi, REDACTED)
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, REDACTED);
}

/** Scrub, flatten to one line and cut to `max` characters. */
export function safeText(text, max, secrets = []) {
  const flat = scrub(text, secrets).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// ── GitHub context ─────────────────────────────────────────────────────────

/**
 * GitHub's job status, as a result. `null` means "send nothing".
 *
 * A cancelled or skipped job did not measure anything. Reporting it as a pass
 * would be a green light for a check that never ran, and reporting it as a
 * failure would page somebody for a run that was superseded.
 */
export function statusFromGithub(jobStatus) {
  const value = String(jobStatus ?? '').trim().toLowerCase();
  if (value === 'success') return 'pass';
  if (value === 'failure') return 'fail';
  return null;
}

/**
 * Several jobs' results, as one GitHub-style status.
 *
 * Any failure fails the run. Otherwise a cancelled job means the run was cut
 * short, so nothing is said. Otherwise it passed if at least one job actually
 * ran; when every job was skipped nothing was measured, so nothing is said.
 */
export function combineResults(results) {
  const list = (Array.isArray(results) ? results : String(results ?? '').split(','))
    .map((entry) => String(entry).trim().toLowerCase())
    .filter(Boolean);
  if (list.includes('failure')) return 'failure';
  if (list.includes('cancelled')) return 'cancelled';
  if (list.includes('success')) return 'success';
  return 'skipped';
}

export function triggerFromEvent(eventName) {
  const value = String(eventName ?? '').trim();
  if (value === 'schedule') return 'schedule';
  if (value === 'repository_dispatch' || value === 'workflow_run' || value === 'push') return 'deploy';
  // `workflow_dispatch`, and a run from somebody's shell.
  return 'manual';
}

/** The run's page on GitHub, or `null` when this is not a GitHub run. */
export function runUrlFromEnv(env = process.env) {
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: runId } = env;
  if (!server || !repository || !runId) return null;
  const url = `${server.replace(/\/+$/, '')}/${repository}/actions/runs/${runId}`;
  // The backend drops anything else; not sending it keeps the two in step.
  return url.startsWith('https://github.com/') ? url : null;
}

/**
 * The commit the result is about.
 *
 * `RELIABILITY_COMMIT`, when it is defined at all, wins over `GITHUB_SHA`. The
 * public monitor repository defines it on every run (to the deployed commit
 * when a deploy triggered the run, empty otherwise), because there `GITHUB_SHA`
 * is the monitor repository's own commit and says nothing about the product.
 */
export function commitFromEnv(env = process.env) {
  const raw = env.RELIABILITY_COMMIT !== undefined ? env.RELIABILITY_COMMIT : env.GITHUB_SHA;
  const value = String(raw ?? '').trim();
  return /^[a-f0-9]{7,40}$/i.test(value) ? value.slice(0, 7) : null;
}

/**
 * Why a run must not report, or `null` when it may.
 *
 * A run from a feature branch tests that branch's copy of the check, not what
 * is deployed, so it must not open or close an incident. A run outside GitHub
 * (no `GITHUB_REF`) is somebody at a shell and is allowed, as `manual`.
 */
export function refRefusal(env = process.env) {
  if (!env.GITHUB_REF || env.GITHUB_REF === REPORTING_REF) return null;
  if (env.RELIABILITY_REPORT_ANY_REF === '1') return null;
  return 'only runs on the main branch report';
}

// ── building the result ────────────────────────────────────────────────────

function wholeMs(value) {
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

/** One result in the contract's shape, cut to its limits and scrubbed. */
export function buildResult(input, env = process.env) {
  const secrets = [env.PROBE_API_KEY];
  const steps = (input.steps ?? []).slice(0, LIMITS.steps).map((step) => ({
    name: safeText(step.name, LIMITS.name, secrets),
    status: step.status === 'fail' || step.status === 'skipped' ? step.status : 'pass',
    durationMs: wholeMs(step.durationMs),
    detail: safeText(step.detail ?? '', LIMITS.detail, secrets),
  }));
  const status = input.status === 'pass' ? 'pass' : 'fail';
  const startedAt = new Date(input.startedAt);
  return {
    checkKey: String(input.checkKey ?? ''),
    status,
    startedAt: (Number.isNaN(startedAt.getTime()) ? new Date() : startedAt).toISOString(),
    durationMs: wholeMs(input.durationMs) ?? 0,
    steps,
    failedStep:
      status === 'fail' && input.failedStep ? safeText(input.failedStep, LIMITS.name, secrets) : null,
    error: status === 'fail' && input.error ? safeText(input.error, LIMITS.error, secrets) : null,
    runUrl: runUrlFromEnv(env),
    trigger: triggerFromEvent(env.GITHUB_EVENT_NAME),
    commit: commitFromEnv(env),
  };
}

// ── sending ────────────────────────────────────────────────────────────────

/** Where results go: the API the check itself ran against, unless told otherwise. */
export function reportUrlFromEnv(env = process.env) {
  const base = (env.RELIABILITY_API_URL || env.PROBE_API_URL || DEFAULT_API_URL).replace(/\/+$/, '');
  return `${base}/reliability/results`;
}

/** The key travels over https, or to this machine, and nowhere else. */
function refusesKey(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return 'the address is not a valid URL';
  }
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && local)) return null;
  return 'the address is not https';
}

/**
 * Post one result. Never throws. Resolves `{ sent, reason }`.
 *
 * Prints exactly one line either way, so a run's log always says whether the
 * Reliability page heard about it.
 */
export async function sendResult(result, { env = process.env, fetchImpl = fetch, log = console.log } = {}) {
  const say = (sent, reason) => {
    log(
      sent
        ? `reliability report accepted: ${result.checkKey} ${result.status}`
        : `reliability report was not accepted (${reason}). This does not change the result above.`,
    );
    return { sent, reason: sent ? null : reason };
  };

  try {
    const key = env.PROBE_API_KEY;
    if (!key) return say(false, 'PROBE_API_KEY is not set');
    if (!result.checkKey) return say(false, 'no check key was given');

    const url = reportUrlFromEnv(env);
    const refusal = refusesKey(url);
    if (refusal) return say(false, refusal);

    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [PROBE_KEY_HEADER]: key },
      body: JSON.stringify(result),
      signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
    });
    if (response.status >= 200 && response.status < 300) return say(true, null);
    // The status only. A response body is somebody else's text and is not printed.
    return say(false, `the server answered HTTP ${response.status}`);
  } catch (error) {
    return say(false, `no answer: ${error?.name || 'network error'}`);
  }
}

/**
 * Report one probe run from the probe's own step list.
 *
 * `steps` is the list the probe already keeps and prints:
 * `{ name, ok, ms?, detail? }`. `failure` is the error the run ended on, or
 * nothing for a pass. `failedStep` names the step when the probe knows better
 * than "the first one that is not ok".
 */
export async function reportProbeRun(
  { checkKey, startedMs, steps = [], failure = null, failureMessage, failedStep },
  options = {},
) {
  try {
    const env = options.env ?? process.env;
    const refusal = refRefusal(env);
    if (refusal) {
      (options.log ?? console.log)(`reliability report not sent: ${refusal}.`);
      return { sent: false, reason: refusal };
    }
    const failed = Boolean(failure) || Boolean(failureMessage);
    const firstFailed = steps.find((step) => step.ok === false)?.name ?? null;
    const result = buildResult(
      {
        checkKey,
        status: failed ? 'fail' : 'pass',
        startedAt: new Date(startedMs).toISOString(),
        durationMs: Date.now() - startedMs,
        steps: steps.map((step) => ({
          name: step.name,
          status: step.ok === false ? 'fail' : 'pass',
          durationMs: step.ms,
          detail: step.detail ?? '',
        })),
        failedStep: failed ? (failedStep ?? firstFailed) : null,
        error: failed ? (failureMessage ?? failure?.message ?? String(failure)) : null,
      },
      env,
    );
    return await sendResult(result, options);
  } catch (error) {
    (options.log ?? console.log)(
      `reliability report was not accepted (could not be built: ${error?.name || 'error'}). ` +
        'This does not change the result above.',
    );
    return { sent: false, reason: 'could not be built' };
  }
}

// ── command line ───────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]);
    if (!match) continue;
    args[match[1]] = match[2] !== undefined ? match[2] : (argv[++i] ?? '');
  }
  return args;
}

/**
 * The workflow-step form. Always resolves; the caller exits 0.
 *
 *   --check <key>        the check key from the Reliability registry
 *   --status <status>    GitHub's job status: success | failure | cancelled | skipped
 *   --results <a,b,c>    instead of --status: several jobs' results, combined
 *   --started <iso>      when the job started (default: now)
 *   --failed-step <text> optional, for a failed run
 *   --error <text>       optional, for a failed run
 */
export async function runCli(argv, { env = process.env, fetchImpl = fetch, log = console.log } = {}) {
  const args = parseArgs(argv);
  const quiet = (reason) => {
    log(`reliability report not sent: ${reason}.`);
    return { sent: false, reason };
  };

  if (!args.check) return quiet('no --check was given');

  const githubStatus = args.results !== undefined ? combineResults(args.results) : args.status;
  const status = statusFromGithub(githubStatus);
  if (!status) {
    return quiet(`the run ended "${safeText(githubStatus || 'unknown', 40)}", which is neither a pass nor a failure`);
  }

  const refusal = refRefusal(env);
  if (refusal) return quiet(refusal);

  const startedAt = new Date(args.started || Date.now());
  const startedMs = Number.isNaN(startedAt.getTime()) ? Date.now() : startedAt.getTime();
  const result = buildResult(
    {
      checkKey: args.check,
      status,
      startedAt: new Date(startedMs).toISOString(),
      durationMs: Math.max(0, Date.now() - startedMs),
      steps: [],
      failedStep: args['failed-step'] || null,
      error:
        status === 'fail'
          ? args.error || 'The workflow run failed. Open the run to see which step stopped it.'
          : null,
    },
    env,
  );
  return sendResult(result, { env, fetchImpl, log });
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

/**
 * `--scrub-stdin`: copy standard input to standard output, one line at a time,
 * through `scrub`.
 *
 * The public monitor repository pipes every probe's output through this,
 * because a public repository's run logs are readable by anyone, and a probe's
 * failure message quotes response bodies. GitHub masks the values of secrets it
 * was given; it knows nothing about a client secret in a response body. Each
 * line is flushed as it arrives so a slow step still shows progress.
 */
export async function scrubStream(input, output, secrets = []) {
  const { createInterface } = await import('node:readline');
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) output.write(`${scrub(line, secrets)}\n`);
}

if (invokedDirectly()) {
  try {
    if (process.argv.includes('--scrub-stdin')) {
      await scrubStream(process.stdin, process.stdout, [process.env.PROBE_API_KEY]);
    } else {
      await runCli(process.argv.slice(2));
    }
  } catch (error) {
    console.log(`reliability report not sent: ${error?.name || 'unexpected error'}.`);
  }
  // Always 0. A reporting problem is never a reason to fail a job.
  process.exit(0);
}
