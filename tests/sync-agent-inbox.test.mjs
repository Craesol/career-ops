// The inbox merge is the only place in the fork where two machines' copies of
// a personal queue get reconciled, so the thing worth proving is that it never
// drops an item and never un-resolves one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeInboxes, parseInbox, keyOf, stampOf, preferItem,
} from '../sync-agent-inbox.mjs';

const HEADER = '# Agent Inbox\n\n> protocol line\n';
const inbox = (...items) => HEADER + '\n' + items.join('\n') + '\n';

const pending = (stamp, text) => `- [ ] ${stamp} — ${text}`;
const done = (stamp, text, result) => `- [x] ${stamp} — ${text} → result: ${result}`;

test('parseInbox separates header from items and reads the checkbox', () => {
  const { header, items } = parseInbox(inbox(
    pending('2026-10-08 09:00', 'alpha'),
    done('2026-10-08 10:00', 'beta', 'shipped'),
  ));
  assert.match(header, /# Agent Inbox/);
  assert.equal(items.length, 2);
  assert.equal(items[0].done, false);
  assert.equal(items[1].done, true);
});

test('keyOf ignores the result suffix so the two sides match', () => {
  assert.equal(
    keyOf('2026-10-08 09:00 — do the thing → result: done'),
    keyOf('2026-10-08 09:00 — do the thing'),
  );
});

test('keyOf keeps the stamp — same request on another day is another intent', () => {
  assert.notEqual(keyOf('2026-10-08 09:00 — scan'), keyOf('2026-10-09 09:00 — scan'));
});

// The two machines are different Windows installs, and anything that rewrites
// the file with the wrong codepage mangles the em-dash and the accents. The key
// has to survive that, or one item silently becomes two.
test('keyOf is immune to mojibake: the em-dash damage observed in testing', () => {
  const clean = '2026-10-07 23:38 — RECORDATORIO: revisión del perfil';
  const broken = '2026-10-07 23:38 â€" RECORDATORIO: revisiÃ³n del perfil';
  assert.equal(keyOf(clean), keyOf(broken));
});

test('keyOf treats the dash variants as the same separator', () => {
  const dashes = ['—', '–', '-', '--'].map((d) => keyOf(`2026-10-08 09:00 ${d} same request`));
  assert.equal(new Set(dashes).size, 1);
});

test('merge does not duplicate an item whose copies differ only by encoding', () => {
  const clean = HEADER + '\n- [x] 2026-10-07 23:38 — RECORDATORIO: revisión → result: hecho\n';
  const broken = HEADER + '\n- [ ] 2026-10-07 23:38 â€" RECORDATORIO: revisiÃ³n\n';
  const { total, pending } = mergeInboxes(clean, broken);
  assert.equal(total, 1, 'the mojibake copy must merge, not duplicate');
  assert.equal(pending, 0, 'and the resolved side must win');
});

test('keyOf still separates genuinely different requests at the same stamp', () => {
  assert.notEqual(
    keyOf('2026-10-08 09:00 — evaluate acme'),
    keyOf('2026-10-08 09:00 — evaluate globex'),
  );
});

test('stampOf reads the stamp and tolerates its absence', () => {
  assert.equal(stampOf('2026-10-08 09:00 — x'), '2026-10-08 09:00');
  assert.equal(stampOf('no stamp here'), '');
});

test('union: items unique to either side all survive', () => {
  const local = inbox(pending('2026-10-08 09:00', 'local only'));
  const remote = inbox(pending('2026-10-08 10:00', 'remote only'));
  const { text, total, fromRemote } = mergeInboxes(local, remote);
  assert.equal(total, 2);
  assert.equal(fromRemote, 1);
  assert.match(text, /local only/);
  assert.match(text, /remote only/);
});

test('a resolved item is never un-resolved by the other side stale copy', () => {
  const local = inbox(done('2026-10-08 09:00', 'fix the crash', 'done in ea3f5e39'));
  const remote = inbox(pending('2026-10-08 09:00', 'fix the crash'));
  const { text, pending: open } = mergeInboxes(local, remote);
  assert.match(text, /\[x\]/);
  assert.match(text, /done in ea3f5e39/);
  assert.equal(open, 0);
  // and symmetrically, whichever side holds the resolution
  const flipped = mergeInboxes(remote, local);
  assert.match(flipped.text, /\[x\]/);
  assert.equal(flipped.pending, 0);
});

test('the same item is not duplicated when both sides have it', () => {
  const one = inbox(pending('2026-10-08 09:00', 'same request'));
  const { total } = mergeInboxes(one, one);
  assert.equal(total, 1);
});

test('two different resolutions keep the longer note, losing no item', () => {
  const local = inbox(done('2026-10-08 09:00', 'x', 'short'));
  const remote = inbox(done('2026-10-08 09:00', 'x', 'a much longer explanation'));
  const { text, total } = mergeInboxes(local, remote);
  assert.equal(total, 1);
  assert.match(text, /a much longer explanation/);
});

test('output is ordered by stamp regardless of input order', () => {
  const local = inbox(pending('2026-10-09 08:00', 'later'));
  const remote = inbox(pending('2026-10-07 08:00', 'earlier'));
  const { text } = mergeInboxes(local, remote);
  assert.ok(text.indexOf('earlier') < text.indexOf('later'));
});

test('an unstamped item is kept, at the end rather than dropped', () => {
  const local = inbox('- [ ] hand-written with no stamp');
  const remote = inbox(pending('2026-10-08 09:00', 'stamped'));
  const { text, total } = mergeInboxes(local, remote);
  assert.equal(total, 2);
  assert.match(text, /hand-written with no stamp/);
  assert.ok(text.indexOf('stamped') < text.indexOf('hand-written'));
});

test('an empty side is a no-op, not a wipe', () => {
  const local = inbox(pending('2026-10-08 09:00', 'keep me'));
  assert.equal(mergeInboxes(local, '').total, 1);
  assert.match(mergeInboxes(local, '').text, /keep me/);
  assert.equal(mergeInboxes('', local).total, 1);
});

test('the header survives and is not duplicated', () => {
  const local = inbox(pending('2026-10-08 09:00', 'a'));
  const remote = inbox(pending('2026-10-08 10:00', 'b'));
  const { text } = mergeInboxes(local, remote);
  assert.equal(text.match(/# Agent Inbox/g).length, 1);
});

test('a missing header on both sides falls back to the canonical one', () => {
  const { text } = mergeInboxes('- [ ] 2026-10-08 09:00 — bare\n', '');
  assert.match(text, /# Agent Inbox/);
  assert.match(text, /Agent protocol/);
});

test('CRLF input does not leak carriage returns into the merge', () => {
  const local = inbox(pending('2026-10-08 09:00', 'crlf item')).replace(/\n/g, '\r\n');
  const { text } = mergeInboxes(local, '');
  assert.ok(!text.includes('\r'), 'merged text should be LF-only');
  assert.match(text, /crlf item/);
});

test('preferItem is deterministic when the two sides are identical', () => {
  const a = { raw: '- [ ] x', done: false, key: 'x', body: 'x' };
  assert.equal(preferItem(a, { ...a }), a);
});

test('merging is idempotent — running the sync twice changes nothing', () => {
  const local = inbox(pending('2026-10-08 09:00', 'a'), done('2026-10-08 10:00', 'b', 'ok'));
  const remote = inbox(pending('2026-10-08 11:00', 'c'));
  const first = mergeInboxes(local, remote).text;
  const second = mergeInboxes(first, remote).text;
  assert.equal(second, first);
});
