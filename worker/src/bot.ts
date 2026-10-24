// Telegram update router (P03, P06, P08, P09, P11-07, P13-01/02/04/05).
//   * group messages are stored only for chats an owner explicitly enabled
//   * in a group, /ask (or @mention) answers only from that same group (P13-01)
//   * everything personal (profile, intros, digest, data rights) happens in private chat
//   * texts follow the member's language: Telegram setting or /language (P13-04)

import { ensureMember, grantStatement, langOf, memberByTg, readable, revoke, VISIBILITIES, type Member, type Visibility } from "./acl";
import { digestHour, ownerIds, timezone, type Env } from "./env";
import { eligibleCandidates, label, labelIn, labelsFor, matchSkills, resolveSkill, TAXONOMY } from "./experts";
import { recordAnswer, vote } from "./feedback";
import { build as buildDigest } from "./digest";
import { answerSuggestion, detectEvent, markCanonical, toIcs, upcomingEvents } from "./features";
import { maybeHint } from "./hints";
import { defaultLang, langFromCode, T, type Lang, type Messages } from "./i18n";
import { citation, docOffloadable, docSupported, EDGE_DOC_MAX_BYTES, enabledSource, ingestMessage, removeMessage, storeDocument, type TgMessage, type TgUser } from "./ingest";
import { act, cancelNeed, IntroError, requestIntro } from "./intros";
import { reconcile } from "./outbox";
import { forgetMember } from "./rights";
import { forgetPerson, personForMember } from "./continuity/people";
import { cmdPassport, CONTINUITY_OWNER, ownerContinuity } from "./continuity/bot";
import { hydraStatus } from "./hydra/bot";
import { touchOwners } from "./hydra/notices";
import { assistCallback, cmdHelpNeed, forgetMissions, listMissions, ownerAssistCommand, OWNER_COMMANDS } from "./assist/bot";
import { brief } from "./ai/beam";
import { answer, parseFilters, renderAnswer } from "./search";
import type { Fetcher, InlineButton, Telegram } from "./telegram";
import { DefiniteFailure } from "./telegram";
import { welcomeJoinRequest, welcomeJoiner } from "./welcome";
import { escapeHtml } from "./text";
import { audit, DAY, HOUR, localParts, newId, nowIso, tzOffsetMinutes } from "./util";

export interface App {
  env: Env;
  db: D1Database;
  tg: Telegram;
  /** Outbound HTTP for partner gateways (tests inject a fake). */
  net?: Fetcher;
  /** Cron only: subrequests left in this run; loops stop before they would run out. */
  budget?: { left(): number };
}

interface CallbackQuery {
  id: string;
  from: TgUser;
  data?: string;
  message?: { message_id: number; chat: { id: number; type?: string } };
}
interface ChatMemberUpdated {
  chat: { id: number; type: string; title?: string };
  from: TgUser;
  old_chat_member?: { status: string; user: TgUser; is_member?: boolean };
  new_chat_member: { status: string; user: TgUser; is_member?: boolean };
}
interface ChatJoinRequest {
  chat: { id: number; type: string; title?: string };
  from: TgUser;
  user_chat_id?: number;
}
export interface Update {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: CallbackQuery;
  my_chat_member?: ChatMemberUpdated;
  chat_member?: ChatMemberUpdated;
  chat_join_request?: ChatJoinRequest;
}

/** Kept for tests and docs: the English privacy notice. */
export const PRIVACY_NOTICE = T("en").privacy;

const PRIVATE_ONLY = new Set(["intro", "expert", "profile", "optin", "optout", "skills", "forget_me", "digest", "requests", "language", "catchup", "events", "pings", "app", "cancel", "desk", "offer", "partner", "fed", "ledger", "passport", "continuity", "destinations", "alert", "drill"]);
const GROUP_TYPES = new Set(["group", "supergroup"]);
const btn = (text: string, data: string): InlineButton => ({ text, callback_data: data });

// ---- helpers --------------------------------------------------------------------------

export function parseCommand(msg: TgMessage, botUsername?: string): { cmd: string; args: string } | null {
  const text = msg.text ?? "";
  const e = msg.entities?.[0];
  if (!e || e.type !== "bot_command" || e.offset !== 0) return null;
  const [name, at] = text.slice(1, e.length).toLowerCase().split("@");
  if (at && botUsername && at !== botUsername.toLowerCase()) return null; // addressed to another bot
  return { cmd: name ?? "", args: text.slice(e.length).trim() };
}

/** "@telepathy_bot where is the venue?" -> "where is the venue?" (only when BOT_USERNAME is set). */
export function mentionQuestion(msg: TgMessage, botUsername?: string): string | null {
  if (!botUsername || !msg.text) return null;
  const handle = `@${botUsername.toLowerCase()}`;
  const hit = msg.entities?.find((e) => e.type === "mention" && msg.text!.slice(e.offset, e.offset + e.length).toLowerCase() === handle);
  if (!hit) return null;
  const q = (msg.text.slice(0, hit.offset) + msg.text.slice(hit.offset + hit.length)).trim();
  return q || null;
}

const hits = new Map<number, number[]>();
/** Per-isolate sliding window. Best effort: isolates are not shared, which is fine for abuse damping. */
export function rateOk(userId: number, perMinute: number, now = Date.now()): boolean {
  const q = (hits.get(userId) ?? []).filter((t) => now - t < 60_000);
  if (q.length >= perMinute) {
    hits.set(userId, q);
    return false;
  }
  q.push(now);
  hits.set(userId, q);
  return true;
}
export const resetRateLimits = () => hits.clear();

