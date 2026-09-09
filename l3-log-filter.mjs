#!/usr/bin/env node
// l3-log-filter.mjs — hourly-scan.bat pipes the L3 route's ndjson stream here.
//
// Why not findstr: it silently DROPS lines longer than ~8KB, which ate every
// successful `done` line (they carry the known[]/filtered[] arrays), so the
// log's "latest done lines" were really the morning outage's short cliExit:1
// ones — a false failure-streak alarm on 2026-09-09. This keeps
// start/proposed/done/log/error, drops progress, and truncates long lines so
// the log stays greppable and bounded (~1KB per run).
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { buf += d; });
process.stdin.on('end', () => {
  for (const line of buf.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.includes('"kind":"progress"')) continue;
    console.log(t.length > 400 ? t.slice(0, 400) + ' ...[' + t.length + ' chars total]' : t);
  }
});
