#!/usr/bin/env node
// l3-hourly.mjs — engine orchestrator for the hourly L3 deep scan.
//
// Two engines, one pipeline (l3-writer.mjs):
//   claude — POST localhost:3000/api/explore/l3 (claude headless on sonnet,
//            spends Claude-plan usage)
//   gemini — gemini-l3.mjs (Gemini API + Google Search grounding, free tier)
//
// Schedule: with L3_ALTERNATE=1, EVEN hours run gemini and ODD hours claude —
// halves the plan burn and searches two different indexes. DEFAULT is claude
// primary every hour with gemini as failover only: probed 2026-09-10, this
// key's FREE tier returns 429 on any google_search-grounded call (plain calls
// are fine), so alternation stays dormant until the user enables billing on
// the Google project (the paid tier's daily grounding allowance covers our
// ~184 queries/day at $0). Flip L3_ALTERNATE=1 in hourly-scan.bat then.
//
// Env: L3_ENGINE=claude|gemini forces the primary (testing); the failover
// still applies. Output is log-friendly: progress dropped, lines truncated.

import { runGeminiL3 } from './gemini-l3.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const trunc = (s) => (s.length > 400 ? s.slice(0, 400) + ' ...[' + s.length + ' chars total]' : s);

async function runClaudeL3() {
  let res;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 900_000);
    res = await fetch('http://localhost:3000/api/explore/l3', {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cliId: 'claude', model: 'sonnet' }),
    });
    if (!res.ok) {
      clearTimeout(timer);
      console.error('claude-l3: HTTP ' + res.status);
      return { engine: 'claude', ok: false, reason: 'http ' + res.status };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let done = null;
    for (;;) {
      const { value, done: eof } = await reader.read();
      if (eof) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line || line.includes('"kind":"progress"')) continue;
        console.log(trunc(line));
        try {
          const j = JSON.parse(line);
          if (j.kind === 'done') done = j;
        } catch { /* partial line */ }
      }
    }
    clearTimeout(timer);
    if (!done) return { engine: 'claude', ok: false, reason: 'stream ended without done' };
    // cliExit !== 0 with nothing proposed = the CLI itself failed (limits,
    // auth, API incident) — that IS the failover case. cliExit 0 with 0
    // proposed is a legitimately quiet run.
    if (done.cliExit !== 0 && !(done.proposed > 0)) {
      return { engine: 'claude', ok: false, reason: 'cli exit ' + done.cliExit };
    }
    return { engine: 'claude', ok: true, proposed: done.proposed ?? 0, added: done.added ?? 0 };
  } catch (e) {
    console.error('claude-l3: ' + (e && e.message));
    return { engine: 'claude', ok: false, reason: String((e && e.message) || e) };
  }
}

async function main() {
  const hour = new Date().getHours();
  const forced = (process.env.L3_ENGINE || '').toLowerCase();
  const alternate = process.env.L3_ALTERNATE === '1';
  const primary =
    forced === 'claude' || forced === 'gemini' ? forced : alternate && hour % 2 === 0 ? 'gemini' : 'claude';
  const secondary = primary === 'gemini' ? 'claude' : 'gemini';
  const run = (name) => (name === 'gemini' ? runGeminiL3() : runClaudeL3());

  console.log('[l3-hourly] hour ' + hour + ' → primary ' + primary + (forced ? ' (forced)' : ''));
  let result = await run(primary);
  if (!result.ok) {
    console.log('[l3-hourly] ' + primary + ' failed (' + (result.reason || '?') + ') → failover to ' + secondary);
    result = await run(secondary);
    if (!result.ok) {
      console.error('[l3-hourly] BOTH engines failed this hour (' + (result.reason || '?') + ')');
      process.exit(1);
    }
  }
  console.log('[l3-hourly] ' + result.engine + ' ok · proposed ' + (result.proposed ?? 0) + ' · added ' + (result.added ?? 0));
}

if (isMainModule(import.meta.url)) {
  await main();
}
