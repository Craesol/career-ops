#!/usr/bin/env node
// gemini-l3.mjs — the FREE twin of the Claude L3 deep scan (user request
// 2026-09-10: "usar los tokens gratuitos para potenciar la búsqueda").
//
// Runs the same portals.yml search_queries through the Gemini API with Google
// Search grounding (free-tier quota, key in .env), asks for the same
// <<offer:{...}>> envelope contract, and persists through the SAME canonical
// writer (l3-writer.mjs) — identical gates, identical dedup, identical
// freshness policy. Two engines, one pipeline; Google's index also surfaces
// postings Claude's WebSearch misses.
//
// One grounded generateContent call PER query (focused grounding, isolated
// failures), throttled. Free-tier quota errors (429) count the query as
// failed; if EVERY query fails the script exits 2 so l3-hourly.mjs can fail
// over to the Claude engine.
//
// Env knobs:
//   GEMINI_API_KEY          (required — .env or environment)
//   GEMINI_L3_MODEL         (default gemini-3.6-flash)
//   GEMINI_L3_MAX_QUERIES   (default 0 = all enabled queries)
//   GEMINI_L3_GAP_MS        (default 3500 between calls)
//
// Exit codes: 0 ran (even with 0 finds) · 2 engine failure (no key / all
// queries failed) — the failover signal.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import * as yaml from 'js-yaml';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { localToday } from './lib/local-today.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const ROOT = getCareerOpsRoot();

function loadApiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  const envPath = resolve(ROOT, '.env');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = /^GEMINI_API_KEY\s*=\s*(.+)$/.exec(line.trim());
      if (m) return m[1].trim().replace(/^["']|["']$/g, '');
    }
  }
  return '';
}

function loadQueries() {
  const cfg = yaml.load(readFileSync(resolve(ROOT, 'portals.yml'), 'utf8'));
  const out = [];
  for (const q of Array.isArray(cfg?.search_queries) ? cfg.search_queries : []) {
    if (q && typeof q.name === 'string' && typeof q.query === 'string' && q.enabled !== false) {
      out.push({ name: q.name.trim(), query: q.query.replace(/\s+/g, ' ').trim() });
    }
  }
  return out;
}

// Same proposer contract as the Claude L3 paths (route + nightly), one query
// per call so the grounding stays focused.
function buildPrompt(q, today) {
  return [
    'You are a job-posting FINDER. Today is ' + today + '.',
    'Run this web search and inspect the results. For every plausible job posting you find, emit ONE line, never inside a code fence:',
    '<<offer:{"url":"…","title":"…","company":"…","location":"…","portal":"' + q.name.toLowerCase().replace(/[^a-z0-9]+/g, '') + '"}>>',
    'Rules: valid JSON per line; include the DIRECT posting URL, not a search page or aggregator listing page; no commentary is required.',
    'Be broad: community, program, ecosystem, social-media and creator-program roles. Do not judge fit or score anything.',
    'PRIORITIZE REMOTE: the candidate is based on the French Riviera and works remote-first. Emit remote / worldwide / EMEA / Europe-eligible postings first, and skip roles that are onsite-only outside Europe. A remote role anchored to a non-European HQ is fine — say so in "location".',
    'FRESHNESS IS MANDATORY: search indexes keep dead job pages for years. Skip any result whose snippet or page shows a posting date older than ~45 days. NEVER emit a linkedin.com/jobs/view/ URL whose numeric job id is below 4300000000 — those are years-old dead pages.',
    '',
    'SEARCH: ' + q.query,
  ].join('\n');
}

async function groundedCall(apiKey, model, prompt) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 90_000);
  let res;
  try {
    res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.6, maxOutputTokens: 4096 },
      }),
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 300);
    const err = new Error('HTTP ' + res.status + ': ' + body);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.map((p) => p?.text || '').join('\n');
}