/** Public origin for links back to this Worker (set PUBLIC_URL; falls back to workers.dev naming). */
const appOrigin = (app: App) => (app.env.PUBLIC_URL ?? "").replace(/\/$/, "");

const isOwner = (app: App, userId?: number) => userId !== undefined && ownerIds(app.env).has(userId);
const rateLimit = (app: App) => Number(app.env.ASK_RATE_PER_MINUTE ?? "10") || 10;

async function isChatAdmin(app: App, chatId: number, userId: number): Promise<boolean> {
  try {
    const cm = await app.tg.call<{ status: string }>("getChatMember", { chat_id: chatId, user_id: userId });
    return cm.status === "creator" || cm.status === "administrator";
  } catch {
    return false;
  }
}

/** Configured owner AND current chat admin: two independent checks. */
async function ownerInGroup(app: App, msg: TgMessage): Promise<boolean> {
  return !!msg.from && isOwner(app, msg.from.id) && (await isChatAdmin(app, msg.chat.id, msg.from.id));
}

const reply = (app: App, chatId: number, text: string, buttons?: InlineButton[][], replyTo?: number) =>
  app.tg.sendMessage(chatId, text, { buttons, replyTo });

/** Language for someone we may not know yet: stored choice, else their Telegram setting. */
async function langForUser(app: App, user?: TgUser): Promise<Lang> {
  if (!user) return defaultLang();
  const m = await memberByTg(app.db, user.id);
  return m?.lang_explicit ? langOf(m) : langFromCode(user.language_code);
}

async function knownMember(app: App, msg: TgMessage): Promise<Member | null> {
  if (!msg.from) return null;
  let m = await memberByTg(app.db, msg.from.id);
  if (!m && isOwner(app, msg.from.id)) m = await ensureMember(app.db, msg.from.id, "owner");
  if (!m || m.removed_at) {
    await reply(app, msg.chat.id, T(langFromCode(msg.from.language_code)).dontKnowYou);
    return null;
  }
  // Existing member: keep their language in sync with Telegram unless they chose one.
  return ensureMember(app.db, msg.from.id, undefined, msg.from.language_code);
}

// ---- entry point ----------------------------------------------------------------------

/** Handle one update. Returns effect keys that should be dispatched right away. */
export async function handleUpdate(app: App, u: Update): Promise<string[]> {
  if (u.message) return onMessage(app, u.message, false);
  if (u.edited_message) return onMessage(app, u.edited_message, true);
  if (u.callback_query) return onCallback(app, u.callback_query);
  if (u.my_chat_member) return onBotMembership(app, u.my_chat_member);
  if (u.chat_member) return onChatMember(app, u.chat_member);
  if (u.chat_join_request) {
    await welcomeJoinRequest(app, u.chat_join_request.chat.id, u.chat_join_request.from, u.chat_join_request.user_chat_id);
    return [];
  }
  return [];
}

async function onMessage(app: App, msg: TgMessage, edited: boolean): Promise<string[]> {
  const command = edited ? null : parseCommand(msg, app.env.BOT_USERNAME);
  if (GROUP_TYPES.has(msg.chat.type)) {
    if (msg.migrate_to_chat_id) {
      // Group upgraded to a supergroup: Telegram gives it a new id. Keep collecting it.
      const r = await app.db.prepare("UPDATE sources SET chat_id=? WHERE chat_id=?").bind(msg.migrate_to_chat_id, msg.chat.id).run();
      if (r.meta.changes) await audit(app.db, "source.migrate", "system", String(msg.chat.id), { to: msg.migrate_to_chat_id });
      return [];
    }
    if (command) {
      if (PRIVATE_ONLY.has(command.cmd)) {
        await reply(app, msg.chat.id, T(await langForUser(app, msg.from)).privateOnly, undefined, msg.message_id);
        return [];
      }
      if (command.cmd === "ask") return groupAsk(app, msg, command.args);
      if (command.cmd === "enable") return cmdEnable(app, msg, command.args);
      if (command.cmd === "disable") return cmdDisable(app, msg);
      if (command.cmd === "retention") return cmdRetention(app, msg, command.args);
      if (command.cmd === "hints") return cmdToggle(app, msg, command.args, "hints");
      if (command.cmd === "routing") return cmdToggle(app, msg, command.args, "routing");
      if (command.cmd === "welcome") return cmdToggle(app, msg, command.args, "welcome");
      if (command.cmd === "canonical") return cmdCanonical(app, msg);
      if (command.cmd === "notevent") return cmdNotEvent(app, msg);
      if (command.cmd === "forget") return cmdForgetMessage(app, msg);
    }
    const keys: string[] = [];
    const mentioned = edited ? null : mentionQuestion(msg, app.env.BOT_USERNAME);
    // Answer before storing, so the question can't match itself.
    if (mentioned) keys.push(...(await groupAsk(app, msg, mentioned)));
    keys.push(...(await ingest(app, msg, edited)));
    return keys;
  }
  if (msg.chat.type !== "private" || !msg.from) return [];
  // In private, a plain message is a question: no command needed.
  if (!command) {
    const q = (msg.text ?? "").trim();
    return q && !edited ? privateCommand(app, msg, "ask", q) : [];
  }
  return privateCommand(app, msg, command.cmd, command.args);
}

