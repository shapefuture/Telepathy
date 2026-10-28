// «Пульс» (plan: journey 9): the owner's weekly summary of one group, built only from what the bot
// already stores for that group. Names appear only for people who opted in. A quiet week is said
// so, and nothing is sent for a group with no activity at all (silence is the default).

import { namesFor, personLabel } from "./thread-card";
import { effectStatement } from "./outbox";
import { T, defaultLang, type Lang } from "./i18n";
import { escapeHtml } from "./text";
import { DAY, nowIso } from "./util";
import { dueDay } from "./digest";
import { answeredText, closedOf, storeClosed, type Closed } from "./concierge/jobs";
import { T2 } from "./concierge/texts";
import type { App } from "./bot";
import type { InlineButton } from "./telegram";

export interface Pulse {
  messages: number;
  questions: number;
  answered: number;
  waiting: number;
  medianHours: number | null;
  top: { id: string; n: number } | null;
}

const QUESTION = "p.part=0 AND p.removed_at IS NULL AND p.intent='help_request' AND p.intent_conf>=0.55 AND p.event_at>=?";

/** The week's numbers for one group. `since` is an ISO timestamp (UTC). */
export async function pulseOf(db: D1Database, sourceId: string, since: string): Promise<Pulse> {
  const [msgs, qs, ans, wait, speed, top] = await db.batch([
    db.prepare("SELECT COUNT(*) AS n FROM passages p WHERE p.source_id=? AND p.part=0 AND p.removed_at IS NULL AND p.event_at>=?").bind(sourceId, since),
    db.prepare(`SELECT COUNT(*) AS n FROM passages p WHERE p.source_id=? AND ${QUESTION}`).bind(sourceId, since),
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM passages p WHERE p.source_id=? AND ${QUESTION} AND EXISTS ` +
          "(SELECT 1 FROM passages r WHERE r.source_id=p.source_id AND r.reply_to=p.msg_id AND r.part=0 AND r.removed_at IS NULL)",
      )
      .bind(sourceId, since),
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM passages p WHERE p.source_id=? AND ${QUESTION} AND NOT EXISTS ` +
          "(SELECT 1 FROM passages r WHERE r.source_id=p.source_id AND r.reply_to=p.msg_id AND r.part=0 AND r.removed_at IS NULL)",
      )
      .bind(sourceId, since),
    db
      .prepare(
        "SELECT p.event_at AS asked, MIN(r.event_at) AS answered FROM passages p JOIN passages r ON r.source_id=p.source_id AND r.reply_to=p.msg_id AND r.part=0 AND r.removed_at IS NULL " +
          `WHERE p.source_id=? AND ${QUESTION} GROUP BY p.id`,
      )
      .bind(sourceId, since),
    db
      .prepare(
        "SELECT r.author_id AS id, COUNT(*) AS n FROM passages r WHERE r.source_id=? AND r.reply_to IS NOT NULL AND r.part=0 AND r.removed_at IS NULL " +
          "AND r.author_id IS NOT NULL AND r.event_at>=? GROUP BY r.author_id ORDER BY n DESC LIMIT 1",
      )
      .bind(sourceId, since),
  ]);
  const hours = (speed!.results as { asked: string; answered: string }[]).map((r) => (Date.parse(r.answered) - Date.parse(r.asked)) / 3_600_000);
  const sorted = [...hours].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const medianHours = sorted.length ? (sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2) : null;
  return {
    messages: (msgs!.results[0] as { n: number }).n,
    questions: (qs!.results[0] as { n: number }).n,
    answered: (ans!.results[0] as { n: number }).n,
    waiting: (wait!.results[0] as { n: number }).n,
    medianHours,
    top: (top!.results[0] as { id: string; n: number } | undefined) ?? null,
  };
}

const hoursText = (h: number | null, lang: Lang) => {
  if (h === null) return "—";
  if (h >= 1) return `${Math.round(h)} ${lang === "ru" ? "ч" : "h"}`;
  return `${Math.max(1, Math.round(h * 60))} ${lang === "ru" ? "мин" : "min"}`;
};

/** What closed this week, by kind of request, and the introductions and deals both sides confirmed. */
function closedLine(c: Closed, lang: Lang): string {
  return T2(lang).pulseClosed(answeredText(c.answered, lang), c.connected, c.agreed);
}

