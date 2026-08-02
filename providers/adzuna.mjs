// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Adzuna provider — the aggregator's official public API
// (https://developer.adzuna.com, free tier). Unlike the open feeds, Adzuna
// requires per-app credentials, read from env:
//   ADZUNA_APP_ID, ADZUNA_APP_KEY  (register free at developer.adzuna.com)
//
// Wire in via a `job_boards:` entry with `provider: adzuna`. Optional fields:
//   adzuna:
//     country: gb            # API country code (gb, fr, es, de, …); default gb
//     what:                  # search phrases, one API call each; default below
//       - community manager
//       - social media manager
//
// Each `what` phrase costs one request (50 results/page, first page only —
// the scanner wants fresh postings, not the archive). Location filtering is
// left to the scanner's own location_filter; `description` is passed through
// so the content filter can act on it.

const API_BASE = 'https://api.adzuna.com/v1/api/jobs';
const RESULTS_PER_PAGE = 50;
const DEFAULT_COUNTRY = 'gb';
const DEFAULT_WHAT = ['community manager', 'social media manager', 'content manager'];
const MAX_WHAT = 8; // request-count guard

/** @type {Provider} */
export default {
  id: 'adzuna',

  detect(entry) {
    return entry?.provider === 'adzuna' ? { url: API_BASE } : null;
  },

  /**
   * @param {{ name?: string, adzuna?: { country?: string, what?: string[] } }} entry
   * @param {{ fetchJson: (url: string, opts?: { redirect?: 'error'|'follow'|'manual' }) => Promise<any>, sleep?: (ms: number) => Promise<void> }} ctx
   */
  async fetch(entry, ctx) {
    const appId = process.env.ADZUNA_APP_ID;
    const appKey = process.env.ADZUNA_APP_KEY;
    if (!appId || !appKey) {
      throw new Error('adzuna: missing ADZUNA_APP_ID / ADZUNA_APP_KEY in .env — register a free app at developer.adzuna.com');
    }

    const cfg = entry.adzuna || {};
    const country = /^[a-z]{2}$/.test(cfg.country || '') ? cfg.country : DEFAULT_COUNTRY;
    const whats = (Array.isArray(cfg.what) && cfg.what.length ? cfg.what : DEFAULT_WHAT)
      .filter(w => typeof w === 'string' && w.trim())
      .slice(0, MAX_WHAT);

    const seen = new Set();
    const jobs = [];
    for (const what of whats) {
      const url = `${API_BASE}/${country}/search/1?app_id=${encodeURIComponent(appId)}&app_key=${encodeURIComponent(appKey)}` +
        `&results_per_page=${RESULTS_PER_PAGE}&what=${encodeURIComponent(what.trim())}&content-type=application/json`;
      let json;
      try {
        json = await ctx.fetchJson(url, { redirect: 'error' });
      } catch (e) {
        // One failing phrase must not kill the others (rate limits happen).
        continue;
      }
      for (const job of parseAdzunaResults(json)) {
        if (seen.has(job.url)) continue;
        seen.add(job.url);
        jobs.push(job);
      }
      if (ctx.sleep) await ctx.sleep(250);
    }
    return jobs;
  },
};

/**
 * Parse an Adzuna search response. Exported for unit tests.
 * @param {any} json
 * @returns {Array<{title: string, url: string, company: string, location: string, description?: string, postedAt?: number}>}
 */
export function parseAdzunaResults(json) {
  if (!json || !Array.isArray(json.results)) return [];
  return json.results
    .map(r => {
      if (!r || typeof r !== 'object') return null;
      const title = typeof r.title === 'string' ? r.title.replace(/<[^>]*>/g, '').trim() : '';
      const url = typeof r.redirect_url === 'string' ? r.redirect_url.trim() : '';
      if (!title || !/^https?:\/\//i.test(url)) return null;
      const postedAt = r.created ? Date.parse(r.created) : NaN;
      return {
        title,
        url,
        company: (r.company && typeof r.company.display_name === 'string') ? r.company.display_name.trim() : '',
        location: (r.location && typeof r.location.display_name === 'string') ? r.location.display_name.trim() : '',
        description: typeof r.description === 'string' ? r.description.replace(/<[^>]*>/g, ' ').trim() : undefined,
        ...(Number.isNaN(postedAt) ? {} : { postedAt }),
      };
    })
    .filter(Boolean);
}
