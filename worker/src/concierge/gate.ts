// The review record behind "auto" (ADR-007). Each action's verdicts come from the cases the owner
// judged. Rules-based decisions and AI decisions keep separate versions, so a prompt change never
// inherits the old prompt's record, and a rule change never inherits a rule that was wrong.

import { PROMPT_VERSION } from "./agent";
import { effectiveLevel, parseAutonomy, type Action, type Level, type ReviewStats } from "./policy";

export const RULES_VERSION = "rules-v1";
const RULE_ACTIONS: Action[] = ["admit", "moderate", "best_answer"];
export const versionFor = (action: Action): string => (RULE_ACTIONS.includes(action) ? RULES_VERSION : PROMPT_VERSION);

export async function stats(db: D1Database, action: Action): Promise<ReviewStats> {
  const r = await db
    .prepare("SELECT SUM(verdict IN ('good','bad')) AS reviewed, SUM(verdict = 'good') AS good FROM concierge_cases WHERE action = ? AND version = ?")
    .bind(action, versionFor(action))
    .first<{ reviewed: number | null; good: number | null }>();
  return { reviewed: r?.reviewed ?? 0, good: r?.good ?? 0 };
}

/** What the agent may do for this action right now: configuration, capped by code and by the record. */
export async function levelFor(db: D1Database, configured: string | undefined, action: Action): Promise<Level> {
  return effectiveLevel(action, parseAutonomy(configured), await stats(db, action));
}

/** The verdict a judgement gives, for the board and the review record. */
export async function setVerdict(db: D1Database, subject: string, verdict: "good" | "bad" | "skip", now = new Date()): Promise<boolean> {
  const r = await db
    .prepare("UPDATE concierge_cases SET verdict=?, reviewed_at=? WHERE subject=? AND verdict IS NULL")
    .bind(verdict, now.toISOString(), subject)
    .run();
  return (r.meta.changes ?? 0) > 0;
}
