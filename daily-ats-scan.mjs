import 'dotenv/config';
import { readFileSync, appendFileSync, existsSync, writeFileSync } from 'fs';
import yaml from 'js-yaml';
import { buildLocationFilter } from './scan.mjs';

// Location filter comes from portals.yml (same semantics as scan.mjs):
// always_allow (home region) wins over block; block rejects onsite/hybrid and
// out-of-region markets; missing location data always passes.
let locationOk = () => true;
try {
  const portals = yaml.load(readFileSync('./portals.yml', 'utf-8')) || {};
  locationOk = buildLocationFilter(portals.location_filter);
} catch (e) { console.error('[portals.yml location_filter]', e.message); }

const POSITIVE = ['community manager','community lead','community director','head of community','vp of community','community builder','community operations','community growth','community narrative','platform community','community program','ambassador program manager','guild','engagement manager','audience engagement','audience development','creator ecosystem','creator economy','creator relations','influencer relations','game community','player experience','content manager','content strategist','brand storyteller','communications manager','communications strategist','marketing communications','social media manager','brand manager','brand voice','thought leadership','responsable communaute','chargé de communication','charge de communication','responsable communication'];
const NEGATIVE = ['program manager','program lead','head of programs','project manager','pmo','delivery manager','operations manager','partnership manager','partnerships lead','head of partnerships','strategic partnerships','vip relationship','gift card','accelerator program','vietnamese','mandarin','cantonese','korean','japanese','thai','indonesian','tagalog','arabic','turkish','apac','on-site','onsite','on site','in-office','in office','intern','internship','junior','entry level','assistant','specialist','coordinator','apprenticeship','werkstudent','praktikant','auszubildende','azubi','caretaker','spontaneous application','kol affiliate','accountant','finance manager','legal','lawyer','data scientist','machine learning','software engineer','backend engineer','frontend engineer','full-stack engineer','full stack engineer','fullstack engineer','blockchain engineer','protocol engineer','smart contract engineer','rust engineer','solidity engineer','rust blockchain engineer','infrastructure engineer','platform engineer','data engineer','ml engineer','ai engineer','site reliability engineer','sre','qa engineer','test engineer','security engineer','embedded engineer','firmware engineer','devops engineer','staff engineer','principal engineer','senior engineer','lead engineer','engineering manager','vp engineering','head of engineering','director of engineering','cto','ios','android','devops','cobol','mainframe','oracle ebs','technical program manager','technical project manager','infrastructure technology','it project manager','it program manager','technology project manager','product manager','director of product','head of product','vp of product','business operations','marketing operations','player support','revenue operations','sales operations','d2c','live ops manager','liveops manager','live service manager','recruiter','talent acquisition','people operations','human resources','designer','design lead','quality assurance','solutions architect','sales executive','account executive','customer success','stage','stagiaire','stagier','alternance','alternant','apprenti','apprentice','apprentissage','bts','bachelor','dut','licence pro','contrat pro','professionnalisation','volontariat','vie ','pfe','tfe','bénévolat','bénévole','benevolat','benevole','volunteer','developer relations','devrel','developer advocate','developer evangelist','developer experience','dx engineer','developer marketing','ecosystem growth','head of ecosystem growth','vp ecosystem growth','director of ecosystem growth'];

// Companies / domains to skip entirely (content-farm aggregators, geo-restricted talent pools, etc.)
const NEGATIVE_COMPANIES = ['onlinejobs.ph','persona talent','remotasks','outlier','data annotation tech'];

