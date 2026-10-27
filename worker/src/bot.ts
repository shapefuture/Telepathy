// Telegram update router (P03, P06, P08, P09, P11-07, P13-01/02/04/05).
//   * group messages are stored only for chats an owner explicitly enabled
//   * in a group, /ask (or @mention) answers only from that same group (P13-01)
//   * everything personal (profile, intros, digest, data rights) happens in private chat
//   * texts follow the member's language: Telegram setting or /language (P13-04)

import { ensureMember, grantStatement, langOf, memberByTg, readable, revoke, VISIBILITIES, type Member, type Visibility } from "./acl";
import { digestHour, ownerIds, timezone, type Env } from "./env";
import { eligibleCandidates, label, labelIn, labelsFor, matchSkills, resolveSkill, skillName, TAXONOMY } from "./experts";
import { recordAnswer, vote } from "./feedback";
import { build as buildDigest } from "./digest";
import { answerSuggestion, detectEvent, eventUrl, markCanonical, toIcs, upcomingEvents } from "./features";
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
import { assistCallback, clubDeskCommand, cmdHelpNeed, forgetMissions, listMissions, ownerAssistCommand, OWNER_COMMANDS } from "./assist/bot";
import { brief } from "./ai/beam";
import { answer, parseFilters, renderAnswer } from "./search";
import type { Fetcher, InlineButton, Telegram } from "./telegram";
import { DefiniteFailure } from "./telegram";
import { forgetAdminCache, isChatAdminLive } from "./admins";
import { askToConnect, botUsername, chatFromParam, connectGroup, sendGuide } from "./connect";
import { answerPending, bridgeHelpful, openThread, pilotText, resend, threadAction } from "./thread";
import { acceptInvite, alliancesOf, bridgeBoard, clubsOf, connectBridge, createInvite, deliverBridge, inviteCard, isLevel, LEVELS, levelWord, answerBridgeAsHelper, setAlliance, type Level } from "./alliance";
import { bridgeCardKeys } from "./thread-card";
import { pulseCard, shareToGroup } from "./pulse";
import { helpedCount } from "./thread-card";
import { SETTING_COLUMNS, settingsView, toggleSetting, type SettingColumn } from "./group-settings";
import { forgottenView } from "./wow";
import { eventByShort, fullKey, rsvp, shortKey, wantToSee, whoGoes } from "./gather";
import { arkLine, callEveryone, exportFor, forgetPart, knowsCard } from "./ark";
import { welcomeJoinRequest, welcomeJoiner } from "./welcome";
import { escapeHtml } from "./text";
import { audit, DAY, HOUR, localParts, nowIso, tzOffsetMinutes } from "./util";

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
  message?: { message_id: number; chat: { id: number; type?: string; title?: string; username?: string }; reply_markup?: { inline_keyboard: { text: string; callback_data?: string }[][] } };
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

const PRIVATE_ONLY = new Set(["intro", "expert", "profile", "optin", "optout", "skills", "forget_me", "digest", "requests", "language", "catchup", "events", "pings", "app", "cancel", "desk", "offer", "partner", "fed", "ledger", "passport", "continuity", "destinations", "alert", "drill", "name", "pilot", "pulse", "union", "bridges", "ark", "move", "knows"]);
const GROUP_TYPES = new Set(["group", "supergroup"]);
const btn = (text: string, data: string): InlineButton => ({ text, callback_data: data });
const linkBtn = (text: string, href: string) => ({ text, url: href }) as unknown as InlineButton;

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

