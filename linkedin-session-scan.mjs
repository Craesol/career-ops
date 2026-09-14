#!/usr/bin/env node
// linkedin-session-scan.mjs — hourly reader of the user's OWN LinkedIn search
// tab in their OWN Brave session on this machine (user request 2026-09-15).
//
// STRICTLY READ-ONLY, by design and by rule:
//   - attaches to the already-running Brave over CDP (no credentials touched;
//     the session cookie never leaves the browser)
//   - refreshes the search tab the user left open, reads the rendered result
//     cards, and DISCONNECTS — it never opens postings, never clicks Apply,
//     never sends or submits anything
//   - findings go through l3-writer.mjs, the canonical gate pipeline (dedup,
//     title/location filters, LinkedIn ID freshness floor), so only what the
//     user's own rules call relevant lands in whats-new
//
// Conservative on purpose (automating a logged-in LinkedIn session brushes
// against their ToS — the user accepted the risk, so the job of this file is
// to keep it small): one page, ONE refresh every TWO hours (even hours only —
// the user tightened this on 2026-09-15 to lower detection odds), human hours
// only (08-23), small start jitter, hard cap on extracted cards. Every
// failure path exits 0 with a note — the hourly scan must never break
// because Brave is closed.
//
// .env: LINKEDIN_DEBUG_PORT (default 9222) · LINKEDIN_SEARCH_URL (used only
// when no linkedin.com/jobs tab is open) · LINKEDIN_SESSION_24H=1 (skip the
// hours window) · LINKEDIN_SESSION_EVERY=1 (skip the every-2h parity gate)

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const ROOT = getCareerOpsRoot();
const MAX_CARDS = 25;

