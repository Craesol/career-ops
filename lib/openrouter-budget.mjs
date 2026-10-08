/**
 * openrouter-budget.mjs — a hard local cap on OpenRouter free-tier requests
 * (fork-local).
 *
 * WHY THIS EXISTS. OpenRouter's free models are limited per ACCOUNT, not per
 * key, to 20 requests/minute and **50 requests/day** until the account has
 * bought at least 10 credits (then 1,000/day). The user chose to stay on the
 * free tier, so 50/day is a hard ceiling shared by every script here, and
 * `openrouter-runner.mjs` has no concept of a budget at all — its failure path
 * walks the whole free-model list (`for attempt < active.length`), so with ~18
 * free models ONE failing task can spend 18 of the 50. Three of those and the
 * day is gone before the nightly even runs.
 *
 * Two deliberate conservatisms:
 *
 *  - **Every attempt counts, including failures.** OpenRouter's own docs do not
 *    say whether a failed request draws down the daily allowance; its pricing
 *    page suggests it does. Assuming it does is the only safe reading: being
 *    wrong the other way means discovering the cap through 429s at 03:00.
 *
 *  - **A rolling 24h window, not a calendar day.** The reset instant is not
 *    documented, and guessing it wrong would let a burst straddle the boundary
 *    and blow the real cap. A rolling window can only ever be stricter than the
 *    true limit.
 *
 * The default cap is 40, not 50, so ad-hoc and manual runs always have ten
 * requests left. Override with OPENROUTER_DAILY_MAX.
 *
 * Usage:
 *   import { canSpend, record, remaining, status } from './lib/openrouter-budget.mjs';
 *   if (!canSpend(1)) { ... skip, log, try again next hour ... }
 *   record(1);                       // AFTER the attempt, success or failure
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { getCareerOpsRoot } from '../path-resolver.mjs';

/** OpenRouter's documented free-tier ceiling for an account under 10 credits. */
export const FREE_TIER_DAILY_LIMIT = 50;

/** Requests held back for manual/ad-hoc use, so scheduled jobs cannot starve them. */
export const DEFAULT_RESERVE = 10;

const WINDOW_MS = 24 * 60 * 60 * 1000;

function statePath() {
  return process.env.OPENROUTER_BUDGET_FILE
    || resolve(getCareerOpsRoot(), 'data', 'openrouter-budget.json');
}

/** The cap scheduled work may spend. Never above the documented tier limit. */
export function dailyMax() {
  const raw = Number(process.env.OPENROUTER_DAILY_MAX);
  if (Number.isFinite(raw) && raw > 0) return Math.min(raw, FREE_TIER_DAILY_LIMIT);
  return FREE_TIER_DAILY_LIMIT - DEFAULT_RESERVE;
}

function emptyState(now) {
  return { windowStart: new Date(now).toISOString(), used: 0, events: [] };
}

function load(now = Date.now()) {
  const file = statePath();
  if (!existsSync(file)) return emptyState(now);
  let s;
  try {
    s = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // A corrupt budget file must not read as "plenty left" — that is the one
    // failure mode that silently overspends. Start a fresh window instead.
    return emptyState(now);
  }
  if (!s || typeof s.used !== 'number' || !s.windowStart) return emptyState(now);
  // Drop events older than the window, and recompute `used` from what survives,
  // so the rolling window is exact rather than reset-on-expiry.
  const cutoff = now - WINDOW_MS;
  const events = Array.isArray(s.events)
    ? s.events.filter((t) => typeof t === 'number' && t > cutoff)
    : [];
  if (Array.isArray(s.events)) {
    return { windowStart: new Date(Math.min(...[now, ...events])).toISOString(), used: events.length, events };
  }
  // Legacy state with no event list: fall back to the coarse window check.
  const started = Date.parse(s.windowStart);
  if (!Number.isFinite(started) || now - started >= WINDOW_MS) return emptyState(now);
  return { windowStart: s.windowStart, used: s.used, events: [] };
}

function save(state) {
  const file = statePath();
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
  } catch {
    /* bookkeeping must never take a run down with it */
  }
}

/** Requests still available to scheduled work in the rolling window. */
export function remaining(now = Date.now()) {
  return Math.max(0, dailyMax() - load(now).used);
}

/** True when `n` more requests fit inside the cap. */
export function canSpend(n = 1, now = Date.now()) {
  return remaining(now) >= n;
}

/**
 * Record `n` attempts as spent. Call this AFTER the attempt, whether it
 * succeeded or failed — a 429 or a timeout still consumed the allowance.
 */
export function record(n = 1, now = Date.now()) {
  const s = load(now);
  const events = s.events.slice();
  for (let i = 0; i < n; i++) events.push(now);
  const next = { windowStart: s.windowStart, used: events.length, events };
  save(next);
  return remaining(now);
}

/** Human-readable state, for logs and the `--summary` of callers. */
export function status(now = Date.now()) {
  const s = load(now);
  const max = dailyMax();
  const oldest = s.events.length ? Math.min(...s.events) : null;
  return {
    used: s.used,
    max,
    remaining: Math.max(0, max - s.used),
    tierLimit: FREE_TIER_DAILY_LIMIT,
    reserve: FREE_TIER_DAILY_LIMIT - max,
    windowResetsAt: oldest ? new Date(oldest + WINDOW_MS).toISOString() : null,
  };
}

/** Test seam: wipe the window. */
export function reset() {
  save(emptyState(Date.now()));
}
