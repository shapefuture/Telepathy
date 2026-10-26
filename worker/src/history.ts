// History import from the owner's browser (Mini App → Desk → History).
// The owner's own Telegram login runs only in their browser tab (public/history/history.js) and is
// never sent here. The tab reads the whole chat in seconds and parks it as raw pages
// (history_pages); the cron then stores those pages in the background within the daily D1
// budget, with the same rules as `npm run import`: only enabled groups, members who used
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
export const HISTORY_PAGE_MAX = 100; // ids per page the browser reads
const TEXT_MAX = 4_096; // Telegram's own limit; keeps a page row well under D1's 2 MB
const PAGES_PER_RUN = 2; // per cron minute: ≈200 messages, a few D1 queries
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
const keepFromOf = (retentionDays: number, now: Date) => (retentionDays > 0 ? Math.floor((now.getTime() - retentionDays * DAY) / 1000) : 0);

/**
 * Basic groups (ids above -10^12; supergroups are -100… with 10+ more digits) number messages per account: the bot's live copy of a
 * message has a different id than the one the owner's account reads, so ids can't dedupe them.
 * The bot has stored everything since the group was first enabled, so history stops there.
 * Supergroups share one numbering, and INSERT OR IGNORE already skips messages the bot has.
 */
/** Bot API ids of supergroups and channels are -10^12 - their channel id. */
export const SUPERGROUP_MAX = -1_000_000_000_000;

export function liveFrom(chatId: number, firstEnabledIso: string): number {
  if (chatId <= SUPERGROUP_MAX) return Number.POSITIVE_INFINITY;
  const t = Date.parse(firstEnabledIso);
  return Number.isFinite(t) ? Math.floor(t / 1000) : Number.POSITIVE_INFINITY;
}

/** Drops anything malformed instead of failing the page: one odd message shouldn't stop an import. */
export function cleanMessages(raw: unknown, max = HISTORY_PAGE_MAX): HistoryMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: HistoryMessage[] = [];
  for (const r of raw.slice(0, max)) {
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
      "SELECT s.id, s.chat_id, s.title, s.retention_days, j.staged, j.imported, j.read_at, j.done_at, j.mcp_offset, " +
        "(SELECT COUNT(*) FROM passages p WHERE p.source_id=s.id AND p.removed_at IS NULL) AS stored, " +
        "(SELECT COALESCE(SUM(n),0) FROM history_pages h WHERE h.source_id=s.id AND h.body IS NOT NULL) AS pending, " +
        "(SELECT json_group_array(page) FROM history_pages h WHERE h.source_id=s.id) AS pages " +
        "FROM sources s LEFT JOIN history_jobs j ON j.source_id=s.id WHERE s.enabled=1 ORDER BY s.enabled_at",
    )
    .all<{ chat_id: number; title: string | null; retention_days: number; staged: number | null; imported: number | null; read_at: string | null; done_at: string | null; mcp_offset: number | null; stored: number; pending: number; pages: string }>();
  const cap = perDay(env);
  const left = Math.max(0, cap - (await usedToday(db, today(now))));
  return results.map((r) => ({
    chatId: r.chat_id,
    title: r.title ?? String(r.chat_id),
    stored: r.stored,
    staged: r.staged ?? 0,
    imported: r.imported ?? 0,
    pending: r.pending,
    read: !!r.read_at,
    done: !!r.done_at,
    auto: r.mcp_offset !== null && !r.read_at, // being read by the MCP server right now
    // Pages already read, so a closed tab resumes without reading them again.
    pages: r.read_at ? [] : (JSON.parse(r.pages) as number[]),
    days: Math.ceil(r.pending / cap),
    left,
    // The browser stops reading past this date: older messages would be purged anyway.
    keepFrom: keepFromOf(r.retention_days, now),
  }));
}

export type StageResult = { ok: true; pending: number } | { ok: false; error: "not_enabled" | "bad_page" | "auto" };

/**
 * Park one page the browser read (or, with `done`, mark the chat fully read). Costs one D1 row
 * per page, so reading a whole chat takes seconds and almost none of the daily write budget.
 */
