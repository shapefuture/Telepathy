// Who manages a group: its own Telegram admins (creator or administrator), checked with Telegram.
// The operator (OWNER_IDS) runs the bot as a whole; group admins manage only their groups.

import type { App } from "./bot";
import { ownerIds } from "./env";
import { nowIso } from "./util";

const FRESH_MS = 10 * 60_000;

export const isOperator = (app: App, tgId?: number): boolean => tgId !== undefined && ownerIds(app.env).has(tgId);

/** Live answer from Telegram (group commands use this: no caching where it changes something). */
export async function isChatAdminLive(app: App, chatId: number, tgId: number): Promise<boolean> {
  try {
    const cm = await app.tg.call<{ status: string }>("getChatMember", { chat_id: chatId, user_id: tgId });
    return cm.status === "creator" || cm.status === "administrator";
  } catch {
    return false;
  }
}

/** Cached for 10 minutes (the app asks on every screen); chat_member updates clear it sooner. */
export async function isChatAdmin(app: App, chatId: number, tgId: number, now = new Date()): Promise<boolean> {
  const hit = await app.db.prepare("SELECT is_admin, checked_at FROM chat_admins WHERE chat_id=? AND tg_id=?").bind(chatId, tgId).first<{ is_admin: number; checked_at: string }>();
  if (hit && now.getTime() - Date.parse(hit.checked_at) < FRESH_MS) return !!hit.is_admin;
  const yes = await isChatAdminLive(app, chatId, tgId);
  await app.db
    .prepare("INSERT INTO chat_admins(chat_id, tg_id, is_admin, checked_at) VALUES (?,?,?,?) ON CONFLICT(chat_id, tg_id) DO UPDATE SET is_admin=excluded.is_admin, checked_at=excluded.checked_at")
    .bind(chatId, tgId, yes ? 1 : 0, nowIso(now))
    .run();
  return yes;
}

export async function forgetAdminCache(db: D1Database, chatId: number, tgId: number): Promise<void> {
  await db.prepare("DELETE FROM chat_admins WHERE chat_id=? AND tg_id=?").bind(chatId, tgId).run();
}

/** Telegram's own list of a group's admins (creator and administrators; bots left out). Empty when Telegram can't say. */
export async function chatAdminIds(app: App, chatId: number): Promise<number[]> {
  try {
    const list = await app.tg.call<{ user: { id: number; is_bot?: boolean } }[]>("getChatAdministrators", { chat_id: chatId });
    return Array.isArray(list) ? list.filter((x) => !x.user.is_bot).map((x) => x.user.id) : [];
  } catch {
    return [];
  }
}

/** Enabled groups this person manages: groups they're in (or connected) where they are an admin. */
export async function managedChats(app: App, tgId: number): Promise<number[]> {
  const { results } = await app.db
    .prepare(
      "SELECT DISTINCT s.chat_id FROM sources s LEFT JOIN members m ON m.tg_id=? " +
        "WHERE s.enabled=1 AND (s.enabled_by=m.id OR EXISTS (SELECT 1 FROM source_access a WHERE a.source_id=s.id AND a.member_id=m.id AND a.revoked_at IS NULL)) LIMIT 20",
    )
    .bind(tgId)
    .all<{ chat_id: number }>();
  const out: number[] = [];
  for (const r of results) if (await isChatAdmin(app, r.chat_id, tgId)) out.push(r.chat_id);
  return out;
}
