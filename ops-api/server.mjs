#!/usr/bin/env node
/**
 * ops-api/server.mjs — the phone's door into CAJITA (fork-local, 2026-10-19).
 *
 * WHY A SEPARATE SERVER. The web on :3000 has no login and its /api/run starts
 * Claude with file-edit and shell tools, so it must never face the internet.
 * This server is the ONLY thing meant to be port-forwarded: HTTPS with a pinned
 * self-signed certificate, one bearer token, and a FIXED list of actions — it
 * cannot run anything that is not written below.
 *
 * SECRETS live outside the repo (this fork is public), in %USERPROFILE%\.career-ops-ops
 * (override OPS_DIR): token.txt, cert.pem, key.pem. Nothing here prints them.
 *
 * Routes (all need "Authorization: Bearer <token>"):
 *   GET  /v1/status                      tasks, web, tracker counts, free-model budget
 *   GET  /v1/finds?days=2                recent finds + gate verdict + prescore
 *   GET  /v1/tracker?status=Evaluated    tracker rows (optionally one status)
 *   GET  /v1/logs/<hourly|nightly|ats-full|web|ops>?lines=80
 *   GET  /v1/jobs                        Create-CV jobs started from the phone
 *   POST /v1/actions/scan                run the hourly scan task now
 *   POST /v1/actions/create-cv           {url,title,company} → evaluate-cv worker
 *   POST /v1/actions/set-status          {row,status,note?} → set-status.mjs
 *   POST /v1/actions/dismiss             {url,title,company} → web dismiss
 *   POST /v1/actions/restart-web         stop the :3000 server, relaunch its task
 *
 * Usage: node ops-api/server.mjs   (OPS_PORT, default 8443)
 */
