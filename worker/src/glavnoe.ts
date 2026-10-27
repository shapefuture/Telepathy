// «Главное» (plan: journey 7): one card a day instead of hundreds of messages. What needs you
// (replies to you, your open questions, money with its deadline), meetings and decisions, and what
// the club talked about most. Nothing is invented: a quiet day says so, and a day with no activity
// sends nothing. Lines marked done don't come back.

import { eventUrl, parseEventDate, upcomingEvents } from "./features";
import { citation } from "./ingest";
import { T, type Lang } from "./i18n";
import { escapeHtml, snippet } from "./text";
import { btn } from "./thread-card";
import type { InlineButton } from "./telegram";
import { DAY, tzOffsetMinutes } from "./util";

/** Money: an amount with a currency, or a fee-like word. A heuristic; the card says "possibly" nowhere, so keep it strict. */
export const MONEY = /(€|\$|₽|₸|руб\.?|\brub\b|\beur\b|\busd\b)\s*\d|\d[\d\s.,]*\s*(€|\$|₽|₸|руб|\beur\b|\busd\b)|оплат|взнос|платёж|платеж|\binvoice\b|\bpayment\b|\bfee\b/i;
export const DECISION = /(решили|решено|договорились|постановили|итог|decided|agreed|resolved)/i;
export const SHARED_CAP = 4;

export interface Line {
  text: string;
  /** Passage id for a Done button, if the line needs the person's attention. */
  ref?: number;
}

export interface SharedParts {
  money: Line[];
  decisions: Line[];
  meetings: Line[];
  talk: Line[];
}

const fmt = (iso: string, lang: Lang, tz: string) => new Intl.DateTimeFormat(lang === "ru" ? "ru-RU" : "en-GB", { day: "numeric", month: "short", timeZone: tz }).format(new Date(iso));

/** The club-wide parts. Same for everyone who can read the same groups, so the cron builds them once. */
export async function sharedParts(db: D1Database, readable: Set<string>, start: string, end: string, now: Date, tz: string, lang: Lang): Promise<SharedParts> {
  const out: SharedParts = { money: [], decisions: [], meetings: [], talk: [] };
  if (!readable.size) return out;
  const src = JSON.stringify([...readable].sort());
  const { results: recent } = await db
    .prepare(
      "SELECT p.id, p.body FROM passages p WHERE p.part=0 AND p.removed_at IS NULL AND p.body IS NOT NULL AND p.source_id IN (SELECT value FROM json_each(?)) " +
        "AND p.event_at>=? AND p.event_at<? ORDER BY p.event_at DESC LIMIT 400",
    )
    .bind(src, start, end)
    .all<{ id: number; body: string }>();
  const off = tzOffsetMinutes(now, tz);
  for (const r of recent) {
    if (out.money.length < SHARED_CAP && MONEY.test(r.body)) {
      const due = parseEventDate(r.body, now, off);
      const when = due ? ` · ${escapeHtml(fmt(due, lang, tz))}` : "";
      out.money.push({ text: `${escapeHtml(snippet(r.body, [], 140))}${when}`, ref: r.id });
    }
    if (out.decisions.length < 3 && DECISION.test(r.body)) out.decisions.push({ text: escapeHtml(snippet(r.body, [], 160)) });
  }
  const week = now.getTime() + 7 * DAY;
  for (const e of await upcomingEvents(db, readable, now)) {
    if (Date.parse(e.starts_at) > week || out.meetings.length >= 3) continue;
    const url = eventUrl(e);
    const title = url ? `<a href="${escapeHtml(url)}">${escapeHtml(e.title)}</a>` : escapeHtml(e.title);
    out.meetings.push({ text: `${escapeHtml(fmt(e.starts_at, lang, tz))} — ${title}` });
  }
  const { results: talk } = await db
    .prepare(
      "SELECT p.id, p.body, p.msg_id, p.topic_id, s.chat_id, s.username, " +
        "(SELECT COUNT(*) FROM passages r WHERE r.source_id = p.source_id AND r.reply_to = p.msg_id AND r.part = 0 AND r.removed_at IS NULL) AS replies " +
        "FROM passages p JOIN sources s ON s.id = p.source_id WHERE p.part=0 AND p.removed_at IS NULL AND p.body IS NOT NULL " +
        "AND p.source_id IN (SELECT value FROM json_each(?)) AND p.event_at>=? AND p.event_at<? ORDER BY replies DESC, p.event_at DESC LIMIT 3",
    )
    .bind(src, start, end)
    .all<{ id: number; body: string; msg_id: number; topic_id: number | null; chat_id: number; username: string | null; replies: number }>();
  for (const t of talk) {
    const url = citation(t.chat_id, t.msg_id, t.username, t.topic_id);
    const words = `${escapeHtml(snippet(t.body, [], 110))}${t.replies ? ` — ${t.replies}` : ""}`;
    out.talk.push({ text: url ? `<a href="${escapeHtml(url)}">${words}</a>` : words });
  }
  return out;
}

