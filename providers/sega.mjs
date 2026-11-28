// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */
/** @typedef {import('./_types.js').Job} Job */
import { decodeEntities } from './_html-entities.mjs';

// SEGA Europe careers provider — single-company, server-rendered listing
// (pattern: hecklerkoch/dassault/rheinmetall). One board at
// careers.sega.co.uk/vacancies carries every studio SEGA Europe hires for,
// named in the card's own `Studio:` field — observed 2026-11-28: SEGA Europe,
// The Creative Assembly (Total War, Alien: Isolation), Sports Interactive
// (Football Manager). Other SEGA Europe studios (Two Point, Hardlight) post
// here too when they are hiring, so they come for free.
//
// There is no JSON API: /vacancies.json, /api/vacancies, /jobs.json and
// /sitemap.xml all 404 (probed 2026-11-28), and the detail pages carry no
// JSON-LD JobPosting — so this provider is the only zero-token way in. The
// list page is complete and unpaginated (no pager markup at all, 11 postings
// in one 44 KB document), which makes a scan exactly one request.
//
// Drupal Views markup, one `.job-summary.views-row` per posting:
//
//   <div class="job-summary views-row">
//     <div class="views-field views-field-title">
//       <h3 class="field-content"><a href="/vacancies/{slug}" hreflang="zxx">{Title}</a></h3></div>
//     <div class="views-field views-field-field-date-updated">
//       <span class="views-label views-label-field-date-updated">Last updated: </span>
//       <span class="field-content">06 Nov 2026</span></div>
//     <div class="views-field views-field-field-date-start">...<span class="field-content">05 Feb 2027</span></div>
//     <div class="views-field views-field-field-department">...<span class="field-content">Marketing</span></div>
//     <div class="views-field views-field-field-studio">...<span class="field-content">The Creative Assembly</span></div>
//     <div class="views-field views-field-field-country">...<span class="field-content">United Kingdom</span></div>
//   </div>
//
// Three field-mapping decisions, each a deliberate trade:
//
// `company` comes from Studio, not from the portals.yml entry name. The studio
// IS the employer a candidate recognises ("Sports Interactive", not "SEGA"),
// and it is what the company+role dedup should key on: two Community Manager
// roles at two studios are two openings. Falls back to entry.name when the
// card omits it.
//
// `location` comes from Country, verbatim and nothing more. The list page
// gives no city, and the studios sit in different ones (Creative Assembly in
// Horsham, Sports Interactive in London), so a studio-to-city table would be
// inference dressed as data. Same call hecklerkoch.mjs makes.
//
// `postedAt` comes from "Last updated", which is NOT a publication date. It is
// an upper bound on one: a posting's last-updated date is always at or after
// the day it went up, so reading it as postedAt can only ever make a role look
// FRESHER than it is, never older. That asymmetry is the whole reason it is
// safe to set — max_posting_age_days can wrongly keep an old role (one glance)
// but can never wrongly drop a live one (a lost job). The board exposes no
// other date; omitting it would make every SEGA role immortal to the age
// filter.

const MAX_JOBS = 500; // generous cap; the board is tiny (11 postings in 2026-11)
const LIST_HOST = 'careers.sega.co.uk';
const LIST_PATH = '/vacancies';

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** Strip tags, decode entities, collapse whitespace. @param {string} s */
function clean(s) {
  return decodeEntities(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * "06 Nov 2026" to epoch ms (UTC midnight), or undefined when unparseable.
 * Parsed explicitly rather than handed to `new Date(str)`, whose handling of
 * this shape is implementation- and locale-dependent.
 * @param {string} s
 */
export function parseCardDate(s) {
  const m = /^\s*(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})\s*$/.exec(String(s));
  if (!m) return undefined;
  const month = MONTHS[m[2].slice(0, 3).toLowerCase()];
  if (month === undefined) return undefined;
  const day = Number(m[1]);
  const year = Number(m[3]);
  if (day < 1 || day > 31) return undefined;
  const ms = Date.UTC(year, month, day);
  // Reject a rolled-over date (31 Feb becoming 3 Mar) rather than report a wrong day.
  const d = new Date(ms);
  if (d.getUTCDate() !== day || d.getUTCMonth() !== month) return undefined;
  return ms;
}

/**
 * Resolve the vacancy-list URL. The host is a fixed literal, so only that is
 * validated; whatever path the config carried is discarded, never inspected
 * for shape (ADDING_A_PROVIDER.md section 2 — the host is the trust boundary,
 * the path is not).
 * @param {{api?: string, careers_url?: string}} entry
 */
export function resolveListUrl(entry) {
  const raw = (entry && (entry.api || entry.careers_url)) || '';
  if (typeof raw !== 'string' || !raw) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.hostname.toLowerCase() !== LIST_HOST) return null;
  return `https://${LIST_HOST}${LIST_PATH}`;
}

