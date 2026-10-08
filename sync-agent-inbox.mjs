#!/usr/bin/env node

/**
 * sync-agent-inbox.mjs — union-merge the agent inbox between this desktop and
 * CAJITA (fork-local).
 *
 * WHY NOT GIT. data/agent-inbox.md is personal data and agent-inbox.mjs keeps
 * it gitignored on purpose (see its ensureGitignored()). Craesol/career-ops is
 * a PUBLIC fork, so tracking the inbox the way portals.yml and
 * data/scan-history.tsv are tracked would publish every queued item. The
 * inbox therefore travels over the LAN instead, like output/ already does.
 *
 * WHAT IT FIXES. The inbox only ever existed on whichever machine queued the
 * item: a reminder queued from this desktop was invisible to a session opened
 * on CAJITA, and CAJITA had no copy of the file at all. Both machines now
 * converge on the same queue.
 *
 * MERGE RULES (append-only queue, so a union is the whole job):
 *   - Items are keyed by `<stamp> — <request>`, i.e. the line without its
 *     checkbox and without any `→ result:` suffix.
 *   - A resolved item beats a pending one with the same key: resolving on one
 *     machine must not be undone by the other's stale pending copy.
 *   - If both sides resolved the same item differently, the longer line wins
 *     (it carries more of the result) and ties go to local. This cannot lose
 *     an item, only the shorter of two result notes.
 *   - Output is sorted by stamp; anything unparseable keeps its relative order
 *     at the end rather than being dropped.
 *
 * Usage:
 *   node sync-agent-inbox.mjs --local data/agent-inbox.md --remote <pulled.md>
 *     Writes the merge to --out (default: --local) and prints a JSON summary.
 *   node sync-agent-inbox.mjs --local a.md --remote b.md --stdout
 *     Prints the merge instead of writing it (used by the tests).
 *
 * The PowerShell wrapper (sync-agent-inbox.ps1) does the scp in both
 * directions; this file never touches the network.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { isMainModule } from './lib/is-main-module.mjs';

/** `- [x] 2026-10-08 12:30 — do the thing → result: done` */
const ITEM_RE = /^-\s*\[( |x|X)\]\s*(.*)$/;

const DEFAULT_HEADER = [
  '# Agent Inbox',
  '',
  '> **Agent protocol:** at the start of a career-ops session, read this file.',
  '> Run each unchecked item top-to-bottom. After each, mark it `[x]` and append',
  '> `→ result: <one line>`. Items that need live user input (a mock, a paste, a',
  '> decision) → ask the user to start them instead of running them.',
  '>',
  '> Nothing here auto-submits — queued items are *intents* for you to action and',
  '> the user to review. Appended by hand, by a dashboard, or by agent-inbox.mjs.',
  '',
].join('\n');

/** The stamp at the head of an item body, for ordering. '' when absent. */
export function stampOf(body) {
  const m = body.match(/^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2})/);
  return m ? m[1].replace('T', ' ') : '';
}

/**
 * Identity of an item: its body minus any result suffix, reduced to [a-z0-9].
 * Keeping the stamp in the key is deliberate — the same request queued twice on
 * different days is two intents, not one.
 *
 * WHY DELETE NON-ASCII INSTEAD OF FOLDING IT (lib/ascii-fold.mjs argues the
 * opposite, and is right for its own case): asciiFold exists for comparing a
 * name against a target that is ASCII by construction, like a hostname or an
 * ATS slug, where "Telefónica" must become "telefonica". Here both sides are
 * copies of the SAME string and the only difference is encoding damage. A file
 * rewritten with the wrong codepage turns "—" into "â€"" and "ó" into "Ã³";
 * every byte of that damage is non-ASCII, so deleting it converges both forms
 * on the same key, while folding would turn "â" into "a" and leave the two
 * keys different. That is exactly how a single item became two in testing on
 * 2026-10-09: same request, one copy mojibake, merged as two.
 */
export function keyOf(body) {
  return body
    .split(/\s*(?:→|->)\s*result:/)[0]
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 300);
}

export function parseInbox(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const items = [];
  const headerLines = [];
  let seenItem = false;
  for (const line of lines) {
    const m = line.match(ITEM_RE);
    if (!m) {
      if (!seenItem) headerLines.push(line);
      continue; // trailing prose between items is not content we own
    }
    seenItem = true;
    const body = m[2].trim();
    items.push({ raw: line.trimEnd(), body, done: m[1].toLowerCase() === 'x', key: keyOf(body) });
  }
  return { header: headerLines.join('\n').replace(/\s*$/, ''), items };
}

/** Which of two versions of the same item to keep. */
export function preferItem(local, remote) {
  if (local.done !== remote.done) return local.done ? local : remote;
  if (local.raw.length !== remote.raw.length) {
    return local.raw.length > remote.raw.length ? local : remote;
  }
  return local;
}

export function mergeInboxes(localText, remoteText) {
  const local = parseInbox(localText);
  const remote = parseInbox(remoteText);

  const byKey = new Map();
  const order = [];
  const add = (item) => {
    const prev = byKey.get(item.key);
    if (!prev) {
      byKey.set(item.key, item);
      order.push(item.key);
      return;
    }
    byKey.set(item.key, preferItem(prev, item));
  };
  for (const it of local.items) add(it);
  const before = byKey.size;
  for (const it of remote.items) add(it);

  const merged = order.map((k) => byKey.get(k));
  // Stable sort by stamp; unstamped items keep their relative order at the end.
  merged.sort((a, b) => {
    const sa = stampOf(a.body);
    const sb = stampOf(b.body);
    if (!sa && !sb) return 0;
    if (!sa) return 1;
    if (!sb) return -1;
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });

  const header = local.header || remote.header || DEFAULT_HEADER;
  const text = header + '\n' + merged.map((i) => i.raw).join('\n') + '\n';
  return {
    text,
    total: merged.length,
    fromRemote: byKey.size - before,
    pending: merged.filter((i) => !i.done).length,
  };
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : fallback;
}

export async function main() {
  const localPath = arg('local', process.env.CAREER_OPS_INBOX || 'data/agent-inbox.md');
  const remotePath = arg('remote');
  const outPath = arg('out', localPath);
  const toStdout = process.argv.includes('--stdout');

  const localText = existsSync(localPath) ? readFileSync(localPath, 'utf8') : '';
  const remoteText = remotePath && existsSync(remotePath) ? readFileSync(remotePath, 'utf8') : '';
  if (!localText && !remoteText) {
    console.log(JSON.stringify({ skipped: 'no inbox on either side' }));
    return;
  }

  const r = mergeInboxes(localText, remoteText);
  if (toStdout) {
    process.stdout.write(r.text);
    return;
  }
  // Only rewrite when the merge actually changes something: the wrapper reads
  // `changed` to decide whether to push back to CAJITA.
  const changed = r.text !== localText;
  if (changed) {
    // withPipelineLock(path, fn): the lock is keyed on the file, so a sync
    // cannot interleave with a concurrent `agent-inbox.mjs add`, which takes
    // the same lock on the same path.
    const { withPipelineLock } = await import('./pipeline-lock.mjs');
    await withPipelineLock(outPath, () => writeFileSync(outPath, r.text));
  }
  console.log(JSON.stringify({
    total: r.total, pending: r.pending, fromRemote: r.fromRemote, changed,
  }));
}

if (isMainModule(import.meta.url)) await main();
