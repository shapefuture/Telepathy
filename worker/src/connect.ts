// Connecting a community: any group's own admin can do it, and normally doesn't have to do
// anything at all. Adding the bot to a group as its admin connects it; if a non-admin adds it,
// one "Connect" button appears that only an admin can press. /enable still works. The admin then
// gets their guide privately (or a one-tap link to it), with past messages one tap away.

import { ensureMember, grantStatement, type Visibility } from "./acl";
import { isOperator } from "./admins";
import type { App } from "./bot";
import { startAuto } from "./history-mcp";
import { defaultLang, langFromCode, T } from "./i18n";
import type { TgUser } from "./ingest";
import { DefiniteFailure, type InlineButton } from "./telegram";
import { escapeHtml } from "./text";
import { audit, newId, nowIso } from "./util";

export interface GroupChat {
  id: number;
  title?: string;
  username?: string;
}

const origin = (app: App) => (app.env.PUBLIC_URL ?? "").replace(/\/$/, "");
const url = (text: string, href: string) => ({ text, url: href }) as unknown as InlineButton;
const webApp = (text: string, href: string) => ({ text, web_app: { url: href } }) as unknown as InlineButton;

/** The bot's @username for deep links: BOT_USERNAME, else asked once from Telegram and kept. */
export async function botUsername(app: App): Promise<string | null> {
  const set = app.env.BOT_USERNAME?.replace(/^@/, "");
  if (set) return set;
  const kept = await app.db.prepare("SELECT value FROM settings WHERE key='bot.username'").first<{ value: string }>();
  if (kept) return kept.value;
  try {
    const me = await app.tg.call<{ username?: string }>("getMe", {});
    if (!me.username) return null;
    await app.db.prepare("INSERT INTO settings(key, value) VALUES ('bot.username', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(me.username).run();
    return me.username;
  } catch {
    return null;
  }
}

/** /start payload that opens a group's guide: "g" + chat id, with "m" for the minus sign. */
export const guideParam = (chatId: number) => `g${String(chatId).replace("-", "m")}`;
export function chatFromParam(p: string): number | null {
  const m = /^g(m?)(\d{1,16})$/.exec(p.trim());
  if (!m) return null;
  const n = Number(m[2]);
  return Number.isSafeInteger(n) ? (m[1] ? -n : n) : null;
}

/**
 * Connect (or reconnect) a group on behalf of one of its admins, tell the group, and give the
 * admin their guide. Callers check that `admin` really is an admin of `chat`.
 */
export async function connectGroup(app: App, chat: GroupChat, admin: TgUser, vis: Visibility = "MEMBER_CONSENTED"): Promise<string> {
  const operator = isOperator(app, admin.id);
  const member = await ensureMember(app.db, admin.id, operator ? "owner" : undefined, admin.language_code);
  if (!chat.title) {
    const info = await app.tg.call<{ title?: string; username?: string }>("getChat", { chat_id: chat.id }).catch(() => null);
    chat = { ...chat, title: info?.title, username: info?.username };
  }
  const existing = await app.db.prepare("SELECT id FROM sources WHERE chat_id=?").bind(chat.id).first<{ id: string }>();
  const id = existing?.id ?? newId();
  await app.db.batch([
    app.db
      .prepare(
        "INSERT INTO sources(id, chat_id, title, username, visibility, enabled, enabled_by, enabled_at) VALUES (?,?,?,?,?,1,?,?) " +
          "ON CONFLICT(chat_id) DO UPDATE SET enabled=1, visibility=excluded.visibility, title=excluded.title, " +
          "username=excluded.username, enabled_by=excluded.enabled_by, enabled_at=excluded.enabled_at",
      )
      .bind(id, chat.id, chat.title ?? null, chat.username ?? null, vis, member.id, nowIso()),
    grantStatement(app.db, id, member.id),
  ]);
  await audit(app.db, "source.enable", member.id, id, { visibility: vis, by: operator ? "operator" : "group admin" });
  const group = T(defaultLang()); // the whole group reads this one
  await app.tg.sendMessage(chat.id, group.connected());
  if (!(await sendGuide(app, admin, chat, id))) {
    // They never opened the bot privately, so it can't write to them: one tap opens the guide.
    const bot = await botUsername(app);
    if (bot) await app.tg.sendMessage(chat.id, group.guideInGroup(escapeHtml(admin.first_name || "")), { buttons: [[url(group.guideButton, `https://t.me/${bot}?start=${guideParam(chat.id)}`)]] });
  }
  return id;
}

/**
 * The admin's private guide for one group, with its past messages: loaded by themselves through
 * the operator's MCP server (operator's groups only, it reads with the operator's account),
 * otherwise one tap away in the app. False if Telegram won't let the bot write to them yet.
 */
export async function sendGuide(app: App, admin: TgUser, chat: GroupChat, sourceId: string): Promise<boolean> {
  const m = T(langFromCode(admin.language_code));
  const loaded = await app.db.prepare("SELECT 1 FROM history_jobs WHERE source_id=? AND done_at IS NOT NULL").bind(sourceId).first();
  const auto = !loaded && isOperator(app, admin.id) && (await startAuto(app.db, app.env, sourceId)) > 0;
  const o = origin(app);
  const buttons = o && !loaded && !auto ? [[webApp(m.historyButton, `${o}/app?start=history`)]] : undefined;
  const extra = loaded ? "" : auto ? m.historyAuto : m.historyOffer(!!o);
  try {
    await app.tg.sendMessage(admin.id, m.adminGuide(escapeHtml(chat.title ?? "")) + extra, { buttons });
    return true;
  } catch (e) {
    if (e instanceof DefiniteFailure) return false;
    throw e;
  }
}

/** Bot added by someone who isn't an admin there: ask once, with a button only admins can use. */
export async function askToConnect(app: App, chatId: number): Promise<void> {
  const m = T(defaultLang());
  await app.tg.sendMessage(chatId, m.askToConnect, { buttons: [[{ text: m.connectButton, callback_data: "cn" }]] });
}