async function ingest(app: App, msg: TgMessage, edited: boolean): Promise<string[]> {
  const { outcome, source } = await ingestMessage(app.db, msg);
  if (outcome !== "stored" || !source || edited || msg.edit_date) return [];
  const keys: string[] = [];
  const text = msg.text ?? msg.caption ?? "";
  if (text) await detectEvent(app.db, source.id, msg.message_id, text, new Date(), tzOffsetMinutes(new Date(), timezone(app.env)));
  if (!msg.document) {
    const hint = await maybeHint(app.db, source, msg, await langForUser(app, msg.from));
    if (hint) keys.push(hint);
    return keys;
  }
  if (app.env.OFFLOAD_DOCUMENTS === "true" && docOffloadable(msg.document)) {
    const now = nowIso();
    await app.db
      .prepare(
        "INSERT OR IGNORE INTO doc_queue(source_id, msg_id, file_id, file_name, file_size, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
      )
      .bind(source.id, msg.message_id, msg.document.file_id, msg.document.file_name ?? "file", msg.document.file_size ?? null, now, now)
      .run();
    return keys;
  }
  if (!docSupported(msg.document)) return keys;
  try {
    const text = await app.tg.fileText(msg.document.file_id, EDGE_DOC_MAX_BYTES);
    await storeDocument(app.db, source, msg, msg.document.file_name ?? "file.txt", text);
  } catch (e) {
    console.warn("document ingest failed", msg.chat.id, msg.message_id, String(e));
  }
  return keys;
}

/** P13-01: answer in the group, from that group only. Everyone there can already read it. */
async function groupAsk(app: App, msg: TgMessage, question: string): Promise<string[]> {
  const source = await enabledSource(app.db, msg.chat.id);
  if (!source || !msg.from || msg.from.is_bot) return [];
  const lang = await langForUser(app, msg.from);
  if (!rateOk(msg.from.id, rateLimit(app))) {
    await reply(app, msg.chat.id, T(lang).tooMany, undefined, msg.message_id);
    return [];
  }
  const asker = await ensureMember(app.db, msg.from.id, undefined, msg.from.language_code);
  if (asker.collection_opt_out || asker.removed_at) return [];
  const f = await parseFilters(app.db, new Set([source.id]), question);
  const a = await answer(app.db, f.readable, f.query, f.filters);
  const answerId = a.status === "answered" ? await recordAnswer(app.db, asker.id, a.quotes.map((q) => q.id)) : undefined;
  const ai = a.status === "answered" ? await brief(app, f.readable, f.query, a.quotes, lang) : null;
  const r = renderAnswer(a, timezone(app.env), lang, { scope: "group", answerId, brief: ai });
  await reply(app, msg.chat.id, r.text, r.buttons, msg.message_id);
  return [];
}

// ---- owner commands in groups -----------------------------------------------------------

async function cmdEnable(app: App, msg: TgMessage, args: string): Promise<string[]> {
  if (!(await ownerInGroup(app, msg))) return []; // silent: don't advertise admin commands
  const m = T(await langForUser(app, msg.from));
  const vis = (args.trim().toUpperCase() || "MEMBER_CONSENTED") as Visibility;
  if (!VISIBILITIES.includes(vis)) {
    await reply(app, msg.chat.id, m.visibilityMust(VISIBILITIES.join(", ")));
    return [];
  }
  const owner = await ensureMember(app.db, msg.from!.id, "owner");
  const existing = await app.db.prepare("SELECT id FROM sources WHERE chat_id=?").bind(msg.chat.id).first<{ id: string }>();
  const id = existing?.id ?? newId();
  await app.db.batch([
    app.db
      .prepare(
        "INSERT INTO sources(id, chat_id, title, username, visibility, enabled, enabled_by, enabled_at) VALUES (?,?,?,?,?,1,?,?) " +
          "ON CONFLICT(chat_id) DO UPDATE SET enabled=1, visibility=excluded.visibility, title=excluded.title, " +
          "username=excluded.username, enabled_by=excluded.enabled_by, enabled_at=excluded.enabled_at",
      )
      .bind(id, msg.chat.id, msg.chat.title ?? null, msg.chat.username ?? null, vis, owner.id, nowIso()),
    grantStatement(app.db, id, owner.id),
  ]);
  await audit(app.db, "source.enable", owner.id, id, { visibility: vis });
  await reply(app, msg.chat.id, m.enabled(vis));
  // The command guide goes to the admin privately, not to the whole group.
  try {
    await app.tg.sendMessage(msg.from!.id, m.adminGuide(escapeHtml(msg.chat.title ?? "")));
  } catch (e) {
    if (!(e instanceof DefiniteFailure)) throw e; // they never opened the bot privately: nothing to do
  }
  return [];
}

async function cmdDisable(app: App, msg: TgMessage): Promise<string[]> {
  if (!(await ownerInGroup(app, msg))) return [];
  const r = await app.db.prepare("UPDATE sources SET enabled=0 WHERE chat_id=? AND enabled=1").bind(msg.chat.id).run();
  if (r.meta.changes) {
    await audit(app.db, "source.disable", String(msg.from!.id), String(msg.chat.id));
    await reply(app, msg.chat.id, T(await langForUser(app, msg.from)).disabled);
  }
  return [];
}

