#!/usr/bin/env node

/**
 * ats-score.mjs — score a generated CV against ATS heuristics + JD keywords
 *
 * Usage:
 *   node ats-score.mjs <cv.html> [--jd-keywords=path/to/keywords.json] [--out=score.json]
 *   node ats-score.mjs tmp/cv-francisco-ultra.html --jd-keywords=tmp/jd-keywords-ultra.json
 *
 * Output: JSON structure with numeric score (0-100), keyword coverage, structural checks,
 * format checks, gaps, and a verdict (pass / iterate / fail).
 *
 * This is the A phase of the A+D resify-alternative pipeline. Run AFTER generating
 * the CV HTML and BEFORE running generate-pdf.mjs. If verdict != "pass", the caller
 * (subagent) should iterate on the reframe with the gap list in the next prompt.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
let cvPath = null;
let jdKeywordsPath = null;
let outPath = null;

for (const arg of args) {
  if (arg.startsWith('--jd-keywords=')) jdKeywordsPath = arg.split('=')[1];
  else if (arg.startsWith('--out=')) outPath = arg.split('=')[1];
  else if (!cvPath) cvPath = arg;
}

if (!cvPath) {
  console.error('Usage: node ats-score.mjs <cv.html> [--jd-keywords=keywords.json] [--out=score.json]');
  process.exit(1);
}

const html = readFileSync(resolve(cvPath), 'utf-8');
const jdKeywords = jdKeywordsPath && existsSync(resolve(jdKeywordsPath))
  ? JSON.parse(readFileSync(resolve(jdKeywordsPath), 'utf-8'))
  : null;

// ----- Extract plain text from HTML (strip tags, keep structure) -----

function extractPlainText(html) {
  // Remove <style> and <script> content entirely
  let text = html.replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  // Convert block breaks to newlines
  text = text.replace(/<\/(p|div|li|h[1-6]|section|article|header|footer|tr|br)>/gi, '\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, ' ');
  // Decode common HTML entities
  text = text.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  // Collapse whitespace
  text = text.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n\n');
  return text.trim();
}

const cvText = extractPlainText(html);
const cvLower = cvText.toLowerCase();

// ----- 1. Keyword coverage -----

function coverage(keywords) {
  if (!keywords || keywords.length === 0) return { present: [], missing: [], pct: 100 };
  const present = [];
  const missing = [];
  for (const kw of keywords) {
    const kwLower = kw.toLowerCase();
    const re = new RegExp(`\\b${kwLower.replace(/[.+*?^${}()|[\]\\-]/g, '\\$&')}\\b`, 'i');
    if (re.test(cvText)) present.push(kw);
    else missing.push(kw);
  }
  return { present, missing, pct: Math.round((present.length / keywords.length) * 100) };
}

let keywordCoverage = null;
if (jdKeywords && jdKeywords.must_include) {
  const hardSkills = coverage(jdKeywords.must_include.hard_skills || []);
  const phrases = coverage(jdKeywords.must_include.phrases_verbatim || []);
  const properNouns = coverage(jdKeywords.must_include.proper_nouns || []);
  const totalRequired = (jdKeywords.must_include.hard_skills || []).length
    + (jdKeywords.must_include.phrases_verbatim || []).length
    + (jdKeywords.must_include.proper_nouns || []).length;
  const totalPresent = hardSkills.present.length + phrases.present.length + properNouns.present.length;
  keywordCoverage = {
    hard_skills: hardSkills,
    phrases_verbatim: phrases,
    proper_nouns: properNouns,
    total_pct: totalRequired > 0 ? Math.round((totalPresent / totalRequired) * 100) : 100,
  };
}

// ----- 2. Structural checks -----

const structural = { issues: [] };

// 2a. Reverse-chronological ordering (heuristic: extract start-year of each role, check if descending)
const experienceSection = (cvText.match(/(?:work\s+experience|professional\s+experience|experience)([\s\S]*?)(?:education|skills|projects|core\s+competencies|$)/i) || [])[1] || '';
// Match "Month YYYY" as a role start-date; ignore end-dates in ranges like "Month YYYY — Month YYYY / Present"
const startDateMatches = experienceSection.match(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+(\d{4})\b/g) || [];
const startYears = startDateMatches
  .map(m => parseInt(m.match(/(\d{4})/)[1]))
  .filter((_, i) => i % 2 === 0); // every OTHER date is a start date (the first of each range)
if (startYears.length >= 3) {
  // Allow small deviations (a role that overlapped years may appear same-year as next entry)
  let broken = 0;
  for (let i = 1; i < startYears.length; i++) {
    if (startYears[i] > startYears[i - 1]) broken++;
  }
  structural.reverse_chron = broken <= 1; // tolerate 1 minor overlap
  structural.reverse_chron_check = { start_years: startYears, broken_count: broken };
  if (!structural.reverse_chron) structural.issues.push(`Work experience does not appear reverse-chronological (${broken} year-order breaks)`);
}

// 2b. Standard section headers — check both HTML class-based sections AND raw text matches
const standardHeaders = ['summary', 'experience', 'skills', 'education'];
const headersFound = standardHeaders.filter(h => {
  const re = new RegExp(`\\b${h}\\b`, 'i');
  // Look inside section-title classes, h1-h6 tags, or the plain-text CV
  const inHtmlSection = new RegExp(`(?:class=["'][^"']*(?:section-title|heading)[^"']*["'][^>]*>[^<]{0,40}\\b${h}\\b|<h[1-6][^>]*>[^<]{0,40}\\b${h}\\b)`, 'i').test(html);
  const inPlainText = re.test(cvText);
  return inHtmlSection || inPlainText;
});
structural.standard_headers_found = headersFound;
if (headersFound.length < 3) {
  structural.issues.push(`Missing standard sections: found only ${headersFound.length}/4 (${headersFound.join(', ')})`);
}

// 2c. Tables inside experience (ATS-hostile)
const tableInExp = /<table[\s\S]*?experience[\s\S]*?<\/table>/i.test(html)
  || /experience[\s\S]{0,2000}?<table/i.test(html);
structural.no_tables_in_experience = !tableInExp;
if (tableInExp) structural.issues.push('Table detected inside/near Experience section — most ATS parsers fail on tabular experience');

// 2d. Text length estimate → page count (~500 words/page for a resume with headings)
const wordCount = (cvText.match(/\S+/g) || []).length;
const estimatedPages = Math.ceil(wordCount / 500);
structural.word_count = wordCount;
structural.estimated_pages = estimatedPages;
if (estimatedPages > 2) structural.issues.push(`Estimated ${estimatedPages} pages — recommend trimming to ≤ 2`);

// 2e. Contact info presence
structural.contact_email_present = /\b[\w.-]+@[\w.-]+\.\w+\b/.test(cvText);
structural.contact_phone_present = /\+?\d[\d\s().-]{7,}/.test(cvText);
if (!structural.contact_email_present) structural.issues.push('No email detected in CV');

// ----- 3. Format checks -----

const format = { issues: [] };

// 3a. Unicode normalization (should have been done by generate-pdf, but flag if raw HTML has issues)
const hasEmDash = /—/.test(html);
const hasEnDash = /–/.test(html);
const hasSmartQuote = /[‘’“”]/.test(html);
const hasZeroWidth = /[​‌‍⁠﻿]/.test(html);
const hasNbsp = / /.test(html);
format.unicode_flags = { emDash: hasEmDash, enDash: hasEnDash, smartQuote: hasSmartQuote, zeroWidth: hasZeroWidth, nbsp: hasNbsp };
if (hasEmDash || hasEnDash || hasSmartQuote || hasZeroWidth || hasNbsp) {
  format.issues.push('HTML contains non-ASCII typographic chars — generate-pdf.mjs will normalize, but ideally the reframe should not introduce them');
}

// 3b. Images in text layer (ATS-hostile)
const imgCount = (html.match(/<img\b/gi) || []).length;
format.image_count = imgCount;
if (imgCount > 0) format.issues.push(`${imgCount} <img> tag(s) detected — most ATS parsers cannot read image-based text`);

// 3c. Multi-column layout detection (heuristic: columns / column-count / flex with multiple children)
const multiCol = /column-count\s*:\s*[2-9]/.test(html)
  || /columns\s*:\s*[2-9]/.test(html)
  || /grid-template-columns/.test(html);
format.multi_column = multiCol;
if (multiCol) format.issues.push('CSS multi-column layout detected — Workday/iCIMS/Taleo commonly misread columns');

// 3d. Headers/footers with content
const hasHeaderContent = /<header\b[^>]*>[\s\S]*?<[^>\s]/.test(html);
format.header_has_content = hasHeaderContent;

// ----- 4. Compute final score -----

const weights = { keyword: 0.5, structural: 0.3, format: 0.2 };
const keywordScore = keywordCoverage ? keywordCoverage.total_pct : 100; // no penalty if no JD keywords provided
const structuralScore = Math.max(0, 100 - structural.issues.length * 15);
const formatScore = Math.max(0, 100 - format.issues.length * 20);

const finalScore = Math.round(
  keywordScore * weights.keyword
  + structuralScore * weights.structural
  + formatScore * weights.format
);

const verdict = finalScore >= 85 ? 'pass' : finalScore >= 70 ? 'iterate' : 'fail';

// ----- 5. Suggestions for gaps -----

const suggestions = [];
if (keywordCoverage) {
  for (const kw of keywordCoverage.hard_skills.missing) {
    suggestions.push({ type: 'hard_skill_missing', keyword: kw, placement: 'Skills section', note: 'Include only if it appears in cv.md — otherwise leave out (ethics rule).' });
  }
  for (const kw of keywordCoverage.phrases_verbatim.missing) {
    suggestions.push({ type: 'phrase_verbatim_missing', keyword: kw, placement: 'Summary or Experience bullet', note: 'Consider using this exact wording verbatim if it matches a proof point.' });
  }
}

// ----- Assemble output -----

const output = {
  score: finalScore,
  verdict,
  keyword_coverage: keywordCoverage,
  structural,
  format,
  suggestions,
  weights,
  breakdown: {
    keyword_score: keywordScore,
    structural_score: structuralScore,
    format_score: formatScore,
  },
  provenance: {
    cv_file: cvPath,
    jd_keywords_file: jdKeywordsPath,
    word_count: wordCount,
    ethics_note: "Missing keywords are diagnostic only. Only inject keywords whose proof points exist in cv.md or article-digest.md.",
  },
};

const json = JSON.stringify(output, null, 2);
if (outPath) {
  writeFileSync(resolve(outPath), json);
  console.log(`✓ Wrote ${outPath}`);
} else {
  console.log(json);
}

// Human-readable summary to stderr
console.error(`\nATS Score: ${finalScore}/100 (${verdict.toUpperCase()})`);
if (keywordCoverage) console.error(`  Keyword coverage: ${keywordCoverage.total_pct}% (${keywordCoverage.hard_skills.present.length + keywordCoverage.phrases_verbatim.present.length + keywordCoverage.proper_nouns.present.length}/${keywordCoverage.hard_skills.present.length + keywordCoverage.hard_skills.missing.length + keywordCoverage.phrases_verbatim.present.length + keywordCoverage.phrases_verbatim.missing.length + keywordCoverage.proper_nouns.present.length + keywordCoverage.proper_nouns.missing.length})`);
console.error(`  Structural: ${structural.issues.length} issues`);
console.error(`  Format:     ${format.issues.length} issues`);
if (verdict !== 'pass') {
  console.error(`\n⚠ Iterate suggested. Top gaps:`);
  suggestions.slice(0, 5).forEach(s => console.error(`  - [${s.type}] ${s.keyword}`));
}
