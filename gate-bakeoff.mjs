#!/usr/bin/env node
/**
 * gate-bakeoff.mjs — pick the free OpenRouter model for hard-gate classification
 * (fork-local, one-off but kept so the choice can be re-measured).
 *
 * The free tier allows 50 requests/day for the whole account, so choosing a
 * model by reading its name is not acceptable and testing it on one case each
 * is wasteful. Every candidate therefore gets exactly ONE request carrying all
 * the test cases at once — which is also the batching pattern the real
 * classifier must use, so this doubles as proof that it works.
 *
 * Spend is routed through lib/openrouter-budget.mjs, so this run is counted
 * against the same cap the scheduled jobs share.
 *
 * Usage:
 *   node gate-bakeoff.mjs                 # test the default candidate list
 *   node gate-bakeoff.mjs --models a,b    # test specific models
 *   node gate-bakeoff.mjs --dry           # show the prompt and spend nothing
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { canSpend, record, status } from './lib/openrouter-budget.mjs';

const ROOT = getCareerOpsRoot();
const API = 'https://openrouter.ai/api/v1/chat/completions';

// Instruction-following chat models only. Deliberately excluded from the 19 the
// account can see: google/lyria-* (music generation), poolside/laguna-*,
// cohere/north-mini-code (code models), inclusionai/ling-3.1-flash and
// dots-studio/dots-3-note-preview (unknown shape), openrouter/free (a meta
// router — it hides which model answered, which makes a bake-off meaningless).
const DEFAULT_CANDIDATES = [
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nvidia/nemotron-3.5-lightning:free',
];

/**
 * The gates come from modes/_brief.md. Each case states the single reason it
 * should fail, so a model that fails a case for the WRONG gate is caught too —
 * being right by accident is not good enough for something that will filter
 * real applications.
 */
const CASES = [
  { id: 1, expect: 'fail', gate: 'german',     jd: 'Content Creator & Social Media Manager - German & French Markets. Fluent, native-level German required for our DACH audience. Remote within Europe.' },
  { id: 2, expect: 'fail', gate: 'french',     jd: 'Community Manager, Paris. Francais courant exige (C1 minimum). Vous animerez une communaute francophone. CDI, 45-55k EUR.' },
  { id: 3, expect: 'fail', gate: 'internship', jd: 'Community Manager Intern - 6-month stage, convention de stage required. Gratification legale. Based in Lyon, hybrid.' },
  { id: 4, expect: 'fail', gate: 'volunteer',  jd: 'Volunteer Community Moderator for our Discord. Unpaid, 5h/week, great for building your portfolio. Fully remote.' },
  { id: 5, expect: 'fail', gate: 'market',     jd: 'Community Manager, APAC. You will grow our Singapore and Indonesia communities, working APAC hours. Remote.' },
  { id: 6, expect: 'fail', gate: 'comp',       jd: 'Community Lead, fully remote in Europe. English working language. Salary: 32,000 EUR per year, no equity.' },
  { id: 7, expect: 'pass', gate: 'none',       jd: 'Head of Community, remote within the EU. English is our working language. You will own community strategy end to end. 70,000-90,000 EUR plus equity.' },
  { id: 8, expect: 'pass', gate: 'none',       jd: 'Senior Community Manager (Remote, EMEA). Build and run our Discord and Telegram programmes. English required; other languages a plus. Competitive salary.' },
];

