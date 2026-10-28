// Telegram ingestion (P03). One idempotent upsert per message:
// UNIQUE(source_id, msg_id, part) dedupes replays; edits apply only if newer (P03-03).

import { scrubStatement } from "./concierge/replay";
import { ensureMember, grantStatement, type Visibility } from "./acl";
import { classify } from "./classify";
import { nowIso } from "./util";

export interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  language_code?: string;
  username?: string;
}
export interface TgDocument {
  file_id: string;
  file_name?: string;
  file_size?: number;
}
export interface TgMessage {
  message_id: number;
  date: number;
  edit_date?: number;
  chat: { id: number; type: string; title?: string; username?: string };
  from?: TgUser;
  /** Set when sent on behalf of a channel or an anonymous admin; `from` is then a shared fake user. */
  sender_chat?: { id: number };
  text?: string;
  caption?: string;
  message_thread_id?: number;
  is_topic_message?: boolean;
  reply_to_message?: { message_id: number; from?: TgUser; sender_chat?: { id: number } };
  document?: TgDocument;
  entities?: { type: string; offset: number; length: number }[];
  migrate_to_chat_id?: number;
}

export interface Source {
  id: string;
  chat_id: number;
  title: string | null;
  username: string | null;
  visibility: Visibility;
  enabled: number;
  retention_days: number;
  hints: number;
}

export type IngestOutcome = "not_authorized" | "opted_out" | "stored" | "unchanged";

export async function enabledSource(db: D1Database, chatId: number): Promise<Source | null> {
  return db.prepare("SELECT * FROM sources WHERE chat_id=? AND enabled=1").bind(chatId).first<Source>();
}

/**
 * Bot API ids of supergroups and channels are -100 followed by their channel id, so they are at most
 * -10^12. A basic group's id is smaller in magnitude, even when it happens to start with "-100".
 */
export const SUPERGROUP_MAX = -1_000_000_000_000;
export const isSupergroupId = (chatId: number): boolean => chatId <= SUPERGROUP_MAX;

export function citation(chatId: number, msgId: number, username: string | null, topicId?: number | null): string | null {
  if (username) return `https://t.me/${username}/${msgId}`;
  if (!isSupergroupId(chatId)) return null; // basic groups have no message links
  const s = String(chatId).slice(4); // without the -100 prefix
  return topicId ? `https://t.me/c/${s}/${topicId}/${msgId}` : `https://t.me/c/${s}/${msgId}`;
}

const iso = (unix: number): string => nowIso(new Date(unix * 1000));

/** Store or update one group message. Nothing is stored for chats that are not enabled (C01). */
export async function ingestMessage(db: D1Database, msg: TgMessage): Promise<{ outcome: IngestOutcome; source?: Source }> {
  const source = await enabledSource(db, msg.chat.id);
  if (!source) return { outcome: "not_authorized" };
  let authorId: string | null = null;
  const stmts: D1PreparedStatement[] = [];
  if (msg.from && !msg.from.is_bot) {
    const m = await ensureMember(db, msg.from.id, undefined, msg.from.language_code);
    if (m.collection_opt_out) return { outcome: "opted_out", source };
    authorId = m.id;
    stmts.push(grantStatement(db, source.id, m.id));
  }
  const text = msg.text ?? msg.caption ?? "";
  const body = text.trim() ? text : null;
  const c = classify(text);
  const topic = msg.is_topic_message ? (msg.message_thread_id ?? null) : null;
  stmts.push(
    db
      .prepare(
        "INSERT INTO passages(source_id, msg_id, part, author_id, body, event_at, edit_version, topic_id, " +
          "reply_to, intent, intent_conf) VALUES (?,?,0,?,?,?,?,?,?,?,?) " +
          "ON CONFLICT(source_id, msg_id, part) DO UPDATE SET body=excluded.body, " +
          "edit_version=excluded.edit_version, intent=excluded.intent, intent_conf=excluded.intent_conf " +
          "WHERE excluded.edit_version > passages.edit_version AND passages.removed_at IS NULL",
      )
      .bind(
        source.id,
        msg.message_id,
        authorId,
        body,
        iso(msg.date),
        msg.edit_date ?? 0,
        topic,
        msg.reply_to_message?.message_id ?? null,
        c.intent,
        c.confidence,
      ),
  );
  const results = await db.batch(stmts);
  const changed = results.at(-1)!.meta.changes > 0;
  return { outcome: changed ? "stored" : "unchanged", source };
}

/** Revoke all evidence for one message, including attached document chunks (C06). */
export async function removeMessage(db: D1Database, sourceId: string, msgId: number): Promise<boolean> {
  const r = await db
    .prepare("UPDATE passages SET body=NULL, removed_at=? WHERE source_id=? AND msg_id=? AND removed_at IS NULL")
    .bind(nowIso(), sourceId, msgId)
    .run();
  if (r.meta.changes > 0) await db.batch([db.prepare("DELETE FROM ai_cache"), scrubStatement(db)]); // summaries and concierge cases may quote it
  return r.meta.changes > 0;
}

