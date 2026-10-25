// History import from the owner's browser (Mini App → Desk → History).
// The owner's own Telegram login runs only in their browser tab (public/history/history.js) and is
// never sent here; the tab reads the group's past messages and posts them in pages. This file
// stores them with the same rules as `npm run import`: only enabled groups, members who used
// /forget_me skipped, live data never overwritten, removed messages stay removed.

import { langOf, memberByTg } from "./acl";
import type { App } from "./bot";
import { classify } from "./classify";
import { digestHour, timezone, type Env } from "./env";
import { T } from "./i18n";
import { DefiniteFailure, type InlineButton } from "./telegram";
import { escapeHtml } from "./text";
import { audit, DAY, localParts, nowIso } from "./util";

/** At ≈5 D1 rows per message this keeps imports inside the free plan's 100,000 writes a day. */
export const HISTORY_PER_DAY = 15_000;
export const HISTORY_PAGE_MAX = 100; // one messages.getHistory page
const TEXT_MAX = 10_000;
const MAX_REMINDERS = 7;

export interface HistoryMessage {
  id: number;
  date: number; // unix seconds
  text: string;
  from: number | null; // Telegram user id; null for channels, anonymous admins and bots
  edit: number;
  reply: number | null;
  topic: number | null;
}

/** The budget is shared by all groups: D1's write limit is per database. */
async function usedToday(db: D1Database, day: string): Promise<number> {
  return (await db.prepare("SELECT COALESCE(SUM(day_count),0) AS n FROM history_jobs WHERE day=?").bind(day).first<{ n: number }>())!.n;
}

export function perDay(env: Env): number {
  const n = Number(env.HISTORY_PER_DAY);
  return Number.isInteger(n) && n > 0 ? n : HISTORY_PER_DAY;
}

const today = (now: Date) => now.toISOString().slice(0, 10);
const posInt = (v: unknown) => (Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : null);

/** Drops anything malformed instead of failing the page: one odd message shouldn't stop an import. */
export function cleanMessages(raw: unknown): HistoryMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: HistoryMessage[] = [];
  for (const r of raw.slice(0, HISTORY_PAGE_MAX)) {
    if (!r || typeof r !== "object") continue;
    const m = r as Record<string, unknown>;
    const id = posInt(m.id);
    const date = posInt(m.date);
    if (!id || !date || typeof m.text !== "string" || !m.text.trim()) continue;
    out.push({
      id,
      date,
      text: m.text.slice(0, TEXT_MAX),
      from: posInt(m.from),
      edit: posInt(m.edit) ?? 0,
      reply: posInt(m.reply),
      topic: posInt(m.topic),
    });
  }
  return out;
}

/** Enabled groups with their import progress, for the History screen. */
export async function historyGroups(env: Env, db: D1Database, now = new Date()) {
  const { results } = await db
    .prepare(
      "SELECT s.id, s.chat_id, s.title, s.retention_days, j.cursor, j.imported, j.seen, j.done_at, " +
        "(SELECT COUNT(*) FROM passages p WHERE p.source_id=s.id AND p.removed_at IS NULL) AS stored " +
        "FROM sources s LEFT JOIN history_jobs j ON j.source_id=s.id WHERE s.enabled=1 ORDER BY s.enabled_at",
    )
    .all<{ id: string; chat_id: number; title: string | null; retention_days: number; cursor: number | null; imported: number | null; seen: number | null; done_at: string | null; stored: number }>();
  const left = Math.max(0, perDay(env) - (await usedToday(db, today(now))));
  return results.map((r) => ({
    chatId: r.chat_id,
    title: r.title ?? String(r.chat_id),
    cursor: r.cursor ?? 0,
    imported: r.imported ?? 0,
    seen: r.seen ?? 0,
    stored: r.stored,
    done: !!r.done_at,
    left,
    // The browser stops reading once it passes this date: older messages would be purged anyway.
    keepFrom: r.retention_days > 0 ? Math.floor((now.getTime() - r.retention_days * DAY) / 1000) : 0,
  }));
}

export type ImportResult =
  | { ok: true; stored: number; skipped: number; left: number; imported: number; done: boolean }
  | { ok: false; error: "not_enabled" | "paused"; left: number };

/**
 * Store one page. `cursor` is the oldest message id the browser has read so far, so a closed tab
 * resumes there. `done` marks the start of the chat reached.
 */