export async function stagePage(db: D1Database, ownerTg: number, chatId: number, page: unknown, raw: unknown, done: boolean, now = new Date()): Promise<StageResult> {
  const source = await db
    .prepare(
      "SELECT s.id, s.retention_days, (j.mcp_offset IS NOT NULL AND j.read_at IS NULL) AS auto " +
        "FROM sources s LEFT JOIN history_jobs j ON j.source_id=s.id WHERE s.chat_id=? AND s.enabled=1",
    )
    .bind(chatId)
    .first<{ id: string; retention_days: number; auto: number | null }>();
  if (!source) return { ok: false, error: "not_enabled" };
  // The MCP reader and the browser number pages differently; one reader per chat at a time.
  if (source.auto) return { ok: false, error: "auto" };
  const at = nowIso(now);
  const keepFrom = keepFromOf(source.retention_days, now);
  const stmts: D1PreparedStatement[] = [];
  let n = 0;
  if (page != null || !done) {
    if (!Number.isSafeInteger(page) || (page as number) < 0) return { ok: false, error: "bad_page" };
    const msgs = cleanMessages(raw).filter((m) => m.date >= keepFrom);
    n = msgs.length;
    stmts.push(db.prepare("INSERT OR IGNORE INTO history_pages(source_id, page, body, n) VALUES (?,?,?,?)").bind(source.id, page, n ? JSON.stringify(msgs) : null, n));
  }
  stmts.push(
    db
      .prepare(
        "INSERT INTO history_jobs(source_id, owner_tg, staged, read_at, updated_at) VALUES (?1,?2,?3,?4,?5) " +
          "ON CONFLICT(source_id) DO UPDATE SET owner_tg=excluded.owner_tg, staged=history_jobs.staged+excluded.staged, " +
          "read_at=COALESCE(history_jobs.read_at, excluded.read_at), updated_at=excluded.updated_at, reminded_day=NULL, reminders=0",
      )
      .bind(source.id, ownerTg, 0, done ? at : null, at),
    db.prepare("SELECT COALESCE(SUM(n),0) AS n FROM history_pages WHERE source_id=? AND body IS NOT NULL").bind(source.id),
  );
  const res = await db.batch(stmts);
  // Count a page once even if the browser sends it twice (INSERT OR IGNORE).
  if (n && res[0]!.meta.changes > 0) await db.prepare("UPDATE history_jobs SET staged=staged+? WHERE source_id=?").bind(n, source.id).run();
  return { ok: true, pending: (res.at(-1)!.results[0] as { n: number }).n };
}

/**
 * Store parked messages as passages. A handful of set-based statements per page, however many
 * messages it holds: the free plan limits queries per request. Old messages never re-grant
 * access to someone who left.
 */
export async function storeMessages(db: D1Database, sourceId: string, msgs: HistoryMessage[], now = new Date()): Promise<number> {
  const at = nowIso(now);
  const authors = JSON.stringify([...new Set(msgs.map((m) => m.from).filter((x) => x !== null))]);
  const rows = JSON.stringify(
    msgs.map((m) => {
      const c = classify(m.text);
      return { id: m.id, from: m.from, text: m.text, at: nowIso(new Date(m.date * 1000)), edit: m.edit, topic: m.topic, reply: m.reply, intent: c.intent, conf: c.confidence };
    }),
  );
  const v = (k: string) => `json_extract(j.value,'$.${k}')`;
  const res = await db.batch([
    db.prepare("INSERT OR IGNORE INTO members(id, tg_id, created_at) SELECT lower(hex(randomblob(16))), value, ?1 FROM json_each(?2)").bind(at, authors),
    db
      .prepare("INSERT OR IGNORE INTO source_access(source_id, member_id, granted_at) SELECT ?1, id, ?2 FROM members WHERE tg_id IN (SELECT value FROM json_each(?3)) AND collection_opt_out=0")
      .bind(sourceId, at, authors),
    db
      .prepare(
        "INSERT OR IGNORE INTO passages(source_id, msg_id, part, author_id, body, event_at, edit_version, topic_id, reply_to, intent, intent_conf) " +
          `SELECT ?1, ${v("id")}, 0, m.id, ${v("text")}, ${v("at")}, ${v("edit")}, ${v("topic")}, ${v("reply")}, ${v("intent")}, ${v("conf")} ` +
          `FROM json_each(?2) j LEFT JOIN members m ON m.tg_id=${v("from")} ` +
          `WHERE ${v("from")} IS NULL OR (m.id IS NOT NULL AND m.collection_opt_out=0) RETURNING id`,
      )
      .bind(sourceId, rows),
  ]);
  // RETURNING gives exact counts (meta.changes also counts FTS trigger writes).
  return res[2]!.results.length;
}

/**
 * Cron, every minute: store a couple of parked pages while today's budget lasts, then tell the
 * owner once a chat is fully read and stored. Nothing here needs the owner or their login.
 */
