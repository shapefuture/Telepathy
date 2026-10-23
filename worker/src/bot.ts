// Telegram update router (P03, P06, P08, P09, P11-07).
//   * group messages are stored only for chats an owner explicitly enabled
//   * member features answer only in private chat, using the verified Telegram user id
//   * the bot never speaks in groups except to owner commands and redirects

import { ensureMember, memberByTg, readable, revoke, grantStatement, VISIBILITIES, type Member, type Visibility } from "./acl";
import { digestHour, ownerIds, timezone, type Env } from "./env";
import { eligibleCandidates, label, matchSkills, resolveSkill, TAXONOMY } from "./experts";
import { docSupported, EDGE_DOC_MAX_BYTES, enabledSource, ingestMessage, removeMessage, storeDocument, type TgMessage, type TgUser } from "./ingest";
import { act, cancelNeed, IntroError, requestIntro } from "./intros";
import { reconcile } from "./outbox";
import { forgetMember } from "./rights";
import { answer, renderAnswer } from "./search";
import type { InlineButton, Telegram } from "./telegram";
import { escapeHtml } from "./text";
import { audit, newId, nowIso } from "./util";

export interface App {
  env: Env;
  db: D1Database;
  tg: Telegram;
}

interface CallbackQuery {
  id: string;
  from: TgUser;
  data?: string;
  message?: { message_id: number; chat: { id: number } };
}
interface ChatMemberUpdated {
  chat: { id: number; type: string };
  from: TgUser;
  new_chat_member: { status: string; user: TgUser };
}
export interface Update {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: CallbackQuery;
  my_chat_member?: ChatMemberUpdated;
  chat_member?: ChatMemberUpdated;
}

export const PRIVACY_NOTICE =
  "<b>Telepathy privacy notice</b>\n" +
  "• Only groups an owner explicitly enabled are stored. Each group shows a notice.\n" +
  "• Your name, username and phone number are not stored; you get a random internal ID.\n" +
  "• Answers quote messages verbatim with a link, only from groups you can read.\n" +
  "• Data is stored in Cloudflare D1. Nothing is sent to AI services.\n" +
  "• You are not discoverable as an expert unless you run /optin yourself.\n" +
  "• Introductions need both people to agree before any contact is shared.\n" +
  "• Full history is kept. /forget_me deletes your messages and profile and stops collection; " +
  "reply /forget to one of your messages in the group to delete it.";

const HELP =
  "<b>Search</b>\n/ask <i>question</i> — cited answers from your groups (typos and RU/EN spelling tolerated)\n\n" +
  "<b>Experts &amp; introductions</b>\n/intro <i>what you need</i> — consent-based introduction\n" +
  "/expert <i>topic</i> — how many opted-in experts match\n/requests — your open requests\n\n" +
  "<b>Your profile</b>\n/profile — view and change settings\n/digest on · /digest off — daily digest (opt-in)\n" +
  "/optin · /optout — expert discoverability\n/skills · /skills add <i>skill</i> · /skills remove <i>skill</i> · /skills all\n\n" +
  "<b>Your data</b>\n/privacy · /forget_me · /resume_collection";

const PRIVATE_ONLY = new Set(["ask", "intro", "expert", "profile", "optin", "optout", "skills", "forget_me", "digest", "requests"]);
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

const isOwner = (app: App, userId?: number) => userId !== undefined && ownerIds(app.env).has(userId);

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

async function knownMember(app: App, msg: TgMessage): Promise<Member | null> {
  if (!msg.from) return null;
  let m = await memberByTg(app.db, msg.from.id);
  if (!m && isOwner(app, msg.from.id)) m = await ensureMember(app.db, msg.from.id, "owner");
  if (!m || m.removed_at) {
    await reply(app, msg.chat.id, "I don't know you yet. Post a message in an enabled community group first, then try again.");
    return null;
  }
  return m;
}

// ---- entry point ----------------------------------------------------------------------

/** Handle one update. Returns effect keys that should be dispatched right away. */
export async function handleUpdate(app: App, u: Update): Promise<string[]> {
  if (u.message) return onMessage(app, u.message, false);
  if (u.edited_message) return onMessage(app, u.edited_message, true);
  if (u.callback_query) return onCallback(app, u.callback_query);
  if (u.my_chat_member) return onBotMembership(app, u.my_chat_member);
  if (u.chat_member) return onChatMember(app, u.chat_member);
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
        await reply(app, msg.chat.id, "Please send that command to me in a private chat.", undefined, msg.message_id);
        return [];
      }
      if (command.cmd === "enable") return cmdEnable(app, msg, command.args);
      if (command.cmd === "disable") return cmdDisable(app, msg);
      if (command.cmd === "retention") return cmdRetention(app, msg, command.args);
      if (command.cmd === "forget") return cmdForgetMessage(app, msg);
    }
    await ingest(app, msg);
    return [];
  }
  if (msg.chat.type !== "private" || !command || !msg.from) return [];
  return privateCommand(app, msg, command.cmd, command.args);
}

