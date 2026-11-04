// tests/keyword-match-block-delimiters.test.mjs — extractKeywords() has to read
// every shape an evaluation mode actually writes the keyword block in, not just
// the comma-separated one.
//
// The reader split each line on commas alone. Most modes write the block
// middot-delimited instead, so 49 of 79 keyword blocks in reports/ came back as
// ONE keyword holding the whole line: coverage read as ~0% and the tool was
// silently useless across three quarters of the corpus while still printing a
// confident percentage. Two smaller leaks rode along — an ordered-list block
// kept its `1. ` prefix on every term, and the thematic break 35 reports write
// to close the block ahead of the next heading was collected as a keyword named
// `---`, which then showed up as the single most "missing" keyword of all.
//
// The guards at the end are the other half: they fail if the separator list is
// widened to characters no mode writes. `/` is the one that matters — it occurs
// 25 times in reports/ and every occurrence is INSIDE a keyword.
import assert from 'node:assert/strict';
import { extractKeywords } from '../keyword-match.mjs';
import { pass, fail } from './helpers.mjs';

console.log('\nkeyword-match: keyword-block delimiters');

function check(label, run) {
  try { run(); pass(label); } catch (error) { fail(`${label}: ${error.message}`); }
}

const block = (body) => `# Report\n\n## Keywords extracted\n\n${body}\n\n## Verdict\n\nok\n`;

check('a middot-delimited block yields one keyword per term', () => {
  const got = extractKeywords(block('Web3 · DeFi · social media manager · X (Twitter) · brand voice'));
  assert.deepEqual(got, ['Web3', 'DeFi', 'social media manager', 'X (Twitter)', 'brand voice']);
});

check('a comma-separated block still yields one keyword per term', () => {
  const got = extractKeywords(block('Discord, community management, social media, YouTube'));
  assert.deepEqual(got, ['Discord', 'community management', 'social media', 'YouTube']);
});

check('an ordered-list block drops the list numbering', () => {
  const got = extractKeywords(block('1. Project management\n2. Cross-functional coordination\n10. Client onboarding'));
  assert.deepEqual(got, ['Project management', 'Cross-functional coordination', 'Client onboarding']);
});

check('a bulleted block still yields one keyword per line', () => {
  const got = extractKeywords(block('- Community Ambassador\n- moderation\n* grand strategy\n+ Discord'));
  assert.deepEqual(got, ['Community Ambassador', 'moderation', 'grand strategy', 'Discord']);
});

check('a thematic break closing the block is not a keyword', () => {
  for (const rule of ['---', '----', '***', '___']) {
    const got = extractKeywords(`## Keywords extracted\n\nDiscord, moderation\n\n${rule}\n\n## Cover Letter Draft\n\nHi.\n`);
    assert.deepEqual(got, ['Discord', 'moderation'], `thematic break ${rule}`);
  }
});

check('inline-code ticks around a term are stripped', () => {
  const got = extractKeywords(block('`community manager` · `discord` · `x (twitter)`'));
  assert.deepEqual(got, ['community manager', 'discord', 'x (twitter)']);
});

check('mixed middots and commas on one line both split', () => {
  const got = extractKeywords(block('a, b · c, d'));
  assert.deepEqual(got, ['a', 'b', 'c', 'd']);
});

// --- guards: separators that must NOT split -------------------------------

check('a slash inside a keyword is never a separator', () => {
  for (const kw of ['X/Twitter', 'EN/ES/FR', 'stakeholder management / stakeholder engagement', 'CI/CD']) {
    assert.deepEqual(extractKeywords(block(kw)), [kw], kw);
  }
});

check('semicolon, pipe and bullet are not separators', () => {
  for (const kw of ['a; b', 'a | b', 'a • b']) {
    assert.deepEqual(extractKeywords(block(kw)), [kw], kw);
  }
});

check('a bullet line whose term starts with a digit keeps the digit', () => {
  assert.deepEqual(extractKeywords(block('- 3D modeling')), ['3D modeling']);
  assert.deepEqual(extractKeywords(block('360 feedback · 24/7 coverage')), ['360 feedback', '24/7 coverage']);
});

check('a placeholder parenthetical line is still skipped', () => {
  assert.deepEqual(extractKeywords(block('(none extracted)')), []);
});

check('extraction still stops at the next level-2 heading', () => {
  const got = extractKeywords('## Keywords extracted\n\nDiscord\n\n## Job Description\n\nReddit, YouTube\n');
  assert.deepEqual(got, ['Discord']);
});

check('an absent block returns no keywords', () => {
  assert.deepEqual(extractKeywords('# Report\n\n## Verdict\n\nok\n'), []);
});