async function cmdRetention(app: App, msg: TgMessage, args: string): Promise<string[]> {
  if (!(await ownerInGroup(app, msg))) return [];
  const m = T(await langForUser(app, msg.from));
  const src = await enabledSource(app.db, msg.chat.id);
  const days = Number(args.trim());
  if (!src || !args.trim() || !Number.isInteger(days) || days < 0 || days > 3650) {
    await reply(app, msg.chat.id, m.retentionUsage);
    return [];
  }
  await app.db.prepare("UPDATE sources SET retention_days=? WHERE id=?").bind(days, src.id).run();
  await audit(app.db, "source.retention", String(msg.from!.id), src.id, { days });
  await reply(app, msg.chat.id, days === 0 ? m.retentionKeepAll : m.retentionSet(days));
  return [];
}

/** Per-group opt-ins that make the bot speak unprompted: hints (P13-02) and routing (P13-03). */
async function cmdToggle(app: App, msg: TgMessage, args: string, col: "hints" | "routing" | "welcome"): Promise<string[]> {
  if (!(await ownerInGroup(app, msg))) return [];
  const m = T(await langForUser(app, msg.from));
  const src = await enabledSource(app.db, msg.chat.id);
  const arg = args.trim().toLowerCase();
  if (!src || (arg !== "on" && arg !== "off")) {
    await reply(app, msg.chat.id, col === "hints" ? m.hintsUsage : col === "welcome" ? m.welcomeUsage : m.routingUsage);
    return [];
  }
  await app.db.prepare(`UPDATE sources SET ${col}=? WHERE id=?`).bind(arg === "on" ? 1 : 0, src.id).run();
  await audit(app.db, `source.${col}`, String(msg.from!.id), src.id, { on: arg === "on" });
  const text = col === "hints" ? (arg === "on" ? m.hintsOn : m.hintsOff) : col === "welcome" ? (arg === "on" ? m.welcomeOn : m.welcomeOff) : arg === "on" ? m.routingOn : m.routingOff;
  await reply(app, msg.chat.id, text);
  return [];
}

/** P13-07: an owner (chat admin) replies /canonical to the best answer on a topic. */
async function cmdCanonical(app: App, msg: TgMessage): Promise<string[]> {
  const target = msg.reply_to_message;
  const src = await enabledSource(app.db, msg.chat.id);
  if (!target || !src || !(await ownerInGroup(app, msg))) return [];
  const m = T(await langForUser(app, msg.from));
  const r = await markCanonical(app.db, src.id, target.message_id);
  if (!r.ok) await reply(app, msg.chat.id, m.nothingStored, undefined, msg.message_id);
  else {
    await audit(app.db, "passage.canonical", String(msg.from!.id), `${src.id}:${target.message_id}`, { superseded: r.superseded });
    await reply(app, msg.chat.id, r.superseded ? m.canonicalSuperseded(r.superseded) : m.canonicalSet, undefined, msg.message_id);
  }
  return [];
}

/** P13-10: moderators hide a false-positive event by replying /notevent to it. */
async function cmdNotEvent(app: App, msg: TgMessage): Promise<string[]> {
  const target = msg.reply_to_message;
  const src = await enabledSource(app.db, msg.chat.id);
  if (!target || !src || !(await ownerInGroup(app, msg))) return [];
  await app.db.prepare("UPDATE events SET hidden=1 WHERE source_id=? AND msg_id=?").bind(src.id, target.message_id).run();
  await reply(app, msg.chat.id, T(await langForUser(app, msg.from)).eventHidden, undefined, msg.message_id);
  return [];
}

/** Reply /forget to a message: its author or an owner removes it from Telepathy. */
async function cmdForgetMessage(app: App, msg: TgMessage): Promise<string[]> {
  const target = msg.reply_to_message;
  const src = await enabledSource(app.db, msg.chat.id);
  if (!target || !src || !msg.from) return [];
  const isAuthor = target.from?.id === msg.from.id;
  if (!isAuthor && !(await ownerInGroup(app, msg))) return [];
  const m = T(await langForUser(app, msg.from));
  const ok = await removeMessage(app.db, src.id, target.message_id);
  await audit(app.db, "message.remove", String(msg.from.id), `${src.id}:${target.message_id}`, { reason: isAuthor ? "author" : "owner" });
  await reply(app, msg.chat.id, ok ? m.removed : m.nothingStored, undefined, msg.message_id);
  return [];
}

// ---- private commands -------------------------------------------------------------------

function profileView(mem: Member, skills: { code: string; state: string }[]): { text: string; buttons: InlineButton[][] } {
  const lang = langOf(mem);
  const m = T(lang);
  const list =
    skills.map((s) => `${TAXONOMY.get(s.code) ? labelIn(TAXONOMY.get(s.code)!, lang) : s.code}${s.state === "confirmed" ? "" : ` (${m.suggested})`}`).join(", ") ||
    m.noneYet;
  const yn = (v: number) => (v ? m.yes : m.no);
  const oo = (v: number) => (v ? m.on : m.off);
  return {
    text:
      `${m.profileTitle}\n` +
      `${m.pDigest}: <b>${oo(mem.digest)}</b>\n` +
      `${m.pDiscoverable}: <b>${yn(mem.discoverable)}</b>\n` +
      `${m.pAvailable}: <b>${yn(mem.available)}</b>\n` +
      `${m.pReminders}: <b>${oo(mem.reminders)}</b>\n` +
      `${m.pCollection}: <b>${mem.collection_opt_out ? m.pStopped : m.on}</b>\n` +
      `${m.pLanguage}: <b>${lang === "ru" ? "русский" : "English"}</b>\n` +
      `${m.pSkills}: ${escapeHtml(list)}\n\n${m.addSkillHint}`,
    buttons: [
      [btn(mem.digest ? m.bDigestOff : m.bDigestOn, `p:digest:${mem.digest ? 0 : 1}`)],
      [btn(mem.discoverable ? m.bDiscoverOff : m.bDiscoverOn, `p:discoverable:${mem.discoverable ? 0 : 1}`)],
      [
        btn(mem.available ? m.bPause : m.bResume, `p:available:${mem.available ? 0 : 1}`),
        btn(mem.reminders ? m.bRemindersOff : m.bRemindersOn, `p:reminders:${mem.reminders ? 0 : 1}`),
      ],
      [btn(lang === "ru" ? "English" : "Русский", `p:lang:${lang === "ru" ? "en" : "ru"}`)],
    ],
  };
}

