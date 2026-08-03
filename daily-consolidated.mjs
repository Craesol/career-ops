#!/usr/bin/env node
/**
 * daily-consolidated.mjs — single 11:31 AM email that consolidates:
 *   1. LinkedIn Alerts Parser (IMAP → pipeline.md)
 *   2. daily-ats-scan.mjs (--no-email flag; writes to scan-history.tsv + pipeline.md)
 *   3. Optional L3 WebSearch (requires Claude CLI headless — skipped in cron by default)
 *
 * At the end, reads today's `added` entries from scan-history.tsv, re-hits each ATS
 * for publish-date + location metadata, and sends ONE email with:
 *   - Executive summary (LinkedIn alerts count, L2 hits count, L3 hits count if run)
 *   - Full table with Age + Company + Role + Location + Source + Link
 *   - Recent tracker activity (rejections/applies in last 48h)
 *
 * Env:
 *   RESEND_API_KEY, RESEND_FROM, NOTIFY_EMAIL — required
 *   MAX_AGE_DAYS (default 14) — age filter for daily-ats-scan.mjs
 *   INCLUDE_L3 (default false) — set to 'true' to spawn L3 (requires claude CLI + auth)
 *
 * Usage:
 *   node daily-consolidated.mjs
 *
 * Windows Task Scheduler cron: 11:31 AM daily
 */
