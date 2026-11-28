#!/usr/bin/env node
// fix-tracker-cells.mjs — repair tracker rows whose cell count does not match
// the header, by folding the overflow back into the last column.
//
// WHY THIS EXISTS (2026-11-28). A literal `|` inside a Notes cell splits the
// markdown row, so a 9-column tracker gets an 11-cell row. Nothing in the tree
// repairs that: `merge-tracker.mjs --migrate-urls` deliberately leaves such a
// row untouched and names it for hand review, and `--backfill-urls` refuses the
// whole migration ("cannot add the URL column safely (table row N has the wrong
// number of cells)"). One row therefore blocks a schema migration for the whole
// tracker — which is what happened to row #145, whose note quoted a filter
// pattern as `[Marketing|Communication]`.
//
// `cell()` in tracker-utils.mjs already owns the rule for this: a `|` inside a
// value becomes ` / `, because a pipe cannot live in this table under any
// spelling. This script applies that same rule to rows written before (or
// around) `cell()`, nothing more.
//
// SAFETY. The fold assumes the overflow belongs to the LAST column, which is
// where a tracker's free text lives. That assumption is checked, never trusted:
// a row is only repaired when the cells BEFORE the last one still read as the
// columns they should be (a `#`, a date, a score, a status). A row that fails
// that check is reported for hand review and left exactly as it was — the same
// conservatism `--migrate-urls` uses. Dry-run is the default; `--apply` writes,
// under the real tracker lock, through writeFileAtomic, after a .bak.
//
// Usage:
//   node fix-tracker-cells.mjs              # preview (default)
//   node fix-tracker-cells.mjs --apply      # repair
//   node fix-tracker-cells.mjs --json       # machine-readable
//   node fix-tracker-cells.mjs --help

import { readFileSync, copyFileSync } from 'node:fs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import {
  resolveTrackerPath,
  acquireTrackerLockForCli,
  writeFileAtomic,
  cell,
} from './tracker-utils.mjs';

const USAGE = `Usage: node fix-tracker-cells.mjs [--apply] [--json] [--help]

Repairs tracker rows whose cell count does not match the header, by folding the
overflow back into the last column with " / " (the same rule cell() applies).
A row whose leading columns no longer read as #/date/score/status is reported
for hand review and left untouched. Default is a preview; --apply writes.`;

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}
const APPLY = argv.includes('--apply');
const JSON_OUT = argv.includes('--json');
const unknown = argv.filter((a) => !['--apply', '--json', '--help', '-h'].includes(a));
if (unknown.length) {
  console.error(`Unrecognized argument(s): ${unknown.join(', ')}\n\n${USAGE}`);
  process.exit(2);
}

/** Split a markdown table line into its cells (outer pipes dropped). */
function splitRow(line) {
  return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|');
}

/** Does this row's leading run still read as the tracker's own columns? */
function leadingColumnsLookSane(cells) {
  const [num, date, , , score, status] = cells.map((c) => c.trim());
  const numOk = /^(\d+|N\/A|—|-)$/.test(num);
  const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(date);
  const scoreOk = /^(\d(?:\.\d)?\/5|N\/A|—|-)$/.test(score);
  const statusOk = /^[A-Za-z][A-Za-z ]*$|^(—|-)$/.test(status);
  return { ok: numOk && dateOk && scoreOk && statusOk, numOk, dateOk, scoreOk, statusOk };
}

const root = getCareerOpsRoot();
const tracker = resolveTrackerPath(root);
const original = readFileSync(tracker, 'utf8');
const lines = original.split(/\r?\n/);

let headerCount = null;
let headerLine = null;
const repaired = [];
const needsReview = [];
let rowNumber = 0;

const out = lines.map((line, i) => {
  if (!/^\s*\|/.test(line)) return line;
  if (headerCount === null) {
    headerCount = splitRow(line).length;
    headerLine = i + 1;
    return line;
  }
  if (/^\s*\|\s*-+/.test(line)) return line; // separator
  rowNumber += 1;
  const cells = splitRow(line);
  if (cells.length === headerCount) return line;
  const record = {
    trackerRow: rowNumber,
    fileLine: i + 1,
    id: cells[0]?.trim() ?? '',
    cells: cells.length,
    expected: headerCount,
  };
  if (cells.length < headerCount) {
    // A short row is a different defect (a missing column, not a stray pipe)
    // and folding cannot invent the missing cell. Report only.
    needsReview.push({ ...record, reason: 'row is shorter than the header — a column is missing, not overflowing' });
    return line;
  }
  const sane = leadingColumnsLookSane(cells);
  if (!sane.ok) {
    needsReview.push({
      ...record,
      reason: `leading columns no longer read as #/date/score/status (num=${sane.numOk} date=${sane.dateOk} score=${sane.scoreOk} status=${sane.statusOk}) — the stray pipe is not in the last column`,
    });
    return line;
  }
  // Fold the overflow back into the final column, exactly as cell() would have.
  const head = cells.slice(0, headerCount - 1);
  const tail = cells.slice(headerCount - 1).join('|');
  const folded = cell(tail);
  const rebuilt = `|${[...head, ` ${folded} `].join('|')}|`;
  if (splitRow(rebuilt).length !== headerCount) {
    needsReview.push({ ...record, reason: 'fold did not restore the header cell count — left untouched' });
    return line;
  }
  repaired.push({ ...record, before: cells.slice(headerCount - 1).join('|').trim(), after: folded });
  return rebuilt;
});

const result = {
  tracker,
  headerLine,
  headerCells: headerCount,
  dataRows: rowNumber,
  repaired,
  needsReview,
  applied: false,
};

if (repaired.length > 0 && APPLY) {
  const lock = await acquireTrackerLockForCli(tracker, {
    dryRun: false,
    failWith: (exitCode, code, message) => {
      console.error(`❌ ${code}: ${message}`);
      process.exit(exitCode);
    },
  });
  try {
    copyFileSync(tracker, `${tracker}.bak`);
    writeFileAtomic(tracker, out.join('\n'));
    result.applied = true;
    result.backup = `${tracker}.bak`;
  } finally {
    if (lock) lock.release();
  }
}

if (JSON_OUT) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`tracker: ${tracker}`);
  console.log(`header: ${headerCount} cells (line ${headerLine}) | data rows: ${rowNumber}`);
  if (repaired.length === 0 && needsReview.length === 0) {
    console.log('✅ every row matches the header — nothing to repair');
  }
  for (const r of repaired) {
    console.log(`\n${result.applied ? '🔧 repaired' : '• would repair'} row #${r.id} (table row ${r.trackerRow}, file line ${r.fileLine}): ${r.cells} cells → ${r.expected}`);
    console.log(`    before: ${r.before.slice(0, 220)}${r.before.length > 220 ? '…' : ''}`);
    console.log(`    after:  ${r.after.slice(0, 220)}${r.after.length > 220 ? '…' : ''}`);
  }
  for (const r of needsReview) {
    console.log(`\n⚠️  row #${r.id} (table row ${r.trackerRow}, file line ${r.fileLine}) left untouched: ${r.reason}`);
  }
  if (repaired.length > 0 && !result.applied) {
    console.log('\nPreview only. Re-run with --apply to write (a .bak is kept).');
  } else if (result.applied) {
    console.log(`\n✅ ${repaired.length} row(s) repaired. Backup: ${result.backup}`);
  }
}

process.exit(needsReview.length > 0 ? 1 : 0);
