// linkedin-alerts-parser.mjs
//
// Reads LinkedIn job alert emails from Gmail (via IMAP + App Password),
// extracts job URLs, fetches title + company from each LinkedIn job page,
// applies the same title_filter as daily-ats-scan.mjs, dedupes against
// scan-history.tsv, and appends new roles to data/pipeline.md.
//
// Processed emails are marked as Seen and moved out of INBOX into the
// label "career-ops/processed" (so they don't get re-processed).
//
// Scheduled to run at 08:55 local, 5 minutes BEFORE daily-ats-scan.mjs.
// New URLs land in data/pipeline.md and get included in the scan's
// consolidated email summary.
//
// Env vars required:
//   GMAIL_USER             — your Gmail address (e.g. traducto@gmail.com)
//   GMAIL_APP_PASSWORD     — Gmail App Password (NOT regular password)
//                            Generate at: https://myaccount.google.com/apppasswords
//
// IMPORTANT: POSITIVE and NEGATIVE arrays below are duplicated from
// daily-ats-scan.mjs. They MUST stay in sync. If you edit one, edit both.

import 'dotenv/config';
import { readFileSync, appendFileSync, existsSync, writeFileSync } from 'fs';
import { ImapFlow } from 'imapflow';

// ============================================================
// FILTER CONSTANTS — KEEP IN SYNC WITH daily-ats-scan.mjs lines 4-5
// ============================================================
const POSITIVE = ['community manager','community lead','community director','head of community','vp of community','community builder','community operations','ecosystem manager','ecosystem lead','ambassador','guild','dao','program manager','program lead','head of programs','community program','partnership manager','partnerships lead','head of partnerships','project manager','senior project manager','pmo','delivery manager','engagement manager','web3','blockchain','crypto','defi','nft','token','protocol','decentralized','on-chain','move','layer 1','layer 2','gaming','esports','game community','player experience','content manager','content strategist','communications manager','social media manager','brand manager','localization manager','localization project manager','translation project manager','impact','social impact','ngo','nonprofit','chef de projet','responsable communaute','charge de projet','chargé de projet','chargé de communication','responsable communication','responsable marketing','chargé de marketing','chargé web marketing','marketing','communication'];
const NEGATIVE = ['intern','internship','junior','entry level','accountant','finance manager','legal','lawyer','data scientist','machine learning','software engineer','backend engineer','frontend engineer','full-stack engineer','full stack engineer','fullstack engineer','blockchain engineer','protocol engineer','smart contract engineer','rust engineer','solidity engineer','rust blockchain engineer','infrastructure engineer','platform engineer','data engineer','ml engineer','ai engineer','site reliability engineer','sre','qa engineer','test engineer','security engineer','embedded engineer','firmware engineer','devops engineer','staff engineer','principal engineer','senior engineer','lead engineer','engineering manager','vp engineering','head of engineering','director of engineering','cto','ios','android','devops','cobol','mainframe','oracle ebs','technical program manager','technical project manager','infrastructure technology','it project manager','it program manager','technology project manager','product manager','director of product','head of product','vp of product','business operations','marketing operations','player support','revenue operations','sales operations','d2c','live ops manager','liveops manager','live service manager','recruiter','talent acquisition','people operations','human resources','designer','design lead','quality assurance','solutions architect','sales executive','account executive','customer success','stage','stagiaire','stagier','alternance','alternant','apprenti','apprentice','apprentissage','bts','bachelor','dut','licence pro','contrat pro','professionnalisation','volontariat','vie ','pfe','tfe','bénévolat','bénévole','benevolat','benevole','volunteer','developer relations','devrel','developer advocate','developer evangelist','developer experience','dx engineer','developer marketing','ecosystem growth','head of ecosystem growth','vp ecosystem growth','director of ecosystem growth'];

