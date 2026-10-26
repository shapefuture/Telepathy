// The wow moment (plan: journey 1, step 5). Right after a history import the owner gets one card:
// what the community talks about, who helps most, and the questions nobody answered. Everything is
// read from the group just imported, and only the owner (who can already read it) sees it.

import { btn, namesFor, personLabel } from "./thread-card";
import { labelIn, matchSkills, TAXONOMY } from "./experts";
import { T, type Lang } from "./i18n";
import type { InlineButton } from "./telegram";
import { escapeHtml, snippet } from "./text";

export const WOW_SAMPLE = 1500;

/** The topics in a group's stored messages, by how many messages mention them (two at least). */
export async function topicCounts(db: D1Database, sourceId: string, limit: number): Promise<{ code: string; n: number }[]> {
  const { results } = await db
    .prepare("SELECT body FROM passages WHERE source_id=? AND part=0 AND removed_at IS NULL AND body IS NOT NULL ORDER BY event_at DESC LIMIT ?")
    .bind(sourceId, WOW_SAMPLE)
    .all<{ body: string }>();
  const counts = new Map<string, number>();
  for (const r of results) for (const code of matchSkills(r.body, 3)) counts.set(code, (counts.get(code) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([code, n]) => ({ code, n }));
}

/** The top topics in a group, as labels in one language. */
export async function topTopics(db: D1Database, sourceId: string, lang: Lang, limit = 5): Promise<string[]> {
  return (await topicCounts(db, sourceId, limit)).map((t) => labelIn(TAXONOMY.get(t.code)!, lang));
}

/** The questions in a group that nobody replied to. Same definition for the count and the list. */
const UNANSWERED =
  "FROM passages p WHERE p.source_id=? AND p.part=0 AND p.removed_at IS NULL AND p.body IS NOT NULL AND p.intent='help_request' AND p.intent_conf>=0.55 " +
  "AND NOT EXISTS (SELECT 1 FROM passages r WHERE r.source_id=p.source_id AND r.reply_to=p.msg_id AND r.part=0 AND r.removed_at IS NULL)";

export async function forgottenCount(db: D1Database, sourceId: string): Promise<number> {
  return (await db.prepare(`SELECT COUNT(*) AS n ${UNANSWERED}`).bind(sourceId).first<{ n: number }>())?.n ?? 0;
}

export async function forgottenQuestions(db: D1Database, sourceId: string, limit = 5): Promise<{ id: number; body: string }[]> {
  return (await db.prepare(`SELECT p.id, p.body ${UNANSWERED} ORDER BY p.event_at DESC LIMIT ?`).bind(sourceId, limit).all<{ id: number; body: string }>()).results;
}

/** The card for the owner after a history import: the import's own line, then what it found. */
export async function wowCard(db: D1Database, sourceId: string, lang: Lang, importLine: string): Promise<{ text: string; buttons?: InlineButton[][] }> {
  const m = T(lang);
  const topics = await topTopics(db, sourceId, lang);
  const helpers = (
    await db
      .prepare(
        "SELECT r.author_id, COUNT(*) AS n FROM passages r WHERE r.source_id=? AND r.reply_to IS NOT NULL AND r.part=0 AND r.removed_at IS NULL AND r.author_id IS NOT NULL " +
          "GROUP BY r.author_id ORDER BY n DESC LIMIT 3",
      )
      .bind(sourceId)
      .all<{ author_id: string; n: number }>()
  ).results;
  const names = await namesFor(db, helpers.map((h) => h.author_id));
  const forgotten = await forgottenCount(db, sourceId);
  const lines = [importLine];
  if (topics.length) lines.push("", `<b>${m.wowTopics}</b>`, topics.map((t) => `<code>${escapeHtml(t)}</code>`).join(" · "));
  if (helpers.length) lines.push("", `<b>${m.wowHelpers}</b>`, ...helpers.map((h) => `${personLabel(h.author_id, names.get(h.author_id), m)} — ${h.n}`));
  lines.push("", forgotten ? `<b>${m.wowForgotten(forgotten)}</b>` : m.wowNoneForgotten);
  return { text: lines.join("\n"), buttons: forgotten ? [[btn(m.bLook, `wow:${sourceId}`)]] : undefined };
}

/** The list behind "Посмотреть": each question becomes a thread the bot tries to close. */
export async function forgottenView(db: D1Database, sourceId: string, lang: Lang): Promise<{ text: string; buttons: InlineButton[][] }> {
  const m = T(lang);
  const qs = await forgottenQuestions(db, sourceId);
  return {
    text: [`<b>${m.wowForgottenHead}</b>`, ...qs.map((q) => `• ${escapeHtml(snippet(q.body, [], 160))}`)].join("\n"),
    buttons: qs.map((q) => [btn(m.bAnswerIt, `wq:${q.id}`)]),
  };
}