async function mySkills(app: App, memberId: string) {
  return (await app.db.prepare("SELECT code, state FROM skills WHERE member_id=? ORDER BY code").bind(memberId).all<{ code: string; state: string }>()).results;
}

async function setLanguage(app: App, memberId: string, lang: Lang): Promise<void> {
  await app.db.prepare("UPDATE members SET lang=?, lang_explicit=1 WHERE id=?").bind(lang, memberId).run();
}

async function privateCommand(app: App, msg: TgMessage, cmd: string, args: string): Promise<string[]> {
  const chat = msg.chat.id;
  const from = msg.from!;
  const pre = T(await langForUser(app, from));
  switch (cmd) {
    case "start":
      // One short message: what I do, where things work (owners: their tools). Private, so only them.
      await reply(app, chat, pre.start + pre.whereMember + (isOwner(app, from.id) ? pre.whereOwner : ""));
      return [];
    case "help":
      if (args.trim()) break; // "/help <need>" opens a mission below
      await reply(app, chat, pre.help);
      return [];
    case "privacy":
      await reply(app, chat, pre.privacy);
      return [];
    case "status":
    case "sources":
    case "uncertain":
      if (!isOwner(app, from.id)) return [];
      return ownerCommand(app, chat, cmd, pre);
  }
  if (CONTINUITY_OWNER.has(cmd)) {
    if (!isOwner(app, from.id)) return [];
    const owner = await ensureMember(app.db, from.id, "owner", from.language_code);
    return ownerContinuity(app, chat, cmd, args, owner.id);
  }
  if (OWNER_COMMANDS.has(cmd)) {
    if (!isOwner(app, from.id)) return [];
    const owner = await ensureMember(app.db, from.id, "owner", from.language_code);
    await touchOwners(app.db);
    return ownerAssistCommand(app, chat, cmd, args, langOf(owner), owner.id);
  }
  const mem = await knownMember(app, msg);
  if (!mem) return [];
  if (cmd === "language") {
    const want = args.trim().toLowerCase();
    if (want !== "en" && want !== "ru") {
      await reply(app, chat, pre.languageUsage);
      return [];
    }
    await setLanguage(app, mem.id, want);
    await reply(app, chat, T(want).languageSet);
    return [];
  }
  const lang = langOf(mem);
  const m = T(lang);
  if (cmd === "help") return cmdHelpNeed(app, chat, mem, args);
  if (cmd === "passport") return cmdPassport(app, chat, mem);
  switch (cmd) {
    case "ask": {
      if (!rateOk(from.id, rateLimit(app))) {
        await reply(app, chat, m.tooMany);
        return [];
      }
      const f = await parseFilters(app.db, await readable(app.db, mem), args);
      const a = await answer(app.db, f.readable, f.query, f.filters);
      const answerId = a.status === "answered" ? await recordAnswer(app.db, mem.id, a.quotes.map((q) => q.id)) : undefined;
      const ai = a.status === "answered" ? await brief(app, f.readable, f.query, a.quotes, lang) : null;
      const r = renderAnswer(a, timezone(app.env), lang, { answerId, brief: ai });
      await reply(app, chat, r.text, r.buttons);
      return [];
    }
    case "profile": {
      const v = profileView(mem, await mySkills(app, mem.id));
      await reply(app, chat, v.text, v.buttons);
      return [];
    }
    case "digest": {
      const arg = args.toLowerCase();
      if (arg !== "on" && arg !== "off") {
        await reply(app, chat, m.digestState(!!mem.digest));
        return [];
      }
      await app.db.prepare("UPDATE members SET digest=? WHERE id=?").bind(arg === "on" ? 1 : 0, mem.id).run();
      await reply(app, chat, arg === "on" ? m.digestOn(digestHour(app.env)) : m.digestOff);
      return [];
    }
    case "optin":
    case "optout": {
      const on = cmd === "optin";
      await app.db.prepare("UPDATE members SET discoverable=? WHERE id=?").bind(on ? 1 : 0, mem.id).run();
      await audit(app.db, "consent.discovery", mem.id, mem.id, { granted: on });
      await reply(app, chat, on ? m.optin : m.optout);
      return [];
    }
    case "skills":
      return cmdSkills(app, chat, mem, args, m);
    case "expert": {
      if (!rateOk(from.id, rateLimit(app))) {
        await reply(app, chat, m.tooMany);
        return [];
      }
      const codes = matchSkills(args);
      if (!codes.length) {
        await reply(app, chat, m.expertUsage);
        return [];
      }
      const n = (await eligibleCandidates(app.db, mem.id, codes, nowIso())).length;
      // Identities are never listed: discovery happens only through consented intros (K4).
      await reply(app, chat, m.expertCount(n, escapeHtml(labelsFor(codes, lang))));
      return [];
    }
    case "intro": {
      if (!rateOk(from.id, rateLimit(app))) {
        await reply(app, chat, m.tooMany);
        return [];
      }
      if (args.length < 10) {
        await reply(app, chat, m.introUsage);
        return [];
      }
      try {
        const r = await requestIntro(app.db, mem.id, args, nowIso(), lang);
        const labels = escapeHtml(labelsFor(r.skills, lang));
        await reply(app, chat, r.introId ? m.introCreated(labels) : m.introNoMatch(labels));
        return r.keys;
      } catch (e) {
        if (e instanceof IntroError) {
          await reply(app, chat, e.message);
          return [];
        }
        throw e;
      }
    }
    case "cancel":
    case "requests": {
      const listed = await listMissions(app, chat, mem);
      const rows = (await app.db.prepare("SELECT id, text, status FROM needs WHERE member_id=? AND status IN ('open','matching') ORDER BY created_at DESC").bind(mem.id).all<{ id: string; text: string; status: string }>()).results;
      if (!rows.length && !listed) await reply(app, chat, m.noRequests);
      for (const r of rows) await reply(app, chat, m.requestStatus(escapeHtml(r.text), r.status), [[btn(m.bCancelRequest, `n:${r.id}:cancel`)]]);
      return [];
    }
    case "forget_me":
      await reply(app, chat, m.forgetConfirm, [[btn(m.bForgetYes, "fm:yes"), btn(m.bCancel, "fm:no")]]);
      return [];
    case "catchup": {
      if (!rateOk(from.id, rateLimit(app))) {
        await reply(app, chat, m.tooMany);
        return [];
      }
      const rel = /^(\d+)([hd])$/i.exec(args.trim());
      if (args.trim() && !rel) {
        await reply(app, chat, m.catchupUsage);
        return [];
      }
      const now = new Date();
      const startMs = rel ? now.getTime() - Number(rel[1]) * (rel[2]!.toLowerCase() === "h" ? HOUR : DAY) : mem.catchup_at ? Date.parse(mem.catchup_at) : now.getTime() - DAY;
      const start = nowIso(new Date(Math.max(startMs, now.getTime() - 30 * DAY)));
      // End is exclusive and second-precise: include this very second; the next window starts there.
      const end = nowIso(new Date(now.getTime() + 1000));
      const text = await buildDigest(app.db, await readable(app.db, mem), start, end, localParts(now, timezone(app.env)).date, lang);
      await app.db.prepare("UPDATE members SET catchup_at=? WHERE id=?").bind(end, mem.id).run();
      await reply(app, chat, text ?? m.catchupNothing);
      return [];
    }
    case "events": {
      const evs = await upcomingEvents(app.db, await readable(app.db, mem));
      if (!evs.length) {
        await reply(app, chat, m.eventsNone);
        return [];
      }
      const fmt = new Intl.DateTimeFormat(lang === "ru" ? "ru-RU" : "en-GB", { timeZone: timezone(app.env), dateStyle: "medium", timeStyle: "short" });
      const lines = evs.map((e) => {
        const url = citation(e.chat_id, e.msg_id, e.username);
        return `• ${fmt.format(new Date(e.starts_at))} — ${url ? `<a href="${escapeHtml(url)}">${escapeHtml(e.title)}</a>` : escapeHtml(e.title)}`;
      });
      await reply(app, chat, `${m.eventsTitle}\n${lines.join("\n")}`);
      await app.tg.sendFile(chat, "telepathy-events.ics", toIcs(evs), "text/calendar", m.eventsIcs);
      return [];
    }
    case "pings": {
      const arg = args.trim().toLowerCase();
      if (arg !== "on" && arg !== "off") {
        await reply(app, chat, m.pingsUsage);
        return [];
      }
      await app.db.prepare("UPDATE members SET routing=? WHERE id=?").bind(arg === "on" ? 1 : 0, mem.id).run();
      await reply(app, chat, arg === "on" ? m.pingsOn : m.pingsOff);
      return [];
    }
    case "app":
      // Without PUBLIC_URL the chat menu button (set by /admin/setup) is the way in.
      await reply(app, chat, m.appButton, appOrigin(app) ? [[{ text: m.appButton, web_app: { url: `${appOrigin(app)}/app` } } as unknown as InlineButton]] : undefined);
      return [];
    case "resume_collection":
      await app.db.prepare("UPDATE members SET collection_opt_out=0 WHERE id=?").bind(mem.id).run();
      await audit(app.db, "member.resume_collection", mem.id, mem.id);
      await reply(app, chat, m.resumeOk);
      return [];
  }
  return [];
}