import https from 'node:https';
import { readFileSync, existsSync, appendFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OPS_DIR = process.env.OPS_DIR || join(homedir(), '.career-ops-ops');
const PORT = Number(process.env.OPS_PORT) || 8443;
const WEB = 'http://127.0.0.1:3000';
const LOG = join(ROOT, 'logs', 'ops-api.log');

const USAGE = `Usage: node ops-api/server.mjs

Serves the fixed CAJITA ops API over HTTPS on OPS_PORT (default 8443), reading
token.txt, cert.pem and key.pem from OPS_DIR (default ~/.career-ops-ops).

Options:
  --help, -h   Show this help`;

// ── auth ────────────────────────────────────────────────────────────────────
const TOKEN_HASH = () => createHash('sha256').update(readFileSync(join(OPS_DIR, 'token.txt'), 'utf8').trim()).digest();
const FAIL_WINDOW_MS = 15 * 60_000;
const FAIL_LIMIT = 10;
const failures = new Map(); // ip → [timestamps]

function blocked(ip) {
  const now = Date.now();
  const list = (failures.get(ip) || []).filter((t) => now - t < FAIL_WINDOW_MS);
  failures.set(ip, list);
  return list.length >= FAIL_LIMIT;
}
function authorized(req, tokenHash) {
  const m = /^Bearer\s+(\S+)$/.exec(req.headers.authorization || '');
  if (!m) return false;
  return timingSafeEqual(createHash('sha256').update(m[1]).digest(), tokenHash);
}

// ── helpers ─────────────────────────────────────────────────────────────────
function log(line) {
  try { mkdirSync(dirname(LOG), { recursive: true }); appendFileSync(LOG, new Date().toISOString() + ' ' + line + '\n'); } catch { /* best effort */ }
}
function run(cmd, args, timeout = 60_000) {
  return new Promise((res) => {
    execFile(cmd, args, { cwd: ROOT, timeout, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
      res({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}
function tail(file, lines) {
  if (!existsSync(file)) return [];
  const all = readFileSync(file, 'utf8').split(/\r?\n/);
  return all.slice(-Math.min(Math.max(lines, 1), 500) - 1).filter((l, i, a) => i < a.length - 1 || l);
}
function readBody(req) {
  return new Promise((res, rej) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 16_384) { rej(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return res({});
      try { res(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { rej(new Error('bad json')); }
    });
    req.on('error', rej);
  });
}
const isUrl = (u) => typeof u === 'string' && u.length < 2048 && /^https?:\/\/[^\s]+$/i.test(u);
const str = (s, max = 300) => (typeof s === 'string' ? s.slice(0, max) : '');

// ── data readers ────────────────────────────────────────────────────────────
async function taskInfo(name) {
  const r = await run('schtasks', ['/query', '/tn', name, '/v', '/fo', 'list']);
  if (r.code !== 0) return { name, visible: false };
  const field = (label) => (r.stdout.match(new RegExp('^' + label + ':\\s*(.*)$', 'm')) || [])[1]?.trim() || '';
  return {
    name, visible: true,
    state: field('Scheduled Task State'), status: field('Status'),
    lastRun: field('Last Run Time'), lastResult: field('Last Result'), nextRun: field('Next Run Time'),
  };
}
function trackerRows() {
  const p = join(ROOT, 'data', 'applications.md');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter((l) => /^\|\s*\d+\s*\|/.test(l)).map((l) => {
    const c = l.split('|').map((s) => s.trim());
    return { row: Number(c[1]), date: c[2], company: c[3], role: c[4], score: c[5], status: c[6] };
  });
}
function canonicalStates() {
  const y = readFileSync(join(ROOT, 'templates', 'states.yml'), 'utf8');
  return [...y.matchAll(/^\s+label:\s*"?([A-Za-z]+)"?\s*$/gm)].map((m) => m[1]);
}
function tsvMap(file, keyCol, mapRow) {
  const out = new Map();
  if (!existsSync(file)) return out;
  for (const l of readFileSync(file, 'utf8').split('\n').slice(1)) {
    const c = l.split('\t');
    if (c[keyCol]) out.set(c[keyCol], mapRow(c));
  }
  return out;
}
function recentFinds(days) {
  const hist = join(ROOT, 'data', 'scan-history.tsv');
  if (!existsSync(hist)) return [];
  const since = new Date(Date.now() - (days - 1) * 86_400_000);
  const cutoff = [since.getFullYear(), String(since.getMonth() + 1).padStart(2, '0'), String(since.getDate()).padStart(2, '0')].join('-');
  const lines = readFileSync(hist, 'utf8').split('\n');
  const dismissed = new Set(lines.map((l) => l.split('\t')).filter((c) => /^(skipped|skipped_expired|expired)$/.test((c[5] || '').trim())).map((c) => c[0]));
  const gates = tsvMap(join(ROOT, 'data', 'gate-verdicts.tsv'), 0, (c) => ({ verdict: c[2], gate: c[3], why: c[4] }));
  const pres = tsvMap(join(ROOT, 'data', 'prescores.tsv'), 0, (c) => ({ score: c[2], legitimacy: c[3] }));
  return lines.map((l) => l.split('\t'))
    .filter((c) => /^https?:\/\//.test(c[0] || '') && (c[1] || '') >= cutoff && (c[5] || '').trim() === 'added' && !dismissed.has(c[0]))
    .map((c) => ({ url: c[0], date: c[1], source: c[2], title: c[3], company: c[4], location: (c[6] || '').trim(), gate: gates.get(c[0]) || null, prescore: pres.get(c[0]) || null }))
    .reverse();
}

// ── Create-CV jobs (held server-side, so the phone can disconnect) ───────────
const jobs = new Map();
const MAX_RUNNING = 2;
function newestPdfSince(t) {
  const dir = join(ROOT, 'output');
  if (!existsSync(dir)) return null;
  const pdfs = readdirSync(dir).filter((f) => f.endsWith('.pdf')).map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs })).filter((x) => x.m >= t);
  return pdfs.sort((a, b) => b.m - a.m)[0]?.f || null;
}
async function startCvJob({ url, title, company }) {
  const id = randomUUID();
  const job = { id, url, title, company, status: 'running', startedAt: Date.now(), endedAt: null, last: 'starting', error: null, pdf: null };
  jobs.set(id, job);
  (async () => {
    try {
      const resp = await fetch(WEB + '/api/run', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'evaluate-cv', input: url, cliId: 'claude' }),
      });
      if (!resp.ok || !resp.body) throw new Error('web /api/run HTTP ' + resp.status);
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          let ev; try { ev = JSON.parse(line); } catch { continue; }
          if (ev.type === 'tool') job.last = 'using ' + ev.name;
          else if (ev.type === 'status') job.last = ev.label;
          else if (ev.type === 'error') job.error = ev.msg;
        }
      }
      job.pdf = newestPdfSince(job.startedAt);
      job.status = job.error ? 'error' : 'done';
    } catch (e) {
      job.status = 'error'; job.error = e.message;
    }
    job.endedAt = Date.now();
    log('job ' + id + ' ' + job.status + ' pdf=' + (job.pdf || '-'));
  })();
  return job;
}

// ── web restart ─────────────────────────────────────────────────────────────
async function restartWeb() {
  const ns = await run('netstat', ['-ano', '-p', 'TCP']);
  const line = ns.stdout.split('\n').find((l) => /:3000\s+\S+\s+LISTENING/i.test(l));
  const pid = line ? Number(line.trim().split(/\s+/).pop()) : null;
  if (pid) { try { process.kill(pid); } catch (e) { return { ok: false, error: 'could not stop pid ' + pid + ': ' + e.message }; } }
  await new Promise((r) => setTimeout(r, 1500));
  const r = await run('schtasks', ['/run', '/tn', 'career-ops-web']);
  return { ok: r.code === 0, stoppedPid: pid, relaunched: r.code === 0 };
}

// ── routing ─────────────────────────────────────────────────────────────────
const LOGS = {
  hourly: join(ROOT, 'logs', 'hourly-scan.log'),
  nightly: join(ROOT, 'logs', 'daily-consolidated.log'),
  'ats-full': join(ROOT, 'logs', 'ats-full.log'),
  web: join(homedir(), 'web-server.log'),
  ops: LOG,
};

