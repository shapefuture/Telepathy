// Welcome for people who join an enabled group: who the bot is and why to open a private chat.
// Telegram has no "only you can see this" message in groups, so, in order of preference:
//   1. a private message, if this person has opened the bot before;
//   2. a private message after a join request (Telegram allows that even without /start);
//   3. otherwise a short group message tagging them, with a "Start" button, deleted after 2 min.
// Once per person per group. Owners switch it off per group with /welcome off.

import type { App } from "./bot";
import { defaultLang, T } from "./i18n";
import { DefiniteFailure, type InlineButton } from "./telegram";
import { escapeHtml } from "./text";
import { nowIso } from "./util";

export const GROUP_WELCOME_TTL_MS = 2 * 60_000;

interface Joiner {
  id: number;
  is_bot?: boolean;
  first_name?: string;
}

async function source(db: D1Database, chatId: number) {
  return db.prepare("SELECT id, title, welcome FROM sources WHERE chat_id=? AND enabled=1").bind(chatId).first<{ id: string; title: string | null; welcome: number }>();
}

async function claim(db: D1Database, sourceId: string, tgId: number, via: string): Promise<boolean> {
  const r = await db.prepare("INSERT OR IGNORE INTO welcomed(source_id, tg_id, via, at) VALUES (?,?,?,?) RETURNING tg_id").bind(sourceId, tgId, via, nowIso()).first();
  return !!r;
}

async function dm(app: App, userChat: number, title: string): Promise<boolean> {
  try {
    await app.tg.sendMessage(userChat, T(defaultLang()).welcomeDm(escapeHtml(title)));
    return true;
  } catch (e) {
    if (e instanceof DefiniteFailure) return false; // they haven't opened the bot
    throw e;
  }
}

/** Someone became a member of a group (chat_member update). */
export async function welcomeJoiner(app: App, chatId: number, user: Joiner): Promise<void> {
  if (user.is_bot) return;
  const src = await source(app.db, chatId);
  if (!src || !src.welcome) return;
  if (!(await claim(app.db, src.id, user.id, "pending"))) return;
  const title = src.title ?? "";
  if (await dm(app, user.id, title)) {
    await app.db.prepare("UPDATE welcomed SET via='dm' WHERE source_id=? AND tg_id=?").bind(src.id, user.id).run();
    return;
  }
  const m = T(defaultLang());
  const name = `<a href="tg://user?id=${user.id}">${escapeHtml(user.first_name || "👋")}</a>`;
  const bot = app.env.BOT_USERNAME?.replace(/^@/, "");
  const buttons = bot ? [[{ text: m.welcomeButton, url: `https://t.me/${bot}?start=welcome` } as unknown as InlineButton]] : undefined;
  const sent = await app.tg.sendMessage(chatId, m.welcomeGroup(name), { buttons });
  await app.db.batch([
    app.db.prepare("UPDATE welcomed SET via='group' WHERE source_id=? AND tg_id=?").bind(src.id, user.id),
    app.db.prepare("INSERT OR IGNORE INTO pending_deletes(chat_id, message_id, delete_at) VALUES (?,?,?)").bind(chatId, sent.message_id, nowIso(new Date(Date.now() + GROUP_WELCOME_TTL_MS))),
  ]);
}

/** Someone asked to join (groups with "approve new members"): Telegram lets the bot write to them. */
export async function welcomeJoinRequest(app: App, chatId: number, user: Joiner, userChatId?: number): Promise<void> {
  if (user.is_bot) return;
  const src = await source(app.db, chatId);
  if (!src || !src.welcome) return;
  if (!(await claim(app.db, src.id, user.id, "join_request"))) return;
  await dm(app, userChatId ?? user.id, src.title ?? "");
}

/** Cron: delete group welcome messages whose time is up. */
export async function deleteDue(app: App, budget = 5, now = new Date()): Promise<number> {
  const { results } = await app.db.prepare("SELECT chat_id, message_id FROM pending_deletes WHERE delete_at<=? LIMIT ?").bind(nowIso(now), budget).all<{ chat_id: number; message_id: number }>();
  for (const r of results) {
    await app.tg.call("deleteMessage", { chat_id: r.chat_id, message_id: r.message_id }).catch(() => undefined); // already gone is fine
    await app.db.prepare("DELETE FROM pending_deletes WHERE chat_id=? AND message_id=?").bind(r.chat_id, r.message_id).run();
  }
  return results.length;
}