async function cmdSkills(app: App, chat: number, mem: Member, args: string, m: Messages): Promise<string[]> {
  const [verb = "", ...rest] = args.split(/\s+/);
  const what = rest.join(" ");
  if (verb === "all") {
    const lines = [...TAXONOMY.values()].map((s) => `<code>${s.code}</code> ${escapeHtml(label(s))}`);
    for (let i = 0; i < lines.length; i += 35) await reply(app, chat, (i ? "" : `${m.skillsTitle}\n`) + lines.slice(i, i + 35).join("\n"));
    return [];
  }
  if ((verb === "add" || verb === "remove") && what) {
    const code = resolveSkill(what);
    if (!code) {
      await reply(app, chat, m.unknownSkill);
      return [];
    }
    if (verb === "add") {
      await app.db
        .prepare("INSERT INTO skills(member_id, code, state, kind) VALUES (?,?,'confirmed','self_claim') ON CONFLICT(member_id, code) DO UPDATE SET state='confirmed'")
        .bind(mem.id, code)
        .run();
      await reply(app, chat, m.skillAdded(escapeHtml(labelIn(TAXONOMY.get(code)!, langOf(mem))), !!mem.discoverable));
    } else {
      const r = await app.db.prepare("DELETE FROM skills WHERE member_id=? AND code=?").bind(mem.id, code).run();
      await reply(app, chat, r.meta.changes ? m.skillRemoved : m.skillNotOnProfile);
    }
    return [];
  }
  const listed =
    (await mySkills(app, mem.id))
      .filter((s) => s.state === "confirmed")
      .map((s) => `• ${escapeHtml(labelIn(TAXONOMY.get(s.code)!, langOf(mem)))}`)
      .join("\n") || m.noneYet;
  await reply(app, chat, m.yourSkills(listed));
  return [];
}