async function handle(req, url) {
  const p = url.pathname;
  if (req.method === 'GET' && p === '/v1/status') {
    const tasks = await Promise.all(['career-ops-daily-consolidated', 'career-ops-hourly-scan', 'career-ops-web', 'career-ops-ats-full'].map(taskInfo));
    let web = false;
    try { web = (await fetch(WEB + '/api/version', { signal: AbortSignal.timeout(5000) })).ok; } catch { /* down */ }
    const counts = {};
    for (const r of trackerRows()) counts[r.status] = (counts[r.status] || 0) + 1;
    let budget = null;
    try { budget = JSON.parse(readFileSync(join(ROOT, 'data', 'openrouter-budget.json'), 'utf8')); } catch { /* none */ }
    const lastHourly = tail(LOGS.hourly, 400).reverse().find((l) => /\] done \(exit/.test(l)) || null;
    return [200, { now: new Date().toISOString(), tasks, web, tracker: counts, openrouterUsed: budget?.used ?? null, lastHourly, runningJobs: [...jobs.values()].filter((j) => j.status === 'running').length }];
  }
  if (req.method === 'GET' && p === '/v1/finds') {
    const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 2, 1), 14);
    return [200, { days, finds: recentFinds(days) }];
  }
  if (req.method === 'GET' && p === '/v1/tracker') {
    const st = url.searchParams.get('status');
    const rows = trackerRows().filter((r) => !st || r.status === st).reverse();
    return [200, { rows, states: canonicalStates() }];
  }
  if (req.method === 'GET' && p.startsWith('/v1/logs/')) {
    const name = p.slice('/v1/logs/'.length);
    if (!LOGS[name]) return [404, { error: 'unknown log' }];
    return [200, { name, lines: tail(LOGS[name], Number(url.searchParams.get('lines')) || 80) }];
  }
  if (req.method === 'GET' && p === '/v1/jobs') {
    return [200, { jobs: [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 30) }];
  }
  if (req.method !== 'POST') return [404, { error: 'not found' }];

  const body = await readBody(req);
  if (p === '/v1/actions/scan') {
    const r = await run('schtasks', ['/run', '/tn', 'career-ops-hourly-scan']);
    return [r.code === 0 ? 200 : 500, { ok: r.code === 0, detail: (r.stdout || r.stderr).trim().slice(0, 200) }];
  }
  if (p === '/v1/actions/create-cv') {
    if (!isUrl(body.url)) return [400, { error: 'url must be an http(s) URL' }];
    const same = [...jobs.values()].find((j) => j.url === body.url && j.status === 'running');
    if (same) return [200, { job: same, reused: true }];
    if ([...jobs.values()].filter((j) => j.status === 'running').length >= MAX_RUNNING) return [429, { error: 'two CV jobs already running' }];
    return [202, { job: await startCvJob({ url: body.url, title: str(body.title), company: str(body.company) }) }];
  }
  if (p === '/v1/actions/set-status') {
    const row = Number(body.row);
    if (!Number.isInteger(row) || row < 1) return [400, { error: 'row must be a positive integer' }];
    if (!canonicalStates().includes(body.status)) return [400, { error: 'status must be one of ' + canonicalStates().join(', ') }];
    const args = [join(ROOT, 'set-status.mjs'), '--row', String(row), body.status];
    if (body.note) args.push('--note=' + str(body.note, 200));
    const r = await run(process.execPath, args);
    return [r.code === 0 ? 200 : 400, { ok: r.code === 0, detail: (r.stdout || r.stderr).trim().slice(0, 300) }];
  }
  if (p === '/v1/actions/dismiss') {
    if (!isUrl(body.url)) return [400, { error: 'url must be an http(s) URL' }];
    const resp = await fetch(WEB + '/api/explore/dismiss', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ offers: [{ url: body.url, title: str(body.title), company: str(body.company) }] }),
    });
    return [resp.ok ? 200 : 502, { ok: resp.ok, web: await resp.json().catch(() => null) }];
  }
  if (p === '/v1/actions/restart-web') {
    const r = await restartWeb();
    return [r.ok ? 200 : 500, r];
  }
  return [404, { error: 'not found' }];
}

function main() {
  const tokenHash = TOKEN_HASH();
  const server = https.createServer({
    key: readFileSync(join(OPS_DIR, 'key.pem')),
    cert: readFileSync(join(OPS_DIR, 'cert.pem')),
    minVersion: 'TLSv1.2',
  }, async (req, res) => {
    const ip = req.socket.remoteAddress || '?';
    const url = new URL(req.url || '/', 'https://ops');
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(obj));
      log(ip + ' ' + req.method + ' ' + url.pathname + ' ' + code);
    };
    if (blocked(ip)) return send(429, { error: 'too many failed attempts, try later' });
    if (!authorized(req, tokenHash)) {
      failures.get(ip).push(Date.now());
      return send(401, { error: 'unauthorized' });
    }
    try {
      const [code, obj] = await handle(req, url);
      send(code, obj);
    } catch (e) {
      send(400, { error: e.message });
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.listen(PORT, '0.0.0.0', () => log('listening on ' + PORT));
}

if (process.argv.slice(2).some((a) => a === '--help' || a === '-h')) {
  console.log(USAGE);
  process.exit(0);
}
main();
