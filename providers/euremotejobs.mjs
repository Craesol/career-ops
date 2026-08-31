// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// EU Remote Jobs provider — WordPress WP Job Manager RSS feed
// (https://euremotejobs.com/?feed=job_feed). Public, no-auth. Same family as
// jobspresso.mjs (that provider is pinned to its own host, hence the twin).
// Feed items carry title/link/pubDate; the job_listing:company/location
// extensions are usually EMPTY on this host, so those fields stay "" and the
// scanner's title filter is the effective gate. pubDate feeds the freshness
// window. Wire via a `job_boards:` entry with `provider: euremotejobs`.

const FEED_URL = 'https://euremotejobs.com/?feed=job_feed';

const decode = (s) => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&#8211;/g, '-').replace(/&#8217;/g, "'").replace(/&#038;|&amp;/g, '&')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/\s+/g, ' ').trim();

/** @type {Provider} */
export default {
  id: 'euremotejobs',

  detect(entry) {
    return entry?.provider === 'euremotejobs' ? { url: FEED_URL } : null;
  },

  async fetch(_entry, ctx) {
    // redirect:'error' prevents SSRF via server-side redirects.
    const xml = await ctx.fetchText(FEED_URL, { redirect: 'error' });
    return parseEuRemoteJobsFeed(xml);
  },
};

/** Parse the WP Job Manager RSS feed. Exported for unit tests. */
export function parseEuRemoteJobsFeed(xml) {
  const jobs = [];
  for (const item of String(xml ?? '').split('<item>').slice(1)) {
    const tag = (name) => {
      const m = item.match(new RegExp('<' + name + '[^>]*>([\\s\\S]*?)</' + name + '>'));
      return m ? decode(m[1]) : '';
    };
    const title = tag('title');
    const url = tag('link');
    if (!title || !/^https?:\/\//i.test(url)) continue;
    const postedAt = Date.parse(tag('pubDate'));
    jobs.push({
      title,
      url,
      company: tag('job_listing:company'),
      location: tag('job_listing:location'),
      ...(Number.isNaN(postedAt) ? {} : { postedAt }),
    });
  }
  return jobs;
}