/**
 * Split the listing into per-card HTML blocks. Slices between consecutive
 * `job-summary` markers so each block holds exactly one title and its own
 * fields — a lookahead regex would let the last card run into the footer.
 * @param {string} html
 */
function cardBlocks(html) {
  const marker = /<div\b[^>]*\bclass="[^"]*\bjob-summary\b[^"]*"[^>]*>/gi;
  const starts = [];
  let m;
  while ((m = marker.exec(html)) !== null) starts.push(m.index);
  return starts.map((start, i) => html.slice(start, i + 1 < starts.length ? starts[i + 1] : html.length));
}

/**
 * Read one named Views field's `field-content` out of a card block. Bounded
 * so a missing field cannot reach forward into the next one's value.
 * @param {string} block
 * @param {string} name
 */
function viewsField(block, name) {
  const re = new RegExp(
    `views-field-field-${name}\\b[\\s\\S]{0,400}?<span\\b[^>]*\\bclass="[^"]*\\bfield-content\\b[^"]*"[^>]*>([\\s\\S]*?)<\\/span>`,
    'i',
  );
  const m = re.exec(block);
  return m ? clean(m[1]) : '';
}

/**
 * Parse the listing into raw records. Pure — exported for unit testing.
 *
 * Empty vs broken (ADDING_A_PROVIDER.md section 2): a regex scraper has no
 * array container to type-check, so the split keys off the listing signal a
 * populated board carries. Detail-page hrefs present but zero cards parsed
 * means the markup changed, so throw. Neither present means a genuinely empty
 * board, so return [].
 *
 * @param {string} html
 * @returns {{slug: string, href: string, title: string, studio: string, country: string, department: string, updated: string}[]}
 */
export function parseListing(html) {
  if (typeof html !== 'string' || !html) return [];
  const out = [];
  const seen = new Set();
  for (const block of cardBlocks(html)) {
    const titleM = /views-field-title\b[\s\S]{0,400}?<a\b[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!titleM) continue;
    const href = decodeEntities(titleM[1]);
    const title = clean(titleM[2]);
    const slugM = /\/vacancies\/([^/?#]+)/.exec(href);
    if (!title || !slugM) continue;
    const slug = slugM[1];
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push({
      slug,
      href,
      title,
      studio: viewsField(block, 'studio'),
      country: viewsField(block, 'country'),
      department: viewsField(block, 'department'),
      updated: viewsField(block, 'date-updated'),
    });
  }
  if (out.length === 0 && /href="(?:https:\/\/careers\.sega\.co\.uk)?\/vacancies\/[^"]+"/i.test(html)) {
    throw new Error('sega: vacancy links present but no cards parsed — careers.sega.co.uk markup changed');
  }
  return out;
}

/** @type {Provider} */
export default {
  id: 'sega',

  detect(entry) {
    const url = entry && (entry.api || entry.careers_url);
    if (typeof url !== 'string') return null;
    return resolveListUrl({ api: url }) ? { url } : null;
  },

  async fetch(entry, ctx) {
    const listUrl = resolveListUrl(entry);
    if (!listUrl) throw new Error(`sega: cannot resolve vacancy list for ${entry.name}`);
    const html = await ctx.fetchText(listUrl, {
      headers: { accept: 'text/html' },
      redirect: 'error',
    });
    /** @type {Job[]} */
    const jobs = [];
    for (const row of parseListing(html)) {
      // Resolve the card's own href against the board origin, then re-check
      // the host: an absolute href in the markup must not take a job URL off
      // careers.sega.co.uk. new URL() percent-encodes for us, so no manual
      // slug encoding is needed (and none can throw URIError here).
      let url;
      try {
        url = new URL(row.href, listUrl);
      } catch {
        continue;
      }
      if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== LIST_HOST) continue;
      /** @type {Job} */
      const job = {
        title: row.title,
        url: url.href,
        company: row.studio || entry.name || '',
        location: row.country,
        externalId: row.slug,
      };
      const postedAt = parseCardDate(row.updated);
      if (postedAt !== undefined) job.postedAt = postedAt;
      jobs.push(job);
      if (jobs.length >= MAX_JOBS) break;
    }
    return jobs;
  },
};
