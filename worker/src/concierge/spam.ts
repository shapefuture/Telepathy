// Spam guard (ADR-007, item 5). A message is flagged when it looks like spam or a scheme: a new
// member's link, a link or a forward with earn-money wording. Flags go to the group's admins. The
// message is deleted and its author restricted only once the moderate action has been earned
// (gate.ts). A heated exchange between several members is only noted to the admins, never acted on.

import type { App } from "../bot";
import { memberByTg } from "../acl";
import { citation, type TgMessage } from "../ingest";
import { escapeHtml } from "../text";
import { nowIso } from "../util";
import { levelFor, RULES_VERSION, setVerdict } from "./gate";
import { managersOf, notifyStaff } from "./notify";
import { btn, T2 } from "./texts";

// A @name is a mention only when it is not part of an address (ann@example.com).
export const LINK = /https?:\/\/|t\.me\/|telegram\.me\/|(?<![\w.])@[a-z0-9_]{4,}/i;
export const SCHEME = /заработ|доход в (день|месяц)|пассивн\w* доход|инвестиц|крипт|usdt|гарант\w* доход|быстр\w* деньг|в личк|в лс|earn money|passive income|quick money|crypto|guaranteed|investment|dm me/i;
export const SHARP = /идиот|дебил|придурок|заткнись|пошел ты|пошёл ты|сам дурак|shut up|idiot|moron|stfu/i;
export const HEAT_WINDOW_MS = 30 * 60_000;
export const HEAT_MIN_PEOPLE = 2;

/** Runs for every stored group message. Cheap regex first: the database is only read when a word matches. */
export async function spamCheck(app: App, msg: TgMessage, sourceId: string, now = new Date()): Promise<string[]> {
  if (!msg.from || msg.from.is_bot) return [];
  const text = msg.text ?? msg.caption ?? "";
  const forwarded = !!msg.forward_from_chat;
  const link = LINK.test(text);
  const scheme = SCHEME.test(text);
  const keys: string[] = [];
  if (link || scheme || forwarded) keys.push(...(await flag(app, msg, sourceId, { link, scheme, forwarded }, now)));
  if (SHARP.test(text)) keys.push(...(await heat(app, msg.chat.id, sourceId, now)));
  return keys;
}

async function flag(app: App, msg: TgMessage, sourceId: string, sig: { link: boolean; scheme: boolean; forwarded: boolean }, now: Date): Promise<string[]> {
  const src = await app.db.prepare("SELECT spam_guard, username FROM sources WHERE id=?").bind(sourceId).first<{ spam_guard: number; username: string | null }>();
  if (!src?.spam_guard) return [];
  const tg = msg.from!.id;
  const admin = await app.db.prepare("SELECT is_admin FROM chat_admins WHERE chat_id=? AND tg_id=?").bind(msg.chat.id, tg).first<{ is_admin: number }>();
  if (admin?.is_admin) return [];
  const m = await memberByTg(app.db, tg);
  if (!m) return [];
  const prior = await app.db.prepare("SELECT COUNT(*) AS n FROM passages WHERE source_id=? AND author_id=? AND msg_id!=?").bind(sourceId, m.id, msg.message_id).first<{ n: number }>();
  const first = (prior?.n ?? 0) === 0;
  const reasons = [
    first && sig.link && "new_link",
    sig.scheme && sig.link && "scam_link",
    sig.forwarded && sig.scheme && "forwarded_scam",
    first && sig.scheme && "new_scam",
  ].filter((r): r is string => !!r);
  if (!reasons.length) return [];
  if (await app.db.prepare("SELECT 1 FROM spam_flags WHERE source_id=? AND msg_id=?").bind(sourceId, msg.message_id).first()) return [];
  const row = await app.db
    .prepare("INSERT INTO spam_flags(source_id, chat_id, msg_id, author_tg, reasons, status, created_at) VALUES (?,?,?,?,?, 'pending', ?) RETURNING id")
    .bind(sourceId, msg.chat.id, msg.message_id, tg, JSON.stringify(reasons), nowIso(now))
    .first<{ id: number }>();
  const id = row!.id;
  await app.db
    .prepare("INSERT INTO concierge_cases(subject, mode, source_id, version, created_at, action, executed) VALUES (?, 'spam', ?, ?, ?, 'moderate', 0)")
    .bind(`spam:${id}`, sourceId, RULES_VERSION, nowIso(now))
    .run();
  if ((await levelFor(app.db, app.env.CONCIERGE_AUTONOMY, "moderate")) === "auto") {
    await executeModerate(app, id, now);
    return [];
  }
  const link = citation(msg.chat.id, msg.message_id, src.username);
  return notifyStaff(app, await managersOf(app, msg.chat.id), `spam:${id}`, (lang) => {
    const t = T2(lang);
    return {
      text: t.spamAlert(escapeHtml(reasons.map((r) => t.spamReason[r] ?? r).join("; ")), link ? `<a href="${escapeHtml(link)}">${t.boardOpen}</a>` : ""),
      buttons: [[btn(t.bDelete, `bd:p:y:${id}`), btn(t.bNotSpam, `bd:p:n:${id}`)]],
    };
  });
}

