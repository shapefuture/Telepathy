// Skill taxonomy, consent and ranking (P08). Ranking happens only after hard eligibility.
// No personality, health or inferred private traits; a classifier label is never evidence (C08).

import type { Lang } from "./i18n";
import skillsData from "./skills.json";
import { contentTerms, normalize, stemKey, termPresent, tokens } from "./text";
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
/** A skill a person typed in themselves: stored as "my:<text>", shown as the text. */
export const CUSTOM_PREFIX = "my:";
export const CUSTOM_MAX = 20;
/** Clean what was typed into a custom skill code, or null if it is unusable (2 to 40 characters). */
export function customCode(text: string): string | null {
  const t = text.replace(/[\u0000-\u001f\u007f<>&"]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40).trim();
  return t.length >= 2 ? CUSTOM_PREFIX + t : null;
}
/** The name of any skill code: taxonomy label, custom text, or the code itself. */
export const skillName = (code: string, lang: Lang): string => {
  const s = TAXONOMY.get(code);
  return s ? labelIn(s, lang) : code.startsWith(CUSTOM_PREFIX) ? code.slice(CUSTOM_PREFIX.length) : code;
};

/** Full bilingual label (used in /skills all). */
export const label = (s: Skill): string => (s.en === s.ru ? s.en : `${s.en} / ${s.ru}`);
/** Label in one language. */
export const labelIn = (s: Skill, lang: Lang): string => (lang === "ru" ? s.ru : s.en);
export const labelsFor = (codes: string[], lang: Lang): string => codes.map((c) => skillName(c, lang)).join(", ");

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

/** How often this member has answered on a topic in the groups we keep: the "why you" on an invite. */
export async function helpCount(db: D1Database, memberId: string, code: string): Promise<number> {
  const { results } = await db
    .prepare("SELECT body FROM passages WHERE author_id=? AND reply_to IS NOT NULL AND part=0 AND removed_at IS NULL AND body IS NOT NULL ORDER BY event_at DESC LIMIT 300")
    .bind(memberId)
    .all<{ body: string }>();
  return results.filter((r) => matchSkills(r.body, 3).includes(code)).length;
}

const KIND_ORDER = ["weak_conversation_signal", "self_claim", "teaching_contribution", "validated_role", "confirmed_help_outcome"];

export interface Candidate {
  member_id: string;
  total: number;
  components: Record<string, number>;
}

/** Hard filters in SQL (consent, availability, skill, cap, no concurrent intro), then score. */
/** Topics someone who shares a group with this member has offered to help with, most covered first. */
export async function offeredSkills(db: D1Database, requesterId: string, limit = 8): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT s.code, COUNT(DISTINCT m.id) AS n
       FROM skills s JOIN members m ON m.id = s.member_id
       WHERE s.state = 'confirmed' AND m.discoverable = 1 AND m.available = 1 AND m.removed_at IS NULL AND m.collection_opt_out = 0 AND m.id != ?
         AND EXISTS (SELECT 1 FROM source_access a JOIN source_access b ON a.source_id = b.source_id
                     WHERE a.member_id = m.id AND b.member_id = ? AND a.revoked_at IS NULL AND b.revoked_at IS NULL)
       GROUP BY s.code ORDER BY n DESC, s.code LIMIT ?`,
    )
    .bind(requesterId, requesterId, limit)
    .all<{ code: string; n: number }>();
  return results.map((r) => r.code).filter((c) => TAXONOMY.has(c));
}

/** `openWork`: only people who said they're open to projects (hiring requests, plan: «Ищу исполнителя»). */
export async function eligibleCandidates(
  db: D1Database,
  requesterId: string,
  codes: string[],
  now: string,
  exclude: Set<string> = new Set(),
  opts: { openWork?: boolean } = {},
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
         AND (? = 0 OR m.open_work = 1)
         AND NOT (m.quiet_from IS NOT NULL AND ((m.quiet_from <= m.quiet_to AND ? >= m.quiet_from AND ? < m.quiet_to)
                  OR (m.quiet_from > m.quiet_to AND (? >= m.quiet_from OR ? < m.quiet_to))))
         AND m.id != ?
         AND NOT EXISTS (SELECT 1 FROM intros i WHERE i.candidate_id = m.id AND i.requester_id = ?
                         AND i.status IN ('invited','accepted'))
       GROUP BY m.id`,
    )
    .bind(
      weekAgo,
      requesterId,
      requesterId,
      JSON.stringify(codes),
      opts.openWork ? 1 : 0,
      ...Array(4).fill(new Date(now).getUTCHours()),
      requesterId,
      requesterId,
    )
    .all<{ member_id: string; matched: number; kinds: string; pending: number; completed: number; helpful: number; shared: number; req_sources: number }>();
  const out: Candidate[] = [];
  for (const r of results) {
    // One bot serves many communities: only introduce people who share at least one group.
    if (exclude.has(r.member_id) || r.pending >= EXPERT_WEEKLY_CAP || r.shared === 0) continue;
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

/** Whether `hour` (UTC) falls inside someone's quiet hours. */
export const inQuiet = (from: number | null, to: number | null, hour: number): boolean =>
  from !== null && to !== null && ((from <= to && hour >= from && hour < to) || (from > to && (hour >= from || hour < to)));

/**
 * Warm introductions («Нужен выход на…»): people who wrote which doors they can open, in a group whose
 * owner turned introductions on. Matched on the words of their own line; nothing is inferred.
 */
export async function doorCandidates(db: D1Database, requesterId: string, text: string, now: string, exclude: Set<string> = new Set()): Promise<Candidate[]> {
  const terms = contentTerms(text).filter((t) => t.length >= 4);
  if (!terms.length) return [];
  const weekAgo = nowIso(new Date(Date.parse(now) - 7 * DAY));
  const { results } = await db
    .prepare(
      `SELECT DISTINCT m.id AS member_id, m.doors AS doors, m.quiet_from AS quiet_from, m.quiet_to AS quiet_to,
              (SELECT COUNT(*) FROM intros i WHERE i.candidate_id = m.id AND i.created_at >= ?
                 AND i.status IN ('invited','accepted')) AS pending
       FROM members m
       JOIN source_access a ON a.member_id = m.id AND a.revoked_at IS NULL
       JOIN source_access b ON b.source_id = a.source_id AND b.member_id = ? AND b.revoked_at IS NULL
       JOIN sources s ON s.id = a.source_id AND s.enabled = 1 AND s.doors = 1
       WHERE m.doors IS NOT NULL AND m.discoverable = 1 AND m.available = 1 AND m.removed_at IS NULL AND m.collection_opt_out = 0
         AND m.id != ?
         AND NOT EXISTS (SELECT 1 FROM intros i WHERE i.candidate_id = m.id AND i.requester_id = ? AND i.status IN ('invited','accepted'))`,
    )
    .bind(weekAgo, requesterId, requesterId, requesterId)
    .all<{ member_id: string; doors: string; quiet_from: number | null; quiet_to: number | null; pending: number }>();
  const hour = new Date(now).getUTCHours();
  const out: Candidate[] = [];
  for (const r of results) {
    if (exclude.has(r.member_id) || r.pending >= EXPERT_WEEKLY_CAP || inQuiet(r.quiet_from, r.quiet_to, hour)) continue;
    const folded = normalize(r.doors);
    const hits = terms.filter((t) => termPresent(t, folded)).length;
    if (!hits) continue;
    out.push({ member_id: r.member_id, total: Math.round((hits / terms.length) * 10_000) / 10_000, components: { matched: hits, needed: terms.length } });
  }
  return out.sort((a, b) => b.total - a.total || a.member_id.localeCompare(b.member_id));
}
