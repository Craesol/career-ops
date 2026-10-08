/**
 * hard-gates.mjs — the hard-disqualifier classifier, shared (fork-local).
 *
 * One home for the prompt, the model choice and the parser, so gate-triage.mjs
 * and gate-bakeoff.mjs cannot drift apart: the bake-off measures exactly the
 * configuration the nightly runs.
 *
 * WHY A FIXED MODEL, NOT THE RUNNER'S ROTATION. The free tier is 50
 * requests/day for the whole account. openrouter-runner.mjs walks the entire
 * free-model list on failure, so one bad task can spend 19 of the 50. A pinned
 * model is one request per task and a deterministic spend, which is the only
 * shape that fits the cap. Override with CAREER_OPS_GATE_MODEL.
 *
 * Measured 2026-10-09 by gate-bakeoff.mjs: nemotron-3-super scored 8/8 on both
 * verdicts and gate attribution; both Gemma free models returned 429 upstream
 * and nemotron-3.5-lightning timed out at 60s.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { canSpend, record, status } from './openrouter-budget.mjs';

const API = 'https://openrouter.ai/api/v1/chat/completions';

export const DEFAULT_GATE_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free';

export const GATES = ['german', 'french', 'internship', 'volunteer', 'market', 'comp', 'none'];

export const SYSTEM = [
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
  'When the text you are given is only a title and a location, you have little to go on: answer "pass"/"none" unless the title itself states the disqualifier. Never guess a gate from thin input.',
].join('\n');

export function gateModel() {
  return process.env.CAREER_OPS_GATE_MODEL || DEFAULT_GATE_MODEL;
}

export function apiKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  try {
    const env = readFileSync(resolve(getCareerOpsRoot(), '.env'), 'utf8');
    const m = env.match(/^OPENROUTER_API_KEY=(.+)$/m);
    return m ? m[1].trim() : '';
  } catch { return ''; }
}

/** Accept the wrapped {"results":[…]} form, a bare array, or either inside a fence. */
export function parseVerdicts(text) {
  if (!text) return null;
  const t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    const obj = JSON.parse(t);
    if (obj && Array.isArray(obj.results)) return obj.results;
    if (Array.isArray(obj)) return obj;
  } catch { /* fall through */ }
  const start = t.indexOf('[');
  const end = t.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    const arr = JSON.parse(t.slice(start, end + 1));
    return Array.isArray(arr) ? arr : null;
  } catch { return null; }
}

export function buildUserMessage(items) {
  return 'Classify these ' + items.length + ' postings:\n\n'
    + items.map((it, i) => '--- id ' + (i + 1) + ' ---\n' + it.text).join('\n\n');
}

/**
 * Classify a batch in ONE request. `items` is [{ text, ...anything }]; the
 * returned verdicts carry the caller's item back on `item` so nothing has to be
 * re-joined by index afterwards.
 *
 * Returns { ok, verdicts? , error?, spent, budget }.
 */
export async function classifyBatch(items, { timeoutMs = 90_000 } = {}) {
  if (!items || !items.length) return { ok: true, verdicts: [], spent: 0, budget: status() };
  const key = apiKey();
  if (!key) return { ok: false, error: 'no OPENROUTER_API_KEY', spent: 0, budget: status() };
  if (!canSpend(1)) {
    return { ok: false, error: 'daily budget exhausted', spent: 0, budget: status() };
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let out;
  try {
    const resp = await fetch(API, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + key,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/career-ops-hq/career-ops',
        'X-Title': 'career-ops hard-gates',
      },
      body: JSON.stringify({
        model: gateModel(),
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: buildUserMessage(items) }],
        // Room for a reasoning model's visible thinking AND the answer: the
        // bake-off caught nemotron-3.5-lightning spending 1500 tokens narrating
        // and never reaching the JSON.
        max_tokens: 4000,
        temperature: 0,
        response_format: { type: 'json_object' },
      }),
      signal: ctl.signal,
    });
    const body = await resp.text();
    // Counted whether it worked: OpenRouter's docs do not say a failed request
    // is free, and assuming it is would be the one mistake that overspends.
    record(1);
    if (!resp.ok) return { ok: false, error: 'HTTP ' + resp.status + ': ' + body.slice(0, 160), spent: 1, budget: status() };
    const data = JSON.parse(body);
    const choice = data?.choices?.[0] ?? {};
    const verdicts = parseVerdicts(choice?.message?.content) || parseVerdicts(choice?.message?.reasoning);
    if (!verdicts) {
      return {
        ok: false, spent: 1, budget: status(),
        error: 'unparseable (finish=' + (choice?.finish_reason ?? '?')
          + ' contentLen=' + String(choice?.message?.content || '').length + ')',
      };
    }
    // Pair verdicts back to their items by the 1-based id we handed out, and
    // drop anything the model invented an id for.
    out = [];
    for (const v of verdicts) {
      const idx = Number(v?.id) - 1;
      if (!Number.isInteger(idx) || idx < 0 || idx >= items.length) continue;
      const gate = GATES.includes(v?.gate) ? v.gate : 'none';
      const verdict = v?.verdict === 'fail' ? 'fail' : 'pass';
      // A "fail" with gate "none" is incoherent; treat it as a pass rather than
      // discarding a role on a self-contradictory answer.
      out.push({
        item: items[idx],
        verdict: gate === 'none' ? 'pass' : verdict,
        gate,
        why: String(v?.why ?? '').replace(/\s+/g, ' ').slice(0, 120),
      });
    }
    return { ok: true, verdicts: out, spent: 1, budget: status() };
  } catch (e) {
    record(1);
    return {
      ok: false, spent: 1, budget: status(),
      error: e.name === 'AbortError' ? 'timeout ' + timeoutMs / 1000 + 's' : e.message,
    };
  } finally {
    clearTimeout(timer);
  }
}
