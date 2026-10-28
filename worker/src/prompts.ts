// Next-message prompts (conversational input). A command that needs its text asks for it, and the
// person's next private message is that text: /intro asks what is needed, /optin asks what the person
// can help with, and a thank-you asks for skills. One prompt is open at a time and it lasts an hour.
// Any command closes it, «Отмена» closes it at once, and a message that cannot answer it (no skill in
// it, a link that cannot be read) is handed on as an ordinary message: a question, say.

import type { App } from "./bot";
import { langOf, type Member } from "./acl";
import { applyBio, lonelyUrl } from "./bio";
import { btn, T2 } from "./concierge/texts";
import { matchSkills, skillName } from "./experts";
import { IntroError, NoSkillError, requestIntro, retryWaiting } from "./intros";
import { T, type Lang } from "./i18n";
import { effectStatement } from "./outbox";
import { escapeHtml } from "./text";
import { addMs, HOUR, nowIso } from "./util";

export type PromptKind = "intro" | "bio" | "doors";

/** A question is not an answer to "what can you help with?": it goes on to the search instead. */
const looksLikeQuestion = (text: string): boolean =>
  /\?\s*$/.test(text) || /^(кто|как|что|где|когда|почему|зачем|сколько|есть ли|подскажите|посоветуйте|порекомендуйте|who|how|what|where|when|why|which|does|do|is|are|can)\b/i.test(text.trim());

/** The shortest request /intro can match: the same bar as before. */
const INTRO_MIN = 10;
/** An answer shorter than this is a list of topics, matched directly; a longer one is read for skills. */
const BIO_LINE = 60;

/** Arms a prompt in the database, replacing whichever one was open. No message is sent. */
export async function armPrompt(db: D1Database, memberId: string, kind: PromptKind, now = new Date()): Promise<void> {
  await db
    .prepare("INSERT INTO pending_inputs(member_id, kind, ref, expires_at) VALUES (?, ?, '', ?) ON CONFLICT(member_id) DO UPDATE SET kind=excluded.kind, ref='', expires_at=excluded.expires_at")
    .bind(memberId, kind, addMs(nowIso(now), HOUR))
    .run();
}

/** Arms a prompt and sends its question, with a way out. */
export async function openPrompt(app: App, mem: Member, kind: PromptKind, question: string, now = new Date()): Promise<void> {
  await armPrompt(app.db, mem.id, kind, now);
  await app.tg.sendMessage(mem.tg_id, question, { buttons: [[btn(T(langOf(mem)).bCancel, "pc:x")]] });
}

/** A command closes the open prompt. A join screening's answer is not a prompt, so it is kept. */
export async function closePrompts(db: D1Database, memberId: string): Promise<void> {
  await db.prepare("DELETE FROM pending_inputs WHERE member_id=? AND kind IN ('intro','bio','doors','thanks','clarify')").bind(memberId).run();
}

/**
 * The private message that answers an open prompt. Null when no prompt of these kinds is open, so the
 * message goes on to the other pending answers (the doors line, the thank-you's words) and then to a question.
 */
export async function answerPrompt(app: App, mem: Member, text: string, now = new Date()): Promise<string[] | null> {
  const p = await app.db
    .prepare("SELECT kind, expires_at FROM pending_inputs WHERE member_id=? AND kind IN ('intro','bio')")
    .bind(mem.id)
    .first<{ kind: string; expires_at: string }>();
  if (!p) return null;
  if (p.expires_at <= nowIso(now)) {
    await closePrompts(app.db, mem.id);
    return null;
  }
  const t = text.trim();
  if (!t) return null;
  return p.kind === "intro" ? introAnswer(app, mem, t, now) : bioAnswer(app, mem, t, now);
}

async function introAnswer(app: App, mem: Member, text: string, now: Date): Promise<string[]> {
  const m = T(langOf(mem));
  if (text.length < INTRO_MIN) {
    await app.tg.sendMessage(mem.tg_id, m.introUsage, { buttons: [[btn(m.bCancel, "pc:x")]] });
    return [];
  }
  await closePrompts(app.db, mem.id);
  return introFromText(app, mem, text, mem.tg_id, now);
}