/** The card the owner gets, and the celebratory line the group may get (no private details). */
export async function pulseCard(db: D1Database, sourceId: string, title: string, since: string, lang: Lang): Promise<{ text: string; quiet: boolean; shareText: string; closed?: Closed }> {
  const m = T(lang);
  const p = await pulseOf(db, sourceId, since);
  const names = p.top ? await namesFor(db, [p.top.id]) : new Map<string, string | null>();
  const helper = p.top ? personLabel(p.top.id, names.get(p.top.id), m) : m.memberAnon;
  const lines = [m.pulseTitle(escapeHtml(title))];
  let closed: Closed | undefined;
  if (!p.messages) return { text: "", quiet: true, shareText: "" };
  if (!p.questions) lines.push(m.pulseQuiet);
  else {
    lines.push(m.pulseQuestions(p.questions), m.pulseAnswered(p.answered), m.pulseWaiting(p.waiting), m.pulseSpeed(hoursText(p.medianHours, lang)));
    lines.push(p.top ? m.pulseTop(helper, p.top.n) : m.pulseNoHelp);
    closed = await closedOf(db, sourceId, since);
    lines.push(closedLine(closed, lang));
  }
  const shareText = p.questions ? m.pulseShare(escapeHtml(title), p.questions, p.answered, p.top ? helper : m.memberAnon) : "";
  return { text: lines.join("\n"), quiet: !p.questions, shareText, closed };
}

/** Monday, at the club's digest hour: one summary per group that had any activity that week. */
export async function pulseStep(db: D1Database, now: Date, tz: string, hour: number): Promise<string[]> {
  const day = dueDay(now, tz, hour);
  if (!day || new Date(`${day}T12:00:00Z`).getUTCDay() !== 1) return [];
  const since = nowIso(new Date(now.getTime() - 7 * DAY));
  const { results } = await db
    .prepare(
      // Groups already handled today are left out: the step runs every minute until midnight, and
      // the week's numbers read every message of the week.
      "SELECT s.id, s.title, m.tg_id, m.lang FROM sources s JOIN members m ON m.id = s.enabled_by WHERE s.enabled=1 AND m.removed_at IS NULL " +
        "AND NOT EXISTS (SELECT 1 FROM effects e WHERE e.key = 'pulse:' || s.id || ':' || ?) LIMIT 50",
    )
    .bind(day)
    .all<{ id: string; title: string | null; tg_id: number; lang: Lang | null }>();
  const keys: string[] = [];
  for (const s of results) {
    const key = `pulse:${s.id}:${day}`;
    const card = await pulseCard(db, s.id, s.title ?? "", since, s.lang ?? defaultLang());
    if (card.closed) await storeClosed(db, s.id, day, card.closed); // the board shows this week's numbers
    if (!card.text) {
      // No messages all week: say nothing, and remember that this group is done for today.
      await db
        .prepare("INSERT OR IGNORE INTO effects(id, key, chat_id, payload, state, created_at, updated_at) VALUES (?,?,?,'{}','skipped',?,?)")
        .bind(crypto.randomUUID(), key, s.tg_id, nowIso(now), nowIso(now))
        .run();
      continue;
    }
    const m = T(s.lang ?? defaultLang());
    const buttons: InlineButton[][] = card.quiet ? [] : [[{ text: m.bPulseShare, callback_data: `pu:${s.id}` }]];
    await effectStatement(db, key, s.tg_id, { text: card.text, buttons }).run();
    keys.push(key);
  }
  return keys;
}

/** The owner pressed "Share with the group": the celebratory line goes to the group, once a day. */
export async function shareToGroup(db: D1Database, sourceId: string, day: string): Promise<string | null> {
  const src = await db.prepare("SELECT chat_id, title FROM sources WHERE id=? AND enabled=1").bind(sourceId).first<{ chat_id: number; title: string | null }>();
  if (!src) return null;
  const since = nowIso(new Date(Date.now() - 7 * DAY));
  const card = await pulseCard(db, sourceId, src.title ?? "", since, defaultLang());
  if (!card.shareText) return null;
  const key = `pulse-share:${sourceId}:${day}`;
  await effectStatement(db, key, src.chat_id, { text: card.shareText }).run();
  return key;
}