const TARGETS = [
  { ats:'greenhouse', company:'Aptos Labs', slug:'aptoslabs' },
  { ats:'greenhouse', company:'Near Foundation', slug:'nearfoundation' },
  { ats:'greenhouse', company:'Filecoin Foundation', slug:'filecoinfoundation' },
  { ats:'greenhouse', company:'Scopely', slug:'scopely' },
  { ats:'greenhouse', company:'Startale Labs', slug:'startale' },
  { ats:'ashby', company:'Ava Labs (Avalanche)', slug:'ava-labs' },
  { ats:'ashby', company:'Mysten Labs (Sui)', slug:'mystenlabs' },
  { ats:'ashby', company:'Polygon Labs', slug:'polygon-labs' },
  { ats:'ashby', company:'Solana Foundation', slug:'Solana Foundation' },
  { ats:'ashby', company:'Chainlink Labs', slug:'chainlink-labs' },
  { ats:'ashby', company:'Sky Mavis (Ronin)', slug:'skymavis' },
  { ats:'ashby', company:'Blast', slug:'blast-io' },
  { ats:'ashby', company:'Hyperliquid Labs', slug:'Hyperliquid Labs' },
  { ats:'ashby', company:'YO Labs', slug:'yolabs' },
  { ats:'lever', company:'Immutable', slug:'immutable' },
  { ats:'lever', company:'Fun (fun.xyz)', slug:'funxyz' },
  { ats:'lever', company:'Larian Studios', slug:'larian' },
  { ats:'lever', company:'Animoca Brands', slug:'animocabrands' }
];

const QUOTES = [
  ['Nobody expects the Spanish Inquisition!',"Monty Python's Flying Circus"],
  ["It's just a flesh wound.",'Monty Python and the Holy Grail'],
  ['We are the knights who say... NI!','Monty Python and the Holy Grail'],
  ['And now for something completely different.',"Monty Python's Flying Circus"],
  ['Always look on the bright side of life.','Life of Brian'],
  ['Tis but a scratch.','Monty Python and the Holy Grail']
];

