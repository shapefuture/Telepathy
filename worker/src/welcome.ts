// Welcome for people who join an enabled group: who the bot is and why to open a private chat.
// Telegram has no "only you can see this" message in groups, so, in order of preference:
//   1. a private message, if this person has opened the bot before;
//   2. a private message after a join request (Telegram allows that even without /start);
//   3. otherwise a short group message tagging them, with a "Start" button, deleted after 2 min.
// Once per person per group. Owners switch it off per group with /welcome off.

import type { App } from "./bot";
import { defaultLang, T, type Lang } from "./i18n";
import { labelIn, TAXONOMY } from "./experts";
import { DefiniteFailure, type InlineButton } from "./telegram";
import { escapeHtml, snippet } from "./text";
import { topicCounts } from "./wow";
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
    await onboarding(app, user.id, src.id, defaultLang());
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
  const chat = userChatId ?? user.id;
  if (await dm(app, chat, src.title ?? "")) await onboarding(app, chat, src.id, defaultLang());
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

/**
 * Newcomer onboarding (plan: journey 2): the questions this group asks most, the topics it talks
 * about (tap one to say what you can help with), and two lines on what is kept and how to delete it.
 */
export async function onboarding(app: App, userChat: number, sourceId: string, lang: Lang): Promise<void> {
  const m = T(lang);
  const { results: qs } = await app.db
    .prepare(
      "SELECT p.id, p.body FROM passages p WHERE p.source_id=? AND p.part=0 AND p.removed_at IS NULL AND p.body IS NOT NULL AND p.intent='help_request' AND p.intent_conf>=0.55 " +
        "ORDER BY (SELECT COUNT(*) FROM passages r WHERE r.source_id=p.source_id AND r.reply_to=p.msg_id AND r.part=0 AND r.removed_at IS NULL) DESC, p.event_at DESC LIMIT 3",
    )
    .bind(sourceId)
    .all<{ id: number; body: string }>();
  const topics = await topicCounts(app.db, sourceId, 4);
  const rows: InlineButton[][] = qs.map((q) => [{ text: snippet(q.body, [], 52), callback_data: `nq:${q.id}` } as InlineButton]);
  const chips = topics.map((t) => ({ text: labelIn(TAXONOMY.get(t.code)!, lang), callback_data: `ob:${t.code}` }) as InlineButton);
  for (let i = 0; i < chips.length; i += 2) rows.push(chips.slice(i, i + 2));
  rows.push([{ text: m.bSkip, callback_data: "ob:skip" } as InlineButton]);
  const parts = [...(qs.length ? [m.onbQuestions] : []), m.onbPick, m.onbPrivacy];
  try {
    await app.tg.sendMessage(userChat, parts.join("\n\n"), { buttons: rows });
  } catch (e) {
    if (!(e instanceof DefiniteFailure)) throw e;
  }
}