import 'dotenv/config';
import { readFileSync, appendFileSync, existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM || 'career-ops <onboarding@resend.dev>';
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL;
const MAX_AGE_DAYS = parseInt(process.env.MAX_AGE_DAYS || '14', 10);
const INCLUDE_L3 = (process.env.INCLUDE_L3 || 'false') === 'true';

if (!RESEND_API_KEY || !NOTIFY_EMAIL) {
  console.error('Missing RESEND_API_KEY or NOTIFY_EMAIL in .env');
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);
const NOW_TS = Date.now();

console.log('=== career-ops daily consolidated · ' + today + ' ===\n');

// --- STEP 1: LinkedIn Alerts Parser -----------------------------------
const linkedinBefore = countAddedToday();
console.log('[step 1] LinkedIn Alerts Parser');
const laResult = spawnSync('node', [resolve(ROOT, 'linkedin-alerts-parser.mjs')], {
  cwd: ROOT, encoding: 'utf-8', shell: false, timeout: 300000,
});
if (laResult.status === 0) {
  const laLines = (laResult.stdout || '').trim().split('\n').slice(-3).join(' | ');
  console.log('  ok · ' + laLines);
} else {
  console.error('  FAIL (exit ' + laResult.status + '): ' + (laResult.stderr || 'unknown').slice(0, 400));
}
const linkedinAdded = countAddedToday() - linkedinBefore;

// --- STEP 2: daily-ats-scan.mjs with --no-email ------------------------
const l2Before = countAddedToday();
console.log('\n[step 2] daily-ats-scan.mjs (--no-email, MAX_AGE_DAYS=' + MAX_AGE_DAYS + ')');
const l2Result = spawnSync('node', [resolve(ROOT, 'daily-ats-scan.mjs'), '--no-email'], {
  cwd: ROOT, encoding: 'utf-8', shell: false, timeout: 600000,
  env: { ...process.env, MAX_AGE_DAYS: String(MAX_AGE_DAYS) },
});
if (l2Result.status === 0) {
  const l2Tail = (l2Result.stdout || '').trim().split('\n').slice(-4).join(' | ');
  console.log('  ok · ' + l2Tail);
} else {
  console.error('  FAIL (exit ' + l2Result.status + '): ' + (l2Result.stderr || 'unknown').slice(0, 400));
}
let l2Added = countAddedToday() - l2Before;

// --- STEP 2b: full free scan — ATS providers + job_boards from portals.yml ---
// (added 2026-07-26: daily-ats-scan.mjs has its own hardcoded endpoint list and
// never exercises the provider layer, so the job_boards section — Himalayas,
// WeWorkRemotely, GetOnBoard, etc. — only ran on manual scans before this step.)
console.log('\n[step 2b] scan.mjs (providers + job boards)');
const sbBefore = countAddedToday();
const sbResult = spawnSync('node', [resolve(ROOT, 'scan.mjs')], {
  cwd: ROOT, encoding: 'utf-8', shell: false, timeout: 600000,
});
if (sbResult.status === 0) {
  console.log('  ok');
} else {
  console.error('  FAIL (exit ' + sbResult.status + '): ' + (sbResult.stderr || 'unknown').slice(0, 300));
}
l2Added += countAddedToday() - sbBefore;

// --- STEP 3: Optional L3 WebSearch sweep --------------------------------
// PROPOSER / WRITER SPLIT (2026-07-26): the CLI only SEARCHES and emits
// <<offer:{...}>> envelopes on stdout; THIS script parses them, dedups against
// scan-history and persists via the canonical writers. That keeps the step
// CLI-agnostic — Antigravity (free tier) sandboxes its file writes to
// ~/.gemini/antigravity-cli/scratch, so a CLI that "writes the file itself"
// silently persisted nothing. Queries are inlined too, so the CLI needs no
// project read access either.
//   L3_CLI=claude (default) | agy | gemini | qwen
// Antigravity (agy) was evaluated 2026-07-26 and is NOT usable here: its headless
// web search returns prose summaries without per-posting URLs, and any real tool
// use is auto-denied unless the whole run is --dangerously-skip-permissions
// (all-or-nothing shell access in an unattended job). Kept selectable for manual
// runs; the daily sweep stays on claude.
let l3Added = 0;
if (INCLUDE_L3) {
  const L3_CLI = process.env.L3_CLI || 'claude';
  console.log('\n[step 3] L3 WebSearch (via ' + L3_CLI + ' headless)');
  const l3Before = countAddedToday();

  const CLI_PATHS = {
    agy: resolve(process.env.LOCALAPPDATA || '', 'agy', 'bin', 'agy.exe'),
    claude: resolve(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
  };
  const exe = CLI_PATHS[L3_CLI];
  const useExe = exe && existsSync(exe);

  // Inline the enabled queries — no file access needed on the CLI side.
  let queries = [];
  try {
    const y = readFileSync(resolve(ROOT, 'portals.yml'), 'utf-8');
    const blocks = y.split(/\n\s*-\s+name:\s*/).slice(1);
    for (const b of blocks) {
      const name = b.split('\n')[0].trim();
      const qm = b.match(/\n\s*query:\s*'([^']+)'/);
      const enabled = !/\n\s*enabled:\s*false/.test(b);
      if (qm && enabled && name) queries.push({ name, query: qm[1] });
    }
  } catch (e) {
    console.error('  portals.yml unreadable: ' + e.message);
  }
  const MAX_Q = parseInt(process.env.L3_MAX_QUERIES || '14', 10);
  queries = queries.slice(0, MAX_Q);

  const L3_PROMPT = [
    'You are a job-posting FINDER running headless. Today is ' + today + '.',
    'Run each web search below (WebSearch/Google). For every plausible job posting you find, emit ONE line, never inside a code fence:',
    '<<offer:{"url":"…","title":"…","company":"…","location":"…","portal":"…"}>>',
    'Rules: valid JSON per line; "portal" is the source label from the query name (e.g. indeed, monster, hitmarker); include the DIRECT posting URL, not a search page; skip aggregator/search-result URLs; no commentary between envelopes is required.',
    'Be broad: community, program, ecosystem, social-media and creator-program roles. Do not judge fit or score anything.',
    'PRIORITIZE REMOTE: the candidate is based on the French Riviera and works remote-first. Emit remote / worldwide / EMEA / Europe-eligible postings first, and skip roles that are onsite-only outside Europe (US, LATAM, APAC, India, Middle East). A remote role anchored to a non-European HQ is fine — say so in "location".',
    '',
    'SEARCHES:',
    ...queries.map((q, i) => (i + 1) + '. [' + q.name + '] ' + q.query),
  ].join('\n');

  const args = L3_CLI === 'claude'
    ? ['-p', L3_PROMPT, '--allowedTools', 'WebSearch,WebFetch', '--disallowedTools', 'Task,Bash,Write,Edit,NotebookEdit']
    : ['-p', L3_PROMPT];
  const l3Result = spawnSync(useExe ? exe : L3_CLI, args, {
    cwd: ROOT, encoding: 'utf-8', shell: !useExe, timeout: 900000, maxBuffer: 20 * 1024 * 1024,
  });

  const out = (l3Result.stdout || '');
  const proposed = [];
  for (const m of out.matchAll(/<<offer:(\{[\s\S]*?\})>>/g)) {
    try {
      const o = JSON.parse(m[1]);
      if (typeof o.url === 'string' && /^https?:\/\//i.test(o.url) && o.title) {
        proposed.push({
          url: o.url.trim(),
          company: String(o.company || '').trim() || '?',
          title: String(o.title || '').trim(),
          location: String(o.location || '').trim(),
          source: 'websearch:' + (String(o.portal || 'l3').toLowerCase().replace(/[^a-z0-9]+/g, '') || 'l3'),
          note: '',
        });
      }
    } catch { /* malformed envelope — skip */ }
  }

  // Dedup against everything the scanner has ever seen, then persist with the
  // canonical writers (same format the CLI and the web produce).
  let known = new Set();
  try {
    known = new Set(readFileSync(resolve(ROOT, 'data/scan-history.tsv'), 'utf-8')
      .split('\n').map(l => l.split('\t')[0]).filter(Boolean));
  } catch { /* first run */ }
  // Apply the SAME title filter the scanners use. Without this the L3 sweep was
  // the one path into the inbox with no role gate at all, so a web search for
  // "community" happily persisted "Blockchain Solutions Architect".
  let titleOk = () => true;
  try {
    const yaml = (await import('js-yaml')).default;
    const cfg = yaml.load(readFileSync(resolve(ROOT, 'portals.yml'), 'utf-8')) || {};
    const { buildTitleFilter } = await import(pathToFileURL(resolve(ROOT, 'scan.mjs')).href);
    titleOk = buildTitleFilter(cfg.title_filter);
  } catch (e) {
    console.error('  title filter unavailable, keeping all: ' + e.message);
  }

  const seenNow = new Set();
  const offRole = proposed.filter(o => !titleOk(o.title)).length;
  const fresh = proposed.filter(o => titleOk(o.title) && !known.has(o.url) && !seenNow.has(o.url) && seenNow.add(o.url));
  if (offRole) console.log('  ' + offRole + ' dropped by title filter');

  // Liveness gate (2026-07-30): L3 finds come from indexed search results, which
  // routinely resurface postings that died long ago — web3.career keeps expired
  // ads published, and a 4-year-old Uniswap role reached the user's inbox that
  // way. Every other path into the email is checked at the source API; this was
  // the one unchecked one. Expired finds are persisted as 'skipped_expired' so
  // dedup blocks them forever; uncertain ones are kept but labelled in the note.
  let liveFresh = fresh;
  let l3Expired = 0;
  if (fresh.length) {
    liveFresh = [];
    const deadFinds = [];
    try {
      const { checkLivenessViaApi } = await import(pathToFileURL(resolve(ROOT, 'liveness-api.mjs')).href);
      const { checkUrlLivenessWithFallback, newLivenessPage } = await import(pathToFileURL(resolve(ROOT, 'liveness-browser.mjs')).href);
      let browser = null, page = null;
      try {
        for (const o of fresh) {
          let verdict = null;
          try {
            const api = await checkLivenessViaApi(o.url);
            if (api) {
              verdict = api;
            } else {
              if (!browser) {
                const { chromium } = await import('playwright');
                browser = await chromium.launch({ headless: true });
                page = await newLivenessPage(browser);
              }
              verdict = await checkUrlLivenessWithFallback(page, o.url, {});
            }
          } catch (e) {
            verdict = { result: 'uncertain', reason: 'liveness check failed: ' + e.message };
          }
          if (verdict.result === 'expired') {
            deadFinds.push(o);
          } else {
            if (verdict.result === 'uncertain') o.note = (o.note ? o.note + ' · ' : '') + 'liveness uncertain';
            liveFresh.push(o);
          }
        }
      } finally {
        if (browser) await browser.close().catch(() => {});
      }
    } catch (e) {
      // Liveness modules unavailable (old checkout, missing Playwright): fail
      // open but say so, rather than silently reverting to unchecked finds.
      console.error('  liveness gate unavailable (' + e.message + ') — L3 finds pass UNCHECKED');
      liveFresh = fresh;
    }
    l3Expired = deadFinds.length;
    if (deadFinds.length) {
      try {
        const { appendToScanHistory } = await import(pathToFileURL(resolve(ROOT, 'scan.mjs')).href);
        appendToScanHistory(deadFinds, today, 'skipped_expired');
      } catch (e) {
        console.error('  dead-find record FAILED: ' + e.message);
      }
    }
  }

  // Source-side stale gate: L3 rediscovers years-old web3.career postings
  // (their URLs carry sequential ids; the nightly 3a2 sweep alone is too late,
  // because whats-new/home shows `added` rows the moment they land). Drop them
  // here, BEFORE anything is written, and record them as skipped so they never
  // resurface via any path.
  let l3Stale = [];
  try {
    const { w3cStaleFilter } = await import(pathToFileURL(resolve(ROOT, 'prune-stale-web3career.mjs')).href);
    const gate = w3cStaleFilter();
    l3Stale = liveFresh.filter(o => gate.isStale(o.url));
    if (l3Stale.length) {
      liveFresh = liveFresh.filter(o => !gate.isStale(o.url));
      console.log('  ' + l3Stale.length + ' dropped as stale web3.career ids (< ' + gate.threshold + ')');
    }
  } catch (e) {
    console.error('  stale-id gate unavailable (' + e.message + ') — L3 finds pass ungated');
  }

  if (liveFresh.length || l3Stale.length) {
    try {
      // pathToFileURL: Windows' ESM loader rejects bare absolute paths
      // ("Only URLs with a scheme in: file, data…"), which silently swallowed
      // every L3 find before this fix.
      const { appendToPipeline, appendToScanHistory } = await import(pathToFileURL(resolve(ROOT, 'scan.mjs')).href);
      if (liveFresh.length) {
        appendToPipeline(liveFresh);
        appendToScanHistory(liveFresh, today, 'added');
      }
      if (l3Stale.length) appendToScanHistory(l3Stale, today, 'skipped');
    } catch (e) {
      console.error('  persist FAILED: ' + e.message);
    }
  }
  console.log('  ' + queries.length + ' queries · ' + proposed.length + ' proposed · ' + fresh.length + ' new · ' + l3Expired + ' dropped dead');
  if (l3Result.status !== 0) {
    console.error('  CLI exit ' + l3Result.status + ': ' + (l3Result.stderr || 'unknown').slice(0, 300));
  }
  l3Added = countAddedToday() - l3Before;
} else {
  console.log('\n[step 3] L3 WebSearch — skipped (set INCLUDE_L3=true to enable)');
}

// --- STEP 3b: prune postings that died since we found them ---------------
// Job ads expire fast: a one-off audit found 80% of the ATS-checkable inbox
// already gone. Pruning daily (zero tokens, ATS JSON API) keeps the inbox
// something the user can trust instead of a graveyard.
// --- STEP 3a2: prune ancient web3.career postings by posting id ----------
// Dateless sources (L3 websearch) rediscover years-old listings; the id
// sequence is the only recency signal those URLs carry. See the script header.
console.log('\n[step 3a2] prune stale web3.career ids');
const w3cResult = spawnSync('node', [resolve(ROOT, 'prune-stale-web3career.mjs')], {
  cwd: ROOT, encoding: 'utf-8', shell: false, timeout: 120000,
});
console.log('  ' + ((w3cResult.stdout || '').trim().split('\n').pop() || ('exit ' + w3cResult.status)));

console.log('\n[step 3b] prune dead postings');
const pruneResult = spawnSync('node', [resolve(ROOT, 'prune-dead.mjs'), '--apply', '--limit', '120'], {
  cwd: ROOT, encoding: 'utf-8', shell: false, timeout: 600000,
});
if (pruneResult.status === 0) {
  const last = (pruneResult.stdout || '').trim().split('\n').filter(l => /checked|closed/.test(l)).slice(-2).join(' · ');
  console.log('  ' + (last || 'ok'));
} else {
  console.error('  FAIL (exit ' + pruneResult.status + '): ' + (pruneResult.stderr || 'unknown').slice(0, 200));
}

// --- STEP 4: Build consolidated email -----------------------------------
console.log('\n[step 4] Building consolidated email');
const todayAdded = todayAddedRows();
console.log('  Total added today: ' + todayAdded.length + ' (LinkedIn=' + linkedinAdded + ', L2=' + l2Added + ', L3=' + l3Added + ')');

// Enrich with age + location via canonical API where possible (best-effort)
// Group by source for tabular display
const linkedinRows = todayAdded.filter(r => (r.portal || '').startsWith('[linkedin-alert:'));
const apiRows = todayAdded.filter(r => (r.portal || '').startsWith('[API:'));
const feedRows = todayAdded.filter(r => (r.portal || '').startsWith('[FEED:'));
const l3Rows = todayAdded.filter(r => (r.portal || '').replace(/^\[/, '').startsWith('websearch:') || (r.portal || '').startsWith('[L3-'));
const otherRows = todayAdded.filter(r => !linkedinRows.includes(r) && !apiRows.includes(r) && !feedRows.includes(r) && !l3Rows.includes(r));

// Recent tracker activity (48h)
const trackerRecent = readRecentTracker(2);

const subject = 'career-ops · ' + today + ' · ' + todayAdded.length + ' new roles (LinkedIn ' + linkedinRows.length + ' + ATS ' + apiRows.length + ' + feeds ' + feedRows.length + (l3Rows.length ? ' + L3 ' + l3Rows.length : '') + ')';

const html = buildEmailHtml({
  today, todayAdded, linkedinRows, apiRows, feedRows, l3Rows, otherRows,
  linkedinAdded, l2Added, l3Added, MAX_AGE_DAYS, trackerRecent, INCLUDE_L3
});

const res = await fetch('https://api.resend.com/emails', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({ from: RESEND_FROM, to: [NOTIFY_EMAIL], subject, html })
});
const respBody = await res.json().catch(() => ({}));
if (!res.ok) { console.error('Resend HTTP ' + res.status + ':', JSON.stringify(respBody)); process.exit(1); }
console.log('\n✓ Email sent to ' + NOTIFY_EMAIL);
console.log('  ID: ' + (respBody.id || '(no id)'));
console.log('  Subject: ' + subject);


// ==================== helpers =========================================
function isAddedToday(l) {
  // Column-based check: rows may carry trailing location/extra columns after
  // the status (the canonical appendToScanHistory writes them), so a bare
  // endsWith('\tadded') silently misses them. cols: url, first_seen, portal,
  // title, company, status, [location, ...]
  if (!l.includes('\t' + today + '\t')) return false;
  const cols = l.split('\t');
  return (cols[5] || '').trim() === 'added';
}
function countAddedToday() {
  try {
    const c = readFileSync(resolve(ROOT, 'data/scan-history.tsv'), 'utf-8');
    return c.split('\n').filter(isAddedToday).length;
  } catch { return 0; }
}
function todayAddedRows() {
  try {
    const c = readFileSync(resolve(ROOT, 'data/scan-history.tsv'), 'utf-8');
    const lines = c.split('\n');
    // Email ⊆ web invariant: a URL the user removed (web Remove writes an
    // append-only `skipped` row) or the prune step killed (`skipped_expired`)
    // must not resurface in the digest — the web hides it, so the email must
    // too, regardless of row order.
    const dismissed = new Set();
    for (const l of lines) {
      const cols = l.split('\t');
      if (cols[0] && /^(skipped|skipped_expired|expired)$/.test((cols[5] || '').trim())) dismissed.add(cols[0]);
    }
    return lines
      .filter(isAddedToday)
      .filter(l => !dismissed.has(l.split('\t')[0]))
      .map(l => {
        const [url, date, portal, title, company] = l.split('\t');
        return { url, date, portal, title, company };
      });
  } catch { return []; }
}
function readRecentTracker(days) {
  try {
    const c = readFileSync(resolve(ROOT, 'data/applications.md'), 'utf-8');
    const cutoff = new Date(NOW_TS - days*24*60*60*1000).toISOString().slice(0,10);
    return c.split('\n')
      .filter(l => /^\| \d+ \|/.test(l))
      .map(l => {
        const cells = l.split('|').map(c => c.trim());
        return { num: cells[1], date: cells[2], company: cells[3], role: cells[4], score: cells[5], status: cells[6], notes: cells[9] };
      })
      .filter(r => r.date >= cutoff);
  } catch { return []; }
}
function esc(s){return(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function locLabel(loc) {
  if (!loc) return '<span style="color:#999;font-style:italic;">(blank)</span>';
  const l = loc.toLowerCase();
  const isRemote = /remote|worldwide|anywhere|emea|europe/i.test(l);
  const isEU = /france|spain|germany|italy|portugal|netherlands|belgium|austria|switzerland|sweden|denmark|ireland|poland|barcelona|madrid|paris|berlin|amsterdam|london|dublin|stockholm/i.test(l);
  const isNonEU = /tokyo|shanghai|singapore|hong kong|seoul|san francisco|los angeles|new york|toronto|mumbai|bangalore|dubai|sydney|mexico city/i.test(l);
  if (isRemote) return '<span style="color:#15803d;font-weight:600;">' + esc(loc) + '</span>';
  if (isNonEU) return '<span style="color:#b91c1c;">' + esc(loc) + '</span>';
  if (isEU) return '<span style="color:#2563eb;">' + esc(loc) + '</span>';
  return '<span style="color:#666;">' + esc(loc) + '</span>';
}
function row(r) {
  return '<tr>' +
    '<td style="padding:6px 10px;border-bottom:1px solid #eee;font-weight:600;">' + esc(r.company) + '</td>' +
    '<td style="padding:6px 10px;border-bottom:1px solid #eee;">' + esc(r.title) + '</td>' +
    '<td style="padding:6px 10px;border-bottom:1px solid #eee;font-size:10.5px;">' + locLabel(r.location || '') + '</td>' +
    '<td style="padding:6px 10px;border-bottom:1px solid #eee;color:#999;font-size:10.5px;">' + esc(r.portal) + '</td>' +
    '<td style="padding:6px 10px;border-bottom:1px solid #eee;"><a href="' + r.url + '" style="color:#2563eb;text-decoration:none;">View</a></td>' +
  '</tr>';
}
function tbl(rows) {
  return '<table style="width:100%;border-collapse:collapse;margin-top:8px;">' +
    '<thead><tr style="background:#f3f4f6;">' +
    '<th style="padding:8px 10px;text-align:left;font-size:10px;text-transform:uppercase;color:#666;">Company</th>' +
    '<th style="padding:8px 10px;text-align:left;font-size:10px;text-transform:uppercase;color:#666;">Role</th>' +
    '<th style="padding:8px 10px;text-align:left;font-size:10px;text-transform:uppercase;color:#666;">Location</th>' +
    '<th style="padding:8px 10px;text-align:left;font-size:10px;text-transform:uppercase;color:#666;">Source</th>' +
    '<th style="padding:8px 10px;text-align:left;font-size:10px;text-transform:uppercase;color:#666;">Link</th>' +
    '</tr></thead><tbody>' + rows.map(row).join('') + '</tbody></table>';
}
function trackerRow(r) {
  const statusColor = /rejected/i.test(r.status) ? '#b91c1c' : /applied/i.test(r.status) ? '#15803d' : '#374151';
  return '<tr>' +
    '<td style="padding:6px 10px;border-bottom:1px solid #eee;color:#999;font-size:10.5px;">' + esc(r.date) + '</td>' +
    '<td style="padding:6px 10px;border-bottom:1px solid #eee;color:#999;font-size:10.5px;">№' + esc(r.num) + '</td>' +
    '<td style="padding:6px 10px;border-bottom:1px solid #eee;font-weight:600;">' + esc(r.company) + '</td>' +
    '<td style="padding:6px 10px;border-bottom:1px solid #eee;">' + esc(r.role) + '</td>' +
    '<td style="padding:6px 10px;border-bottom:1px solid #eee;color:' + statusColor + ';font-weight:600;">' + esc(r.status) + '</td>' +
    '<td style="padding:6px 10px;border-bottom:1px solid #eee;color:#666;font-size:10.5px;">' + esc(r.score) + '</td>' +
  '</tr>';
}
function trackerTbl(rows) {
  return '<table style="width:100%;border-collapse:collapse;margin-top:8px;">' +
    '<thead><tr style="background:#f3f4f6;">' +
    '<th style="padding:8px 10px;text-align:left;font-size:10px;text-transform:uppercase;color:#666;">Date</th>' +
    '<th style="padding:8px 10px;text-align:left;font-size:10px;text-transform:uppercase;color:#666;">#</th>' +
    '<th style="padding:8px 10px;text-align:left;font-size:10px;text-transform:uppercase;color:#666;">Company</th>' +
    '<th style="padding:8px 10px;text-align:left;font-size:10px;text-transform:uppercase;color:#666;">Role</th>' +
    '<th style="padding:8px 10px;text-align:left;font-size:10px;text-transform:uppercase;color:#666;">Status</th>' +
    '<th style="padding:8px 10px;text-align:left;font-size:10px;text-transform:uppercase;color:#666;">Score</th>' +
    '</tr></thead><tbody>' + rows.map(trackerRow).join('') + '</tbody></table>';
}
function buildEmailHtml(ctx) {
  const { today, todayAdded, linkedinRows, apiRows, feedRows, l3Rows, otherRows, linkedinAdded, l2Added, l3Added, MAX_AGE_DAYS, trackerRecent, INCLUDE_L3 } = ctx;
  let body = '<h2 style="margin-bottom:6px;">career-ops · daily consolidated · ' + today + '</h2>' +
    '<p style="color:#666;margin-top:0;">One consolidated brief. Age filter: ≤ ' + MAX_AGE_DAYS + ' days (postings older than that skipped by scanner where publish date is available).</p>' +
    '<div style="background:#f9fafb;border-left:3px solid hsl(187,74%,32%);padding:12px 16px;margin:16px 0;">' +
    '<strong>Today added: ' + todayAdded.length + ' new roles</strong><br>' +
    '&#8226; LinkedIn Alerts (IMAP): ' + linkedinRows.length + '<br>' +
    '&#8226; Direct ATS APIs: ' + apiRows.length + '<br>' +
    '&#8226; Public feeds (RemoteOK/Remotive/LinkedIn feed/HN/web3.career/JobMonaco/Emploi-Monaco): ' + feedRows.length + '<br>' +
    '&#8226; L3 WebSearch: ' + (INCLUDE_L3 ? l3Rows.length : 'skipped (INCLUDE_L3=false)') + '<br>' +
    '</div>' +
    '<p style="color:#666;font-size:11.5px;"><strong>Legend</strong> — <span style="color:#15803d;">Remote/EMEA/EU-city</span> · <span style="color:#2563eb;">EU country/city</span> · <span style="color:#b91c1c;">Non-EU city (US/Asia/etc.)</span> · <span style="color:#999;">(blank/unknown)</span></p>';

  if (linkedinRows.length > 0) body += '<h3 style="margin-top:24px;color:#111;font-size:15px;">LinkedIn Alerts (' + linkedinRows.length + ')</h3>' + tbl(linkedinRows);
  if (apiRows.length > 0) body += '<h3 style="margin-top:24px;color:#111;font-size:15px;">Direct ATS APIs (' + apiRows.length + ')</h3>' + tbl(apiRows);
  if (feedRows.length > 0) body += '<h3 style="margin-top:24px;color:#111;font-size:15px;">Public feeds (' + feedRows.length + ')</h3>' + tbl(feedRows);
  if (l3Rows.length > 0) body += '<h3 style="margin-top:24px;color:#111;font-size:15px;">L3 WebSearch (' + l3Rows.length + ')</h3>' + tbl(l3Rows);
  if (otherRows.length > 0) body += '<h3 style="margin-top:24px;color:#111;font-size:15px;">Other sources (' + otherRows.length + ')</h3>' + tbl(otherRows);

  if (todayAdded.length === 0) {
    body += '<p style="color:#666;">No new roles today. Filters converged, or public feeds are quiet. Try tightening MAX_AGE_DAYS or check portals.yml for new search queries.</p>';
  }

  if (trackerRecent.length > 0) {
    body += '<h3 style="margin-top:32px;color:#111;font-size:15px;">Tracker activity (last 48h) — ' + trackerRecent.length + '</h3>' + trackerTbl(trackerRecent);
  }

  body += '<p style="margin-top:24px;font-size:12px;color:#999;">career-ops daily consolidated · ' + new Date().toISOString() + '</p>';
  return '<!DOCTYPE html><html><body style="font-family:-apple-system,Segoe UI,sans-serif;color:#111;max-width:1100px;margin:0 auto;padding:24px;">' + body + '</body></html>';
}
