// Best answers (ADR-007, item 3). When the same topic keeps being asked, the club's memory has a
// reply that people found useful. This proposes it as the club's answer, once: the text is the
// reply itself (never a generated one), and accepting it marks it canonical and turns hints on
// for the group (hints are per group, and canonical answers are what they show).

import { markCanonical } from "../features";
import { matchSkills, labelIn, TAXONOMY } from "../experts";
import { newId, nowIso, DAY } from "../util";
import { RULES_VERSION, setVerdict } from "./gate";

export const BEST_MIN_QUESTIONS = 3;
export const BEST_MIN_ANSWERED = 2;
export const BEST_WINDOW_DAYS = 60;
export const BEST_REPEAT_DAYS = 90;

export async function bestStep(db: D1Database, now = new Date()): Promise<number> {
  const { results: sources } = await db.prepare("SELECT id FROM sources WHERE enabled=1").all<{ id: string }>();
  let made = 0;
  for (const s of sources) made += await bestForSource(db, s.id, now);
  return made;
}

interface Question {
  msg_id: number;
  author_id: string | null;
  body: string;
}

async function bestForSource(db: D1Database, sourceId: string, now: Date): Promise<number> {
  const since = nowIso(new Date(now.getTime() - BEST_WINDOW_DAYS * DAY));
  const { results: qs } = await db
    .prepare(
      "SELECT msg_id, author_id, body FROM passages WHERE source_id=? AND part=0 AND removed_at IS NULL AND body IS NOT NULL " +
        "AND intent='help_request' AND intent_conf>=0.55 AND event_at>=? ORDER BY event_at DESC LIMIT 300",
    )
    .bind(sourceId, since)
    .all<Question>();
  const byCode = new Map<string, Question[]>();
  for (const q of qs) for (const code of matchSkills(q.body, 3)) byCode.set(code, [...(byCode.get(code) ?? []), q]);
  let made = 0;
  for (const [code, list] of byCode) {
    if (list.length < BEST_MIN_QUESTIONS) continue;
    const repeat = nowIso(new Date(now.getTime() - BEST_REPEAT_DAYS * DAY));
    if (await db.prepare("SELECT 1 FROM answer_proposals WHERE source_id=? AND code=? AND created_at>=? LIMIT 1").bind(sourceId, code, repeat).first()) continue;
    const { results: replies } = await db
      .prepare(
        "SELECT r.msg_id, r.reply_to, r.author_id, r.body, COALESCE(v.up, 0) AS up FROM passages r LEFT JOIN passage_votes v ON v.passage_id = r.id " +
          "WHERE r.source_id=? AND r.part=0 AND r.removed_at IS NULL AND r.body IS NOT NULL AND length(r.body) >= 40 " +
          "AND r.reply_to IN (SELECT value FROM json_each(?)) ORDER BY up DESC, r.event_at DESC LIMIT 200",
      )
      .bind(sourceId, JSON.stringify(list.map((q) => q.msg_id)))
      .all<{ msg_id: number; reply_to: number; author_id: string | null; body: string; up: number }>();
    const answered = new Set(replies.map((r) => r.reply_to));
    if (answered.size < BEST_MIN_ANSWERED) continue;
    const askedBy = new Map(list.map((q) => [q.msg_id, q.author_id] as const));
    const best = replies.find((r) => r.author_id !== askedBy.get(r.reply_to));
    if (!best) continue;
    const id = newId();
    const at = nowIso(now);
    await db.batch([
      db
        .prepare("INSERT INTO answer_proposals(id, source_id, code, question_msg, answer_msg, status, created_at) VALUES (?,?,?,?,?, 'pending', ?)")
        .bind(id, sourceId, code, list[0]!.msg_id, best.msg_id, at),
      db
        .prepare("INSERT INTO concierge_cases(subject, mode, source_id, version, created_at, action, codes, executed) VALUES (?, 'best', ?, ?, ?, 'best_answer', ?, 0)")
        .bind(`best:${id}`, sourceId, RULES_VERSION, at, JSON.stringify([code])),
    ]);
    made += 1;
  }
  return made;
}

/** The owner's decision on a proposed best answer. */
export async function decideBest(db: D1Database, id: string, verdict: "accept" | "decline" | "skip", now = new Date()): Promise<"ok" | "gone"> {
  const p = await db.prepare("SELECT source_id, answer_msg, status FROM answer_proposals WHERE id=?").bind(id).first<{ source_id: string; answer_msg: number; status: string }>();
  if (!p || p.status !== "pending") return "gone";
  if (verdict === "accept") {
    await markCanonical(db, p.source_id, p.answer_msg);
    await db.prepare("UPDATE sources SET hints=1 WHERE id=?").bind(p.source_id).run();
  }
  const status = verdict === "accept" ? "accepted" : verdict === "decline" ? "declined" : "skipped";
  await db.prepare("UPDATE answer_proposals SET status=?, decided_at=? WHERE id=?").bind(status, nowIso(now), id).run();
  await setVerdict(db, `best:${id}`, verdict === "accept" ? "good" : verdict === "decline" ? "bad" : "skip", now);
  return "ok";
}

export const topicLabel = (code: string, lang: "en" | "ru"): string => {
  const s = TAXONOMY.get(code);
  return s ? labelIn(s, lang) : code;
};
