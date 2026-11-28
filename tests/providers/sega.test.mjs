// tests/providers/sega.test.mjs — careers.sega.co.uk SSR vacancy-list parser.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — sega (careers.sega.co.uk SSR vacancy list)');
try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/sega.mjs')).href);
  const sega = mod.default;
  const { resolveListUrl, parseListing, parseCardDate } = mod;

  // ── id ──
  if (sega.id === 'sega') pass('sega.id is "sega"');
  else fail(`sega.id is ${JSON.stringify(sega.id)}`);

  // ── resolveListUrl / detect ──
  // The host is a fixed literal and the config path is discarded, not inspected:
  // any path on the right host resolves to the one canonical list URL.
  const LIST = 'https://careers.sega.co.uk/vacancies';
  if (resolveListUrl({ careers_url: LIST }) === LIST) pass('sega.resolveListUrl() accepts the vacancy list URL');
  else fail(`sega.resolveListUrl() wrong for the list URL: ${resolveListUrl({ careers_url: LIST })}`);
  if (resolveListUrl({ careers_url: 'https://careers.sega.co.uk/vacancies/some-role?x=1' }) === LIST) {
    pass('sega.resolveListUrl() discards the config path rather than inspecting its shape');
  } else {
    fail('sega.resolveListUrl() should rebuild the canonical list path');
  }
  if (resolveListUrl({ careers_url: 'http://careers.sega.co.uk/' }) === LIST) pass('sega.resolveListUrl() upgrades http to https');
  else fail('sega.resolveListUrl() should upgrade http to https');
  if (resolveListUrl({ careers_url: 'ftp://careers.sega.co.uk/vacancies' }) === null) pass('sega.resolveListUrl() rejects non-http schemes');
  else fail('sega.resolveListUrl() should reject non-http schemes');

  const spoofs = [
    'https://careers.sega.co.uk.evil.com/vacancies',
    'https://evil.com/careers.sega.co.uk/vacancies',
    'https://notcareers.sega.co.uk/vacancies',
    'https://careers.sega.co.uk.example.org/vacancies',
    'not a url',
  ];
  if (spoofs.every((u) => sega.detect({ careers_url: u }) === null)) pass('sega.detect() rejects spoofed and malformed hosts');
  else fail(`sega.detect() accepted a spoofed host: ${JSON.stringify(spoofs.filter((u) => sega.detect({ careers_url: u }) !== null))}`);
  if (
    sega.detect({}) === null &&
    sega.detect({ careers_url: null }) === null &&
    sega.detect({ careers_url: 42 }) === null &&
    sega.detect({ name: 'ExampleCo' }) === null
  ) {
    pass('sega.detect() returns null (no throw) for missing / non-string careers_url');
  } else {
    fail('sega.detect() should return null for missing / non-string careers_url');
  }
  if (sega.detect({ careers_url: LIST })?.url === LIST) pass('sega.detect() claims the careers.sega.co.uk host');
  else fail('sega.detect() should claim the careers.sega.co.uk host');

  // ── parseCardDate ──
  if (parseCardDate('06 Nov 2026') === Date.UTC(2026, 10, 6)) pass('sega.parseCardDate() reads "06 Nov 2026"');
  else fail(`sega.parseCardDate('06 Nov 2026') wrong: ${parseCardDate('06 Nov 2026')}`);
  if (parseCardDate('5 Feb 2027') === Date.UTC(2027, 1, 5)) pass('sega.parseCardDate() reads an unpadded day');
  else fail('sega.parseCardDate() should read an unpadded day');
  // A rolled-over date must be rejected, not silently reported as another day.
  if (
    parseCardDate('31 Feb 2026') === undefined &&
    parseCardDate('06 Foo 2026') === undefined &&
    parseCardDate('') === undefined &&
    parseCardDate('2026-11-06') === undefined
  ) {
    pass('sega.parseCardDate() returns undefined for an impossible or unrecognized date');
  } else {
    fail('sega.parseCardDate() should return undefined for an impossible or unrecognized date');
  }

  // ── parseListing ──
  // Real Drupal Views card markup, fictional employers/roles per the fixture rule.
  const card = (slug, title, { studio = 'ExampleCo Studio', country = 'United Kingdom', dept = 'Marketing', updated = '06 Nov 2026', href = null } = {}) =>
    '<div class="job-summary views-row">' +
      `<div class="views-field views-field-title"><h3 class="field-content"><a href="${href ?? `/vacancies/${slug}`}" hreflang="zxx">${title}</a></h3></div>` +
      `<div class="views-field views-field-field-date-updated"><span class="views-label views-label-field-date-updated">Last updated: </span><span class="field-content">${updated}</span></div>` +
      '<div class="views-field views-field-field-date-start"><span class="views-label views-label-field-date-start">Start date: </span><span class="field-content">05 Feb 2027</span></div>' +
      `<div class="views-field views-field-field-department"><span class="views-label views-label-field-department">Department: </span><span class="field-content">${dept}</span></div>` +
      `<div class="views-field views-field-field-studio"><span class="views-label views-label-field-studio">Studio: </span><span class="field-content">${studio}</span></div>` +
      `<div class="views-field views-field-field-country"><span class="views-label views-label-field-country">Country: </span><span class="field-content">${country}</span></div>` +
      '<div class="views-field views-field-field-description-brief"><span class="field-content"></span></div>' +
    '</div>';
  const page = (...cards) => `<html><body><div class="view-content">${cards.join('')}</div><footer>SEGA Europe Limited</footer></body></html>`;

  const rows = parseListing(page(
    card('community-manager', 'Community Manager', { studio: 'ExampleCo Studio' }),
    card('senior-producer', 'Senior Producer', { studio: 'BigCo Interactive', updated: '16 Nov 2026' }),
  ));
  if (rows.length === 2) pass('sega.parseListing() yields one row per job-summary card');
  else fail(`sega.parseListing() returned ${rows.length}, expected 2`);
  if (rows[0]?.title === 'Community Manager' && rows[0]?.studio === 'ExampleCo Studio' && rows[0]?.country === 'United Kingdom' && rows[0]?.updated === '06 Nov 2026') {
    pass('sega.parseListing() reads title, studio, country and last-updated off the card');
  } else {
    fail(`sega.parseListing() row wrong: ${JSON.stringify(rows[0])}`);
  }
  // Each card's fields must come from its own block — a bounded field read is
  // what stops a missing field borrowing the next card's value.
  if (rows[1]?.studio === 'BigCo Interactive' && rows[1]?.updated === '16 Nov 2026') pass('sega.parseListing() keeps each card fields scoped to its own block');
  else fail(`sega.parseListing() leaked fields across cards: ${JSON.stringify(rows[1])}`);

  // A card whose Studio / Country fields are absent must still parse, with
  // those values empty — a malformed field is never an exception.
  const sparse = parseListing(page(
    '<div class="job-summary views-row"><div class="views-field views-field-title"><h3 class="field-content"><a href="/vacancies/bare-role">Bare Role</a></h3></div></div>',
  ));
  if (sparse.length === 1 && sparse[0].studio === '' && sparse[0].country === '' && sparse[0].updated === '') {
    pass('sega.parseListing() parses a card missing every optional field');
  } else {
    fail(`sega.parseListing() should tolerate missing optional fields: ${JSON.stringify(sparse)}`);
  }

  // A title-less card, and a card whose link is not a vacancy permalink, are
  // dropped rows — not a thrown fetch.
  const dropped = parseListing(page(
    '<div class="job-summary views-row"><div class="views-field views-field-title"><h3 class="field-content"><a href="/vacancies/no-title"></a></h3></div></div>',
    card('kept-role', 'Kept Role'),
    '<div class="job-summary views-row"><div class="views-field views-field-title"><h3 class="field-content"><a href="/about/not-a-vacancy">Not A Vacancy</a></h3></div></div>',
  ));
  if (dropped.length === 1 && dropped[0].slug === 'kept-role') pass('sega.parseListing() drops a title-less card and a non-vacancy link, keeps the rest');
  else fail(`sega.parseListing() filtering wrong: ${JSON.stringify(dropped)}`);

  // The same posting listed twice collapses on its slug.
  const dupes = parseListing(page(card('same-role', 'Same Role'), card('same-role', 'Same Role')));
  if (dupes.length === 1) pass('sega.parseListing() dedups repeated slugs');
  else fail(`sega.parseListing() should dedup repeated slugs, got ${dupes.length}`);

  // ── HTML entities decoded before anything downstream matches on the title ──
  const entity = parseListing(page(card('ui-ux', 'UI &amp; UX Designer &#8212; Contract')));
  if (entity[0]?.title === 'UI & UX Designer — Contract') pass('sega.parseListing() decodes title entities (an encoded & must not hide the job from the keyword filter)');
  else fail(`sega.parseListing() did not decode the title: ${JSON.stringify(entity[0]?.title)}`);

  // A malformed numeric entity degrades to literal text rather than throwing.
  const badEntity = parseListing(page(card('bad-entity', 'Bad&#xD800;Entity')));
  if (badEntity.length === 1 && badEntity[0].title === 'Bad&#xD800;Entity') pass('sega.parseListing() tolerates an invalid numeric entity (no RangeError)');
  else fail(`sega.parseListing() should degrade a malformed entity to literal text: ${JSON.stringify(badEntity)}`);

  // ── empty vs broken ──
  // Vacancy links in the HTML but zero cards parsed = the markup changed.
  let threw = null;
  try {
    parseListing('<html><body><a href="/vacancies/associate-community-manager">Associate Community Manager</a></body></html>');
  } catch (e) {
    threw = e;
  }
  if (threw && /markup changed/i.test(threw.message)) pass('sega.parseListing() throws descriptively when vacancy links are present but no cards parse');
  else fail(`sega.parseListing() should throw on a markup change, got: ${threw ? threw.message : 'no throw'}`);

  // Neither links nor cards = a genuinely empty board.
  if (
    parseListing('<html><body><div class="view-empty">There are no vacancies at this time.</div></body></html>').length === 0 &&
    parseListing('').length === 0 &&
    parseListing(undefined).length === 0
  ) {
    pass('sega.parseListing() returns [] for an empty board and for non-string input');
  } else {
    fail('sega.parseListing() should return [] for an empty board');
  }

  // ── fetch ──
  const html = page(
    card('community-manager', 'Community Manager', { studio: 'ExampleCo Studio', updated: '06 Nov 2026' }),
    card('bare-studio', 'Bare Studio Role', { studio: '', country: 'Germany', updated: 'not a date' }),
  );
  const calls = [];
  const jobs = await sega.fetch(
    { name: 'ExampleCo Group', careers_url: LIST },
    { fetchText: async (u, o) => { calls.push({ u, o }); return html; } },
  );
  if (calls.length === 1 && calls[0].u === LIST) pass('sega.fetch() issues exactly one list request');
  else fail(`sega.fetch() request wrong: ${JSON.stringify(calls.map((c) => c.u))}`);
  if (calls[0]?.o?.redirect === 'error') pass('sega.fetch() passes redirect:"error" on the list request');
  else fail(`sega.fetch() must pass redirect:"error", got ${JSON.stringify(calls[0]?.o?.redirect)}`);
  if (jobs.length === 2) pass('sega.fetch() normalizes every card');
  else fail(`sega.fetch() returned ${jobs.length} jobs, expected 2`);
  if (
    jobs[0]?.title === 'Community Manager' &&
    jobs[0]?.url === 'https://careers.sega.co.uk/vacancies/community-manager' &&
    jobs[0]?.company === 'ExampleCo Studio' &&
    jobs[0]?.location === 'United Kingdom' &&
    jobs[0]?.externalId === 'community-manager' &&
    jobs[0]?.postedAt === Date.UTC(2026, 10, 6)
  ) {
    pass('sega.fetch() maps studio to company, country to location, slug to externalId and last-updated to postedAt');
  } else {
    fail(`sega.fetch() normalization wrong: ${JSON.stringify(jobs[0])}`);
  }
  // Studio absent: fall back to the entry name rather than ship an empty company.
  if (jobs[1]?.company === 'ExampleCo Group') pass('sega.fetch() falls back to entry.name when the card has no studio');
  else fail(`sega.fetch() company fallback wrong: ${JSON.stringify(jobs[1]?.company)}`);
  // An unparseable date leaves postedAt off entirely — never a guessed value.
  if (!('postedAt' in jobs[1])) pass('sega.fetch() omits postedAt when the card date is unparseable');
  else fail(`sega.fetch() should omit an unparseable postedAt, got ${jobs[1].postedAt}`);

  // The host guard runs BEFORE any network call: a stub that fails on entry
  // proves the throw came from the guard, not from a wrongly attempted fetch.
  let guardThrew = null;
  try {
    await sega.fetch(
      { name: 'ExampleCo', careers_url: 'https://evil.example/vacancies' },
      { fetchText: async () => { fail('sega.fetch() fetched an untrusted host'); return ''; } },
    );
  } catch (e) {
    guardThrew = e;
  }
  if (guardThrew && /cannot resolve vacancy list/i.test(guardThrew.message)) pass('sega.fetch() throws on an untrusted host before any fetch');
  else fail(`sega.fetch() should refuse an untrusted host before fetching, got: ${guardThrew ? guardThrew.message : 'no throw'}`);

  // An absolute href in the markup pointing off the board host is dropped, not
  // followed: the markup is host-controlled, so the URL is re-checked after
  // resolution.
  const offHost = await sega.fetch(
    { name: 'ExampleCo', careers_url: LIST },
    { fetchText: async () => page(
      card('x', 'Off-host Role', { href: 'https://evil.example/vacancies/x' }),
      card('kept', 'Kept Role'),
    ) },
  );
  if (offHost.length === 1 && offHost[0].url === 'https://careers.sega.co.uk/vacancies/kept') pass('sega.fetch() drops a card whose href resolves off careers.sega.co.uk');
  else fail(`sega.fetch() off-host href handling wrong: ${JSON.stringify(offHost.map((j) => j.url))}`);

  // A lone UTF-16 surrogate in the host-controlled slug must cost that one
  // posting at most. The URL constructor percent-encodes rather than throwing
  // (unlike encodeURIComponent), so the row survives with an encoded URL —
  // either way the clean posting must come back.
  let surrogate = null;
  try {
    surrogate = await sega.fetch(
      { name: 'ExampleCo', careers_url: LIST },
      { fetchText: async () => page(card('bad\uD800slug', 'Bad Slug Role'), card('clean-slug', 'Clean Role')) },
    );
  } catch (e) {
    fail(`sega.fetch() threw on a lone-surrogate slug (${e.constructor.name}: ${e.message})`);
  }
  if (surrogate && surrogate.some((j) => j.url === 'https://careers.sega.co.uk/vacancies/clean-slug')) {
    pass('sega.fetch() keeps the clean posting when another slug holds a lone surrogate');
  } else if (surrogate) {
    fail(`sega.fetch() lost the clean posting: ${JSON.stringify(surrogate.map((j) => j.url))}`);
  }
} catch (e) {
  fail(`sega provider tests crashed: ${e.message}`);
}