// Short keywords (<=4 chars) and a few tricky 5-char ones use word boundaries
// to avoid false positives (e.g. "ngo" in "Django", "stage" in "Backstage").
// Longer keywords use substring matching so stems catch plurals and forms
// ("token" → "tokenization", "guild" → "guildmaster", "communication" → "communications").
const BOUNDARY_KEYWORDS = new Set(['stage','vie ','d2c','pfe','tfe','bts','dut']);
function hasKeyword(text, kw) {
  if (BOUNDARY_KEYWORDS.has(kw) || kw.length <= 4) {
    const re = new RegExp('\\b' + kw.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&') + '\\b', 'i');
    return re.test(text);
  }
  return text.toLowerCase().includes(kw);
}
function matchCompany(company) {
  if (!company) return true;
  const c = company.toLowerCase();
  return !NEGATIVE_COMPANIES.some(blocked => c.includes(blocked.toLowerCase()));
}
function match(t, company){
  const x = (t || '');
  if (!matchCompany(company)) return false;
  if (NEGATIVE.some(n => hasKeyword(x, n))) return false;
  return POSITIVE.some(p => hasKeyword(x, p));
}
function esc(s){return(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

async function fetchAts(t){
  try {
    if(t.ats==='greenhouse'){
      const r=await fetch('https://boards-api.greenhouse.io/v1/boards/'+t.slug+'/jobs');
      if(!r.ok)return [];
      const j=await r.json();
      return (j.jobs||[]).map(x=>({url:x.absolute_url,title:x.title,company:t.company,location:(x.location&&x.location.name)||''}));
    }
    if(t.ats==='ashby'){
      const r=await fetch('https://api.ashbyhq.com/posting-api/job-board/'+encodeURIComponent(t.slug));
      if(!r.ok)return [];
      const j=await r.json();
      return (j.jobs||[]).map(x=>({url:x.jobUrl||x.applyUrl,title:x.title,company:t.company,location:[x.location,...(x.secondaryLocations||[]).map(s=>s&&s.location)].filter(Boolean).join('; ')}));
    }
    if(t.ats==='lever'){
      const r=await fetch('https://api.lever.co/v0/postings/'+t.slug+'?mode=json');
      if(!r.ok)return [];
      const arr=await r.json();
      return (Array.isArray(arr)?arr:[]).map(x=>({url:x.hostedUrl,title:x.text,company:t.company,location:(x.categories&&x.categories.location)||''}));
    }
  } catch(e) { console.error('['+t.company+']',e.message); }
  return [];
}

const UA = { 'User-Agent': 'Mozilla/5.0 career-ops/1.0' };

async function fetchRemoteOK() {
  try {
    const r = await fetch('https://remoteok.com/api', { headers: UA });
    if (!r.ok) return [];
    const j = await r.json();
    // First entry is API metadata (legal/source info), skip it
    return j.filter(x => x.id && x.position).map(x => ({
      url: x.url || ('https://remoteok.com/remote-jobs/' + x.slug),
      title: x.position,
      company: x.company || 'RemoteOK'
    }));
  } catch(e) { console.error('[RemoteOK]', e.message); return []; }
}

async function fetchRemotive() {
  // Remotive supports category filter; pull a few relevant categories
  const cats = ['marketing', 'all-others', 'business', 'product'];
  const all = [];
  for (const cat of cats) {
    try {
      const r = await fetch('https://remotive.com/api/remote-jobs?category=' + cat, { headers: UA });
      if (!r.ok) continue;
      const j = await r.json();
      for (const x of (j.jobs || [])) {
        all.push({ url: x.url, title: x.title, company: x.company_name || 'Remotive', location: x.candidate_required_location || '' });
      }
    } catch(e) { console.error('[Remotive ' + cat + ']', e.message); }
  }
  return all;
}

const LINKEDIN_BROWSER_UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36' };

// Body check: fetch a LinkedIn job page and look for stage/internship markers in the JD body.
// Returns true if the role is detected as a stage/intern/apprenticeship despite a clean title.
async function isLinkedInStageRole(jobUrl) {
  try {
    const r = await fetch(jobUrl, { headers: LINKEDIN_BROWSER_UA });
    if (!r.ok) return false;
    const html = await r.text();
    // Look for the employment-type criteria block + JD body
    // Common stage indicators in French/English JD bodies
    const stageMarkers = [
      /\bemployment type[^<]{0,40}internship/i,
      /\btype d['e]?\s*contrat[^<]{0,40}stage/i,
      /\bstage\s+de\s+\d/i,                          // "stage de 6 mois"
      /\bdur[ée]e\s+du\s+stage\b/i,                  // "durée du stage"
      /\bconvention\s+de\s+stage\b/i,                // "convention de stage"
      /\bgratification\s+de\s+stage\b/i,             // "gratification de stage"
      /\bindemnit[ée]\s+de\s+stage\b/i,              // "indemnité de stage"
      /\bcontrat\s+d['e]?\s*apprentissage\b/i,       // apprenticeship
      /\bcontrat\s+de\s+professionnalisation\b/i,
      /\balternance\s+de\s+\d/i,                     // "alternance de 12 mois"
      /selon\s+la\s+r[ée]glementation[^<]{0,60}stage/i,  // "selon la réglementation [...] stage"
      /\binternship\s+(position|role|opportunity)\b/i
    ];
    return stageMarkers.some(re => re.test(html));
  } catch(e) {
    return false;  // On error, don't filter (let the title filter decide)
  }
}

async function fetchLinkedIn() {
  const queries = [
    { kw: '"community manager" web3', loc: 'Worldwide' },
    { kw: '"head of community" crypto', loc: 'Worldwide' },
    { kw: '"community manager" gaming', loc: 'European Union' },
    { kw: '"social media manager" web3', loc: 'Worldwide' },
    { kw: '"community lead" crypto', loc: 'European Union' },
    { kw: '"community manager"', loc: 'Sophia Antipolis, France' },
    { kw: '"community manager" OR "social media manager" OR "content manager"', loc: 'Monaco' }
  ];
  const all = [];
  for (const q of queries) {
    try {
      const url = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=' + encodeURIComponent(q.kw) + '&location=' + encodeURIComponent(q.loc) + '&f_TPR=r604800&start=0';
      const r = await fetch(url, { headers: LINKEDIN_BROWSER_UA });
      if (!r.ok) continue;
      const html = await r.text();
      // Each card: <a class="base-card__full-link ..."> + <h3 class="base-search-card__title">{title}</h3> + <h4 class="base-search-card__subtitle">...<a>{company}</a></h4>
      const cards = html.split('<div class="base-card');
      for (const card of cards.slice(1)) {
        const cardUrl = (card.match(/<a class="base-card__full-link[^"]*"[^>]*href="([^"?]+)/) || [])[1];
        const title = (card.match(/<h3 class="base-search-card__title"[^>]*>\s*([^<]+?)\s*<\/h3>/) || [])[1];
        const company = (card.match(/<h4 class="base-search-card__subtitle"[\s\S]*?<a[^>]*>\s*([^<]+?)\s*<\/a>/) || [])[1];
        if (cardUrl && title) {
          const cleanUrl = cardUrl.replace(/&amp;/g, '&').split('?')[0];
          // For French LinkedIn results (most stage offenders), do a body-check to filter stages
          // whose title doesn't explicitly say "Stage/Stagiaire/Alternance"
          if (cleanUrl.startsWith('https://fr.linkedin.com/')) {
            const isStage = await isLinkedInStageRole(cleanUrl);
            if (isStage) {
              console.log('  [LinkedIn fr-body-filter] STAGE detected & dropped: ' + title);
              continue;
            }
          }
          // Location: the card's own location span, else derive the country from
          // the LinkedIn country subdomain (in./hk./sg./be./...) so the
          // location filter never judges an empty string for these results.
          const cardLoc = (card.match(/job-search-card__location[^>]*>\s*([^<]+?)\s*</) || [])[1];
          const cc = (cleanUrl.match(/^https:\/\/([a-z]{2})\.linkedin\.com\//) || [])[1];
          const CC_NAMES = { in:'India', hk:'Hong Kong', sg:'Singapore', tw:'Taiwan', ph:'Philippines', th:'Thailand', vn:'Vietnam', id:'Indonesia', my:'Malaysia', cn:'China', jp:'Japan', kr:'South Korea', au:'Australia', nz:'New Zealand', ae:'UAE', sa:'Saudi Arabia', qa:'Qatar', us:'United States', ca:'Canada', mx:'Mexico', br:'Brazil', ar:'Argentina', fr:'France', be:'Belgium', ch:'Switzerland', lu:'Luxembourg', mc:'Monaco', es:'Spain', uk:'United Kingdom', de:'Germany', nl:'Netherlands', it:'Italy', pt:'Portugal' };
          const location = [cardLoc && cardLoc.replace(/&amp;/g, '&'), cc && CC_NAMES[cc]].filter(Boolean).join(', ');
          all.push({
            url: cleanUrl,
            title: title.replace(/&amp;/g, '&').replace(/&#x27;/g, "'"),
            company: (company || 'LinkedIn').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").trim(),
            location
          });
        }
      }
    } catch(e) { console.error('[LinkedIn ' + q.kw + ']', e.message); }
  }
  return all;
}

function decodeHtml(s) {
  return (s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&[a-z]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchHackerNewsWhoshiring() {
  try {
    // Find latest "Who is hiring?" thread (NOT "who wants to be hired" — different thread)
    const r1 = await fetch('https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=5');
    const j1 = await r1.json();
    const thread = (j1.hits || []).find(h => /^Ask HN: Who is hiring\?/i.test(h.title));
    if (!thread) return [];
    const threadId = thread.objectID;
    const all = [];
    for (let page = 0; page < 10; page++) {
      const r2 = await fetch('https://hn.algolia.com/api/v1/search?tags=comment,story_' + threadId + '&hitsPerPage=100&page=' + page);
      const j2 = await r2.json();
      if (!j2.hits || j2.hits.length === 0) break;
      for (const h of j2.hits) {
        // Only top-level comments (direct hiring posts), skip replies
        if (String(h.parent_id) !== String(threadId)) continue;
        const text = decodeHtml(h.comment_text);
        // First "line" before any sentence break — HN posts usually start with: Company | Role | Location | Type
        const head = text.split(/(?<=\|.*?\|.*?\|.*?\|)/)[0] || text.slice(0, 200);
        // Use the segment between the first and second pipe as the role title (typical structure)
        const parts = text.split('|').map(s => s.trim());
        const company = (parts[0] || 'HN').slice(0, 80);
        // Build a clean title from first 2-3 segments
        const title = parts.slice(0, 3).join(' | ').slice(0, 160) || head.slice(0, 160);
        all.push({
          url: 'https://news.ycombinator.com/item?id=' + h.objectID,
          title,
          company
        });
      }
      if (j2.hits.length < 100) break;
    }
    return all;
  } catch(e) { console.error('[HN]', e.message); return []; }
}

async function fetchAdzuna() {
  const APP_ID = process.env.ADZUNA_APP_ID;
  const API_KEY = process.env.ADZUNA_API_KEY;
  if (!APP_ID || !API_KEY) {
    console.log('  (Adzuna skipped: ADZUNA_APP_ID or ADZUNA_API_KEY missing in .env)');
    return [];
  }
  // 7 markets × 3 query types = 21 calls/day = ~630 calls/month (within 1000-call free tier)
  const markets = ['fr', 'gb', 'us', 'de', 'es', 'it', 'ch'];
  const queries = [
    { what: 'community manager web3', what_or: 'community lead' },
    { what: 'social media manager web3', what_or: 'content manager' },
    { what: 'community manager gaming', what_or: 'social media manager gaming' }
  ];
  const all = [];
  for (const country of markets) {
    for (const q of queries) {
      try {
        const params = new URLSearchParams({
          app_id: APP_ID,
          app_key: API_KEY,
          results_per_page: '20',
          what: q.what,
          what_or: q.what_or || '',
          max_days_old: '7',
          'content-type': 'application/json'
        });
        const url = 'https://api.adzuna.com/v1/api/jobs/' + country + '/search/1?' + params.toString();
        const r = await fetch(url, { headers: UA });
        if (!r.ok) {
          if (r.status === 429) console.error('[Adzuna ' + country + '] rate limited');
          continue;
        }
        const j = await r.json();
        for (const x of (j.results || [])) {
          all.push({
            url: x.redirect_url || x.url,
            title: x.title,
            company: (x.company && x.company.display_name) || 'Adzuna ' + country.toUpperCase()
          });
        }
      } catch(e) { console.error('[Adzuna ' + country + '/' + q.what + ']', e.message); }
    }
  }
  return all;
}

async function fetchWeb3Career() {
  const pages = [
    'https://web3.career/community-manager-jobs',
    'https://web3.career/ecosystem-manager-jobs',
    'https://web3.career/head-of-community-jobs',
    'https://web3.career/marketing-jobs'
  ];
  const all = [];
  for (const url of pages) {
    try {
      const r = await fetch(url, { headers: LINKEDIN_BROWSER_UA });
      if (!r.ok) continue;
      const html = await r.text();
      const links = [...html.matchAll(/<a[^>]+href="\/((?!sitemap|category|blog|company|about|companies|tags|jobs|advertise)[a-z0-9-]+\/(\d+))"/g)];
      const seen = new Set();
      for (const m of links) {
        const path = m[1];
        if (seen.has(path)) continue;
        seen.add(path);
        const slug = path.split('/')[0];
        const title = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        all.push({
          url: 'https://web3.career/' + path,
          title,
          company: 'web3.career'
        });
      }
    } catch(e) { console.error('[Web3.career]', e.message); }
  }
  return all;
}

// Monaco MPF-platform scraper. Both jobmonaco.com and emploi-monaco.com use the same
// Bootstrap + searchmpf_* template (Monaco Public-Private foundation / MPF service).
// Card structure: <div class="card-mpf-joboffer"> with <img alt="{company}"> + <h3><a>{title}</a></h3>
async function fetchMonacoMpf(baseUrl, portalLabel) {
  try {
    const r = await fetch(baseUrl, { headers: LINKEDIN_BROWSER_UA });
    if (!r.ok) return [];
    const html = await r.text();
    // Split by card boundary; first chunk before any card is discarded
    const cards = html.split('card-mpf-joboffer').slice(1);
    const all = [];
    const seenUrls = new Set();
    for (const card of cards) {
      // Look ahead at most ~2500 chars per card (rest belongs to next card or page chrome)
      const slice = card.slice(0, 2500);
      const hrefMatch = slice.match(/href="(\/en\/offers\/[^"]+)"/);
      if (!hrefMatch) continue;
      const offerPath = hrefMatch[1];
      const fullUrl = new URL(baseUrl).origin + offerPath;
      if (seenUrls.has(fullUrl)) continue;
      seenUrls.add(fullUrl);
      const companyMatch = slice.match(/alt="([^"]+)"/);
      const titleMatch = slice.match(/<h3[^>]*>\s*<a[^>]+>\s*([\s\S]+?)\s*<\/a>\s*<\/h3>/);
      const company = (companyMatch && companyMatch[1] !== 'Logo' && companyMatch[1] !== 'logo')
        ? companyMatch[1].trim()
        : portalLabel;
      let title;
      if (titleMatch) {
        title = titleMatch[1].replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();
      } else {
        // Fallback: derive title from URL slug
        const slugPart = offerPath.split('/').pop().replace(/^\d+-/, '');
        title = slugPart.replace(/-/g, ' ');
      }
      if (title) all.push({ url: fullUrl, title, company });
    }
    return all;
  } catch(e) { console.error('[' + portalLabel + ']', e.message); return []; }
}

async function fetchJobMonaco() {
  return fetchMonacoMpf('https://www.jobmonaco.com/en/', 'JobMonaco');
}

async function fetchEmploiMonaco() {
  return fetchMonacoMpf('https://www.emploi-monaco.com/en/', 'Emploi-Monaco');
}

const FEEDS = [
  { id: 'remoteok', label: 'RemoteOK', fetch: fetchRemoteOK },
  { id: 'remotive', label: 'Remotive', fetch: fetchRemotive },
  { id: 'linkedin', label: 'LinkedIn (guest)', fetch: fetchLinkedIn },
  { id: 'hn-whoshiring', label: 'HN Who is Hiring', fetch: fetchHackerNewsWhoshiring },
  { id: 'web3career', label: 'Web3.career', fetch: fetchWeb3Career },
  { id: 'adzuna', label: 'Adzuna (7 markets)', fetch: fetchAdzuna },
  { id: 'jobmonaco', label: 'JobMonaco', fetch: fetchJobMonaco },
  { id: 'emploi-monaco', label: 'Emploi-Monaco', fetch: fetchEmploiMonaco }
];

if (!existsSync('./data/scan-history.tsv')) {
  writeFileSync('./data/scan-history.tsv', 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n');
}
const tsv = readFileSync('./data/scan-history.tsv','utf-8');
const seen = new Set(tsv.trim().split('\n').slice(1).map(l=>l.split('\t')[0]));
// Extended dedup: also block URLs already in pipeline.md (in queue) or applications.md
// (already evaluated/applied/discarded). Prevents resurfacing of user-discarded roles whose
// scan-history entry hasn't been re-marked, plus URLs added to pipeline by agentic scans.
for (const extraFile of ['./data/pipeline.md', './data/applications.md']) {
  if (existsSync(extraFile)) {
    const content = readFileSync(extraFile, 'utf-8');
    const urlMatches = content.match(/https?:\/\/[^\s|)\]>"]+/g) || [];
    for (const u of urlMatches) seen.add(u.replace(/[.,;]$/, ''));
  }
}
const today = new Date().toISOString().slice(0,10);
const newRoles = [];
// Within-run dedup by {company}|{title} to catch boosted re-posts (e.g., RemoteOK companies
// re-posting same role under multiple numeric IDs to game visibility). Key is normalized
// lowercase + collapsed whitespace to absorb minor variations.
const seenCompanyTitle = new Set();
function ctKey(company, title) {
  return ((company || '') + '|' + (title || '')).toLowerCase().replace(/\s+/g, ' ').trim();
}

// Phase 1: ATS APIs (16 known companies)
for (const t of TARGETS) {
  const jobs = await fetchAts(t);
  console.log('['+t.ats+':'+t.company+'] '+jobs.length+' jobs');
  for (const j of jobs) {
    if(!j.url||seen.has(j.url))continue;
    seen.add(j.url);
    const portal = '[API:'+t.ats+'/'+t.slug+']';
    let status;
    if (!match(j.title, t.company)) {
      status = 'skipped_title';
    } else if (!locationOk(j.location, j.url, j.title)) {
      status = 'skipped_location';
    } else {
      const k = ctKey(t.company, j.title);
      if (seenCompanyTitle.has(k)) {
        status = 'skipped_company_title_dup';
      } else {
        seenCompanyTitle.add(k);
        status = 'added';
      }
    }
    appendFileSync('./data/scan-history.tsv',[j.url,today,portal,j.title,t.company,status].join('\t')+'\n');
    if(status==='added'){
      newRoles.push({url:j.url,title:j.title,company:t.company,portal});
      appendFileSync('./data/pipeline.md','- [ ] '+j.url+' | '+t.company+' | '+j.title+'\n');
    }
  }
}

// Phase 2: Public job feeds (RemoteOK, Remotive — broad WebSearch-style coverage)
for (const f of FEEDS) {
  const jobs = await f.fetch();
  console.log('[FEED:'+f.id+'] '+jobs.length+' jobs');
  for (const j of jobs) {
    if(!j.url||seen.has(j.url))continue;
    seen.add(j.url);
    const portal = '[FEED:'+f.id+']';
    const company = j.company || f.label;
    let status;
    if (!match(j.title, company)) {
      status = 'skipped_title';
    } else if (!locationOk(j.location, j.url, j.title)) {
      status = 'skipped_location';
    } else {
      const k = ctKey(company, j.title);
      if (seenCompanyTitle.has(k)) {
        status = 'skipped_company_title_dup';
      } else {
        seenCompanyTitle.add(k);
        status = 'added';
      }
    }
    appendFileSync('./data/scan-history.tsv',[j.url,today,portal,j.title,company,status].join('\t')+'\n');
    if(status==='added'){
      newRoles.push({url:j.url,title:j.title,company,portal});
      appendFileSync('./data/pipeline.md','- [ ] '+j.url+' | '+company+' | '+j.title+'\n');
    }
  }
}

console.log('\nFound '+newRoles.length+' new roles\n');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM || 'career-ops <onboarding@resend.dev>';
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL;
if (!RESEND_API_KEY || !NOTIFY_EMAIL) {
  console.error('Missing RESEND_API_KEY or NOTIFY_EMAIL in .env');
  process.exit(1);
}

function row(r){return '<tr><td style="padding:8px 12px;border-bottom:1px solid #eee;font-weight:600;">'+esc(r.company)+'</td><td style="padding:8px 12px;border-bottom:1px solid #eee;">'+esc(r.title)+'</td><td style="padding:8px 12px;border-bottom:1px solid #eee;color:#999;font-size:11px;">'+esc(r.portal)+'</td><td style="padding:8px 12px;border-bottom:1px solid #eee;"><a href="'+r.url+'" style="color:#2563eb;text-decoration:none;">View</a></td></tr>';}
function tbl(rows){return '<table style="width:100%;border-collapse:collapse;margin-top:8px;"><thead><tr style="background:#f3f4f6;"><th style="padding:10px 12px;text-align:left;font-size:12px;text-transform:uppercase;color:#666;">Company</th><th style="padding:10px 12px;text-align:left;font-size:12px;text-transform:uppercase;color:#666;">Role</th><th style="padding:10px 12px;text-align:left;font-size:12px;text-transform:uppercase;color:#666;">Source</th><th style="padding:10px 12px;text-align:left;font-size:12px;text-transform:uppercase;color:#666;">Link</th></tr></thead><tbody>'+rows+'</tbody></table>';}

const apiHits = newRoles.filter(r=>r.portal.startsWith('[API:'));
const feedHits = newRoles.filter(r=>r.portal.startsWith('[FEED:'));

let subject, html;
if (newRoles.length === 0) {
  const q = QUOTES[Math.floor(Math.random()*QUOTES.length)];
  subject = 'career-ops: no new roles today - ' + today;
  html = '<!DOCTYPE html><html><body style="font-family:-apple-system,Segoe UI,sans-serif;color:#111;max-width:800px;margin:0 auto;padding:24px;">'+
    '<h2>career-ops scan - '+today+'</h2>'+
    '<p style="color:#666;">No new positions today. 16 ATS APIs + 2 public feeds (RemoteOK, Remotive) ran clean.</p>'+
    '<blockquote style="margin:32px 0;padding:18px 24px;border-left:4px solid #2596be;background:#f9f9f9;font-style:italic;font-size:15px;">'+
    '"'+esc(q[0])+'"<br><cite style="display:block;margin-top:10px;font-style:normal;font-size:12px;color:#666;">- '+esc(q[1])+'</cite>'+
    '</blockquote>'+
    '<p style="color:#666;font-size:13px;">And now for something completely different.</p>'+
    '</body></html>';
} else {
  subject = 'career-ops: '+newRoles.length+' new role(s) ('+apiHits.length+' ATS + '+feedHits.length+' feeds) - '+today;
  let body = '<h2>career-ops scan - '+today+'</h2>'+
    '<p style="color:#666;">'+newRoles.length+' new role(s) total &middot; '+apiHits.length+' from direct ATS APIs &middot; '+feedHits.length+' from public job feeds.</p>';
  if (apiHits.length > 0) {
    body += '<h3 style="margin-top:28px;color:#111;font-size:15px;">&#127919; Direct ATS hits ('+apiHits.length+')</h3>'+
      '<p style="color:#666;font-size:12px;margin:0 0 4px 0;">Highest signal: pulled directly from each company Greenhouse / Ashby / Lever endpoint.</p>'+
      tbl(apiHits.map(row).join(''));
  }
  if (feedHits.length > 0) {
    body += '<h3 style="margin-top:28px;color:#111;font-size:15px;">&#127760; Public feeds ('+feedHits.length+')</h3>'+
      '<p style="color:#666;font-size:12px;margin:0 0 4px 0;">Broader discovery: RemoteOK + Remotive aggregator feeds.</p>'+
      tbl(feedHits.map(row).join(''));
  }
  body += '<p style="margin-top:24px;font-size:12px;color:#999;">career-ops daily scan - '+new Date().toISOString()+'</p>';
  html = '<!DOCTYPE html><html><body style="font-family:-apple-system,Segoe UI,sans-serif;color:#111;max-width:980px;margin:0 auto;padding:24px;">'+body+'</body></html>';
}

// --no-email: orchestrators (daily-consolidated.mjs) run this scan as a step
// and send ONE consolidated email themselves — honor the flag so the user
// never gets two emails per cycle. (Regression guard: this flag existed
// before and was lost in an upstream refresh, which double-mailed every run.)
if (process.argv.includes('--no-email')) {
  console.log('[--no-email] Skipping email send. Scan output written to scan-history.tsv + pipeline.md.');
  console.log('Subject would have been: ' + subject);
} else {
  const res = await fetch('https://api.resend.com/emails', {
    method:'POST',
    headers:{'Authorization':'Bearer '+RESEND_API_KEY,'Content-Type':'application/json'},
    body: JSON.stringify({from:RESEND_FROM,to:[NOTIFY_EMAIL],subject,html})
  });
  const body = await res.json().catch(()=>({}));
  if(!res.ok){console.error('Resend HTTP '+res.status+':',JSON.stringify(body));process.exit(1);}
  console.log('Email sent. ID:',body.id||'(no id)','to',NOTIFY_EMAIL);
}
console.log('\nNew roles:');
newRoles.forEach(r=>console.log('  - '+r.company+' / '+r.title));
