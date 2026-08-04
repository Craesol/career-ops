// Local parser for builtin.com remote job search (SSR page, no public API).
// Contract (jobs-json-v1): print [{ title, url, company, location, postedAt? }].
//
// Card anatomy (server-rendered):
//   <a data-id="company-title" ...><span>Company</span></a>
//   <a href="/job/{slug}/{id}" data-id="job-card-title" ...>Title</a>
//   "Reposted 6 Days Ago" / "Yesterday" / "12 Hours Ago" freshness span
//   <i class="fa-location-dot ..."></i></div><div><span ...>Berlin, DEU</span>
// One request per search phrase; dedup by job id. postedAt is derived from the
// freshness span so the scanner's age logic gets a real date.

const SEARCHES = [
  'community manager',
  'social media manager',
  'content manager',
  'marketing communications',
  'localization manager',
];
const BASE = 'https://builtin.com/jobs/remote?search=';
const UA = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36' };

const strip = (s) => s.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();

function postedAtFrom(chunk) {
  const now = Date.now();
  if (/\b(today|just posted)\b/i.test(chunk)) return now;
  if (/\byesterday\b/i.test(chunk)) return now - 86400000;
  let m = chunk.match(/\b(\d+)\s+Hours?\s+Ago\b/i);
  if (m) return now - parseInt(m[1], 10) * 3600000;
  m = chunk.match(/\b(\d+)\s+Days?\s+Ago\b/i);
  if (m) return now - parseInt(m[1], 10) * 86400000;
  return undefined;
}

const jobs = new Map(); // id → job
for (const q of SEARCHES) {
  let html;
  try {
    const res = await fetch(BASE + encodeURIComponent(q), { headers: UA, signal: AbortSignal.timeout(20000) });
    if (!res.ok) continue;
    html = (await res.text()).replace(/\n/g, ' ');
  } catch {
    continue; // one failing phrase must not kill the rest
  }
  const re = /<a href="(\/job\/[^"]+\/(\d+))"[^>]*data-id="job-card-title"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const [, path, id, rawTitle] = m;
    if (jobs.has(id)) continue;
    const title = strip(rawTitle);
    if (!title) continue;
    // Look back for the company anchor, forward for freshness + location.
    const back = html.slice(Math.max(0, m.index - 1500), m.index);
    const fwd = html.slice(re.lastIndex, re.lastIndex + 2000);
    const company = strip(back.match(/data-id="company-title"[^>]*>\s*<span>([^<]+)<\/span>[\s\S]*$/)?.[1] ?? '');
    // These come from the /jobs/remote listing, so the shown location is the
    // eligibility region of a REMOTE role — prefix it so the scanner's
    // location_filter (which presumes bare countries/cities are on-site)
    // reads it correctly.
    const rawLoc = strip(fwd.match(/fa-location-dot[^>]*><\/i><\/div>\s*<div><span[^>]*>([^<]+)<\/span>/)?.[1] ?? '');
    const location = rawLoc && !/remote/i.test(rawLoc) ? 'Remote — ' + rawLoc : (rawLoc || 'Remote');
    const postedAt = postedAtFrom(fwd);
    jobs.set(id, {
      title,
      url: 'https://builtin.com' + path,
      company,
      location,
      ...(postedAt ? { postedAt } : {}),
    });
  }
}

if (jobs.size === 0) {
  console.error('builtin-jobs: 0 postings parsed — page markup may have changed or requests failed');
  process.exit(1);
}
console.log(JSON.stringify([...jobs.values()]));
