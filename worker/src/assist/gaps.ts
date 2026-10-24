// Gap signals (plan Track 11, I13). When several different members needed the same kind of help
// and nobody could provide it, suggest creating capacity (office hours, a clinic) instead of
// pinging more people. Shown only from GAP_MIN_MEMBERS distinct members, in coarse buckets, so a
// signal can't point at one person.

import { DAY, nowIso } from "../util";

export const GAP_MIN_MEMBERS = 5;
export const GAP_WINDOW_DAYS = 90;

/** 5 → "5+", 12 → "10+", 30 → "25+": never an exact small count. */
export function bucket(n: number): string {
  const steps = [100, 50, 25, 10, 5];
  const s = steps.find((x) => n >= x);
  return s ? `${s}+` : "";
}

/** Recompute signals; returns job codes that just crossed the threshold (status 'new'). */
export async function computeGaps(db: D1Database, now = new Date()): Promise<string[]> {
  const since = nowIso(new Date(now.getTime() - GAP_WINDOW_DAYS * DAY));
  const { results } = await db
    .prepare(
      "SELECT job_code, COUNT(DISTINCT member_id) AS members, COUNT(*) AS missions FROM missions " +
        "WHERE updated_at>=? AND (status IN ('failed_with_explanation','no_eligible_provider') " +
        "OR (status='expired' AND id NOT IN (SELECT mission_id FROM outcome_receipts WHERE requester_useful=1))) " +
        "GROUP BY job_code HAVING COUNT(DISTINCT member_id)>=?",
    )
    .bind(since, GAP_MIN_MEMBERS)
    .all<{ job_code: string; members: number; missions: number }>();
  const ts = nowIso(now);
  const fresh: string[] = [];
  for (const r of results) {
    const u = await db
      .prepare(
        "INSERT INTO gap_signals(job_code, members, missions, window_days, status, updated_at) VALUES (?,?,?,?, 'new', ?) " +
          "ON CONFLICT(job_code) DO UPDATE SET members=excluded.members, missions=excluded.missions, updated_at=excluded.updated_at RETURNING status",
      )
      .bind(r.job_code, r.members, r.missions, GAP_WINDOW_DAYS, ts)
      .first<{ status: string }>();
    if (u?.status === "new") fresh.push(r.job_code);
  }
  // Signals whose job no longer qualifies drop off (unless an operator acted on them).
  await db
    .prepare("DELETE FROM gap_signals WHERE status IN ('new','notified') AND job_code NOT IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(results.map((r) => r.job_code)))
    .run();
  return fresh;
}

export async function openGaps(db: D1Database) {
  return (await db.prepare("SELECT job_code, members FROM gap_signals WHERE status IN ('new','notified') ORDER BY members DESC").all<{ job_code: string; members: number }>()).results;
}

export async function setGapStatus(db: D1Database, job: string, status: "notified" | "dismissed" | "actioned"): Promise<boolean> {
  const r = await db.prepare("UPDATE gap_signals SET status=?, updated_at=? WHERE job_code=? RETURNING job_code").bind(status, nowIso(), job).all();
  return r.results.length > 0;
}