function parseEnvelopes(text, queryName) {
  const out = [];
  for (const m of String(text).matchAll(/<<offer:(\{[\s\S]*?\})>>/g)) {
    try {
      const o = JSON.parse(m[1]);
      if (typeof o.url === 'string' && /^https?:\/\//i.test(o.url) && o.title) {
        out.push({
          url: o.url.trim(),
          company: String(o.company || '').trim() || '?',
          title: String(o.title || '').trim(),
          location: String(o.location || '').trim(),
          source: 'websearch:' + (String(o.portal || queryName).toLowerCase().replace(/[^a-z0-9]+/g, '') || 'l3'),
          note: '',
        });
      }
    } catch {
      /* malformed envelope */
    }
  }
  return out;
}

function runWriter(proposed) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [resolve(ROOT, 'l3-writer.mjs')], { cwd: ROOT, env: process.env });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('close', (code) => {
      let parsed = null;
      const s = out.indexOf('{');
      const e = out.lastIndexOf('}');
      if (s >= 0 && e > s) {
        try { parsed = JSON.parse(out.slice(s, e + 1)); } catch { /* below */ }
      }
      resolvePromise(parsed || { added: 0, error: 'writer exit ' + code + ': ' + (err || out).slice(-200) });
    });
    child.on('error', (e) => resolvePromise({ added: 0, error: 'writer spawn: ' + e.message }));
    child.stdin.write(JSON.stringify(proposed));
    child.stdin.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runGeminiL3() {
  const apiKey = loadApiKey();
  if (!apiKey) {
    console.error('gemini-l3: no GEMINI_API_KEY (env or .env)');
    return { engine: 'gemini', ok: false, reason: 'no api key' };
  }
  const model = process.env.GEMINI_L3_MODEL || 'gemini-3.6-flash';
  const cap = parseInt(process.env.GEMINI_L3_MAX_QUERIES || '0', 10);
  const gap = parseInt(process.env.GEMINI_L3_GAP_MS || '3500', 10);
  const today = localToday();

  let queries = loadQueries();
  if (!queries.length) {
    console.error('gemini-l3: no enabled search_queries in portals.yml');
    return { engine: 'gemini', ok: false, reason: 'no queries' };
  }
  if (cap > 0) queries = queries.slice(0, cap);

  console.log('gemini-l3: ' + queries.length + ' queries · model ' + model);
  const proposed = [];
  const seen = new Set();
  let failed = 0;
  let attempted = 0;
  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    attempted++;
    try {
      const text = await groundedCall(apiKey, model, buildPrompt(q, today));
      const found = parseEnvelopes(text, q.name);
      for (const o of found) {
        if (!seen.has(o.url)) { seen.add(o.url); proposed.push(o); }
      }
      console.log('  [' + (i + 1) + '/' + queries.length + '] ' + q.name + ' → ' + found.length);
    } catch (e) {
      failed++;
      console.error('  [' + (i + 1) + '/' + queries.length + '] ' + q.name + ' FAILED: ' + String(e.message).slice(0, 160));
      // A quota error mid-run means the rest will fail too — stop burning calls.
      if (e.status === 429 && failed >= 2) {
        console.error('  quota exhausted — stopping early');
        break;
      }
    }
    if (i < queries.length - 1) await sleep(gap);
  }

  // Engine-unusable = nothing proposed and every ATTEMPTED query failed —
  // covers the early-stop path too (the 2026-09-10 test: 2 quota failures out
  // of 4 planned read as "ok" and skipped the Claude failover).
  if (proposed.length === 0 && failed > 0 && failed === attempted) {
    console.error('gemini-l3: every attempted query failed — engine unusable this run');
    return { engine: 'gemini', ok: false, reason: 'all ' + attempted + ' attempted queries failed', failed };
  }

  const summary = proposed.length ? await runWriter(proposed) : { added: 0, rejected: {}, offers: [], known: [], filtered: [] };
  const line = { kind: 'done', engine: 'gemini', queries: queries.length, queryFailures: failed, proposed: proposed.length, ...summary };
  // Same truncation discipline as the hourly log: keep it greppable.
  const s = JSON.stringify(line);
  console.log(s.length > 400 ? s.slice(0, 400) + ' ...[' + s.length + ' chars total]' : s);
  return { engine: 'gemini', ok: true, proposed: proposed.length, added: summary.added ?? 0, failed };
}

if (isMainModule(import.meta.url)) {
  const r = await runGeminiL3();
  process.exit(r.ok ? 0 : 2);
}