/** Each community manages itself: a group's own Telegram admins run its group commands (live check). */
async function ownerInGroup(app: App, msg: TgMessage): Promise<boolean> {
  return !!msg.from && !msg.sender_chat && (await isChatAdminLive(app, msg.chat.id, msg.from.id));
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

/** Questions about the bot itself ("что ты умеешь", "кто ты", "help"): answered with the guide. */
export const ABOUT_BOT = /^\s*(?:(?:а\s+)?(?:что|чё|че|чего)\s+(?:ты\s+)?(?:умеешь|можешь|делаешь)|кто\s+ты(?:\s+такой)?|ты\s+кто|(?:как\s+)?(?:тобой\s+)?пользоваться|помощь|помоги|инструкция|what\s+can\s+you\s+do|who\s+are\s+you|how\s+(?:do\s+i\s+)?use\s+(?:you|this)|help)\s*[?!.)]*\s*$/i;

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
      if (command.cmd === "settings") return cmdSettings(app, msg);
    }
    const keys: string[] = [];
    const mentioned = edited ? null : mentionQuestion(msg, app.env.BOT_USERNAME);
    // Answer before storing, so the question can't match itself.
    if (mentioned) {
      try {
        keys.push(...(await groupAsk(app, msg, mentioned)));
      } catch (e) {
        if (!(e instanceof DefiniteFailure)) throw e; // a refused reply must not lose the message itself
      }
    }
    keys.push(...(await ingest(app, msg, edited)));
    return keys;
  }
  if (msg.chat.type !== "private" || !msg.from) return [];
  // In private, a plain message is a question: no command needed.
  if (!command) {
    const q = (msg.text ?? "").trim();
    if (!q || edited) return [];
    const asker = msg.from ? await memberByTg(app.db, msg.from.id) : null;
    const words = asker ? await answerPending(app, asker, q) : null; // the words for a 🙏 just pressed
    if (words) return words;
    // "What can you do?" is about the bot, not a question for the community's memory.
    return privateCommand(app, msg, ABOUT_BOT.test(q) ? "help" : "ask", ABOUT_BOT.test(q) ? "" : q);
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

/**
 * P13-01 + the quiet rule (plan: Нить): the answer opens as a card in the asker's private chat, and
 * the group sees one line with a button to it. If Telegram won't let the bot write to them yet, the
 * group gets the answer itself, as before.
 */
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
  const m = T(lang);
  if (!f.query) {
    await reply(app, msg.chat.id, m.askUsage, undefined, msg.message_id);
    return [];
  }
  const opened = await openThread(app, { memberId: asker.id, tgId: msg.from.id, question: f.query, readable: f.readable, filters: f.filters, lang, sourceId: source.id });
  if (opened) {
    const bot = await botUsername(app);
    const buttons = bot ? [[linkBtn(m.bOpenPrivately, `https://t.me/${bot}?start=q${opened.id}`)]] : undefined;
    await reply(app, msg.chat.id, opened.count ? m.threadGroupFound(opened.count) : m.threadGroupNothing, buttons, msg.message_id);
    return [];
  }
  const a = await answer(app.db, f.readable, f.query, f.filters);
  const answerId = a.status === "answered" ? await recordAnswer(app.db, asker.id, a.quotes.map((q) => q.id)) : undefined;
  const ai = a.status === "answered" ? await brief(app, f.readable, f.query, a.quotes, lang) : null;
  const r = renderAnswer(a, timezone(app.env), lang, { scope: "group", answerId, brief: ai });
  await reply(app, msg.chat.id, r.text, r.buttons, msg.message_id);
  return [];
}

async function cmdSettings(app: App, msg: TgMessage): Promise<string[]> {
  if (!(await ownerInGroup(app, msg))) return [];
  const view = await settingsView(app.db, msg.chat.id, await langForUser(app, msg.from));
  if (view) await reply(app, msg.chat.id, view.text, view.buttons); // an unconnected group has no card: stay silent
  return [];
}

// ---- owner commands in groups -----------------------------------------------------------

async function cmdEnable(app: App, msg: TgMessage, args: string): Promise<string[]> {
  if (!(await ownerInGroup(app, msg))) return []; // silent: don't advertise admin commands
  const vis = (args.trim().toUpperCase() || "MEMBER_CONSENTED") as Visibility;
  if (!VISIBILITIES.includes(vis)) {
    await reply(app, msg.chat.id, T(await langForUser(app, msg.from)).visibilityMust(VISIBILITIES.join(", ")));
    return [];
  }
  await connectGroup(app, msg.chat, msg.from!, vis);
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
  // Messages sent as a channel or an anonymous admin all share one fake `from`; compare the chat then.
  const isAuthor = msg.sender_chat || target.sender_chat ? msg.sender_chat?.id === target.sender_chat?.id : target.from?.id === msg.from.id;
  if (!isAuthor && !(await ownerInGroup(app, msg))) return [];
  const m = T(await langForUser(app, msg.from));
  const ok = await removeMessage(app.db, src.id, target.message_id);
  await audit(app.db, "message.remove", String(msg.from.id), `${src.id}:${target.message_id}`, { reason: isAuthor ? "author" : "owner" });
  await reply(app, msg.chat.id, ok ? m.removed : m.nothingStored, undefined, msg.message_id);
  return [];
}

// ---- private commands -------------------------------------------------------------------

/** Quiet hours are stored in UTC; shown in the club's own timezone. */
function quietLocal(mem: Member, tz: string): string | null {
  if (mem.quiet_from === null || mem.quiet_from === undefined || mem.quiet_to === null || mem.quiet_to === undefined) return null;
  const off = Math.round(tzOffsetMinutes(new Date(), tz) / 60);
  const hh = (utc: number) => String((utc + off + 24) % 24).padStart(2, "0") + ":00";
  return `${hh(mem.quiet_from)}–${hh(mem.quiet_to)}`;
}