export async function ingestHistory(app: App, now = new Date()): Promise<number> {
  const db = app.db;
  const day = today(now);
  let stored = 0;
  for (let i = 0; i < PAGES_PER_RUN; i++) {
    const p = await db
      .prepare(
        "SELECT h.source_id, h.page, h.body, s.retention_days, s.chat_id, s.enabled_at, " +
          "(SELECT MIN(at) FROM audit WHERE action='source.enable' AND subject=s.id) AS first_enable " +
          "FROM history_pages h JOIN sources s ON s.id=h.source_id " +
          "WHERE h.body IS NOT NULL AND s.enabled=1 ORDER BY h.source_id, h.page DESC LIMIT 1",
      )
      .first<{ source_id: string; page: number; body: string; retention_days: number; chat_id: number; enabled_at: string; first_enable: string | null }>();
    if (!p || (await usedToday(db, day)) >= perDay(app.env)) break;
    // Re-check at store time: /forget_me and /retention may have changed since the page was read.
    const keepFrom = keepFromOf(p.retention_days, now);
    const before = liveFrom(p.chat_id, p.first_enable ?? p.enabled_at);
    const msgs = cleanMessages(JSON.parse(p.body)).filter((m) => m.date >= keepFrom && m.date < before);
    const n = msgs.length ? await storeMessages(db, p.source_id, msgs, now) : 0;
    stored += n;
    await db.batch([
      db.prepare("UPDATE history_pages SET body=NULL WHERE source_id=? AND page=?").bind(p.source_id, p.page),
      db
        .prepare(
          "UPDATE history_jobs SET imported=imported+?, day_count=CASE WHEN day=? THEN day_count+? ELSE ? END, day=?, updated_at=? WHERE source_id=?",
        )
        .bind(n, day, msgs.length, msgs.length, day, nowIso(now), p.source_id),
    ]);
  }
  await finishHistory(app, now);
  return stored;
}

/** Jobs that are fully read and fully stored: drop their pages, record it, tell the owner. */
async function finishHistory(app: App, now: Date): Promise<void> {
  const { results } = await app.db
    .prepare(
      "SELECT j.source_id, j.owner_tg, j.imported, s.title FROM history_jobs j JOIN sources s ON s.id=j.source_id " +
        "WHERE j.read_at IS NOT NULL AND j.done_at IS NULL AND NOT EXISTS (SELECT 1 FROM history_pages h WHERE h.source_id=j.source_id AND h.body IS NOT NULL) LIMIT 3",
    )
    .all<{ source_id: string; owner_tg: number; imported: number; title: string | null }>();
  for (const r of results) {
    await app.db.batch([
      app.db.prepare("UPDATE history_jobs SET done_at=? WHERE source_id=?").bind(nowIso(now), r.source_id),
      app.db.prepare("DELETE FROM history_pages WHERE source_id=?").bind(r.source_id),
    ]);
    await audit(app.db, "history.import", String(r.owner_tg), r.source_id, { imported: r.imported });
    const t = T(langOf(await memberByTg(app.db, r.owner_tg)));
    try {
      await app.tg.sendMessage(r.owner_tg, t.historyDone(escapeHtml(r.title ?? ""), r.imported));
    } catch (e) {
      if (!(e instanceof DefiniteFailure)) throw e;
    }
  }
}

/** Owners can restart an import (e.g. after /retention changed); progress starts over. */
export async function resetHistory(db: D1Database, chatId: number): Promise<boolean> {
  const id = (await db.prepare("SELECT id FROM sources WHERE chat_id=?").bind(chatId).first<{ id: string }>())?.id;
  if (!id) return false;
  await db.batch([db.prepare("DELETE FROM history_pages WHERE source_id=?").bind(id), db.prepare("DELETE FROM history_jobs WHERE source_id=?").bind(id)]);
  return true;
}

/**
 * Cron: once a day at the digest hour, remind whoever started reading a chat but closed the
 * screen before the end (only their browser can read). Stops after a week of silence.
 */
export async function remindHistory(app: App, now = new Date()): Promise<number> {
  const local = localParts(now, timezone(app.env));
  if (local.hour !== digestHour(app.env)) return 0;
  const day = today(now);
  const { results } = await app.db
    .prepare(
      "SELECT j.source_id, j.owner_tg, j.staged, s.title FROM history_jobs j JOIN sources s ON s.id=j.source_id " +
        "WHERE j.read_at IS NULL AND s.enabled=1 AND j.reminders<? AND (j.reminded_day IS NULL OR j.reminded_day<?) AND j.updated_at<? LIMIT 5",
    )
    .bind(MAX_REMINDERS, day, `${day}T00:00:00Z`)
    .all<{ source_id: string; owner_tg: number; staged: number; title: string | null }>();
  const origin = (app.env.PUBLIC_URL ?? "").replace(/\/$/, "");
  let sent = 0;
  for (const r of results) {
    await app.db.prepare("UPDATE history_jobs SET reminded_day=?, reminders=reminders+1 WHERE source_id=?").bind(day, r.source_id).run();
    const t = T(langOf(await memberByTg(app.db, r.owner_tg)));
    const buttons = origin ? [[{ text: t.historyButton, web_app: { url: `${origin}/app?start=history` } } as unknown as InlineButton]] : undefined;
    try {
      await app.tg.sendMessage(r.owner_tg, t.historyRemind(escapeHtml(r.title ?? ""), r.staged, !!origin), { buttons });
      sent++;
    } catch (e) {
      if (!(e instanceof DefiniteFailure)) throw e;
    }
  }
  return sent;
}
