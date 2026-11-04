// tests/keyword-match-dash-folding.test.mjs — inside a multi-word keyword, a
// space and a dash have to be the same separator.
//
// countOccurrences() searched the literal term, so a JD keyword `rapid
// response` came back missing against a CV that writes `rapid-response`, and
// `thought leadership` missed `thought-leadership`. The compounds both sides
// hyphenate are the bulk of it — cross-functional, short-form, fast-paced,
// remote-first, data-driven, self-directed are the six most frequent hyphenated
// keywords in reports/ — and an ATS tokenizer splits on both characters, so
// every one of those pairs was a false "missing" telling the candidate to add
// wording the CV already had.
//
// The guards at the end are the other half. Folding must stay confined to
// separators ALREADY present in the term: it may relax how that term's own gaps
// are spelled and nothing more, so it can never match a single word of a
// multi-word keyword, reach across unrelated words, or soften the boundary rule
// that keeps `java` out of `javascript`.
import assert from 'node:assert/strict';
import { analyzeCoverage, countOccurrences } from '../keyword-match.mjs';
import { pass, fail } from './helpers.mjs';

console.log('\nkeyword-match: space and dash fold together inside a term');

function check(label, run) {
  try { run(); pass(label); } catch (error) { fail(`${label}: ${error.message}`); }
}

/** Whether keyword-match counts `keyword` as present in `cv`. */
const found = (keyword, cv) => analyzeCoverage([keyword], cv).present.includes(keyword);

check('a spaced keyword matches the hyphenated CV compound', () => {
  for (const [keyword, cv] of [
    ['rapid response', 'rapid-response content around launches'],
    ['thought leadership', 'thought-leadership copy for executives'],
    ['short form', 'short-form copywriting'],
    ['data driven', 'data-driven optimization'],
    ['remote first', 'remote-first Europe'],
    ['self directed', 'self-directed operator'],
  ]) {
    assert.ok(found(keyword, cv), `${keyword} in "${cv}"`);
  }
});

check('a hyphenated keyword matches the spaced CV wording', () => {
  for (const [keyword, cv] of [
    ['cross-functional', 'cross functional coordination'],
    ['fast-paced', 'a fast paced environment'],
    ['platform-native', 'platform native content'],
  ]) {
    assert.ok(found(keyword, cv), `${keyword} in "${cv}"`);
  }
});

check('en dash, em dash and minus sign fold like a hyphen', () => {
  for (const dash of ['‐', '‑', '‒', '–', '—', '―', '−']) {
    const cv = `rapid${dash}response content`;
    assert.ok(found('rapid response', cv), `U+${dash.codePointAt(0).toString(16)}`);
  }
});

check('folding is symmetric, so both spellings count the same occurrences', () => {
  assert.equal(countOccurrences('cross-functional', 'cross functional and cross-functional'), 2);
  assert.equal(countOccurrences('cross functional', 'cross functional and cross-functional'), 2);
});

// --- guards: what folding must NOT do -------------------------------------

check('a single word of a multi-word keyword is not a match', () => {
  assert.ok(!found('thought leadership', 'thought experiments and leadership training'));
  assert.ok(!found('rapid response', 'rapid growth; incident response'));
});

check('folding does not reach across unrelated words', () => {
  assert.ok(!found('community management', 'community operations and incident management'));
  assert.ok(!found('brand voice', 'brand strategy and voice of the customer'));
});

check('the alphanumeric boundary still holds', () => {
  assert.equal(countOccurrences('java', 'javascript developer'), 0);
  assert.equal(countOccurrences('response', 'rapid-response content'), 1);
  assert.equal(countOccurrences('sponse', 'rapid-response content'), 0);
});

check('symbols inside a term are untouched by folding', () => {
  assert.equal(countOccurrences('ci/cd', 'built ci/cd pipelines'), 1);
  assert.equal(countOccurrences('node.js', 'node.js backend'), 1);
  assert.equal(countOccurrences('c++', 'wrote c++ daily'), 1);
  assert.equal(countOccurrences('x/twitter', 'posted on x/twitter'), 1);
});

check('a term with no letter or digit never matches', () => {
  for (const junk of ['---', '***', '-', '  ', '·']) {
    assert.equal(countOccurrences(junk, 'any text at all --- with separators'), 0, JSON.stringify(junk));
  }
});

check('an empty term still returns no occurrences', () => {
  assert.equal(countOccurrences('', 'anything'), 0);
});