async function ownerCommand(app: App, chat: number, cmd: string, m: Messages): Promise<string[]> {
  if (cmd === "status") {
    const st = await status(app.db);
    await reply(app, chat, `${m.statusTitle}\n` + Object.entries(st).map(([k, v]) => `${escapeHtml(k)}: <b>${escapeHtml(String(v))}</b>`).join("\n"));
  } else if (cmd === "sources") {
    const rows = (await app.db.prepare("SELECT s.*, (SELECT COUNT(*) FROM passages p WHERE p.source_id=s.id AND p.part=0 AND p.removed_at IS NULL) AS n FROM sources s ORDER BY enabled DESC, title").all<{ title: string | null; chat_id: number; visibility: string; enabled: number; retention_days: number; hints: number; n: number }>()).results;
    const lines = rows.map((r) => `${r.enabled ? "✅" : "⏸"} ${escapeHtml(r.title ?? String(r.chat_id))} · ${r.visibility} · ${r.retention_days ? `${r.retention_days}d` : m.fullHistory} · ${r.n} msgs${r.hints ? " · 💡" : ""}`);
    await reply(app, chat, `${m.sourcesTitle}\n` + (lines.join("\n") || "—"));
  } else {
    const rows = (await app.db.prepare("SELECT id, key, chat_id, updated_at FROM effects WHERE state='uncertain' ORDER BY updated_at LIMIT 10").all<{ id: string; key: string; chat_id: number; updated_at: string }>()).results;
    if (!rows.length) await reply(app, chat, m.noUncertain);
    for (const r of rows) {
      await reply(app, chat, `<code>${escapeHtml(r.key)}</code> → ${r.chat_id} (${r.updated_at})\n${m.didArrive}`, [[btn(m.bDelivered, `u:${r.id}:1`), btn(m.bNotDelivered, `u:${r.id}:0`)]]);
    }
  }
  return [];
}

export async function status(db: D1Database): Promise<Record<string, string | number>> {
  const q = (sql: string) => db.prepare(sql);
  const rows = await db.batch([
    q("SELECT COUNT(*) AS n FROM sources WHERE enabled=1"),
    q("SELECT COUNT(*) AS n FROM members WHERE removed_at IS NULL"),
    q("SELECT COUNT(*) AS n FROM members WHERE discoverable=1"),
    q("SELECT COUNT(*) AS n FROM members WHERE digest=1"),
    q("SELECT COUNT(*) AS n FROM passages WHERE removed_at IS NULL AND body IS NOT NULL"),
    q("SELECT MAX(event_at) AS n FROM passages"),
    q("SELECT COUNT(*) AS n FROM effects WHERE state='pending'"),
    q("SELECT COUNT(*) AS n FROM effects WHERE state='uncertain'"),
    q("SELECT COUNT(*) AS n FROM effects WHERE state='failed'"),
    q("SELECT COUNT(*) AS n FROM needs WHERE status IN ('open','matching')"),
    q("SELECT COUNT(*) AS n FROM intros WHERE status IN ('mutually_confirmed','completed')"),
    q("SELECT COUNT(*) AS n FROM doc_queue WHERE status='pending'"),
    q("SELECT COALESCE(SUM(up),0) || ' / ' || COALESCE(SUM(down),0) || ' / ' || COALESCE(SUM(bad),0) AS n FROM passage_votes"),
    q("SELECT COUNT(*) AS n FROM missions WHERE status NOT IN ('draft','closed','cancelled','expired','failed_with_explanation')"),
    q("SELECT COUNT(*) AS n FROM organizations WHERE kind='partner' AND status='active'"),
    q("SELECT COUNT(*) AS n FROM fed_outbox WHERE state IN ('uncertain','failed','manual')"),
  ]);
  const v = (i: number) => ((rows[i]!.results[0] as { n: number | string | null } | undefined)?.n ?? 0) as string | number;
  return {
    "enabled sources": v(0),
    members: v(1),
    "discoverable experts": v(2),
    "digest subscribers": v(3),
    "searchable passages": v(4),
    "latest message": v(5) || "never",
    "sends pending": v(6),
    "sends uncertain": v(7),
    "sends failed": v(8),
    "open intro requests": v(9),
    "intros connected": v(10),
    "documents queued": v(11),
    "feedback up / down / wrong": v(12),
    "open missions": v(13),
    "active partners": v(14),
    "partner messages needing attention": v(15),
  };
}

// ---- callbacks --------------------------------------------------------------------------