function loadEnvFile() {
  const env = {};
  const p = resolve(ROOT, '.env');
  if (existsSync(p)) {
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = /^([A-Z_0-9]+)\s*=\s*(.+)$/.exec(line.trim());
      if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return { ...env, ...process.env };
}

// Lines that are card METADATA, not company/location (EN + ES UIs).
const META_RE = /^(promoted|promocionado|easy apply|solicitud sencilla|actively (recruiting|hiring)|contratación activa|viewed|visto|applied|solicitado|hace \d|posted|\d+\s*(applicants|solicitudes)|new|nuevo|con verificación|with verification|verificad)/i;

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

async function main() {
  const env = loadEnvFile();
  const hour = new Date().getHours();
  if (env.LINKEDIN_SESSION_24H !== '1' && (hour < 8 || hour > 23)) {
    console.log('linkedin-session: fuera de horario humano (' + hour + 'h) — saltado');
    return;
  }
  // Every-2-hours gate (even hours): 8 refreshes/day, not 16 — the user's
  // 2026-09-15 call to keep the pattern extra human.
  if (env.LINKEDIN_SESSION_EVERY !== '1' && hour % 2 !== 0) {
    console.log('linkedin-session: hora impar (' + hour + 'h) — cadencia es cada 2h; saltado');
    return;
  }
  // Small jitter so the refresh never lands on the exact same second each hour.
  await sleep(5000 + Math.floor(Math.random() * 35000));

  const port = env.LINKEDIN_DEBUG_PORT || '9222';
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (e) {
    console.log('linkedin-session: playwright no disponible (' + e.message + ') — saltado');
    return;
  }

  let browser;
  try {
    browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 10_000 });
  } catch {
    console.log('linkedin-session: Brave sin puerto CDP ' + port + ' (¿cerrado o sin flag?) — saltado');
    return;
  }

  try {
    let page = null;
    for (const ctx of browser.contexts()) {
      for (const p of ctx.pages()) {
        if (/linkedin\.com\/jobs/i.test(p.url())) { page = p; break; }
      }
      if (page) break;
    }
    const isNew = !page;
    if (isNew) {
      const url = env.LINKEDIN_SEARCH_URL;
      if (!url) {
        console.log('linkedin-session: sin pestaña de LinkedIn abierta y sin LINKEDIN_SEARCH_URL — saltado');
        return;
      }
      const ctx = browser.contexts()[0];
      if (!ctx) { console.log('linkedin-session: sin contexto de navegador — saltado'); return; }
      page = await ctx.newPage();
    }

    // LinkedIn's 2026 search UI is an RSC app: the result cards carry NO ids
    // in the live DOM (hydration consumes and removes the state scripts), but
    // the ~5MB DOCUMENT delivered on reload contains every jobPosting id.
    // Capture the raw document body during the refresh and regex the ids out —
    // format-agnostic, survives their class obfuscation.
    let rawDoc = '';
    page.on('response', (res) => {
      try {
        if (res.request().resourceType() !== 'document') return;
        if (!/linkedin\.com\/jobs/i.test(res.url())) return;
        res.text().then((t) => { if (t.length > rawDoc.length) rawDoc = t; }).catch(() => {});
      } catch { /* ignore */ }
    });

    if (isNew) {
      await page.goto(env.LINKEDIN_SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    } else {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
    }
    await page.waitForTimeout(8000);

    if (/authwall|\/login|checkpoint/i.test(page.url())) {
      console.log('linkedin-session: la sesión pide login (authwall) — reinicia sesión en Brave; saltado');
      return;
    }

    // Ids: raw document first, DOM anchors as a secondary net (classic UI).
    const ids = new Set();
    for (const m of rawDoc.matchAll(/jobPosting(?:Card)?[^0-9a-zA-Z]{0,10}(\d{10})/g)) ids.add(m[1]);
    for (const m of rawDoc.matchAll(/fsd_jobPosting(?:Card)?%3A(\d{10})/g)) ids.add(m[1]);
    const domIds = await page.evaluate(() => {
      const out = [];
      for (const a of document.querySelectorAll('a[href*="/jobs/view/"]')) {
        const m = (a.href || '').match(/\/jobs\/view\/(\d{8,})/);
        if (m) out.push(m[1]);
      }
      return out;
    }).catch(() => []);
    for (const id of domIds) ids.add(id);
    console.log('linkedin-session: ' + ids.size + ' ids en la página (doc ' + Math.round(rawDoc.length / 1024) + 'KB)');
    if (ids.size === 0) {
      console.log('linkedin-session: 0 ids — ¿cambió el formato del documento?');
      return;
    }

    // Only NEW ids get the guest-page metadata fetch — known URLs would be
    // dedup'd by the writer anyway, so don't spend requests on them.
    const known = new Set();
    try {
      for (const l of readFileSync(resolve(ROOT, 'data', 'scan-history.tsv'), 'utf8').split('\n')) {
        const u = l.split('\t')[0];
        const m = u && u.match(/linkedin\.com\/jobs\/view\/(\d{8,})/);
        if (m) known.add(m[1]);
      }
    } catch { /* first run */ }
    const fresh = [...ids].filter((id) => !known.has(id)).slice(0, 15);
    console.log('linkedin-session: ' + fresh.length + ' ids nuevos a enriquecer');
    if (fresh.length === 0) return;

    // Guest /jobs/view/{id} gives a stable <title>: "{Company} hiring {Title}
    // in {Location} | LinkedIn" or "{Title} at {Company} — {Location} |
    // LinkedIn Jobs". Plain unauthenticated fetches, capped and spaced.
    const unescape = (s) => s.replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    const proposed = [];
    for (const id of fresh) {
      const url = 'https://www.linkedin.com/jobs/view/' + id + '/';
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 15_000);
        const res = await fetch(url, {
          redirect: 'follow',
          signal: ctl.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
            'Accept-Language': 'en',
          },
        });
        clearTimeout(timer);
        const html = res.ok ? await res.text() : '';
        const raw = unescape((/<title>([^<]+)<\/title>/i.exec(html)?.[1] || '').replace(/\s*\|\s*LinkedIn( Jobs)?\s*$/i, '').trim());
        let title = '', company = '?', location = '';
        let m = /^(.*?) hiring (.*?) in (.+)$/.exec(raw);
        if (m) { company = m[1]; title = m[2]; location = m[3]; }
        else if ((m = /^(.*?) at (.*?) [—–-] (.+)$/.exec(raw))) { title = m[1]; company = m[2]; location = m[3]; }
        else if ((m = /^(.*?) at (.+)$/.exec(raw))) { title = m[1]; company = m[2]; }
        else if (raw) { title = raw; }
        if (title) {
          proposed.push({ url, company: company.trim() || '?', title: title.trim(), location: location.trim(), source: 'linkedin-session', note: '' });
        }
      } catch { /* guest fetch failed — drop this id */ }
      await sleep(1200 + Math.floor(Math.random() * 800));
    }

    console.log('linkedin-session: ' + proposed.length + ' ofertas enriquecidas');
    if (proposed.length === 0) return;
    const summary = await runWriter(proposed);
    const line = JSON.stringify({ kind: 'done', engine: 'linkedin-session', ids: ids.size, nuevos: fresh.length, ...summary });
    console.log(line.length > 400 ? line.slice(0, 400) + ' ...[' + line.length + ' chars total]' : line);
  } finally {
    // connectOverCDP: close() drops OUR connection; Brave keeps running.
    await browser.close().catch(() => {});
  }
}

if (isMainModule(import.meta.url)) {
  await main();
}