/** Delete the message and restrict its author. Only ever run from a decision (a person's or the earned rule). */
export async function executeModerate(app: App, id: number, now = new Date()): Promise<"removed" | "failed" | "gone"> {
  const f = await app.db.prepare("SELECT chat_id, msg_id, author_tg, status FROM spam_flags WHERE id=?").bind(id).first<{ chat_id: number; msg_id: number; author_tg: number | null; status: string }>();
  if (!f || f.status !== "pending") return "gone";
  try {
    await app.tg.call("deleteMessage", { chat_id: f.chat_id, message_id: f.msg_id });
  } catch {
    return "failed"; // usually: the bot isn't allowed to delete here. Left pending for a person.
  }
  if (f.author_tg) {
    try {
      await app.tg.call("restrictChatMember", { chat_id: f.chat_id, user_id: f.author_tg, permissions: { can_send_messages: false } });
    } catch {
      // The message is gone already; a failed restriction is left for the admins to set by hand.
    }
  }
  await app.db.batch([
    app.db.prepare("UPDATE spam_flags SET status='removed', decided_at=? WHERE id=?").bind(nowIso(now), id),
    app.db.prepare("UPDATE concierge_cases SET executed=1 WHERE subject=?").bind(`spam:${id}`),
  ]);
  return "removed";
}

/** An admin says it isn't spam. */
export async function dismissSpam(app: App, id: number, now = new Date()): Promise<"ok" | "gone"> {
  const r = await app.db.prepare("UPDATE spam_flags SET status='dismissed', decided_at=? WHERE id=? AND status='pending' RETURNING id").bind(nowIso(now), id).first();
  if (!r) return "gone";
  await setVerdict(app.db, `spam:${id}`, "bad", now);
  return "ok";
}

async function heat(app: App, chatId: number, sourceId: string, now: Date): Promise<string[]> {
  const last = await app.db.prepare("SELECT value FROM settings WHERE key=?").bind(`heat:${sourceId}`).first<{ value: string }>();
  if (last && now.getTime() - Date.parse(last.value) < HEAT_WINDOW_MS) return [];
  const since = nowIso(new Date(now.getTime() - HEAT_WINDOW_MS));
  const { results } = await app.db
    .prepare("SELECT DISTINCT author_id, body FROM passages WHERE source_id=? AND event_at>=? AND part=0 AND removed_at IS NULL AND body IS NOT NULL AND author_id IS NOT NULL")
    .bind(sourceId, since)
    .all<{ author_id: string; body: string }>();
  const people = new Set(results.filter((r) => SHARP.test(r.body)).map((r) => r.author_id));
  if (people.size < HEAT_MIN_PEOPLE) return [];
  await app.db.prepare("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(`heat:${sourceId}`, nowIso(now)).run();
  return notifyStaff(app, await managersOf(app, chatId), `heat:${sourceId}:${nowIso(now)}`, (lang) => ({ text: T2(lang).heatAlert(people.size) }));
}
