// posting-freshness.mjs — proof-of-freshness assessor for L3 web-search finds.
//
// Two consecutive zombie incidents (2026-09-08/09) proved that liveness
// HEURISTICS cannot guard the deep scan: a WordPress posting page never says
// "expired" (1000 Dreams Fund), and an aggregator can show "Deadline:
// October 31st, 2023" in plain text while still rendering a title, a
// description and an Apply button (Boid via cryptocurrencyjobs.co) — the
// browser check reads that page as active/uncertain and the zombie walks in.
//
// So the L3 policy inverts: a find must PROVE it is fresh. This module
// gathers the proof:
//   'fresh'   — LinkedIn id above the stale cutoff (sequential ids date the
//               posting), or JSON-LD datePosted within maxAgeDays with no
//               past validThrough
//   'stale'   — JSON-LD datePosted older than maxAgeDays
//   'expired' — validThrough in the past, an explicit past deadline in the
//               page text, or HTTP 404/410
//   'unknown' — no date evidence either way (the CALLER decides; the L3
//               writers drop these — recall is sacrificed for precision,
//               deliberately: fresh real postings also reach the pipeline
//               through the API scanners, feeds and ats-full, which all
//               carry dates)
//
// ATS API liveness (liveness-api.mjs) stays the first rung in the callers:
// a Greenhouse/Lever/Ashby/Workday API answer is authoritative and cheaper.

import { linkedInJobId, LINKEDIN_STALE_ID_CUTOFF } from './linkedin-stale.mjs';

const MONTHS = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';
// "Deadline: October 31st, 2023", "closing date 15/01/2024", "apply by 2023-10-31".
// Runs against TAG-STRIPPED text ("<strong>Deadline:</strong> October ..." has
// tags between the label and the date in raw HTML).
const DEADLINE_RE = new RegExp(
  '(?:deadline|closing date|apply (?:by|before)|applications? clos(?:es?|ed|ing)|date limite)' +
  '[^{}]{0,80}?(' +
  '(?:' + MONTHS + ')[a-z]*\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+20\\d{2}' +
  '|\\d{1,2}[/.]\\d{1,2}[/.]20\\d{2}' +
  '|20\\d{2}-\\d{2}-\\d{2}' +
  ')',
  'i'
);

function stripTags(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

function parseLooseDate(s) {
  if (!s) return null;
  const cleaned = String(s).replace(/(\d{1,2})(st|nd|rd|th)/i, '$1');
  // dd/mm/yyyy vs mm/dd/yyyy: job deadlines in this corpus are EU-leaning, but
  // both readings only differ inside the same year — for a past/future verdict
  // try both and keep the LATEST (most charitable to the posting).
  const m = cleaned.match(/^(\d{1,2})[/.](\d{1,2})[/.](20\d{2})$/);
  if (m) {
    const a = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
    const b = new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
    const best = [a, b].filter(d => !isNaN(d)).sort((x, y) => y - x)[0];
    return best || null;
  }
  const d = new Date(cleaned);
  return isNaN(d) ? null : d;
}

function* jsonLdObjects(html) {
  const re = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let parsed;
    try { parsed = JSON.parse(m[1].trim()); } catch { continue; }
    const queue = Array.isArray(parsed) ? [...parsed] : [parsed];
    while (queue.length) {
      const o = queue.shift();
      if (!o || typeof o !== 'object') continue;
      if (Array.isArray(o['@graph'])) queue.push(...o['@graph']);
      yield o;
    }
  }
}

function isJobPosting(o) {
  const t = o['@type'];
  const types = Array.isArray(t) ? t : [t];
  return types.some(x => typeof x === 'string' && x.toLowerCase() === 'jobposting');
}

export async function assessPostingFreshness(url, { maxAgeDays = 45, now = Date.now(), fetchImpl = fetch } = {}) {
  // Deterministic shortcut: a LinkedIn job id above the stale cutoff IS the
  // freshness proof (ids are sequential; the cutoff sits ~5-6 weeks back).
  const liId = linkedInJobId(url);
  if (liId !== null) {
    return liId >= LINKEDIN_STALE_ID_CUTOFF
      ? { verdict: 'fresh', reason: 'linkedin id ' + liId + ' >= ' + LINKEDIN_STALE_ID_CUTOFF }
      : { verdict: 'stale', reason: 'linkedin id ' + liId + ' < ' + LINKEDIN_STALE_ID_CUTOFF };
  }

  let res;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    res = await fetchImpl(url, {
      redirect: 'follow',
      signal: ctl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en,fr;q=0.8,es;q=0.7',
      },
    });
  } catch (e) {
    clearTimeout(timer);
    return { verdict: 'unknown', reason: 'fetch failed: ' + (e && e.message) };
  }
  clearTimeout(timer);
  if (res.status === 404 || res.status === 410) {
    return { verdict: 'expired', reason: 'HTTP ' + res.status };
  }
  if (!res.ok) {
    return { verdict: 'unknown', reason: 'HTTP ' + res.status };
  }
  let html = '';
  try { html = await res.text(); } catch (e) {
    return { verdict: 'unknown', reason: 'body read failed: ' + (e && e.message) };
  }

  // 1) Structured data — the strongest page-side evidence.
  for (const o of jsonLdObjects(html)) {
    if (!isJobPosting(o)) continue;
    const validThrough = parseLooseDate(o.validThrough || o.validUntil);
    if (validThrough && validThrough.getTime() < now) {
      return { verdict: 'expired', reason: 'validThrough ' + validThrough.toISOString().slice(0, 10), validThrough };
    }
    const posted = parseLooseDate(o.datePosted || o.datePublished);
    if (posted) {
      const ageDays = (now - posted.getTime()) / 86400000;
      if (ageDays > maxAgeDays) {
        return { verdict: 'stale', reason: 'datePosted ' + posted.toISOString().slice(0, 10) + ' (' + Math.round(ageDays) + 'd old)', datePosted: posted };
      }
      return { verdict: 'fresh', reason: 'datePosted ' + posted.toISOString().slice(0, 10), datePosted: posted };
    }
  }

  // 2) Text fallback — explicit deadlines a human can read ("Deadline:
  //    October 31st, 2023"). Only ever produces 'expired', never 'fresh':
  //    prose is too messy to prove recency, but a past deadline is a verdict.
  const dm = DEADLINE_RE.exec(stripTags(html));
  if (dm) {
    const d = parseLooseDate(dm[1]);
    if (d && d.getTime() < now) {
      return { verdict: 'expired', reason: 'page deadline ' + dm[1] };
    }
  }

  return { verdict: 'unknown', reason: 'no date evidence on page' };
}