/**
 * One member's card, or null when there was no activity in their groups at all. Their own lines
 * come first; the club's lines follow; a day with nothing that needs them says so.
 */
export async function glavnoeFor(
  db: D1Database,
  memberId: string,
  readable: Set<string>,
  start: string,
  end: string,
  now: Date,
  tz: string,
  lang: Lang,
  shared?: SharedParts,
): Promise<{ text: string; buttons: InlineButton[][] } | null> {
  const m = T(lang);
  if (!readable.size) return null;
  const src = JSON.stringify([...readable].sort());
  const activity = await db
    .prepare("SELECT COUNT(*) AS n FROM passages WHERE part=0 AND removed_at IS NULL AND source_id IN (SELECT value FROM json_each(?)) AND event_at>=? AND event_at<?")
    .bind(src, start, end)
    .first<{ n: number }>();
  if (!activity?.n) return null;
  const [replies, own] = await db.batch([
    db
      .prepare(
        "SELECT r.id, r.body FROM passages r JOIN passages p ON p.source_id = r.source_id AND p.msg_id = r.reply_to AND p.part = 0 AND p.author_id = ? " +
          "WHERE r.part = 0 AND r.removed_at IS NULL AND r.event_at >= ? AND r.event_at < ? AND (r.author_id IS NULL OR r.author_id <> ?) " +
          "AND r.source_id IN (SELECT value FROM json_each(?)) AND NOT EXISTS (SELECT 1 FROM glavnoe_done d WHERE d.member_id = ? AND d.passage_id = r.id) LIMIT 4",
      )
      .bind(memberId, start, end, memberId, src, memberId),
    db
      .prepare(
        "SELECT p.id, p.body FROM passages p WHERE p.author_id = ? AND p.part = 0 AND p.removed_at IS NULL AND p.intent = 'help_request' " +
          "AND p.event_at >= ? AND p.event_at < ? AND p.source_id IN (SELECT value FROM json_each(?)) " +
          "AND NOT EXISTS (SELECT 1 FROM passages r WHERE r.source_id = p.source_id AND r.reply_to = p.msg_id AND r.part = 0 AND r.removed_at IS NULL) " +
          "AND NOT EXISTS (SELECT 1 FROM glavnoe_done d WHERE d.member_id = ? AND d.passage_id = p.id) LIMIT 3",
      )
      .bind(memberId, start, end, src, memberId),
  ]);
  const mine: Line[] = (replies!.results as { id: number; body: string }[]).map((r) => ({ text: `${escapeHtml(snippet(r.body, [], 120))}`, ref: r.id }));
  const asked: Line[] = (own!.results as { id: number; body: string }[]).map((r) => ({ text: `${escapeHtml(snippet(r.body, [], 120))}`, ref: r.id }));
  const parts = shared ?? (await sharedParts(db, readable, start, end, now, tz, lang));
  // Money the person already marked done stays done.
  const doneMoney = new Set<number>();
  for (const l of parts.money) if (l.ref !== undefined) doneMoney.add(l.ref);
  const done = new Set(
    (await db.prepare(`SELECT passage_id FROM glavnoe_done WHERE member_id=? AND passage_id IN (SELECT value FROM json_each(?))`).bind(memberId, JSON.stringify([...doneMoney])).all<{ passage_id: number }>()).results.map((r) => r.passage_id),
  );
  const money = parts.money.filter((l) => l.ref === undefined || !done.has(l.ref));
  const needs = mine.length + asked.length + money.length + parts.meetings.length;

  const lines = [`<b>${m.glavTitle}</b>`, `<i>${escapeHtml(fmt(now.toISOString(), lang, tz))}</i>`];
  const buttons: InlineButton[][] = [];
  const section = (title: string, items: Line[]) => {
    if (!items.length) return;
    lines.push("", `<b>${title}</b>`);
    for (const it of items) {
      lines.push(`• ${it.text}`);
      if (it.ref !== undefined && buttons.length < 6) buttons.push([btn(m.bDone, `gd:${it.ref}`)]);
    }
  };
  section(m.glavNeed, mine);
  section(m.glavOwnQ, asked);
  section(m.glavPay, money);
  section(m.glavMeet, [...parts.meetings, ...parts.decisions]);
  if (!needs && !parts.decisions.length) lines.push("", m.glavQuiet);
  section(m.glavTalk, parts.talk);
  return { text: lines.join("\n"), buttons };
}