/** A request for someone who can help: the answer to /intro, or to its prompt. Returns the effect keys to dispatch. */
export async function introFromText(app: App, mem: Member, text: string, chat: number, now = new Date()): Promise<string[]> {
  const lang = langOf(mem);
  const m = T(lang);
  try {
    const r = await requestIntro(app.db, mem.id, text, nowIso(now), lang);
    const labels = escapeHtml(labelsOf(r.skills, lang));
    if (r.introId) {
      await app.tg.sendMessage(chat, m.introCreated(labels));
    } else {
      // Nobody is free yet: the request waits, and the person can hand it to the club's team now.
      await app.tg.sendMessage(chat, m.introNoMatch(labels), { buttons: [[btn(m.bTeam, `n:${r.needId}:team`)], [btn(m.bCancelRequest, `n:${r.needId}:cancel`)]] });
    }
    return r.keys;
  } catch (e) {
    if (!(e instanceof IntroError)) throw e;
    // No topic in the sentence: let them rephrase it, rather than starting over.
    if (e instanceof NoSkillError) await armPrompt(app.db, mem.id, "intro", now);
    await app.tg.sendMessage(chat, e.message);
    return [];
  }
}

const labelsOf = (codes: string[], lang: Lang): string => codes.map((c) => skillName(c, lang)).join(", ");

/** "What else can you help with?": a list of topics, a few lines about yourself, or a link to your profile. */
async function bioAnswer(app: App, mem: Member, text: string, now: Date): Promise<string[] | null> {
  const lang = langOf(mem);
  const m = T(lang);
  const keep = { buttons: [[btn(m.bCancel, "pc:x")]] };
  if (!lonelyUrl(text) && text.length < BIO_LINE) {
    const codes = matchSkills(text);
    if (!codes.length) {
      if (looksLikeQuestion(text)) {
        await closePrompts(app.db, mem.id);
        return null;
      }
      await app.tg.sendMessage(mem.tg_id, m.bioNone, keep);
      return [];
    }
    const { added, known } = await addSkills(app.db, mem.id, codes);
    await closePrompts(app.db, mem.id);
    await app.tg.sendMessage(mem.tg_id, added.length ? m.bioAdded(escapeHtml(labelsOf(added, lang)), known) : m.bioKnown);
    return skillKeysAfter(app, mem.id, now);
  }
  const r = await applyBio(app, mem, text, "bot");
  if (r.status === "none" && looksLikeQuestion(text)) {
    await closePrompts(app.db, mem.id);
    return null;
  }
  if (r.status !== "ok") {
    const say: Record<string, string> = { none: m.bioNone, empty: m.bioNone, short: m.bioShort, blocked: m.bioBlocked, bad_url: m.bioBadUrl, failed: m.bioFailed };
    await app.tg.sendMessage(mem.tg_id, say[r.status] ?? m.bioNone, keep);
    return [];
  }
  await closePrompts(app.db, mem.id);
  await app.tg.sendMessage(mem.tg_id, r.added.length ? m.bioAdded(r.added.map(escapeHtml).join(", "), r.known) : m.bioKnown);
  return skillKeysAfter(app, mem.id, now);
}

/** Adds topics as confirmed skills, in the person's own words. Returns the new ones and how many were there already. */
export async function addSkills(db: D1Database, memberId: string, codes: string[]): Promise<{ added: string[]; known: number }> {
  const have = new Set((await db.prepare("SELECT code FROM skills WHERE member_id=? AND state='confirmed'").bind(memberId).all<{ code: string }>()).results.map((r) => r.code));
  const added: string[] = [];
  let known = 0;
  for (const code of codes) {
    if (have.has(code)) {
      known++;
      continue;
    }
    await db
      .prepare("INSERT INTO skills(member_id, code, state, kind) VALUES (?,?,'confirmed','self_claim') ON CONFLICT(member_id, code) DO UPDATE SET state='confirmed'")
      .bind(memberId, code)
      .run();
    added.push(code);
  }
  return { added, known };
}

/** Once per person, and only while they have no skills yet: after a thank-you, ask what they can help with. */
export async function askSkillsOnce(app: App, mem: Member, now = new Date()): Promise<string[]> {
  const has = await app.db.prepare("SELECT 1 FROM skills WHERE member_id=? AND state='confirmed' LIMIT 1").bind(mem.id).first();
  if (has) return [];
  const lang = langOf(mem);
  const key = `skillask:${mem.id}`;
  const sent = await effectStatement(app.db, key, mem.tg_id, { text: T2(lang).skillAsk, buttons: [[btn(T(lang).bSkip, "pc:x")]] }).run();
  if (!sent.meta.changes) return [];
  await armPrompt(app.db, mem.id, "bio", now);
  return [key];
}

/** A person's skills changed: the requests waiting for those topics get another look now. */
export async function skillKeysAfter(app: App, memberId: string, now = new Date()): Promise<string[]> {
  const rows = await app.db.prepare("SELECT code FROM skills WHERE member_id=? AND state='confirmed'").bind(memberId).all<{ code: string }>();
  return retryWaiting(app.db, nowIso(now), { codes: rows.results.map((r) => r.code) });
}