async function onCallback(app: App, cb: CallbackQuery): Promise<string[]> {
  const data = cb.data ?? "";
  const [kind, a = "", b = ""] = data.split(":");
  const answerCb = (text = "", alert = false) => app.tg.call("answerCallbackQuery", { callback_query_id: cb.id, text: text.slice(0, 190), show_alert: alert });
  const clearButtons = async () => {
    if (cb.message) {
      await app.tg.call("editMessageReplyMarkup", { chat_id: cb.message.chat.id, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
    }
  };
  if (["m", "o", "r", "d", "x", "g"].includes(kind ?? "")) return assistCallback(app, cb, await memberByTg(app.db, cb.from.id), data);
  const pre = T(await langForUser(app, cb.from));
  if (kind === "hy") {
    // Hydra status button on incident notices (owners only).
    await answerCb();
    if (isOwner(app, cb.from.id) && cb.message && app.env.CONTINUITY_KEY) await app.tg.sendMessage(cb.message.chat.id, await hydraStatus(app));
    return [];
  }
  if (kind === "u") {
    if (!isOwner(app, cb.from.id)) {
      await answerCb();
      return [];
    }
    const ok = await reconcile(app.db, a, b === "1", `operator ${cb.from.id}`);
    await answerCb(ok ? pre.recorded : pre.alreadyResolved);
    await clearButtons();
    return [];
  }
  const mem = await memberByTg(app.db, cb.from.id);
  if (!mem) {
    await answerCb(pre.notAvailable);
    return [];
  }
  const m = T(langOf(mem));
  let keys: string[] = [];
  if (kind === "s") {
    const ok = await answerSuggestion(app.db, mem.id, a, b === "add");
    await answerCb(!ok ? m.notAvailable : b === "add" ? m.suggestAdded : m.suggestDismissed);
    await clearButtons();
    return [];
  }
  if (kind === "f") {
    // Feedback stays on the message (others in a group may vote too); only a toast confirms it.
    const r = await vote(app.db, a, mem.id, b);
    await answerCb(r === "recorded" ? m.fbThanks : r === "already" ? m.fbAlready : m.notAvailable);
  } else if (kind === "i") {
    const r = await act(app.db, a, mem.id, b);
    keys = r.keys;
    await answerCb(r.reply, r.reply.length > 60);
    await clearButtons();
  } else if (kind === "n") {
    const r = await cancelNeed(app.db, mem.id, a);
    keys = r.keys;
    await answerCb(r.ok ? m.requestCancelled : m.alreadyClosed);
    await clearButtons();
  } else if (kind === "p" && ["digest", "discoverable", "available", "reminders", "lang"].includes(a)) {
    if (a === "lang") {
      if (b === "en" || b === "ru") await setLanguage(app, mem.id, b);
    } else {
      await app.db.prepare(`UPDATE members SET ${a}=? WHERE id=?`).bind(b === "1" ? 1 : 0, mem.id).run();
      if (a === "discoverable") await audit(app.db, "consent.discovery", mem.id, mem.id, { granted: b === "1" });
    }
    const fresh = (await memberByTg(app.db, cb.from.id))!;
    const v = profileView(fresh, await mySkills(app, mem.id));
    await answerCb(T(langOf(fresh)).saved);
    if (cb.message) {
      await app.tg.call("editMessageText", { chat_id: cb.message.chat.id, message_id: cb.message.message_id, text: v.text, parse_mode: "HTML", reply_markup: { inline_keyboard: v.buttons } });
    }
  } else if (kind === "fm") {
    if (a === "yes") {
      keys = await forgetMissions(app, mem.id);
      const personId = await personForMember(app.db, mem.id);
      if (personId) await forgetPerson(app.db, personId);
      const r = await forgetMember(app.db, mem.id, mem.tg_id);
      await answerCb(m.deleted);
      await reply(app, cb.from.id, m.forgetDone(r.passages, r.skills, r.intros));
    } else {
      await answerCb(m.nothingDeleted);
    }
    await clearButtons();
  } else {
    await answerCb();
  }
  return keys;
}

// ---- membership events -------------------------------------------------------------------

/** Bot removed from a group = lost approval: stop ingest and hide its evidence. */
async function onBotMembership(app: App, ev: ChatMemberUpdated): Promise<string[]> {
  if (["left", "kicked"].includes(ev.new_chat_member.status)) {
    const r = await app.db.prepare("UPDATE sources SET enabled=0 WHERE chat_id=? AND enabled=1").bind(ev.chat.id).run();
    if (r.meta.changes) await audit(app.db, "source.disable", "system", String(ev.chat.id), { reason: "bot removed" });
  }
  return [];
}

/** Leaving a group revokes read access to it (C06); joining grants it. */
const IN = ["member", "administrator", "creator", "restricted"];
// A restricted person who leaves stays "restricted" with is_member false (Bot API ChatMemberRestricted).
const inChat = (cm?: { status: string; is_member?: boolean }) => !!cm && IN.includes(cm.status) && !(cm.status === "restricted" && cm.is_member === false);
async function onChatMember(app: App, ev: ChatMemberUpdated): Promise<string[]> {
  // Newly joined (not a promotion or restriction change): a short welcome, privately when possible.
  const src = await enabledSource(app.db, ev.chat.id);
  const m = src ? await memberByTg(app.db, ev.new_chat_member.user.id) : null;
  if (src && m) {
    if (!inChat(ev.new_chat_member)) await revoke(app.db, src.id, m.id);
    else await grantStatement(app.db, src.id, m.id).run();
  }
  // After the access change: a welcome Telegram refuses (400/403) must not skip it.
  if (inChat(ev.new_chat_member) && !inChat(ev.old_chat_member)) await welcomeJoiner(app, ev.chat.id, ev.new_chat_member.user);
  return [];
}
