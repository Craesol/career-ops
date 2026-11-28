// fix-tracker-cells: folds a stray `|` in the last column back into that cell,
// so one malformed row stops blocking `merge-tracker --backfill-urls` for the
// whole tracker. Child-process CLI tests against disposable data roots;
// fictional data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describeSpawn } from './helpers/describe-spawn.mjs';

const CODE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HEADER = [
  '# Applications Tracker', '',
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
  '|---|------|---------|------|-------|--------|-----|--------|-------|',
];
// A well-formed row: exactly the 9 cells the header declares.
const clean = (n, company, note = `note ${n}`) =>
  `| ${n} | 2026-07-15 | ${company} | Coordinator | 3.2/5 | Applied | ❌ | — | ${note} |`;
// The real defect: a note quoting an alternation, so the pipes split the row.
const PIPED_NOTE = 'titles like [Marketing|Communication] or [Design|Brand] = skip';

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-fix-cells-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  return root;
}
const trackerPath = (root) => join(root, 'data', 'applications.md');
const bakPath = (root) => `${trackerPath(root)}.bak`;
const writeTracker = (root, lines) => writeFileSync(trackerPath(root), lines.join('\n') + '\n');
const tracker = (root) => readFileSync(trackerPath(root), 'utf-8');
const rowOf = (root, n) => tracker(root).split('\n').find((l) => l.startsWith(`| ${n} |`));
const cellCount = (line) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').length;