// ---- Documents (edge-safe text formats only) ------------------------------------------

export const EDGE_DOC_MAX_BYTES = 512 * 1024; // keeps parsing well inside the CPU budget
const TEXT_EXT = [".txt", ".md", ".markdown", ".html", ".htm", ".vtt", ".srt", ".csv"];
const TARGET_WORDS = 260;
const MAX_WORDS = 450;
const OVERLAP_WORDS = 50;
const WINDOW_SECONDS = 90;

export const OFFLOAD_EXT = [".pdf", ".docx", ".pptx"];
export const OFFLOAD_MAX_BYTES = 20 * 1024 * 1024; // Bot API download limit

/** Heavy formats parsed off-Worker by the GitHub Actions job (when enabled). */
export function docOffloadable(doc?: TgDocument): boolean {
  const name = (doc?.file_name ?? "").toLowerCase();
  return !!doc && OFFLOAD_EXT.some((e) => name.endsWith(e)) && (doc.file_size ?? 0) <= OFFLOAD_MAX_BYTES;
}

export function docSupported(doc?: TgDocument): boolean {
  const name = (doc?.file_name ?? "").toLowerCase();
  return !!doc && TEXT_EXT.some((e) => name.endsWith(e)) && (doc.file_size ?? 0) <= EDGE_DOC_MAX_BYTES;
}

interface Segment {
  locator: string | null;
  text: string;
}

const fmtTs = (s: number): string => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

export function parseTranscript(text: string): Segment[] {
  const cue = /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,]\d{1,3}\s*-->/;
  const cues: [number, string][] = [];
  let start: number | null = null;
  let buf: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const m = cue.exec(line);
    if (m) {
      if (start !== null && buf.length) cues.push([start, buf.join(" ")]);
      start = Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      buf = [];
    } else if (line && !/^\d+$/.test(line) && line !== "WEBVTT" && !line.startsWith("NOTE") && start !== null) {
      buf.push(line.replace(/<[^>]+>/g, ""));
    }
  }
  if (start !== null && buf.length) cues.push([start, buf.join(" ")]);
  const out: Segment[] = [];
  let winStart: number | null = null;
  let win: string[] = [];
  for (const [s, t] of cues) {
    if (winStart === null) winStart = s;
    if (s - winStart >= WINDOW_SECONDS && win.length) {
      out.push({ locator: fmtTs(winStart), text: win.join(" ") });
      winStart = s;
      win = [];
    }
    win.push(t);
  }
  if (win.length && winStart !== null) out.push({ locator: fmtTs(winStart), text: win.join(" ") });
  return out;
}

export function parseDocument(fileName: string, data: string): Segment[] {
  const name = fileName.toLowerCase();
  if (name.endsWith(".vtt") || name.endsWith(".srt")) return parseTranscript(data);
  if (name.endsWith(".html") || name.endsWith(".htm")) {
    const text = data
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<(br|p|div|li|h\d|tr)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " ");
    return [{ locator: null, text }];
  }
  return [{ locator: null, text: data }];
}

export function chunk(segments: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const seg of segments) {
    const words = seg.text.split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    if (words.length <= MAX_WORDS) {
      out.push({ locator: seg.locator, text: words.join(" ") });
      continue;
    }
    for (let start = 0; start < words.length; start = start + TARGET_WORDS - OVERLAP_WORDS) {
      const end = Math.min(words.length, start + TARGET_WORDS);
      out.push({ locator: seg.locator, text: words.slice(start, end).join(" ") });
      if (end === words.length) break;
    }
  }
  return out;
}

/** Store document chunks as parts 1..n of the posting message (deleting the message revokes them). */
export async function storeDocument(
  db: D1Database,
  source: Source,
  msg: TgMessage,
  fileName: string,
  data: string,
): Promise<number> {
  return storeChunks(db, source.id, msg.message_id, fileName, chunk(parseDocument(fileName, data)));
}

export const MAX_CHUNKS = 200;

/** Insert pre-chunked text. Stores nothing if the posting message was removed meanwhile (C06). */
export async function storeChunks(
  db: D1Database,
  sourceId: string,
  msgId: number,
  fileName: string,
  segments: { locator: string | null; text: string }[],
): Promise<number> {
  const live = await db
    .prepare("SELECT author_id, event_at FROM passages WHERE source_id=? AND msg_id=? AND part=0 AND removed_at IS NULL")
    .bind(sourceId, msgId)
    .first<{ author_id: string | null; event_at: string }>();
  if (!live) return 0;
  const chunks = segments.filter((c) => c.text.trim()).slice(0, MAX_CHUNKS);
  const stmts = chunks.map((c, i) =>
    db
      .prepare(
        "INSERT OR IGNORE INTO passages(source_id, msg_id, part, author_id, body, label, event_at) " +
          "VALUES (?,?,?,?,?,?,?)",
      )
      .bind(sourceId, msgId, i + 1, live.author_id, c.text, c.locator ? `${fileName} · ${c.locator}` : fileName, live.event_at),
  );
  if (stmts.length) await db.batch(stmts);
  return stmts.length;
}
