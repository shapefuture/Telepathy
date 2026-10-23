// Data rights and retention (P08-09, P11-07, C06, C13, K15).

import { audit, DAY, nowIso } from "./util";

export async function forgetMember(db: D1Database, memberId: string, tgId: number): Promise<{ passages: number; skills: number; intros: number }> {
  const now = nowIso();
  const [p, s, , , i] = await db.batch([
    // RETURNING gives exact counts (D1's meta.changes also counts FTS trigger writes).
    db.prepare("UPDATE passages SET body=NULL, removed_at=? WHERE author_id=? AND removed_at IS NULL RETURNING id").bind(now, memberId),
    db.prepare("DELETE FROM skills WHERE member_id=? RETURNING code").bind(memberId),
    db.prepare("DELETE FROM answer_votes WHERE member_id=?").bind(memberId),
    db.prepare("DELETE FROM answers WHERE member_id=?").bind(memberId),
    db
      .prepare(
        "UPDATE intros SET status='cancelled', updated_at=? WHERE (requester_id=? OR candidate_id=?) " +
          "AND status IN ('invited','accepted','mutually_confirmed') RETURNING id",
      )
      .bind(now, memberId, memberId),
    db.prepare("UPDATE needs SET status='cancelled', text='[removed]' WHERE member_id=?").bind(memberId),
    db.prepare("UPDATE effects SET state='failed', error='member forgotten', updated_at=? WHERE state='pending' AND chat_id=?").bind(now, tgId),
    db
      .prepare("UPDATE members SET discoverable=0, available=0, digest=0, collection_opt_out=1 WHERE id=?")
      .bind(memberId),
  ]);
  const report = { passages: p!.results.length, skills: s!.results.length, intros: i!.results.length };
  await audit(db, "member.forget", memberId, memberId, report);
  return report;
}

/** Purge only for groups where an owner set /retention N (0 = keep full history). */
export async function applyRetention(db: D1Database, now = new Date(), batch = 500): Promise<number> {
  const { results } = await db.prepare("SELECT id, retention_days FROM sources WHERE retention_days > 0").all<{ id: string; retention_days: number }>();
  let total = 0;
  for (const s of results) {
    const cutoff = nowIso(new Date(now.getTime() - s.retention_days * DAY));
    const r = await db
      .prepare(
        "UPDATE passages SET body=NULL, removed_at=? WHERE id IN " +
          "(SELECT id FROM passages WHERE source_id=? AND removed_at IS NULL AND event_at < ? LIMIT ?) RETURNING id",
      )
      .bind(nowIso(now), s.id, cutoff, batch)
      .all();
    total += r.results.length;
  }
  if (total) await audit(db, "retention.purge", "system", null, { passages: total });
  return total;
}