function profileView(mem: Member, skills: { code: string; state: string }[], helped = 0, tz = "UTC"): { text: string; buttons: InlineButton[][] } {
  const lang = langOf(mem);
  const m = T(lang);
  const list =
    skills.map((s) => `${skillName(s.code, lang)}${s.state === "confirmed" ? "" : ` (${m.suggested})`}`).join(", ") ||
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
      `${m.pSkills}: ${escapeHtml(list)}\n` +
      `${m.pHelped(helped)}\n` +
      `${m.pQuiet}: <b>${escapeHtml(quietLocal(mem, tz) ?? m.off)}</b>\n\n${m.addSkillHint}`,
    buttons: [
      [btn(mem.digest ? m.bDigestOff : m.bDigestOn, `p:digest:${mem.digest ? 0 : 1}`)],
      [btn(mem.discoverable ? m.bDiscoverOff : m.bDiscoverOn, `p:discoverable:${mem.discoverable ? 0 : 1}`)],
      [
        btn(mem.available ? m.bPause : m.bResume, `p:available:${mem.available ? 0 : 1}`),
        btn(mem.reminders ? m.bRemindersOff : m.bRemindersOn, `p:reminders:${mem.reminders ? 0 : 1}`),
      ],
      [btn(mem.display_name ? m.bNameOff : m.bNameOn, `p:name:${mem.display_name ? 0 : 1}`)],
      [btn(mem.quiet_from !== null && mem.quiet_from !== undefined ? m.bQuietOff : m.bQuietOn, `p:quiet:${mem.quiet_from !== null && mem.quiet_from !== undefined ? 0 : 1}`)],
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
    case "start": {
      // An alliance invitation (Союз): the other club's owner sees what would cross, then accepts.
      const invite = /^u([0-9a-f]{16})$/i.exec(args.trim());
      if (invite) {
        const who = (await memberByTg(app.db, from.id)) ?? (await ensureMember(app.db, from.id, undefined, from.language_code));
        const view = await inviteCard(app.db, invite[1]!, langOf(who));
        const mm = T(langOf(who));
        await reply(app, chat, view ? view.text : mm.unionGone, view?.buttons.map((r) => r));
        return [];
      }
      // From a group's quiet reply ("open in private"): that request's card, again.
      const thread = /^q([0-9a-f]{32})$/i.exec(args.trim());
      if (thread) {
        const asker = await memberByTg(app.db, from.id);
        if (asker) await resend(app, thread[1]!, asker.id);
        return [];
      }
      // From a group's "open my guide" link: that group's admin guide, privately.
      const group = chatFromParam(args);
      const src = group !== null ? await enabledSource(app.db, group) : null;
      if (src && (await isChatAdminLive(app, src.chat_id, from.id))) {
        await sendGuide(app, from, { id: src.chat_id, title: src.title ?? undefined }, src.id);
        return [];
      }
      // One short message: what I do, where things work (owners: their tools). Private, so only them.
      await reply(app, chat, pre.start + pre.whereMember + (isOwner(app, from.id) ? pre.whereOwner : pre.whereGroupAdmin));
      return [];
    }
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
  // /desk for a group admin: the escalated requests of their own groups' members (the operator's is below).
  if (cmd === "desk" && !isOwner(app, from.id)) {
    const asker = await knownMember(app, msg);
    return asker ? clubDeskCommand(app, chat, from.id, langOf(asker)) : [];
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
  if (cmd === "knows") {
    const who = await memberByTg(app.db, from.id);
    if (!who) return [];
    const v = await knowsCard(app.db, who.id, lang);
    await reply(app, chat, v.text, v.buttons);
    return [];
  }
  if (cmd === "ark" || cmd === "move") {
    // Ковчег (journey 10): the owner's clubs, the last copy, taking everything, and calling everyone.
    if (!isOwner(app, from.id)) return [];
    const who = await ensureMember(app.db, from.id, "owner", from.language_code);
    const clubs = (await app.db.prepare("SELECT id, title FROM sources WHERE enabled=1 AND enabled_by=? ORDER BY title").bind(who.id).all<{ id: string; title: string | null }>()).results;
    if (cmd === "move") {
      const url = args.trim();
      if (!url) {
        await reply(app, chat, pre.arkMoveUsage);
        return [];
      }
      if (!/^https:\/\/[^\s<>"]{4,200}$/i.test(url)) {
        await reply(app, chat, pre.arkMoveBad);
        return [];
      }
      for (const c of clubs) await app.db.prepare("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(`ark.move.${c.id}`, url).run();
      await audit(app.db, "ark.move", who.id, "clubs", { clubs: clubs.length });
      await reply(app, chat, pre.arkMoveSet(escapeHtml(url)));
      return [];
    }
    const line = await arkLine(app.db, app.env, lang);
    await reply(app, chat, line);
    for (const c of clubs) await reply(app, chat, escapeHtml(c.title ?? ""), [[btn(pre.bArkTake, `ak:${c.id}:take`), btn(pre.bArkCall, `ak:${c.id}:call`)]]);
    return [];
  }
  if (cmd === "union") {
    const who = await memberByTg(app.db, from.id);
    if (!who) return [];
    const v = await unionView(app, who, lang);
    await reply(app, chat, v.text, v.buttons);
    return [];
  }
  if (cmd === "bridges") {
    if (!isOwner(app, from.id)) return [];
    const rows = await bridgeBoard(app.db, lang);
    if (!rows.length) {
      await reply(app, chat, pre.bridgesNone);
      return [];
    }
    await reply(app, chat, [pre.bridgesTitle, ...rows.map((r) => r.line)].join("\n"), rows.filter((r) => r.open).map((r) => [btn(pre.bResend, `bq:${r.id}:send`), btn(pre.bCloseBridge, `bq:${r.id}:close`)]));
    return [];
  }
  if (cmd === "pulse") {
    if (!isOwner(app, from.id)) return [];
    const rows = (await app.db.prepare("SELECT id, title FROM sources WHERE enabled=1 AND enabled_by=? ORDER BY title").bind(mem.id).all<{ id: string; title: string | null }>()).results;
    const since = nowIso(new Date(Date.now() - 7 * DAY));
    if (!rows.length) await reply(app, chat, pre.pulseNone);
    for (const r of rows) {
      const card = await pulseCard(app.db, r.id, r.title ?? "", since, lang);
      await reply(app, chat, card.text || pre.pulseNone, card.quiet || !card.text ? undefined : [[btn(pre.bPulseShare, `pu:${r.id}`)]]);
    }
    return [];
  }
  if (cmd === "pilot") {
    if (!isOwner(app, from.id)) return [];
    await reply(app, chat, await pilotText(app.db, lang));
    return [];
  }
  if (cmd === "passport") return cmdPassport(app, chat, mem);
  switch (cmd) {
    case "ask": {
      if (!rateOk(from.id, rateLimit(app))) {
        await reply(app, chat, m.tooMany);
        return [];
      }
      const f = await parseFilters(app.db, await readable(app.db, mem), args);
      if (!f.query) {
        await reply(app, chat, m.askUsage);
        return [];
      }
      await openThread(app, { memberId: mem.id, tgId: chat, question: f.query, readable: f.readable, filters: f.filters, lang });
      return [];
    }
    case "name": {
      const arg = args.trim().toLowerCase();
      if (arg !== "on" && arg !== "off") {
        await reply(app, chat, m.nameUsage);
        return [];
      }
      await app.db.prepare("UPDATE members SET display_name=? WHERE id=?").bind(arg === "on" ? (from.first_name ?? null) : null, mem.id).run();
      await reply(app, chat, arg === "on" ? m.nameOn : m.nameOff);
      return [];
    }
    case "profile": {
      const v = profileView(mem, await mySkills(app, mem.id), await helpedCount(app.db, mem.id), timezone(app.env));
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
        const url = eventUrl(e);
        return `• ${fmt.format(new Date(e.starts_at))} — ${url ? `<a href="${escapeHtml(url)}">${escapeHtml(e.title)}</a>` : escapeHtml(e.title)}`;
      });
      await reply(app, chat, `${m.eventsTitle}\n${lines.join("\n")}`);
      // Each of the next few gets its own card: I'm going, not this time, who's going (journey 8).
      for (const e of evs.slice(0, 4)) {
        const k = shortKey(e.source_id, e.msg_id);
        await reply(app, chat, `<b>${escapeHtml(e.title)}</b>\n${escapeHtml(fmt.format(new Date(e.starts_at)))}`, [[btn(m.gatherGo, `rv:${k}:go`), btn(m.gatherNo, `rv:${k}:no`)], [btn(m.gatherWhoBtn, `rw:${k}`)]]);
      }
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

/** /union: this member's alliances, with the credit both ways, and the invitations they can send. */
async function unionView(app: App, mem: Member, lang: Lang): Promise<{ text: string; buttons: InlineButton[][] }> {
  const m = T(lang);
  const rows = await alliancesOf(app.db, mem.id);
  const lines = [m.unionTitle];
  if (!rows.length) lines.push(m.unionNone);
  const buttons: InlineButton[][] = [];
  for (const r of rows) {
    const status = r.status === "active" ? m.unionStatusActive : r.status === "paused" ? m.unionStatusPaused : m.unionStatusEnded;
    lines.push(m.unionRow(escapeHtml(r.mine), escapeHtml(r.other), levelWord(m, r.level), status), m.unionCredit(r.helped, r.received));
    if (r.status === "active") buttons.push([btn(m.bUnionPause, `ux:${r.id}:pause`), btn(m.bUnionEnd, `ux:${r.id}:end`)]);
    if (r.status === "paused") buttons.push([btn(m.bUnionResume, `ux:${r.id}:resume`), btn(m.bUnionEnd, `ux:${r.id}:end`)]);
  }
  for (const c of await clubsOf(app.db, mem.id)) buttons.push([btn(m.bInviteFrom(c.title ?? ""), `uv:${c.id}`)]);
  return { text: lines.join("\n"), buttons };
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
  if (kind === "cn") {
    // "Connect" under the bot's hello in a group it was added to by a non-admin.
    const chat = cb.message?.chat;
    if (!chat || !["group", "supergroup"].includes(chat.type ?? "")) return answerCb().then(() => []);
    if (!(await isChatAdminLive(app, chat.id, cb.from.id))) {
      await answerCb(pre.onlyAdminsConnect, true);
      return [];
    }
    await answerCb();
    await clearButtons();
    // The message carries the group's title: no need to ask Telegram for it again.
    if (!(await enabledSource(app.db, chat.id))) await connectGroup(app, { id: chat.id, title: chat.title, username: chat.username }, cb.from);
    return [];
  }
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
  if (kind === "rv" || kind === "rw" || kind === "wn") {
    // Gatherings (journey 8): «Иду» / «Не иду», who's going, and "I'd like to see them again".
    const mem = await memberByTg(app.db, cb.from.id);
    if (!mem) {
      await answerCb(pre.notAvailable);
      return [];
    }
    const lang = langOf(mem);
    const ev = await eventByShort(app.db, a, await readable(app.db, mem));
    if (!ev) {
      await answerCb(pre.notAvailable);
      return [];
    }
    const key = fullKey(ev.source_id, ev.msg_id);
    if (kind === "rv") {
      if (b !== "go" && b !== "no") {
        await answerCb(pre.notAvailable);
        return [];
      }
      await rsvp(app.db, mem.id, key, b === "go" ? "going" : "not", nowIso());
      await answerCb(T(lang).saved);
      if (b === "go") await app.tg.sendMessage(cb.from.id, T(lang).gatherSaved);
      return [];
    }
    if (kind === "rw") {
      await answerCb();
      await app.tg.sendMessage(cb.from.id, await whoGoes(app.db, key, mem, lang));
      return [];
    }
    await answerCb();
    const r = await wantToSee(app, mem, key, b, nowIso());
    await app.tg.sendMessage(cb.from.id, r.text);
    return r.keys;
  }
  if (kind === "ak") {
    // Ковчег (owner): take everything in an open file, or call everyone to the new address.
    const mem = await memberByTg(app.db, cb.from.id);
    const own = mem && isOwner(app, cb.from.id) ? await app.db.prepare("SELECT 1 FROM sources WHERE id=? AND enabled_by=?").bind(a, mem.id).first() : null;
    if (!mem || !own) {
      await answerCb(pre.notAvailable);
      return [];
    }
    if (b === "take") {
      const out = await exportFor(app.db, mem.id, new Date());
      await app.tg.sendFile(cb.from.id, "telepathy-export.json", out.json, "application/json", pre.arkTaken(out.messages));
      await answerCb(pre.arkTaken(out.messages));
      return [];
    }
    const called = await callEveryone(app.db, a, nowIso().slice(0, 10));
    if (!called.url) {
      await answerCb(pre.arkNoMoveUrl, true);
      return [];
    }
    await answerCb(pre.arkCalled(called.keys.length));
    return called.keys;
  }
  if (kind === "kn") {
    // What the bot knows about me: remove one part of it (messages go with /forget_me).
    const mem = await memberByTg(app.db, cb.from.id);
    if (!mem || !(await forgetPart(app.db, mem.id, a))) {
      await answerCb(pre.notAvailable);
      return [];
    }
    await answerCb(pre.knowsDone);
    const v = await knowsCard(app.db, mem.id, langOf(mem));
    await app.tg.sendMessage(cb.from.id, v.text, { buttons: v.buttons });
    return [];
  }
  if (kind === "gd") {
    // Done on a line of «Главное» (plan: journey 7): it doesn't come back, and its button leaves the card.
    const mem = await memberByTg(app.db, cb.from.id);
    if (!mem || !/^\d+$/.test(a)) {
      await answerCb(pre.notAvailable);
      return [];
    }
    await app.db.prepare("INSERT OR IGNORE INTO glavnoe_done(member_id, passage_id, at) VALUES (?,?,?)").bind(mem.id, Number(a), nowIso()).run();
    await answerCb(pre.bDone);
    if (cb.message?.reply_markup) {
      const rest = cb.message.reply_markup.inline_keyboard.map((row) => row.filter((x) => x.callback_data !== data)).filter((row) => row.length);
      await app.tg.call("editMessageReplyMarkup", { chat_id: cb.message.chat.id, message_id: cb.message.message_id, reply_markup: { inline_keyboard: rest } }).catch(() => undefined);
    }
    return [];
  }
  if (kind === "ob") {
    // Onboarding chips (plan: journey 2): what I can help with. Then, if someone here knows it, offer to ask.
    const mem = await memberByTg(app.db, cb.from.id);
    if (!mem) {
      await answerCb(pre.notAvailable);
      return [];
    }
    await answerCb();
    await clearButtons();
    if (a === "skip") return [];
    if (!TAXONOMY.has(a)) return [];
    await app.db.prepare("INSERT INTO skills(member_id, code, state, kind) VALUES (?,?,'confirmed','self_claim') ON CONFLICT(member_id, code) DO UPDATE SET state='confirmed'").bind(mem.id, a).run();
    const label = labelIn(TAXONOMY.get(a)!, langOf(mem));
    const someone = await app.db
      .prepare(
        "SELECT m.id FROM members m JOIN skills s ON s.member_id = m.id AND s.code = ? AND s.state = 'confirmed' " +
          "WHERE m.discoverable = 1 AND m.removed_at IS NULL AND m.id <> ? AND EXISTS (SELECT 1 FROM source_access a1 JOIN source_access a2 ON a1.source_id = a2.source_id " +
          "WHERE a1.member_id = ? AND a2.member_id = m.id AND a1.revoked_at IS NULL AND a2.revoked_at IS NULL) LIMIT 1",
      )
      .bind(a, mem.id, mem.id)
      .first();
    const mm = T(langOf(mem));
    if (someone) await app.tg.sendMessage(cb.from.id, mm.onbMatch(label), { buttons: [[btn(mm.bAskThem, `wy:${a}`)]] });
    else await app.tg.sendMessage(cb.from.id, mm.onbSaved(label));
    return [];
  }
  if (kind === "wy") {
    // Ask the people who know a topic you picked. Still an introduction: they must agree.
    const mem = await memberByTg(app.db, cb.from.id);
    if (!mem || !TAXONOMY.has(a)) {
      await answerCb(pre.notAvailable);
      return [];
    }
    await answerCb();
    await clearButtons();
    const label = labelIn(TAXONOMY.get(a)!, langOf(mem));
    const r = await requestIntro(app.db, mem.id, `${label}: looking for help`, nowIso(), langOf(mem));
    await app.tg.sendMessage(cb.from.id, T(langOf(mem)).introCreated(escapeHtml(label)));
    return r.keys;
  }
  if (kind === "nq") {
    // A question another member asked, tapped from the welcome: it becomes this person's own thread.
    const mem = await memberByTg(app.db, cb.from.id);
    const q = await app.db.prepare("SELECT source_id, body FROM passages WHERE id=? AND part=0 AND removed_at IS NULL").bind(Number(a)).first<{ source_id: string; body: string }>();
    const readableNow = mem ? await readable(app.db, mem) : new Set<string>();
    if (!mem || !q || !q.body || !readableNow.has(q.source_id)) {
      await answerCb(pre.notAvailable);
      return [];
    }
    await answerCb();
    await openThread(app, { memberId: mem.id, tgId: cb.from.id, question: q.body.slice(0, 300), readable: readableNow, filters: {}, lang: langOf(mem), sourceId: q.source_id });
    return [];
  }
  if (kind === "st") {
    // Settings card toggles (group admins only): edit the card in place.
    const chat = cb.message?.chat;
    if (!chat || !GROUP_TYPES.has(chat.type ?? "") || !SETTING_COLUMNS.includes(a as SettingColumn)) {
      await answerCb();
      return [];
    }
    if (!(await isChatAdminLive(app, chat.id, cb.from.id))) {
      await answerCb(pre.onlyAdminsConnect, true);
      return [];
    }
    const view = await toggleSetting(app, chat.id, a as SettingColumn, b === "1", cb.from.id, await langForUser(app, cb.from));
    await answerCb(pre.saved);
    if (view && cb.message) {
      await app.tg.call("editMessageText", { chat_id: chat.id, message_id: cb.message.message_id, text: view.text, parse_mode: "HTML", reply_markup: { inline_keyboard: view.buttons } });
    }
    return [];
  }
  if (kind === "uv" || kind === "ui") {
    // Invite: pick what crosses (uv), then make the invitation (ui). Only a club's own owner may.
    const who = await memberByTg(app.db, cb.from.id);
    const owned = who ? (await clubsOf(app.db, who.id)).some((c) => c.id === a) : false;
    if (!who || !owned) {
      await answerCb(pre.notAvailable);
      return [];
    }
    await answerCb();
    if (kind === "uv") {
      const mm = T(langOf(who));
      await app.tg.sendMessage(cb.from.id, mm.unionWhatCrosses, { buttons: LEVELS.map((l) => [btn(levelWord(mm, l), `ui:${a}:${l}`)]) });
      return [];
    }
    const level = isLevel(b) ? b : ("requests" as Level);
    const code = await createInvite(app.db, a, who.id, level, nowIso());
    const bot = await botUsername(app);
    const mm = T(langOf(who));
    const link = bot ? `https://t.me/${bot}?start=u${code}` : null;
    await app.tg.sendMessage(cb.from.id, link ? mm.unionInviteSent(link) : mm.unionInviteCode(code));
    return [];
  }
  if (kind === "ac") {
    // Accept (ac:<code>:<level>): the alliance runs at the smaller of the two levels.
    const who = (await memberByTg(app.db, cb.from.id)) ?? (await ensureMember(app.db, cb.from.id, undefined, cb.from.language_code));
    const r = await acceptInvite(app.db, a, who.id, isLevel(b) ? b : "requests", nowIso());
    await answerCb(r.text ?? "", !r.ok);
    if (r.ok && r.text) await app.tg.sendMessage(cb.from.id, r.text);
    await clearButtons();
    return r.keys;
  }
  if (kind === "ux") {
    // Pause, resume or end an alliance (ux:<id>:pause|resume|end), by either side.
    const who = await memberByTg(app.db, cb.from.id);
    const act = b as "pause" | "resume" | "end";
    if (!who || !["pause", "resume", "end"].includes(act)) {
      await answerCb(pre.notAvailable);
      return [];
    }
    const r = await setAlliance(app.db, who.id, a, act, nowIso());
    await answerCb(r.ok ? pre.saved : pre.notAvailable);
    return r.keys;
  }
  if (kind === "bh") {
    // The bridge (Мост): a helper says yes or no; the asker connects; the asker says it helped.
    const who = await memberByTg(app.db, cb.from.id);
    if (!who) {
      await answerCb(pre.notAvailable);
      return [];
    }
    if (b === "yes") {
      const r = await answerBridgeAsHelper(app.db, who, a, nowIso());
      await answerCb(r.text, !r.ok);
      await clearButtons();
      return r.keys;
    }
    if (b === "no") {
      await answerCb();
      await clearButtons();
      return [];
    }
    if (b === "ask") {
      const r = await connectBridge(app.db, who, a, nowIso());
      await answerCb(r.ok ? "" : r.text, !r.ok);
      if (r.ok) await app.tg.sendMessage(cb.from.id, r.text);
      await clearButtons();
      return r.keys;
    }
    if (b === "helpful") {
      const r = await bridgeHelpful(app, who, a, new Date());
      await answerCb(r.ok ? pre.threadSolvedToast : pre.notAvailable);
      return r.keys;
    }
    await answerCb();
    return [];
  }
  if (kind === "bq") {
    // Operator's bridge console: send the request to its club again, or close it.
    if (!isOwner(app, cb.from.id)) {
      await answerCb();
      return [];
    }
    if (b === "send") {
      const keys = await deliverBridge(app.db, a, nowIso());
      await answerCb(keys.length ? pre.bridgeSent : pre.notAvailable);
      return keys;
    }
    const closed = await app.db.prepare("UPDATE bridges SET status='closed', updated_at=? WHERE id=? AND status IN ('open','helper_yes')").bind(nowIso(), a).run();
    await answerCb(closed.meta.changes ? pre.bridgeClosedByOperator : pre.notAvailable);
    return closed.meta.changes ? await bridgeCardKeys(app.db, a, nowIso()) : [];
  }
  if (kind === "pu") {
    const mem2 = await memberByTg(app.db, cb.from.id);
    const src = await app.db.prepare("SELECT id, enabled_by FROM sources WHERE id=?").bind(a).first<{ id: string; enabled_by: string | null }>();
    if (!src || !(isOwner(app, cb.from.id) || (mem2 && src.enabled_by === mem2.id))) {
      await answerCb(pre.notAvailable);
      return [];
    }
    const key = await shareToGroup(app.db, a, nowIso().slice(0, 10));
    await answerCb(key ? pre.pulseShared : pre.notAvailable);
    return key ? [key] : [];
  }
  if (kind === "wow" || kind === "wq") {
    // The owner's card after a history import: list the unanswered questions, open one as a card.
    if (!isOwner(app, cb.from.id)) {
      await answerCb();
      return [];
    }
    const owner = await ensureMember(app.db, cb.from.id, "owner", cb.from.language_code);
    const ownerLang = langOf(owner);
    if (kind === "wow") {
      await answerCb();
      const v = await forgottenView(app.db, a, ownerLang);
      await app.tg.sendMessage(cb.from.id, v.text, { buttons: v.buttons });
      return [];
    }
    const q = await app.db.prepare("SELECT source_id, body FROM passages WHERE id=? AND part=0 AND removed_at IS NULL").bind(Number(a)).first<{ source_id: string; body: string }>();
    const can = q && (await readable(app.db, owner)).has(q.source_id);
    if (!q || !can || !q.body) {
      await answerCb(pre.notAvailable);
      return [];
    }
    await answerCb();
    const f = await parseFilters(app.db, await readable(app.db, owner), q.body.slice(0, 500));
    await openThread(app, { memberId: owner.id, tgId: cb.from.id, question: f.query || q.body.slice(0, 500), readable: f.readable, filters: f.filters, lang: ownerLang });
    return [];
  }

  const mem = await memberByTg(app.db, cb.from.id);
  if (!mem) {
    await answerCb(pre.notAvailable);
    return [];
  }
  const m = T(langOf(mem));
  let keys: string[] = [];
  if (kind === "t") {
    // The living request card (Нить): ask people, outcome, thanks, and the answer feedback.
    const toast = (text = "", alert = false) => answerCb(text, alert);
    return threadAction(app, mem, a, b, data.split(":")[3] ?? "", toast);
  }
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
  } else if (kind === "p" && ["digest", "discoverable", "available", "reminders", "lang", "name", "quiet"].includes(a)) {
    if (a === "lang") {
      if (b === "en" || b === "ru") await setLanguage(app, mem.id, b);
    } else if (a === "quiet") {
      // 22:00–08:00 in the club's timezone, stored in UTC.
      const off = Math.round(tzOffsetMinutes(new Date(), timezone(app.env)) / 60);
      const utc = (h: number) => (h - off + 24) % 24;
      await app.db.prepare("UPDATE members SET quiet_from=?, quiet_to=? WHERE id=?").bind(b === "1" ? utc(22) : null, b === "1" ? utc(8) : null, mem.id).run();
    } else if (a === "name") {
      await app.db.prepare("UPDATE members SET display_name=? WHERE id=?").bind(b === "1" ? (cb.from.first_name ?? null) : null, mem.id).run();
    } else {
      await app.db.prepare(`UPDATE members SET ${a}=? WHERE id=?`).bind(b === "1" ? 1 : 0, mem.id).run();
      if (a === "discoverable") await audit(app.db, "consent.discovery", mem.id, mem.id, { granted: b === "1" });
    }
    const fresh = (await memberByTg(app.db, cb.from.id))!;
    const v = profileView(fresh, await mySkills(app, mem.id), await helpedCount(app.db, mem.id), timezone(app.env));
    await answerCb(T(langOf(fresh)).saved);
    if (cb.message) {
      await app.tg.call("editMessageText", { chat_id: cb.message.chat.id, message_id: cb.message.message_id, text: v.text, parse_mode: "HTML", reply_markup: { inline_keyboard: v.buttons } });
    }
  } else if (kind === "fm") {
    if (a === "yes") {
      // Their living cards hold their questions and quotes: remove the messages too (best effort).
      const cards = await app.db.prepare("SELECT chat_id, message_id FROM threads WHERE member_id=? AND message_id IS NOT NULL").bind(mem.id).all<{ chat_id: number; message_id: number }>();
      for (const c of cards.results) await app.tg.call("deleteMessage", { chat_id: c.chat_id, message_id: c.message_id }).catch(() => undefined);
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
    return [];
  }
  // Added to a group: an admin adding it is the whole setup; anyone else gets a button for an admin.
  const added = inChat(ev.new_chat_member) && !inChat(ev.old_chat_member);
  if (!added || !["group", "supergroup"].includes(ev.chat.type) || ev.from.is_bot) return [];
  if (await enabledSource(app.db, ev.chat.id)) return [];
  if (await isChatAdminLive(app, ev.chat.id, ev.from.id)) await connectGroup(app, ev.chat, ev.from);
  else await askToConnect(app, ev.chat.id);
  return [];
}

/** Leaving a group revokes read access to it (C06); joining grants it. */
const IN = ["member", "administrator", "creator", "restricted"];
// A restricted person who leaves stays "restricted" with is_member false (Bot API ChatMemberRestricted).
const inChat = (cm?: { status: string; is_member?: boolean }) => !!cm && IN.includes(cm.status) && !(cm.status === "restricted" && cm.is_member === false);
async function onChatMember(app: App, ev: ChatMemberUpdated): Promise<string[]> {
  if (ev.old_chat_member?.status !== ev.new_chat_member.status) await forgetAdminCache(app.db, ev.chat.id, ev.new_chat_member.user.id);
  const src = await enabledSource(app.db, ev.chat.id);
  // Joining an enabled group grants reading it (C06), so the person gets their record here, before they post.
  const joining = inChat(ev.new_chat_member) && !ev.new_chat_member.user.is_bot;
  const m = src ? (joining ? await ensureMember(app.db, ev.new_chat_member.user.id, undefined, ev.new_chat_member.user.language_code) : await memberByTg(app.db, ev.new_chat_member.user.id)) : null;
  if (src && m) {
    if (!inChat(ev.new_chat_member)) await revoke(app.db, src.id, m.id);
    else await grantStatement(app.db, src.id, m.id).run();
  }
  // Newly joined (not a promotion or restriction change): a short welcome, privately when possible.
  // After the access change, so a welcome Telegram refuses (400/403) can't skip it.
  if (inChat(ev.new_chat_member) && !inChat(ev.old_chat_member)) await welcomeJoiner(app, ev.chat.id, ev.new_chat_member.user);
  return [];
}
