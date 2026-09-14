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
const META_RE = /^(promoted|promocionado|easy apply|solicitud sencilla|actively (recruiting|hiring)|contratación activa|viewed|visto|applied|solicitado|hace \d|posted|\d+\s*(applicants|solicitudes)|new|nuevo)/i;

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
    if (!page) {
      const url = env.LINKEDIN_SEARCH_URL;
      if (!url) {
        console.log('linkedin-session: sin pestaña de LinkedIn abierta y sin LINKEDIN_SEARCH_URL — saltado');
        return;
      }
      const ctx = browser.contexts()[0];
      if (!ctx) { console.log('linkedin-session: sin contexto de navegador — saltado'); return; }
      page = await ctx.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    } else {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
    }
    await page.waitForTimeout(6000);
    // One gentle scroll of the results pane so lazy cards render; nothing else.
    await page.evaluate(() => {
      const el =
        document.querySelector('[class*="jobs-search-results-list"]') ||
        document.querySelector('[class*="scaffold-layout__list"]') ||
        document.scrollingElement;
      if (el && typeof el.scrollBy === 'function') el.scrollBy(0, 1400);
      else if (el) el.scrollTop += 1400;
    }).catch(() => {});
    await page.waitForTimeout(2500);

    const authwall = /authwall|login|checkpoint/i.test(page.url());
    if (authwall) {
      console.log('linkedin-session: la sesión pide login (authwall) — reinicia sesión en Brave; saltado');
      return;
    }

    const cards = await page.evaluate((metaSrc) => {
      const META = new RegExp(metaSrc, 'i');
      const out = [];
      const seen = new Set();
      for (const a of document.querySelectorAll('a[href*="/jobs/view/"]')) {
        const m = (a.href || '').match(/\/jobs\/view\/(\d{8,})/);
        if (!m || seen.has(m[1])) continue;
        seen.add(m[1]);
        const li = a.closest('li') || a.closest('div[data-job-id]') || a.parentElement;
        const title = (a.textContent || '').split('\n').map((s) => s.trim()).filter(Boolean)[0] || '';
        const lines = (li && li.innerText ? li.innerText : '')
          .split('\n').map((s) => s.trim())
          .filter((s) => s && s !== title && !META.test(s));
        out.push({ id: m[1], title, company: lines[0] || '', location: lines[1] || '' });
        if (out.length >= 40) break;
      }
      return out;
    }, META_RE.source);

    const proposed = cards.slice(0, MAX_CARDS).filter((c) => c.title).map((c) => ({
      url: 'https://www.linkedin.com/jobs/view/' + c.id + '/',
      company: c.company || '?',
      title: c.title,
      location: c.location || '',
      source: 'linkedin-session',
      note: '',
    }));

    console.log('linkedin-session: ' + proposed.length + ' tarjetas leídas de la pestaña');
    if (proposed.length === 0) {
      console.log('linkedin-session: 0 tarjetas — ¿cambió el DOM de LinkedIn o la búsqueda está vacía?');
      return;
    }
    const summary = await runWriter(proposed);
    const line = JSON.stringify({ kind: 'done', engine: 'linkedin-session', cards: proposed.length, ...summary });
    console.log(line.length > 400 ? line.slice(0, 400) + ' ...[' + line.length + ' chars total]' : line);
  } finally {
    // connectOverCDP: close() drops OUR connection; Brave keeps running.
    await browser.close().catch(() => {});
  }
}

if (isMainModule(import.meta.url)) {
  await main();
}
