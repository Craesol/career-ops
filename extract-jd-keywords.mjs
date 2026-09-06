#!/usr/bin/env node

/**
 * extract-jd-keywords.mjs — extract ATS-critical keywords from a job description
 *
 * Usage:
 *   node extract-jd-keywords.mjs <jd.txt|jd.md> [--out=keywords.json] [--profile=cv.md,article-digest.md]
 *   node extract-jd-keywords.mjs - < jd.txt              (read from stdin)
 *
 * Output: JSON structure with must-include keywords, verbatim phrases, experience floor,
 * and a provenance section noting which keywords the candidate can honestly claim
 * (cross-checked against cv.md + article-digest.md).
 *
 * ETHICS: Only keywords with proof points in the candidate's CV are marked
 * `honest_include`. Keywords missing from CV are flagged for user awareness but
 * NEVER auto-injected. This is the D phase of the A+D resify-alternative pipeline.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getCareerOpsRoot } from './path-resolver.mjs';
const USER_ROOT = getCareerOpsRoot();

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
let jdPath = null;
let outPath = null;
let profileFiles = ['cv.md'];
if (existsSync(resolve(USER_ROOT, 'article-digest.md'))) profileFiles.push('article-digest.md');

for (const arg of args) {
  if (arg.startsWith('--out=')) outPath = arg.split('=')[1];
  else if (arg.startsWith('--profile=')) profileFiles = arg.split('=')[1].split(',');
  else if (!jdPath) jdPath = arg;
}

if (!jdPath) {
  console.error('Usage: node extract-jd-keywords.mjs <jd.txt> [--out=keywords.json] [--profile=cv.md,article-digest.md]');
  process.exit(1);
}

const jdText = jdPath === '-'
  ? readFileSync(0, 'utf-8')
  : readFileSync(resolve(jdPath), 'utf-8');

const profileText = profileFiles
  .map(f => resolve(__dirname, f))
  .filter(existsSync)
  .map(f => readFileSync(f, 'utf-8'))
  .join('\n\n');

// ----- Extraction helpers -----

const STOPWORDS = new Set([
  'the','and','for','with','you','your','our','their','this','that','these','those',
  'from','into','across','about','around','between','under','over','than','then','when',
  'where','while','through','during','also','being','been','are','was','were','has','have',
  'had','will','can','may','might','must','should','could','would','would','who','what',
  'why','how','which','both','either','neither','each','every','all','any','some','no',
  'not','yes','well','more','most','less','least','many','much','few','several','other',
  'others','same','such','same','own','still','yet','ever','never','always','often',
  'sometimes','usually','typically','required','preferred','plus','strong','excellent',
  'good','great','ideal','solid','proven','deep','high','low','key','core','part','role',
  'team','job','position','opportunity','company','candidate','someone','person','people',
  'we','us','ll','re','ve','job description','job summary','about us','about the role',
  'nice to have','minimum','qualifications','requirements','responsibilities','benefits',
  'equal opportunity','eeo','equal employment','minority','disability','sponsor','sponsorship',
  'apply','send','email','contact','location','remote','onsite','hybrid','office','full time',
  'part time','contract','permanent','fixed term','fte','freelance'
]);

const KNOWN_TOOLS_WEB3 = ['discord','telegram','twitter','x.com','farcaster','lens','solana','ethereum','bitcoin','polygon','arbitrum','optimism','avalanche','sui','aptos','near','move','solidity','rust','defi','nft','dao','tokenomics','web3','on-chain','onchain','ambassador','guild','ecosystem','hub','governance','staking','airdrop','protocol','layer 1','layer 2','l1','l2','rollup','zk-rollup','zk','snark','bridge','wallet','metamask','phantom','walletconnect'];
const KNOWN_TOOLS_TECH = ['react','vue','angular','svelte','nextjs','node','python','java','kotlin','go','rust','typescript','javascript','sql','postgres','mysql','mongo','redis','kafka','aws','gcp','azure','kubernetes','docker','terraform','github','gitlab','jira','slack','notion','asana','figma','miro'];
const KNOWN_TOOLS_MARKETING = ['seo','sem','sea','ppc','cta','ctr','cpc','cpm','cpa','roas','mql','sql','crm','salesforce','hubspot','marketo','pardot','mailchimp','klaviyo','sendgrid','iterable','google analytics','ga4','gtm','tag manager','looker','tableau','segment','amplitude','mixpanel','braze','iterable','tiktok','instagram','linkedin','pinterest','snapchat','youtube','reddit','medium','substack'];
const KNOWN_TOOLS_GAMING = ['unity','unreal','godot','steam','epic','xbox','playstation','nintendo','twitch','discord','battle.net','origin','esports','esl','faceit','streaming','fmv','vfx','shader'];
const KNOWN_CERTS = ['pmp','csm','safe','prince2','itil','ceh','cissp','cisa','aws certified','gcp certified','azure certified','scrum master','product owner','agile','lean six sigma'];

const ALL_KNOWN_TOOLS = new Set([
  ...KNOWN_TOOLS_WEB3, ...KNOWN_TOOLS_TECH, ...KNOWN_TOOLS_MARKETING,
  ...KNOWN_TOOLS_GAMING, ...KNOWN_CERTS,
].map(s => s.toLowerCase()));

const jdLower = jdText.toLowerCase();
const profileLower = profileText.toLowerCase();

// 1) Detect hard skills (named tools present in JD)
const hardSkills = new Set();
for (const tool of ALL_KNOWN_TOOLS) {
  const re = new RegExp(`\\b${tool.replace(/[.+*?^${}()|[\]\\-]/g, '\\$&')}\\b`, 'i');
  if (re.test(jdText)) hardSkills.add(tool);
}

// 2) Detect capitalized product/company/tool names not already captured
const capitalizedTokens = (jdText.match(/\b[A-Z][a-zA-Z0-9]{2,}(?:\s+[A-Z][a-zA-Z0-9]+){0,2}\b/g) || [])
  .map(t => t.trim())
  .filter(t => !/^(The|A|An|And|Or|For|With|You|Your|Our|Their|We|This|That|These|Those|If|When|Where|While|About|Also|Requirements|Responsibilities|Qualifications|Benefits|Location|Remote|Contract|Permanent|Full|Part|Time)$/.test(t));
const capitalizedFrequency = capitalizedTokens.reduce((acc, t) => {
  acc[t] = (acc[t] || 0) + 1;
  return acc;
}, {});
const likelyProperNouns = Object.entries(capitalizedFrequency)
  .filter(([, n]) => n >= 2)
  .map(([t]) => t)
  .slice(0, 20);

// 3) Detect verbatim phrases (bigrams and trigrams occurring 2+ times)
const wordsRaw = jdText.toLowerCase().replace(/[^a-z0-9\s-]/gi, ' ').split(/\s+/).filter(Boolean);
const bigrams = {}, trigrams = {};
for (let i = 0; i < wordsRaw.length - 1; i++) {
  const bg = wordsRaw[i] + ' ' + wordsRaw[i + 1];
  if (wordsRaw[i].length > 2 && wordsRaw[i + 1].length > 2 && !STOPWORDS.has(wordsRaw[i]) && !STOPWORDS.has(wordsRaw[i + 1])) {
    bigrams[bg] = (bigrams[bg] || 0) + 1;
  }
}
for (let i = 0; i < wordsRaw.length - 2; i++) {
  const tg = wordsRaw[i] + ' ' + wordsRaw[i + 1] + ' ' + wordsRaw[i + 2];
  if (![wordsRaw[i], wordsRaw[i + 1], wordsRaw[i + 2]].some(w => STOPWORDS.has(w))) {
    trigrams[tg] = (trigrams[tg] || 0) + 1;
  }
}
const verbatimPhrases = [
  ...Object.entries(bigrams).filter(([, n]) => n >= 2).map(([p, n]) => ({ phrase: p, count: n, n: 2 })),
  ...Object.entries(trigrams).filter(([, n]) => n >= 2).map(([p, n]) => ({ phrase: p, count: n, n: 3 })),
].sort((a, b) => b.count - a.count).slice(0, 25);

// 4) Experience floor
const expMatch = jdText.match(/\b(\d+)\+?\s*(?:\+\s*)?(?:years?|yrs?)\b/i);
const experienceFloor = expMatch ? { years: parseInt(expMatch[1]), text: expMatch[0] } : null;

// 5) Certifications
const foundCerts = KNOWN_CERTS.filter(c => new RegExp(`\\b${c.replace(/[.+*?^${}()|[\]\\-]/g, '\\$&')}\\b`, 'i').test(jdText));

// 6) Job title (heuristic — first "Role:" line or first heading in JD)
const titleMatch = jdText.match(/(?:role|position|job title|title):\s*(.+)/i)
  || jdText.match(/^#+\s+(.+)/m);
const jobTitle = titleMatch ? titleMatch[1].trim() : null;

// 7) Cross-check against CV/profile (ethics gate)
function isInProfile(keyword) {
  const kw = keyword.toLowerCase();
  return profileLower.includes(kw);
}

const hardSkillsArr = [...hardSkills];
const honestHardSkills = hardSkillsArr.filter(isInProfile);
const missingHardSkills = hardSkillsArr.filter(k => !isInProfile(k));

const honestPhrases = verbatimPhrases.filter(p => isInProfile(p.phrase));
const missingPhrases = verbatimPhrases.filter(p => !isInProfile(p.phrase));

const honestProperNouns = likelyProperNouns.filter(isInProfile);
const missingProperNouns = likelyProperNouns.filter(k => !isInProfile(k));

// 8) Assemble output
const output = {
  job_title: jobTitle,
  experience_floor: experienceFloor,
  must_include: {
    hard_skills: honestHardSkills,
    phrases_verbatim: honestPhrases.map(p => p.phrase),
    proper_nouns: honestProperNouns,
    certifications: foundCerts.filter(isInProfile),
  },
  gap_awareness: {
    hard_skills_missing_from_cv: missingHardSkills,
    phrases_missing_from_cv: missingPhrases.map(p => p.phrase),
    proper_nouns_missing_from_cv: missingProperNouns,
    certifications_missing_from_cv: foundCerts.filter(c => !isInProfile(c)),
  },
  provenance: {
    profile_files_checked: profileFiles,
    total_jd_length: jdText.length,
    total_keywords_detected: hardSkillsArr.length + verbatimPhrases.length + likelyProperNouns.length,
    total_honest_include: honestHardSkills.length + honestPhrases.length + honestProperNouns.length,
    ethics_note: "Only keywords with proof points in cv.md + article-digest.md are marked must_include. Gap_awareness keywords are diagnostic only — DO NOT auto-inject.",
  },
};

const json = JSON.stringify(output, null, 2);
if (outPath) {
  writeFileSync(resolve(outPath), json);
  console.log(`✓ Wrote ${outPath}`);
  console.log(`  Must include: ${output.must_include.hard_skills.length} hard skills, ${output.must_include.phrases_verbatim.length} phrases, ${output.must_include.proper_nouns.length} proper nouns`);
  console.log(`  Gap awareness: ${output.gap_awareness.hard_skills_missing_from_cv.length + output.gap_awareness.phrases_missing_from_cv.length + output.gap_awareness.proper_nouns_missing_from_cv.length} items diagnostic only`);
} else {
  console.log(json);
}