const SYSTEM = [
  'You classify job postings against a fixed set of HARD DISQUALIFIERS for one specific candidate.',
  'The candidate: Spanish native, English C2, French only B1-B2 (cannot work in French above that, cannot do French-facing community work), NO German and no other languages. 20+ years experience. Hard salary floor 50,000 EUR per year. Based in France, targets remote-EU or Europe-hybrid roles.',
  '',
  'Return ONLY a JSON OBJECT with a "results" array, no prose, no markdown fence. One entry per posting, all of them:',
  '{"results": [{"id": <number>, "verdict": "pass" | "fail", "gate": "german" | "french" | "internship" | "volunteer" | "market" | "comp" | "none", "why": "<12 words max>"}]}',
  'A top-level array is NOT accepted: the response must be an object whose only key is "results".',
  '',
  'The gates, and nothing else counts as a fail:',
  '  german     - the posting requires German (or Dutch, Mandarin, Japanese, Korean, Arabic, Turkish, Hindi, Thai, Vietnamese, Indonesian, Tagalog) at any working level.',
  '  french     - it requires French above B1-B2: native, bilingual, C1+, "courant", or the audience/community is French-only.',
  '  internship - internship, stage, stagiaire, alternance, apprenticeship, trainee, Werkstudent, Praktikum, beca, practicas, working student, or a new-grad scheme.',
  '  volunteer  - unpaid, volunteer, benevolat, voluntariado.',
  '  market     - the role is anchored to a non-European LOCAL audience (APAC, Middle East, LATAM, India, Brazil, Japan, China), even if listed as remote.',
  '               EMEA, Europe, EU, UK, DACH-as-a-region, "global", "worldwide" and "international" are NOT market anchors - EMEA and global roles INCLUDE Europe and must pass this gate.',
  '               A false "market" verdict is the costliest mistake you can make here: it silently discards a role the candidate wants. When the audience is not clearly non-European, answer "none".',
  '  comp       - a STATED salary or range whose top is below 50,000 EUR per year. Unstated compensation is NOT a fail.',
  '  none       - no gate applies; verdict is "pass".',
  '',
  'If a posting trips more than one gate, report the first one in the list above. Judge only what the text says; never infer a gate from a company name or a guess.',
].join('\n');

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : null;
}

function apiKey() {
  const direct = process.env.OPENROUTER_API_KEY;
  if (direct) return direct;
  try {
    const env = readFileSync(resolve(ROOT, '.env'), 'utf8');
    const m = env.match(/^OPENROUTER_API_KEY=(.+)$/m);
    return m ? m[1].trim() : '';
  } catch { return ''; }
}

function userMessage() {
  return 'Classify these ' + CASES.length + ' postings:\n\n'
    + CASES.map((c) => '--- id ' + c.id + ' ---\n' + c.jd).join('\n\n');
}

/** Pull the JSON array out of a reply that may be fenced or padded with prose. */
export function parseVerdicts(text) {
  if (!text) return null;
  let t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  // Accept either a bare array or the wrapped {"results":[...]} form that
  // response_format:json_object requires. The first bake-off run proved a model
  // will honour the object constraint over an instruction asking for an array.
  try {
    const obj = JSON.parse(t);
    if (obj && Array.isArray(obj.results)) return obj.results;
    if (Array.isArray(obj)) return obj;
  } catch { /* fall through to bracket extraction */ }
  const start = t.indexOf('[');
  const end = t.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    const arr = JSON.parse(t.slice(start, end + 1));
    return Array.isArray(arr) ? arr : null;
  } catch { return null; }
}

export function scoreVerdicts(verdicts) {
  const byId = new Map();
  for (const v of verdicts || []) if (v && typeof v.id === 'number') byId.set(v.id, v);
  let verdictOk = 0;
  let gateOk = 0;
  const detail = [];
  for (const c of CASES) {
    const v = byId.get(c.id);
    const vOk = v && v.verdict === c.expect;
    const gOk = vOk && v.gate === c.gate;
    if (vOk) verdictOk++;
    if (gOk) gateOk++;
    detail.push({
      id: c.id, expect: c.expect, expectGate: c.gate,
      got: v ? v.verdict : '(missing)', gotGate: v ? v.gate : '(missing)',
      verdictOk: Boolean(vOk), gateOk: Boolean(gOk),
    });
  }
  return { verdictOk, gateOk, total: CASES.length, detail };
}