export async function importPage(env: Env, db: D1Database, ownerTg: number, chatId: number, raw: unknown, cursor: number, done: boolean, now = new Date()): Promise<ImportResult> {
  const day = today(now);
  const source = await db
    .prepare(
      "SELECT s.id, s.retention_days, j.done_at, (SELECT COALESCE(SUM(day_count),0) FROM history_jobs WHERE day=?) AS used " +
        "FROM sources s LEFT JOIN history_jobs j ON j.source_id=s.id WHERE s.chat_id=? AND s.enabled=1",
    )
    .bind(day, chatId)
    .first<{ id: string; retention_days: number; done_at: string | null; used: number }>();
  if (!source) return { ok: false, error: "not_enabled", left: 0 };
  const cap = perDay(env);
  if (source.used >= cap) return { ok: false, error: "paused", left: 0 };

  const keepFrom = source.retention_days > 0 ? Math.floor((now.getTime() - source.retention_days * DAY) / 1000) : 0;
  const all = cleanMessages(raw);
  const msgs = all.filter((m) => m.date >= keepFrom);
  const at = nowIso(now);
  const finished = done || (keepFrom > 0 && msgs.length === 0 && all.length > 0);
  const authors = JSON.stringify([...new Set(msgs.map((m) => m.from).filter((x) => x !== null))]);
  const rows = JSON.stringify(
    msgs.map((m) => {
      const c = classify(m.text);
      return { id: m.id, from: m.from, text: m.text, at: nowIso(new Date(m.date * 1000)), edit: m.edit, topic: m.topic, reply: m.reply, intent: c.intent, conf: c.confidence };
    }),
  );
  const v = (k: string) => `json_extract(j.value,'$.${k}')`;
  // A handful of set-based statements per page, however many messages it holds: the free plan
  // limits queries per request. Old messages never re-grant access to someone who left.
  const res = await db.batch([
    db.prepare("INSERT OR IGNORE INTO members(id, tg_id, created_at) SELECT lower(hex(randomblob(16))), value, ?1 FROM json_each(?2)").bind(at, authors),
    db
      .prepare("INSERT OR IGNORE INTO source_access(source_id, member_id, granted_at) SELECT ?1, id, ?2 FROM members WHERE tg_id IN (SELECT value FROM json_each(?3)) AND collection_opt_out=0")
      .bind(source.id, at, authors),
    db
      .prepare(
        "INSERT OR IGNORE INTO passages(source_id, msg_id, part, author_id, body, event_at, edit_version, topic_id, reply_to, intent, intent_conf) " +
          `SELECT ?1, ${v("id")}, 0, m.id, ${v("text")}, ${v("at")}, ${v("edit")}, ${v("topic")}, ${v("reply")}, ${v("intent")}, ${v("conf")} ` +
          `FROM json_each(?2) j LEFT JOIN members m ON m.tg_id=${v("from")} ` +
          `WHERE ${v("from")} IS NULL OR (m.id IS NOT NULL AND m.collection_opt_out=0) RETURNING id`,
      )
      .bind(source.id, rows),
    db
      .prepare(
        "INSERT INTO history_jobs(source_id, owner_tg, cursor, seen, day, day_count, done_at, updated_at) VALUES (?1,?2,?3,?4,?5,?4,?6,?7) " +
          "ON CONFLICT(source_id) DO UPDATE SET owner_tg=excluded.owner_tg, " +
          "cursor=CASE WHEN excluded.cursor>0 AND (history_jobs.cursor=0 OR excluded.cursor<history_jobs.cursor) THEN excluded.cursor ELSE history_jobs.cursor END, " +
          "seen=history_jobs.seen+excluded.seen, " +
          "day_count=CASE WHEN history_jobs.day=excluded.day THEN history_jobs.day_count+excluded.day_count ELSE excluded.day_count END, day=excluded.day, " +
          "done_at=COALESCE(history_jobs.done_at, excluded.done_at), updated_at=excluded.updated_at, reminded_day=NULL, reminders=0 RETURNING imported",
      )
      .bind(source.id, ownerTg, posInt(cursor) ?? 0, msgs.length, day, finished ? at : null, at),
  ]);
  // RETURNING gives exact counts (meta.changes also counts FTS trigger writes).
  const stored = res[2]!.results.length;
  if (stored) await db.prepare("UPDATE history_jobs SET imported=imported+? WHERE source_id=?").bind(stored, source.id).run();
  const total = (res[3]!.results[0] as { imported: number }).imported + stored;
  if (finished && !source.done_at) await audit(db, "history.import", String(ownerTg), source.id, { imported: total });
  return { ok: true, stored, skipped: msgs.length - stored, left: Math.max(0, cap - source.used - msgs.length), imported: total, done: finished };
}

/** Owners can restart a finished import (e.g. after /retention changed); progress starts over. */
export async function resetHistory(db: D1Database, chatId: number): Promise<boolean> {
  const r = await db.prepare("DELETE FROM history_jobs WHERE source_id=(SELECT id FROM sources WHERE chat_id=?)").bind(chatId).run();
  return r.meta.changes > 0;
}

/**
 * Cron: once a day at the digest hour, remind whoever started an unfinished import that it can
 * continue (the browser holds the login, so only they can). Stops after a week of silence.
 */
export async function remindHistory(app: App, now = new Date()): Promise<number> {
  const local = localParts(now, timezone(app.env));
  if (local.hour !== digestHour(app.env)) return 0;
  const day = today(now);
  const { results } = await app.db
    .prepare(
      "SELECT j.source_id, j.owner_tg, j.imported, s.title FROM history_jobs j JOIN sources s ON s.id=j.source_id " +
        "WHERE j.done_at IS NULL AND s.enabled=1 AND j.reminders<? AND (j.reminded_day IS NULL OR j.reminded_day<?) AND j.updated_at<? LIMIT 5",
    )
    .bind(MAX_REMINDERS, day, `${day}T00:00:00Z`)
    .all<{ source_id: string; owner_tg: number; imported: number; title: string | null }>();
  const origin = (app.env.PUBLIC_URL ?? "").replace(/\/$/, "");
  let sent = 0;
  for (const r of results) {
    await app.db.prepare("UPDATE history_jobs SET reminded_day=?, reminders=reminders+1 WHERE source_id=?").bind(day, r.source_id).run();
    const m = await memberByTg(app.db, r.owner_tg);
    const t = T(langOf(m));
    const buttons = origin ? [[{ text: t.historyButton, web_app: { url: `${origin}/app?start=history` } } as unknown as InlineButton]] : undefined;
    try {
      await app.tg.sendMessage(r.owner_tg, t.historyRemind(escapeHtml(r.title ?? ""), r.imported, !!origin), { buttons });
      sent++;
    } catch (e) {
      if (!(e instanceof DefiniteFailure)) throw e;
    }
  }
  return sent;
}