function run(root, args = []) {
  const env = { ...process.env };
  for (const k of ['CAREER_OPS_ROOT', 'CAREER_OPS_DATA_DIR', 'CAREER_OPS_TRACKER']) delete env[k];
  env.CAREER_OPS_ROOT = root;
  const r = spawnSync(process.execPath, [join(CODE_ROOT, 'fix-tracker-cells.mjs'), ...args], {
    cwd: CODE_ROOT, env, encoding: 'utf-8', timeout: 30_000,
  });
  assert.equal(r.error, undefined);
  return { ...r, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
const withRoot = (fn) => () => { const root = makeRoot(); try { fn(root); } finally { rmSync(root, { recursive: true, force: true }); } };

test('--help exits 0 and prints usage without touching the tracker', withRoot((root) => {
  writeTracker(root, [...HEADER, clean(1, 'Acme Widgets')]);
  const before = tracker(root);
  const r = run(root, ['--help']);
  assert.equal(r.status, 0, describeSpawn(r));
  assert.match(r.out, /Usage: node fix-tracker-cells\.mjs/);
  assert.equal(tracker(root), before);
}));

test('an unrecognized flag exits 2 with the usage block', withRoot((root) => {
  writeTracker(root, [...HEADER, clean(1, 'Acme Widgets')]);
  const r = run(root, ['--repair-everything']);
  assert.equal(r.status, 2, describeSpawn(r));
  assert.match(r.out, /Unrecognized argument\(s\): --repair-everything/);
}));

test('a tracker whose every row matches the header reports nothing to repair', withRoot((root) => {
  writeTracker(root, [...HEADER, clean(1, 'Acme Widgets'), clean(2, 'Bolt Gadgets')]);
  const before = tracker(root);
  const r = run(root);
  assert.equal(r.status, 0, describeSpawn(r));
  assert.match(r.out, /every row matches the header/);
  assert.equal(tracker(root), before);
  assert.equal(existsSync(bakPath(root)), false);
}));

test('dry-run names the over-wide row and leaves the file byte-identical', withRoot((root) => {
  writeTracker(root, [...HEADER, clean(1, 'Acme Widgets'), clean(2, 'Bolt Gadgets', PIPED_NOTE)]);
  const before = tracker(root);
  const r = run(root);
  assert.equal(r.status, 0, describeSpawn(r));
  assert.match(r.out, /would repair row #2 .*11 cells → 9/);
  assert.match(r.out, /Preview only/);
  assert.equal(tracker(root), before, 'dry-run must not write');
  assert.equal(existsSync(bakPath(root)), false, 'dry-run takes no backup');
}));

test('--apply folds every stray pipe into the last cell and restores the header count', withRoot((root) => {
  writeTracker(root, [...HEADER, clean(1, 'Acme Widgets'), clean(2, 'Bolt Gadgets', PIPED_NOTE), clean(3, 'Cog Supplies')]);
  const untouchedBefore = [rowOf(root, 1), rowOf(root, 3)];
  const r = run(root, ['--apply']);
  assert.equal(r.status, 0, describeSpawn(r));
  assert.match(r.out, /repaired row #2/);

  const fixed = rowOf(root, 2);
  assert.equal(cellCount(fixed), 9, 'the repaired row must match the header');
  // The rule is cell()'s: a pipe becomes " / ". Both occurrences, no others.
  assert.match(fixed, /\[Marketing \/ Communication\]/);
  assert.match(fixed, /\[Design \/ Brand\]/);
  // Every other column of that row survives untouched.
  assert.match(fixed, /\| 2 \| 2026-07-15 \| Bolt Gadgets \| Coordinator \| 3\.2\/5 \| Applied \|/);
  // And the neighbouring rows are byte-identical.
  assert.deepEqual([rowOf(root, 1), rowOf(root, 3)], untouchedBefore);
  assert.equal(existsSync(bakPath(root)), true, 'a real run keeps a backup');
  assert.match(readFileSync(bakPath(root), 'utf-8'), /\[Marketing\|Communication\]/, 'the backup holds the original bytes');
}));

test('--apply is idempotent: a second run finds nothing left to repair', withRoot((root) => {
  writeTracker(root, [...HEADER, clean(1, 'Acme Widgets', PIPED_NOTE)]);
  assert.equal(run(root, ['--apply']).status, 0);
  const afterFirst = tracker(root);
  const second = run(root, ['--apply']);
  assert.equal(second.status, 0, describeSpawn(second));
  assert.match(second.out, /every row matches the header/);
  assert.equal(tracker(root), afterFirst);
}));

test('a stray pipe OUTSIDE the last column is reported for review, never folded', withRoot((root) => {
  // The pipe lands in Company, so the cells after it shift and the Score/Status
  // positions no longer read as a score and a status. Folding the tail would
  // silently mis-assign real columns, so the row is left exactly as it was.
  writeTracker(root, [
    ...HEADER,
    '| 9 | 2026-07-15 | Acme | Widgets | Coordinator | 3.2/5 | Applied | ❌ | — | note 9 |',
  ]);
  const before = tracker(root);
  const r = run(root, ['--apply']);
  assert.equal(r.status, 1, describeSpawn(r));
  assert.match(r.out, /row #9 .*left untouched/);
  assert.match(r.out, /not in the last column/);
  assert.equal(tracker(root), before);
  assert.equal(existsSync(bakPath(root)), false, 'a review-only run writes nothing, so it takes no backup');
}));

test('a row SHORTER than the header is reported, not padded', withRoot((root) => {
  writeTracker(root, [...HEADER, '| 8 | 2026-07-15 | Acme Widgets | Coordinator |']);
  const before = tracker(root);
  const r = run(root, ['--apply']);
  assert.equal(r.status, 1, describeSpawn(r));
  assert.match(r.out, /a column is missing, not overflowing/);
  assert.equal(tracker(root), before);
}));

test('a repairable row and a review-only row coexist: one is fixed, the other kept, exit 1', withRoot((root) => {
  writeTracker(root, [
    ...HEADER,
    clean(1, 'Acme Widgets', PIPED_NOTE),
    '| 8 | 2026-07-15 | Bolt Gadgets | Coordinator |',
  ]);
  const r = run(root, ['--apply']);
  assert.equal(r.status, 1, describeSpawn(r));
  assert.equal(cellCount(rowOf(root, 1)), 9, 'the repairable row is fixed');
  assert.match(rowOf(root, 1), /\[Marketing \/ Communication\]/);
  assert.equal(rowOf(root, 8), '| 8 | 2026-07-15 | Bolt Gadgets | Coordinator |', 'the review-only row is untouched');
}));

test('--json reports the repair without writing in preview mode', withRoot((root) => {
  writeTracker(root, [...HEADER, clean(1, 'Acme Widgets', PIPED_NOTE)]);
  const r = run(root, ['--json']);
  assert.equal(r.status, 0, describeSpawn(r));
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.applied, false);
  assert.equal(payload.headerCells, 9);
  assert.equal(payload.repaired.length, 1);
  assert.equal(payload.repaired[0].id, '1');
  assert.equal(payload.repaired[0].cells, 11);
  assert.equal(payload.repaired[0].expected, 9);
  assert.match(payload.repaired[0].after, /\[Marketing \/ Communication\]/);
  assert.deepEqual(payload.needsReview, []);
}));

test('a backfill-sentinel # and an N\\/A score still read as sane leading columns', withRoot((root) => {
  // A retroactive row carries sentinels (#1799). It must still be repairable:
  // treating a sentinel as "not sane" would quietly refuse the rows most likely
  // to have been hand-written, which is exactly where stray pipes come from.
  writeTracker(root, [
    ...HEADER,
    `| N/A | 2026-07-15 | Acme Widgets | Coordinator | N/A | Discarded | ❌ | — | ${PIPED_NOTE} |`,
  ]);
  const r = run(root, ['--apply']);
  assert.equal(r.status, 0, describeSpawn(r));
  const fixed = tracker(root).split('\n').find((l) => l.startsWith('| N/A |'));
  assert.equal(cellCount(fixed), 9);
  assert.match(fixed, /\[Marketing \/ Communication\]/);
}));