async function callModel(model, key) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 60_000);
  try {
    const resp = await fetch(API, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + key,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/career-ops-hq/career-ops',
        'X-Title': 'career-ops gate-bakeoff',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: userMessage() }],
        // 4000, not 1500: the first run showed nemotron-3.5-lightning spending
        // its whole allowance narrating a visible chain of thought and never
        // reaching the JSON, and nemotron-3-super returning empty. A reasoning
        // model needs room for the thinking AND the answer.
        max_tokens: 4000,
        temperature: 0,
        // Ask for JSON natively where the provider supports it. Harmless where
        // it does not — OpenRouter forwards it and non-supporting models ignore
        // the hint rather than erroring.
        response_format: { type: 'json_object' },
      }),
      signal: ctl.signal,
    });
    const bodyText = await resp.text();
    if (!resp.ok) return { ok: false, error: 'HTTP ' + resp.status + ': ' + bodyText.slice(0, 180) };
    const data = JSON.parse(bodyText);
    const choice = data?.choices?.[0] ?? {};
    // Some reasoning models put the answer in `content` and the thinking in a
    // sibling `reasoning` field; others emit the thinking INTO content and
    // truncate. Capture both plus finish_reason so a failure is diagnosable
    // instead of just "unparseable".
    const content = choice?.message?.content ?? '';
    return {
      ok: true,
      content,
      reasoning: choice?.message?.reasoning ?? null,
      finish: choice?.finish_reason ?? choice?.native_finish_reason ?? null,
      usage: data?.usage ?? null,
    };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'timeout 60s' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

const models = (arg('models') || '').split(',').map((s) => s.trim()).filter(Boolean);
const candidates = models.length ? models : DEFAULT_CANDIDATES;

if (process.argv.includes('--dry')) {
  console.log('SYSTEM:\n' + SYSTEM + '\n\nUSER:\n' + userMessage());
  console.log('\ncandidates: ' + candidates.join(', '));
  console.log('budget: ' + JSON.stringify(status()));
  process.exit(0);
}

const key = apiKey();
if (!key) {
  console.error('No OPENROUTER_API_KEY in env or .env');
  process.exit(1);
}

const need = candidates.length;
if (!canSpend(need)) {
  console.error('Budget exhausted: need ' + need + ', ' + JSON.stringify(status()));
  process.exit(1);
}

console.log('budget before: ' + JSON.stringify(status()));
console.log('one request per candidate, ' + CASES.length + ' cases batched into each\n');

const results = [];
for (const model of candidates) {
  process.stdout.write('  ' + model.padEnd(44));
  const r = await callModel(model, key);
  record(1); // counted whether it worked or not
  if (!r.ok) {
    console.log('FAILED  ' + r.error);
    results.push({ model, ok: false, error: r.error });
    continue;
  }
  // Try content first, then the sibling reasoning field — a model that put the
  // JSON after its thinking still answered correctly.
  const verdicts = parseVerdicts(r.content) || parseVerdicts(r.reasoning);
  if (!verdicts) {
    const why = 'finish=' + (r.finish ?? '?')
      + ' contentLen=' + String(r.content || '').length
      + ' reasoningLen=' + String(r.reasoning || '').length
      + (r.usage ? ' tok=' + (r.usage.total_tokens ?? '?') : '');
    console.log('UNPARSEABLE  ' + why);
    results.push({
      model, ok: false, error: 'unparseable (' + why + ')',
      raw: String(r.content || r.reasoning || '').slice(0, 500),
    });
    continue;
  }
  const s = scoreVerdicts(verdicts);
  console.log('verdicts ' + s.verdictOk + '/' + s.total + '   gates ' + s.gateOk + '/' + s.total
    + (r.usage ? '   tok ' + (r.usage.total_tokens ?? '?') : ''));
  results.push({ model, ok: true, ...s });
}

console.log('\nbudget after: ' + JSON.stringify(status()));

const winners = results.filter((r) => r.ok).sort((a, b) => (b.gateOk - a.gateOk) || (b.verdictOk - a.verdictOk));
if (winners.length) {
  console.log('\nbest: ' + winners[0].model + '  (verdicts ' + winners[0].verdictOk + '/' + winners[0].total
    + ', gates ' + winners[0].gateOk + '/' + winners[0].total + ')');
  console.log('\nper-case detail for the best model:');
  for (const d of winners[0].detail) {
    const mark = d.gateOk ? 'OK  ' : (d.verdictOk ? 'GATE' : 'WRONG');
    console.log('  ' + mark + ' id' + d.id + '  expected ' + d.expect + '/' + d.expectGate
      + '  got ' + d.got + '/' + d.gotGate);
  }
}
for (const r of results.filter((x) => !x.ok)) {
  console.log('\n' + r.model + ' -> ' + r.error + (r.raw ? '\n  raw: ' + r.raw.replace(/\s+/g, ' ') : ''));
}