async function ingest(app: App, msg: TgMessage): Promise<void> {
  const { outcome, source } = await ingestMessage(app.db, msg);
  if (outcome !== "stored" || !source || msg.edit_date || !docSupported(msg.document)) return;
  try {
    const text = await app.tg.fileText(msg.document!.file_id, EDGE_DOC_MAX_BYTES);
    await storeDocument(app.db, source, msg, msg.document!.file_name ?? "file.txt", text);
  } catch (e) {
    console.warn("document ingest failed", msg.chat.id, msg.message_id, String(e));
  }
}

// ---- owner commands in groups -----------------------------------------------------------

async function cmdEnable(app: App, msg: TgMessage, args: string): Promise<string[]> {
  if (!(await ownerInGroup(app, msg))) return []; // silent: don't advertise admin commands
  const vis = (args.trim().toUpperCase() || "MEMBER_CONSENTED") as Visibility;
  if (!VISIBILITIES.includes(vis)) {
    await reply(app, msg.chat.id, `Visibility must be one of: ${VISIBILITIES.join(", ")}`);
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
  await reply(
    app,
    msg.chat.id,
    `Telepathy is now <b>collecting</b> this chat (visibility: ${vis}, full history kept). ` +
      "Members can search it privately via /ask in a DM with the bot. DM the bot /privacy for details or /forget_me to delete your data.",
  );
  return [];
}

async function cmdDisable(app: App, msg: TgMessage): Promise<string[]> {
  if (!(await ownerInGroup(app, msg))) return [];
  const r = await app.db.prepare("UPDATE sources SET enabled=0 WHERE chat_id=? AND enabled=1").bind(msg.chat.id).run();
  if (r.meta.changes) {
    await audit(app.db, "source.disable", String(msg.from!.id), String(msg.chat.id));
    await reply(app, msg.chat.id, "Telepathy stopped collecting this chat. Existing messages are excluded from all answers.");
  }
  return [];
}

async function cmdRetention(app: App, msg: TgMessage, args: string): Promise<string[]> {
  if (!(await ownerInGroup(app, msg))) return [];
  const src = await enabledSource(app.db, msg.chat.id);
  const days = Number(args.trim());
  if (!src || !Number.isInteger(days) || days < 0 || days > 3650) {
    await reply(app, msg.chat.id, "Usage: /retention <days 1..3650> to purge older messages, or /retention 0 to keep full history.");
    return [];
  }
  await app.db.prepare("UPDATE sources SET retention_days=? WHERE id=?").bind(days, src.id).run();
  await audit(app.db, "source.retention", String(msg.from!.id), src.id, { days });
  await reply(app, msg.chat.id, days === 0 ? "Full history will be kept. Nothing is purged automatically." : `Retention set to ${days} days. Older messages are purged daily.`);
  return [];
}

/** Reply /forget to a message: its author or an owner removes it from Telepathy. */
async function cmdForgetMessage(app: App, msg: TgMessage): Promise<string[]> {
  const target = msg.reply_to_message;
  const src = await enabledSource(app.db, msg.chat.id);
  if (!target || !src || !msg.from) return [];
  const isAuthor = target.from?.id === msg.from.id;
  if (!isAuthor && !(await ownerInGroup(app, msg))) return [];
  const ok = await removeMessage(app.db, src.id, target.message_id);
  await audit(app.db, "message.remove", String(msg.from.id), `${src.id}:${target.message_id}`, { reason: isAuthor ? "author" : "owner" });
  await reply(app, msg.chat.id, ok ? "Removed from Telepathy." : "Nothing stored for that message.", undefined, msg.message_id);
  return [];
}

// ---- private commands -------------------------------------------------------------------

function profileView(m: Member, skills: { code: string; state: string }[]): { text: string; buttons: InlineButton[][] } {
  const list = skills.map((s) => `${TAXONOMY.get(s.code)?.en ?? s.code}${s.state === "confirmed" ? "" : " (suggested)"}`).join(", ") || "none yet";
  const yes = (v: number) => (v ? "yes" : "no");
  return {
    text:
      "<b>Your profile</b> (only you see this)\n" +
      `Daily digest: <b>${m.digest ? "on" : "off"}</b>\n` +
      `Discoverable as expert: <b>${yes(m.discoverable)}</b>\n` +
      `Available for introductions: <b>${yes(m.available)}</b>\n` +
      `Reminders: <b>${m.reminders ? "on" : "off"}</b>\n` +
      `Message collection: <b>${m.collection_opt_out ? "stopped" : "on"}</b>\n` +
      `Skills: ${escapeHtml(list)}\n\nAdd skills with <code>/skills add accounting</code>.`,
    buttons: [
      [btn(m.digest ? "Digest off" : "Digest on", `p:digest:${m.digest ? 0 : 1}`)],
      [btn(m.discoverable ? "Stop being discoverable" : "Become discoverable", `p:discoverable:${m.discoverable ? 0 : 1}`)],
      [
        btn(m.available ? "Pause introductions" : "Resume introductions", `p:available:${m.available ? 0 : 1}`),
        btn(m.reminders ? "Reminders off" : "Reminders on", `p:reminders:${m.reminders ? 0 : 1}`),
      ],
    ],
  };
}

async function mySkills(app: App, memberId: string) {
  return (await app.db.prepare("SELECT code, state FROM skills WHERE member_id=? ORDER BY code").bind(memberId).all<{ code: string; state: string }>()).results;
}

async function privateCommand(app: App, msg: TgMessage, cmd: string, args: string): Promise<string[]> {
  const chat = msg.chat.id;
  const from = msg.from!;
  const rate = Number(app.env.ASK_RATE_PER_MINUTE ?? "10") || 10;
  switch (cmd) {
    case "start":
      await reply(app, chat, "Hi! I search your community's enabled groups and answer with cited quotes, and I can introduce you to opted-in experts.\n\n" + HELP);
      return [];
    case "help":
      await reply(app, chat, HELP);
      return [];
    case "privacy":
      await reply(app, chat, PRIVACY_NOTICE);
      return [];
    case "status":
    case "sources":
    case "uncertain":
      if (!isOwner(app, from.id)) return [];
      return ownerCommand(app, chat, cmd);
  }
  const m = await knownMember(app, msg);
  if (!m) return [];
  switch (cmd) {
    case "ask": {
      if (!rateOk(from.id, rate)) {
        await reply(app, chat, "Too many requests. Please wait a minute.");
        return [];
      }
      const a = await answer(app.db, await readable(app.db, m), args);
      await reply(app, chat, renderAnswer(a, timezone(app.env)));
      return [];
    }
    case "profile": {
      const v = profileView(m, await mySkills(app, m.id));
      await reply(app, chat, v.text, v.buttons);
      return [];
    }
    case "digest": {
      const arg = args.toLowerCase();
      if (arg !== "on" && arg !== "off") {
        await reply(app, chat, `Daily digest is <b>${m.digest ? "on" : "off"}</b>. Change with <code>/digest on</code> or <code>/digest off</code>.`);
        return [];
      }
      await app.db.prepare("UPDATE members SET digest=? WHERE id=?").bind(arg === "on" ? 1 : 0, m.id).run();
      await reply(app, chat, arg === "on" ? `You'll get a daily digest (${digestHour(app.env)}:00 local) covering the groups you can read.` : "Daily digest turned off.");
      return [];
    }
    case "optin":
    case "optout": {
      const on = cmd === "optin";
      await app.db.prepare("UPDATE members SET discoverable=? WHERE id=?").bind(on ? 1 : 0, m.id).run();
      await audit(app.db, "consent.discovery", m.id, m.id, { granted: on });
      await reply(
        app,
        chat,
        on
          ? "You're now discoverable for introductions <b>in the skills you list</b>. Nobody sees your identity unless you accept a specific request and the requester confirms.\nAdd skills: <code>/skills add python</code> · undo anytime: /optout"
          : "You're no longer discoverable. Pending invitations stay answerable.",
      );
      return [];
    }
    case "skills":
      return cmdSkills(app, chat, m, args);
    case "expert": {
      if (!rateOk(from.id, rate)) {
        await reply(app, chat, "Too many requests. Please wait a minute.");
        return [];
      }
      const codes = matchSkills(args);
      if (!codes.length) {
        await reply(app, chat, "Tell me a topic, e.g. <code>/expert tax advice</code> (see /skills all).");
        return [];
      }
      const n = (await eligibleCandidates(app.db, m.id, codes, nowIso())).length;
      const labels = codes.map((c) => TAXONOMY.get(c)!.en).join(", ");
      // Identities are never listed: discovery happens only through consented intros (K4).
      await reply(app, chat, `<b>${n}</b> opted-in, available member(s) match <i>${escapeHtml(labels)}</i>.\n` + (n ? "Use <code>/intro …</code> to request an introduction." : "Try a broader topic, or ask in the community."));
      return [];
    }
    case "intro": {
      if (!rateOk(from.id, rate)) {
        await reply(app, chat, "Too many requests. Please wait a minute.");
        return [];
      }
      if (args.length < 10) {
        await reply(app, chat, "Describe what you need in a sentence, e.g.\n<code>/intro need an accountant for a 3-person startup</code>\n\nYour text is shown to matching experts <b>without your name</b>.");
        return [];
      }
      try {
        const r = await requestIntro(app.db, m.id, args);
        const labels = r.skills.map((c) => TAXONOMY.get(c)!.en).join(", ");
        await reply(
          app,
          chat,
          r.introId
            ? `Request created (<i>${escapeHtml(labels)}</i>). I've invited the best-matching available expert anonymously. You'll be asked to confirm before any contact is shared. Invitations expire after 72h; I'll try up to 3 experts.`
            : `No opted-in, available expert matches <i>${escapeHtml(labels)}</i> right now. Try again later or ask in the community.`,
        );
        return r.keys;
      } catch (e) {
        if (e instanceof IntroError) {
          await reply(app, chat, e.message);
          return [];
        }
        throw e;
      }
    }
    case "requests": {
      const rows = (await app.db.prepare("SELECT id, text, status FROM needs WHERE member_id=? AND status IN ('open','matching') ORDER BY created_at DESC").bind(m.id).all<{ id: string; text: string; status: string }>()).results;
      if (!rows.length) await reply(app, chat, "You have no open requests.");
      for (const r of rows) await reply(app, chat, `<blockquote>${escapeHtml(r.text)}</blockquote>Status: ${r.status}`, [[btn("Cancel request", `n:${r.id}:cancel`)]]);
      return [];
    }
    case "forget_me":
      await reply(
        app,
        chat,
        "<b>Delete my data?</b>\nThis removes all your stored messages, skills and open introductions, and stops storing your future messages. It cannot be undone.",
        [[btn("Yes, delete everything", "fm:yes"), btn("Cancel", "fm:no")]],
      );
      return [];
    case "resume_collection":
      await app.db.prepare("UPDATE members SET collection_opt_out=0 WHERE id=?").bind(m.id).run();
      await audit(app.db, "member.resume_collection", m.id, m.id);
      await reply(app, chat, "Your new messages in enabled groups will be stored again.");
      return [];
  }
  return [];
}

async function cmdSkills(app: App, chat: number, m: Member, args: string): Promise<string[]> {
  const [verb = "", ...rest] = args.split(/\s+/);
  const what = rest.join(" ");
  if (verb === "all") {
    const lines = [...TAXONOMY.values()].map((s) => `<code>${s.code}</code> ${escapeHtml(label(s))}`);
    for (let i = 0; i < lines.length; i += 35) await reply(app, chat, (i ? "" : "<b>Skills</b>\n") + lines.slice(i, i + 35).join("\n"));
    return [];
  }
  if ((verb === "add" || verb === "remove") && what) {
    const code = resolveSkill(what);
    if (!code) {
      await reply(app, chat, "Unknown skill. See /skills all.");
      return [];
    }
    if (verb === "add") {
      await app.db
        .prepare("INSERT INTO skills(member_id, code, state, kind) VALUES (?,?,'confirmed','self_claim') ON CONFLICT(member_id, code) DO UPDATE SET state='confirmed'")
        .bind(m.id, code)
        .run();
      const note = m.discoverable ? "" : " You're not discoverable yet — run /optin when ready.";
      await reply(app, chat, `Added <b>${escapeHtml(label(TAXONOMY.get(code)!))}</b>.${note}`);
    } else {
      const r = await app.db.prepare("DELETE FROM skills WHERE member_id=? AND code=?").bind(m.id, code).run();
      await reply(app, chat, r.meta.changes ? "Removed." : "That skill wasn't on your profile.");
    }
    return [];
  }
  const listed = (await mySkills(app, m.id)).filter((s) => s.state === "confirmed").map((s) => `• ${escapeHtml(label(TAXONOMY.get(s.code)!))}`).join("\n") || "none yet";
  await reply(app, chat, `<b>Your skills</b>\n${listed}\n\n<code>/skills add …</code> · <code>/skills remove …</code> · /skills all`);
  return [];
}

async function ownerCommand(app: App, chat: number, cmd: string): Promise<string[]> {
  if (cmd === "status") {
    const st = await status(app.db);
    await reply(app, chat, "<b>Status</b>\n" + Object.entries(st).map(([k, v]) => `${escapeHtml(k)}: <b>${escapeHtml(String(v))}</b>`).join("\n"));
  } else if (cmd === "sources") {
    const rows = (await app.db.prepare("SELECT s.*, (SELECT COUNT(*) FROM passages p WHERE p.source_id=s.id AND p.part=0 AND p.removed_at IS NULL) AS n FROM sources s ORDER BY enabled DESC, title").all<{ title: string | null; chat_id: number; visibility: string; enabled: number; retention_days: number; n: number }>()).results;
    const lines = rows.map((r) => `${r.enabled ? "✅" : "⏸"} ${escapeHtml(r.title ?? String(r.chat_id))} · ${r.visibility} · ${r.retention_days ? `${r.retention_days}d` : "full history"} · ${r.n} msgs`);
    await reply(app, chat, "<b>Sources</b>\n" + (lines.join("\n") || "none"));
  } else {
    const rows = (await app.db.prepare("SELECT id, key, chat_id, updated_at FROM effects WHERE state='uncertain' ORDER BY updated_at LIMIT 10").all<{ id: string; key: string; chat_id: number; updated_at: string }>()).results;
    if (!rows.length) await reply(app, chat, "No uncertain sends.");
    for (const r of rows) {
      await reply(app, chat, `<code>${escapeHtml(r.key)}</code> → ${r.chat_id} (${r.updated_at})\nDid it arrive?`, [[btn("Delivered", `u:${r.id}:1`), btn("Not delivered", `u:${r.id}:0`)]]);
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
  if (kind === "u") {
    if (!isOwner(app, cb.from.id)) {
      await answerCb();
      return [];
    }
    const ok = await reconcile(app.db, a, b === "1", `operator ${cb.from.id}`);
    await answerCb(ok ? "Recorded." : "Already resolved.");
    await clearButtons();
    return [];
  }
  const m = await memberByTg(app.db, cb.from.id);
  if (!m) {
    await answerCb("Not available.");
    return [];
  }
  let keys: string[] = [];
  if (kind === "i") {
    const r = await act(app.db, a, m.id, b);
    keys = r.keys;
    await answerCb(r.reply, r.reply.length > 60);
    await clearButtons();
  } else if (kind === "n") {
    const r = await cancelNeed(app.db, m.id, a);
    keys = r.keys;
    await answerCb(r.ok ? "Request cancelled." : "Already closed.");
    await clearButtons();
  } else if (kind === "p" && ["digest", "discoverable", "available", "reminders"].includes(a)) {
    await app.db.prepare(`UPDATE members SET ${a}=? WHERE id=?`).bind(b === "1" ? 1 : 0, m.id).run();
    if (a === "discoverable") await audit(app.db, "consent.discovery", m.id, m.id, { granted: b === "1" });
    const fresh = (await memberByTg(app.db, cb.from.id))!;
    const v = profileView(fresh, await mySkills(app, m.id));
    await answerCb("Saved.");
    if (cb.message) {
      await app.tg.call("editMessageText", { chat_id: cb.message.chat.id, message_id: cb.message.message_id, text: v.text, parse_mode: "HTML", reply_markup: { inline_keyboard: v.buttons } });
    }
  } else if (kind === "fm") {
    if (a === "yes") {
      const r = await forgetMember(app.db, m.id, m.tg_id);
      await answerCb("Deleted.");
      await reply(app, cb.from.id, `Done: ${r.passages} message(s), ${r.skills} skill(s) and ${r.intros} introduction(s) removed. Your future messages won't be stored. /resume_collection undoes the collection stop.`);
    } else {
      await answerCb("Nothing deleted.");
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
async function onChatMember(app: App, ev: ChatMemberUpdated): Promise<string[]> {
  const src = await enabledSource(app.db, ev.chat.id);
  const m = src ? await memberByTg(app.db, ev.new_chat_member.user.id) : null;
  if (!src || !m) return [];
  if (["left", "kicked"].includes(ev.new_chat_member.status)) await revoke(app.db, src.id, m.id);
  else if (["member", "administrator", "creator", "restricted"].includes(ev.new_chat_member.status)) await grantStatement(app.db, src.id, m.id).run();
  return [];
}
