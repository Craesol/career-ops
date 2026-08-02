// Local parser for careers.factorialhr.com (Factorial's own ATS, SSR page).
// Contract (jobs-json-v1): print [{ title, url, location }] to stdout.
// The list renders one <li class='job-offer-item'> per posting with the job URL
// in data-job-postings-url, the title in the first bold heading div, and the
// work mode ("Onsite" / "Remote" / "Hybrid") as the last gray text column —
// mapped into `location` so the scanner's location_filter sees it.

const CAREERS_URL = 'https://careers.factorialhr.com';

const stripTags = (s) => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

const res = await fetch(CAREERS_URL, {
  headers: { 'user-agent': 'career-ops (job search assistant)' },
  signal: AbortSignal.timeout(15_000),
});
if (!res.ok) {
  console.error(`factorial-jobs: HTTP ${res.status} from ${CAREERS_URL}`);
  process.exit(1);
}
const html = (await res.text()).replace(/\n/g, ' ');

const jobs = [];
const seen = new Set();
for (const block of html.split(/<li class='job-offer-item/).slice(1)) {
  const url = block.match(/data-job-postings-url='([^']+)'/)?.[1];
  if (!url || seen.has(url)) continue;
  const title = stripTags(block.match(/font-bold[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? '');
  if (!title) continue;
  const grays = [...block.matchAll(/text-gray-350[^>]*>([\s\S]*?)<\/div>/g)].map((m) => stripTags(m[1]));
  const location = grays[1] ?? ''; // [team, workMode] — workMode doubles as location signal
  seen.add(url);
  jobs.push({ title, url, location });
}

if (jobs.length === 0) {
  console.error('factorial-jobs: 0 postings parsed — page markup may have changed');
  process.exit(1);
}
console.log(JSON.stringify(jobs));