function hasKeyword(text, kw) {
  if (kw.length <= 5) {
    const re = new RegExp('\\b' + kw.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&') + '\\b', 'i');
    return re.test(text);
  }
  return text.toLowerCase().includes(kw);
}

function match(t) {
  const x = (t || '');
  if (NEGATIVE.some(n => hasKeyword(x, n))) return false;
  return POSITIVE.some(p => hasKeyword(x, p));
}

// ============================================================
// LinkedIn job page fetcher
// ============================================================
const LINKEDIN_BROWSER_UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36' };

async function fetchLinkedInJobMeta(jobUrl) {
  try {
    const r = await fetch(jobUrl, { headers: LINKEDIN_BROWSER_UA });
    if (!r.ok) return null;
    const html = await r.text();

    // Strategy 1: JSON-LD structured data (most reliable)
    const jsonLdMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    if (jsonLdMatch) {
      try {
        const j = JSON.parse(jsonLdMatch[1]);
        const title = j.title;
        const company = j.hiringOrganization && j.hiringOrganization.name;
        if (title && company) return { title: String(title).trim(), company: String(company).trim(), html };
      } catch (_e) { /* fall through to title tag */ }
    }

    // Strategy 2: <title> tag — typical format "Title - Company | LinkedIn"
    const titleTagMatch = html.match(/<title>([\s\S]*?)<\/title>/);
    if (titleTagMatch) {
      let raw = titleTagMatch[1].trim();
      raw = raw.replace(/\s*\|\s*LinkedIn\s*$/i, '');
      // Try " hiring " separator first (very common LinkedIn page title pattern)
      let hiringMatch = raw.match(/^(.+?)\s+hiring\s+(.+)$/i);
      if (hiringMatch) {
        return { title: hiringMatch[2].trim(), company: hiringMatch[1].trim(), html };
      }
      // Fallback: split on " - " or " – "
      const parts = raw.split(/\s+[-–]\s+/);
      if (parts.length >= 2) {
        return { title: parts[0].trim(), company: parts[parts.length - 1].trim(), html };
      }
      // Last resort: whole thing is the title, no company
      return { title: raw.trim(), company: 'LinkedIn (unknown company)', html };
    }

    return null;
  } catch (_e) { return null; }
}

// ============================================================
// Stage / internship body-check (reused logic from daily-ats-scan.mjs)
// ============================================================
const STAGE_MARKERS = [
  /\bemployment type[^<]{0,40}internship/i,
  /\btype d['e]?\s*contrat[^<]{0,40}stage/i,
  /\bstage\s+de\s+\d/i,
  /\bdur[ée]e\s+du\s+stage\b/i,
  /\bconvention\s+de\s+stage\b/i,
  /\bgratification\s+de\s+stage\b/i,
  /\bindemnit[ée]\s+de\s+stage\b/i,
  /\bcontrat\s+d['e]?\s*apprentissage\b/i,
  /\bcontrat\s+de\s+professionnalisation\b/i,
  /\balternance\s+de\s+\d/i,
  /selon\s+la\s+r[ée]glementation[^<]{0,60}stage/i,
  /\binternship\s+(position|role|opportunity)\b/i
];

function isStageFromHtml(html) {
  return STAGE_MARKERS.some(re => re.test(html));
}

// ============================================================
// Email body parser — extracts LinkedIn job IDs
// ============================================================
function extractLinkedInJobIds(emailBody) {
  const ids = new Set();
  // LinkedIn alert emails use either:
  //   /jobs/view/{id}/?...tracking...
  //   /comm/jobs/view/{id}/?...tracking...
  // Job IDs are typically 9-11 digits, but allow 8-13 to be safe.
  const re = /\/(?:comm\/)?jobs\/view\/(\d{8,13})/g;
  let m;
  while ((m = re.exec(emailBody)) !== null) {
    ids.add(m[1]);
  }
  return [...ids];
}

// ============================================================
// Main
// ============================================================
async function main() {
  const GMAIL_USER = process.env.GMAIL_USER;
  const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    console.error('FATAL: Missing GMAIL_USER or GMAIL_APP_PASSWORD in .env');
    process.exit(1);
  }

  const today = new Date().toISOString().slice(0, 10);

  // Ensure scan-history.tsv exists + load seen set
  if (!existsSync('./data/scan-history.tsv')) {
    writeFileSync('./data/scan-history.tsv', 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n');
  }
  const tsv = readFileSync('./data/scan-history.tsv', 'utf-8');
  const seen = new Set(tsv.trim().split('\n').slice(1).map(l => l.split('\t')[0]));

  // Connect to Gmail IMAP
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    logger: false
  });

  try {
    await client.connect();
  } catch (e) {
    console.error('FATAL: IMAP connection failed -', e.message);
    process.exit(1);
  }

  // Ensure processed label exists (Gmail creates it on first messageMove,
  // but we create it explicitly so it's visible immediately in the UI)
  const PROCESSED_LABEL = 'career-ops/processed';
  try {
    await client.mailboxCreate(PROCESSED_LABEL);
    console.log('Created label: ' + PROCESSED_LABEL);
  } catch (_e) {
    // Already exists — silent
  }

  // LinkedIn alert sender addresses
  const SENDERS = [
    'jobalerts-noreply@linkedin.com',
    'jobs-noreply@linkedin.com',
    'jobs-listings@linkedin.com'
  ];

  let processedEmails = 0;
  const newRoles = [];
  const skippedTitle = [];
  const skippedDup = [];

  const lock = await client.getMailboxLock('INBOX');
  try {
    for (const sender of SENDERS) {
      const uids = await client.search({ from: sender, seen: false }, { uid: true });
      if (!uids || uids.length === 0) {
        console.log('[' + sender + '] 0 unread');
        continue;
      }
      console.log('[' + sender + '] ' + uids.length + ' unread');

      for (const uid of uids) {
        let msg;
        try {
          msg = await client.fetchOne(uid, { source: true, envelope: true }, { uid: true });
        } catch (e) {
          console.error('  ERROR fetching uid ' + uid + ':', e.message);
          continue;
        }
        if (!msg || !msg.source) continue;

        const body = msg.source.toString('utf-8');
        const subject = (msg.envelope && msg.envelope.subject) || '(no subject)';
        const jobIds = extractLinkedInJobIds(body);

        console.log('  ✉ "' + subject.slice(0, 70) + '" → ' + jobIds.length + ' job URL(s)');

        for (const id of jobIds) {
          const url = 'https://www.linkedin.com/jobs/view/' + id + '/';

          if (seen.has(url)) {
            skippedDup.push(url);
            appendFileSync('./data/scan-history.tsv',
              [url, today, '[ALERT:linkedin-premium]', '', '', 'skipped_dup'].join('\t') + '\n');
            seen.add(url);
            continue;
          }

          // Fetch metadata (title + company) from LinkedIn page
          const meta = await fetchLinkedInJobMeta(url);
          if (!meta) {
            console.log('    ⚠ No metadata for ' + url + ' (LinkedIn may have removed posting)');
            appendFileSync('./data/scan-history.tsv',
              [url, today, '[ALERT:linkedin-premium]', '', '', 'fetch_failed'].join('\t') + '\n');
            seen.add(url);
            continue;
          }

          seen.add(url);

          // Apply title filter
          let status;
          if (!match(meta.title)) {
            status = 'skipped_title';
            skippedTitle.push({ url, title: meta.title, company: meta.company });
          } else if (isStageFromHtml(meta.html)) {
            status = 'skipped_stage';
            console.log('    ⚠ STAGE detected & dropped: ' + meta.title);
          } else {
            status = 'added';
          }

          appendFileSync('./data/scan-history.tsv',
            [url, today, '[ALERT:linkedin-premium]', meta.title, meta.company, status].join('\t') + '\n');

          if (status === 'added') {
            newRoles.push({ url, title: meta.title, company: meta.company });
            appendFileSync('./data/pipeline.md',
              '- [ ] ' + url + ' | ' + meta.company + ' | ' + meta.title + '\n');
            console.log('    ✓ Added: ' + meta.company + ' / ' + meta.title);
          }
        }

        // Mark as read + move out of INBOX into processed label
        try {
          await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
          await client.messageMove(uid, PROCESSED_LABEL, { uid: true });
          processedEmails++;
        } catch (e) {
          console.error('  ERROR moving uid ' + uid + ':', e.message);
        }
      }
    }
  } finally {
    lock.release();
    await client.logout();
  }

  // Summary
  console.log('\n=== Summary ===');
  console.log('Emails processed: ' + processedEmails);
  console.log('New roles in pipeline.md: ' + newRoles.length);
  console.log('Skipped (title filter): ' + skippedTitle.length);
  console.log('Skipped (duplicates): ' + skippedDup.length);
  if (newRoles.length > 0) {
    console.log('\nNew roles:');
    newRoles.forEach(r => console.log('  - ' + r.company + ' / ' + r.title));
    console.log('\n→ Run /career-ops pipeline to evaluate, or wait for daily-ats-scan.mjs to consolidate.');
  }
}

main().catch(e => {
  console.error('FATAL:', e.message);
  console.error(e.stack);
  process.exit(1);
});
