// Live suggestions (ADR-007, item 2). A request still unanswered after the routing delay is
// escalated: the concierge reads what the group already said and proposes one step. The admin's ✅
// sends it (a reply under the request, or routing to people who know). Once the action has been
// earned (gate.ts) it goes out on its own. Every judgement is a review that feeds the gate.

import type { App } from "../bot";
import { ROUTE_AFTER, ROUTE_MAX_AGE, routeQuestion } from "../features";
import { T, defaultLang } from "../i18n";
import { effectStatement } from "../outbox";
import { escapeHtml } from "../text";
import { nowIso } from "../util";
import { conciergeModel, decide, PROMPT_VERSION } from "./agent";
import { conversationsFor } from "./context";
import { levelFor } from "./gate";

export const LIVE_PER_RUN = 3;

interface Open {
  id: number;
  source_id: string;
  msg_id: number;
  author_id: string | null;
  body: string;
  event_at: string;
  topic_id: number | null;
  chat_id: number;
  username: string | null;
}

export async function liveStep(app: App, now = new Date()): Promise<number> {
  if (!conciergeModel(app)) return 0;
  const { results } = await app.db
    .prepare(
      "SELECT p.id, p.source_id, p.msg_id, p.author_id, p.body, p.event_at, p.topic_id, s.chat_id, s.username FROM passages p " +
        "JOIN sources s ON s.id = p.source_id AND s.enabled = 1 " +
        "WHERE p.part = 0 AND p.removed_at IS NULL AND p.body IS NOT NULL AND p.intent = 'help_request' AND p.intent_conf >= 0.7 " +
        "AND p.event_at <= ? AND p.event_at >= ? " +
        "AND NOT EXISTS (SELECT 1 FROM passages r WHERE r.source_id = p.source_id AND r.reply_to = p.msg_id AND r.removed_at IS NULL) " +
        "AND NOT EXISTS (SELECT 1 FROM concierge_cases c WHERE c.subject = 'p:' || p.id) " +
        "ORDER BY p.event_at LIMIT ?",
    )
    .bind(nowIso(new Date(now.getTime() - ROUTE_AFTER)), nowIso(new Date(now.getTime() - ROUTE_MAX_AGE)), LIVE_PER_RUN)
    .all<Open>();
  for (const r of results) {
    // Only what was written before the request: the request itself must not be quoted back.
    const { convs } = await conversationsFor(app.db, new Set([r.source_id]), r.body, r.event_at);
    const plan = await decide(app, r.body, convs, defaultLang());
    const row = await app.db
      .prepare(
        "INSERT INTO concierge_cases(subject, mode, source_id, version, created_at, model, action, error, downgraded, brief, answer, question, " +
          "quotes_verified, quotes_failed, evidence, codes, executed) VALUES (?, 'live', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0) " +
          "ON CONFLICT(subject, version) DO NOTHING RETURNING id",
      )
      .bind(
        `p:${r.id}`,
        r.source_id,
        PROMPT_VERSION,
        nowIso(now),
        plan.model,
        plan.action,
        plan.error ?? null,
        plan.downgraded ? 1 : 0,
        plan.brief,
        plan.answer,
        plan.question,
        plan.verified,
        plan.failed,
        convs.length,
        JSON.stringify(plan.codes),
      )
      .first<{ id: number }>();
    if (row && plan.action && (await levelFor(app.db, app.env.CONCIERGE_AUTONOMY, plan.action)) === "auto") {
      await executeLive(app, row.id, now);
    }
  }
  return results.length;
}

interface Case {
  id: number;
  action: string | null;
  answer: string | null;
  question: string | null;
  executed: number;
  source_id: string;
  chat_id: number;
  username: string | null;
  id_passage: number;
  msg_id: number;
  body: string;
  author_id: string | null;
  topic_id: number | null;
}

/** Sends a live case's step. Returns the effect keys to dispatch, and whether it was skipped because someone answered meanwhile. */
export async function executeLive(app: App, caseId: number, now = new Date()): Promise<{ keys: string[]; skipped: boolean }> {
  const c = await app.db
    .prepare(
      "SELECT c.id, c.action, c.answer, c.question, c.executed, c.source_id, s.chat_id, s.username, p.id AS id_passage, p.msg_id, p.body, p.author_id, p.topic_id " +
        "FROM concierge_cases c JOIN passages p ON 'p:' || p.id = c.subject JOIN sources s ON s.id = c.source_id WHERE c.id = ?",
    )
    .bind(caseId)
    .first<Case>();
  if (!c || c.executed || !c.action) return { keys: [], skipped: false };
  await app.db.prepare("UPDATE concierge_cases SET executed=1 WHERE id=?").bind(caseId).run();
  const answered = await app.db
    .prepare("SELECT 1 FROM passages WHERE source_id=? AND reply_to=? AND part=0 AND removed_at IS NULL LIMIT 1")
    .bind(c.source_id, c.msg_id)
    .first();
  if (answered) return { keys: [], skipped: true };
  if (c.action === "answer" || c.action === "clarify") {
    const text = c.action === "answer" ? `${escapeHtml(c.answer ?? "")}\n\n<i>${escapeHtml(T(defaultLang()).aiNote)}</i>` : escapeHtml(c.question ?? "");
    if (!text.trim()) return { keys: [], skipped: false };
    const key = `concierge:${c.id}`;
    await effectStatement(app.db, key, c.chat_id, { text, reply_to: c.msg_id }).run();
    return { keys: [key], skipped: false };
  }
  if (c.action === "ask_people") {
    const q: Open = { id: c.id_passage, source_id: c.source_id, msg_id: c.msg_id, author_id: c.author_id, body: c.body, event_at: "", topic_id: c.topic_id, chat_id: c.chat_id, username: c.username };
    return { keys: await routeQuestion(app.db, q, now), skipped: false };
  }
  return { keys: [], skipped: false }; // escalate: the board is the escalation, nothing is sent outside
}
