// Skill taxonomy, consent and ranking (P08). Ranking happens only after hard eligibility.
// No personality, health or inferred private traits; a classifier label is never evidence (C08).

import skillsData from "./skills.json";
import { normalize, stemKey, tokens } from "./text";
import { DAY, nowIso } from "./util";

export interface Skill {
  code: string;
  en: string;
  ru: string;
  synonyms: string[];
}

export const TAXONOMY: Map<string, Skill> = new Map(
  (skillsData as { skills: Skill[] }).skills.map((s) => [s.code, s]),
);
export const label = (s: Skill): string => (s.en === s.ru ? s.en : `${s.en} / ${s.ru}`);

export const WEIGHTS = { domain: 0.4, helpfulness: 0.25, evidence: 0.15, context: 0.1, fairness: 0.1 } as const;
const EVIDENCE: Record<string, number> = {
  validated_role: 1,
  confirmed_help_outcome: 1,
  teaching_contribution: 0.8,
  self_claim: 0.5,
  weak_conversation_signal: 0,
};
export const EXPERT_WEEKLY_CAP = 2;

const PHRASES: [string, string][] = [...TAXONOMY.values()]
  .flatMap((s) => [s.code.replaceAll("_", " "), s.en, s.ru, ...s.synonyms].map((p) => [normalize(p), s.code] as [string, string]))
  .sort((a, b) => b[0].length - a[0].length);

export function matchSkills(text: string, limit = 3): string[] {
  const folded = normalize(text);
  const words = tokens(text);
  const found: string[] = [];
  for (const [phrase, code] of PHRASES) {
    if (found.includes(code)) continue;
    const single = /^[\p{L}\p{N}]+$/u.test(phrase);
    const hit = single
      ? words.some((w) => w === phrase || (phrase.length >= 5 && w.startsWith(stemKey(phrase))))
      : folded.includes(phrase);
    if (hit) found.push(code);
    if (found.length >= limit) break;
  }
  return found;
}

export function resolveSkill(text: string): string | null {
  const t = normalize(text).trim().replaceAll(" ", "_");
  if (TAXONOMY.has(t)) return t;
  return matchSkills(text, 1)[0] ?? null;
}

export interface Signals {
  matched: number;
  needed: number;
  helpful: number;
  completed: number;
  bestKind: string;
  shared: number;
  requesterSources: number;
  pending: number;
}

export function score(s: Signals): { total: number; components: Record<keyof typeof WEIGHTS, number> } {
  const clamp = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 10_000) / 10_000;
  const components = {
    domain: clamp(s.needed ? s.matched / s.needed : 0),
    helpfulness: clamp((s.helpful + 1) / (s.completed + 2)), // smoothed: new experts aren't zeroed
    evidence: clamp(EVIDENCE[s.bestKind] ?? 0),
    context: clamp(s.requesterSources ? s.shared / s.requesterSources : 0),
    fairness: clamp(1 - s.pending / EXPERT_WEEKLY_CAP),
  };
  const total = (Object.keys(WEIGHTS) as (keyof typeof WEIGHTS)[]).reduce((a, k) => a + WEIGHTS[k] * components[k], 0);
  return { total: Math.round(total * 10_000) / 10_000, components };
}

const KIND_ORDER = ["weak_conversation_signal", "self_claim", "teaching_contribution", "validated_role", "confirmed_help_outcome"];

export interface Candidate {
  member_id: string;
  total: number;
  components: Record<string, number>;
}

/** Hard filters in SQL (consent, availability, skill, cap, no concurrent intro), then score. */
export async function eligibleCandidates(
  db: D1Database,
  requesterId: string,
  codes: string[],
  now: string,
  exclude: Set<string> = new Set(),
): Promise<Candidate[]> {
  if (!codes.length) return [];
  const weekAgo = nowIso(new Date(Date.parse(now) - 7 * DAY));
  const { results } = await db
    .prepare(
      `SELECT m.id AS member_id,
              COUNT(DISTINCT s.code) AS matched,
              GROUP_CONCAT(s.kind) AS kinds,
              (SELECT COUNT(*) FROM intros i WHERE i.candidate_id = m.id AND i.created_at >= ?
                 AND i.status IN ('invited','accepted')) AS pending,
              (SELECT COUNT(*) FROM intros i WHERE i.candidate_id = m.id AND i.status = 'completed') AS completed,
              (SELECT COUNT(*) FROM intros i WHERE i.candidate_id = m.id AND i.outcome = 'helpful') AS helpful,
              (SELECT COUNT(*) FROM source_access a JOIN source_access b ON a.source_id = b.source_id
                 WHERE a.member_id = m.id AND b.member_id = ? AND a.revoked_at IS NULL AND b.revoked_at IS NULL) AS shared,
              (SELECT COUNT(*) FROM source_access b WHERE b.member_id = ? AND b.revoked_at IS NULL) AS req_sources
       FROM members m
       JOIN skills s ON s.member_id = m.id AND s.state = 'confirmed' AND s.code IN (SELECT value FROM json_each(?))
       WHERE m.discoverable = 1 AND m.available = 1 AND m.removed_at IS NULL AND m.collection_opt_out = 0
         AND m.id != ?
         AND NOT EXISTS (SELECT 1 FROM intros i WHERE i.candidate_id = m.id AND i.requester_id = ?
                         AND i.status IN ('invited','accepted'))
       GROUP BY m.id`,
    )
    .bind(weekAgo, requesterId, requesterId, JSON.stringify(codes), requesterId, requesterId)
    .all<{ member_id: string; matched: number; kinds: string; pending: number; completed: number; helpful: number; shared: number; req_sources: number }>();
  const out: Candidate[] = [];
  for (const r of results) {
    if (exclude.has(r.member_id) || r.pending >= EXPERT_WEEKLY_CAP) continue;
    const kinds = (r.kinds ?? "self_claim").split(",");
    const bestKind = kinds.reduce((a, b) => (KIND_ORDER.indexOf(b) > KIND_ORDER.indexOf(a) ? b : a));
    const { total, components } = score({
      matched: r.matched,
      needed: codes.length,
      helpful: r.helpful,
      completed: r.completed,
      bestKind,
      shared: r.shared,
      requesterSources: r.req_sources,
      pending: r.pending,
    });
    out.push({ member_id: r.member_id, total, components });
  }
  return out.sort((a, b) => b.total - a.total || a.member_id.localeCompare(b.member_id));
}
