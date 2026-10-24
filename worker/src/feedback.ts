// Private answer feedback (P13-05, extends P06-07). Individual votes are never shown;
// only per-passage totals feed a small ranking nudge (search.voteBoost).

import { newId, nowIso } from "./util";

export async function recordAnswer(db: D1Database, memberId: string, passageIds: number[]): Promise<string> {
  const id = newId();
  await db.prepare("INSERT INTO answers(id, member_id, passage_ids, created_at) VALUES (?,?,?,?)").bind(id, memberId, JSON.stringify(passageIds), nowIso()).run();
  return id;
}

const bump = (db: D1Database, col: "up" | "down" | "bad", passageId: number, delta: 1 | -1) =>
  db
    .prepare(`INSERT INTO passage_votes(passage_id, ${col}) VALUES (?, ?) ON CONFLICT(passage_id) DO UPDATE SET ${col} = MAX(0, ${col} + ?)`)
    .bind(passageId, Math.max(0, delta), delta);

/** Apply one button press. Returns "recorded" | "already" | "invalid". */
export async function vote(db: D1Database, answerId: string, memberId: string, action: string): Promise<"recorded" | "already" | "invalid"> {
  const ans = await db.prepare("SELECT passage_ids FROM answers WHERE id=?").bind(answerId).first<{ passage_ids: string }>();
  if (!ans) return "invalid";
  const ids = JSON.parse(ans.passage_ids) as number[];
  const now = nowIso();
  if (action === "up" || action === "down") {
    const other = action === "up" ? "down" : "up";
    const existing = (await db.prepare("SELECT vote FROM answer_votes WHERE answer_id=? AND member_id=? AND vote IN ('up','down')").bind(answerId, memberId).all<{ vote: string }>()).results;
    if (existing.some((e) => e.vote === action)) return "already";
    const stmts: D1PreparedStatement[] = [];
    if (existing.some((e) => e.vote === other)) {
      // Changing your mind replaces the earlier vote instead of counting twice.
      stmts.push(db.prepare("DELETE FROM answer_votes WHERE answer_id=? AND member_id=? AND vote=?").bind(answerId, memberId, other));
      for (const id of ids) stmts.push(bump(db, other, id, -1));
    }
    stmts.push(db.prepare("INSERT INTO answer_votes(answer_id, member_id, vote, created_at) VALUES (?,?,?,?)").bind(answerId, memberId, action, now));
    for (const id of ids) stmts.push(bump(db, action, id, 1));
    await db.batch(stmts);
    return "recorded";
  }
  const m = /^bad(\d)$/.exec(action);
  const passage = m ? ids[Number(m[1])] : undefined;
  if (passage === undefined) return "invalid";
  const r = await db
    .prepare("INSERT OR IGNORE INTO answer_votes(answer_id, member_id, vote, created_at) VALUES (?,?,?,?)")
    .bind(answerId, memberId, `bad:${m![1]}`, now)
    .run();
  if (!r.meta.changes) return "already";
  await bump(db, "bad", passage, 1).run();
  return "recorded";
}
