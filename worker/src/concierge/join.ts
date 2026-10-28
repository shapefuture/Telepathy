// Join screening (ADR-007, item 4). An applicant to a group that approves joins answers three
// questions in private. The answers go to the group's admins with a proposal. A complete screening
// is admitted by rule only once the admit action has been earned (gate.ts). Answers are kept only
// while the decision is open, and what the applicant names as help becomes a self-claimed skill.

import type { App } from "../bot";
import { ensureMember, langOf, type Member } from "../acl";
import { matchSkills } from "../experts";
import { DefiniteFailure } from "../telegram";
import { escapeHtml } from "../text";
import { addMs, DAY, newId, nowIso } from "../util";
import { levelFor, RULES_VERSION, setVerdict } from "./gate";
import { T2 } from "./texts";

export const SCREEN_TTL = 3 * DAY;
export const SCREEN_QUESTIONS = 3;

interface Screen {
  id: string;
  source_id: string;
  chat_id: number;
  applicant_tg: number;
  user_chat: number;
  step: number;
  answers: string;
  status: string;
}

/** Called for a join request. Returns false when this group doesn't screen, so the welcome runs instead. */
export async function startScreen(app: App, chatId: number, user: { id: number; is_bot?: boolean; language_code?: string }, userChat?: number): Promise<boolean> {
  if (user.is_bot) return false;
  const src = await app.db.prepare("SELECT id, title FROM sources WHERE chat_id=? AND enabled=1 AND screen=1").bind(chatId).first<{ id: string; title: string | null }>();
  if (!src) return false;
  const open = await app.db.prepare("SELECT 1 FROM join_screens WHERE source_id=? AND applicant_tg=? AND status IN ('asking','pending_owner')").bind(src.id, user.id).first();
  if (open) return true;
  const m = await ensureMember(app.db, user.id, undefined, user.language_code);
  const id = newId();
  const now = nowIso();
  const chat = userChat ?? user.id;
  const t = T2(langOf(m));
  await app.db.batch([
    app.db
      .prepare("INSERT INTO join_screens(id, source_id, chat_id, applicant_tg, user_chat, member_id, step, answers, status, created_at) VALUES (?,?,?,?,?,?,0,'[]','asking',?)")
      .bind(id, src.id, chatId, user.id, chat, m.id, now),
    app.db
      .prepare("INSERT INTO pending_inputs(member_id, kind, ref, expires_at) VALUES (?, 'screen', ?, ?) ON CONFLICT(member_id) DO UPDATE SET kind='screen', ref=excluded.ref, expires_at=excluded.expires_at")
      .bind(m.id, id, addMs(now, SCREEN_TTL)),
  ]);
  try {
    await app.tg.sendMessage(chat, `${t.joinStart(escapeHtml(src.title ?? ""))}\n\n${t.joinAsk(0)}`);
  } catch (e) {
    if (!(e instanceof DefiniteFailure)) throw e;
    // Telegram won't let the bot write to them: the admins decide without answers.
    await app.db.batch([
      app.db.prepare("UPDATE join_screens SET status='pending_owner' WHERE id=?").bind(id),
      app.db.prepare("DELETE FROM pending_inputs WHERE member_id=? AND kind='screen'").bind(m.id),
    ]);
  }
  return true;
}

/** The applicant's next private message while screening is open. Null when it isn't theirs to answer. */
export async function screenAnswer(app: App, mem: Member, text: string, now = new Date()): Promise<string[] | null> {
  const p = await app.db.prepare("SELECT ref, expires_at FROM pending_inputs WHERE member_id=? AND kind='screen'").bind(mem.id).first<{ ref: string; expires_at: string }>();
  if (!p) return null;
  const s = await app.db
    .prepare("SELECT id, source_id, chat_id, applicant_tg, user_chat, step, answers, status FROM join_screens WHERE id=?")
    .bind(p.ref)
    .first<Screen>();
  if (!s || s.status !== "asking" || p.expires_at <= nowIso(now)) {
    await app.db.batch([
      app.db.prepare("DELETE FROM pending_inputs WHERE member_id=? AND kind='screen'").bind(mem.id),
      app.db.prepare("UPDATE join_screens SET status='expired', answers='' WHERE id=? AND status='asking'").bind(p.ref),
    ]);
    return null;
  }
  const t = T2(langOf(mem));
  const answers = [...(JSON.parse(s.answers) as string[]), text.trim() === "-" ? "" : text.trim().slice(0, 300)];
  if (answers.length < SCREEN_QUESTIONS) {
    await app.db.prepare("UPDATE join_screens SET step=?, answers=? WHERE id=?").bind(answers.length, JSON.stringify(answers), s.id).run();
    await app.tg.sendMessage(s.user_chat, t.joinAsk(answers.length));
    return [];
  }
  await finish(app, s, answers, mem, now);
  return [];
}

async function finish(app: App, s: Screen, answers: string[], mem: Member, now: Date): Promise<void> {
  const complete = answers.every((a) => a.length > 0);
  const skills = answers[2] ? matchSkills(answers[2], 3) : [];
  const title = (await app.db.prepare("SELECT title FROM sources WHERE id=?").bind(s.source_id).first<{ title: string | null }>())?.title ?? "";
  const wantAdmit = complete && (await levelFor(app.db, app.env.CONCIERGE_AUTONOMY, "admit")) === "auto";
  let admitted = false;
  if (wantAdmit) {
    try {
      await app.tg.call("approveChatJoinRequest", { chat_id: s.chat_id, user_id: s.applicant_tg });
      admitted = true;
    } catch {
      admitted = false; // the admins still see it, with the proposal
    }
  }
  const at = nowIso(now);
  const stmts = [
    app.db.prepare("DELETE FROM pending_inputs WHERE member_id=? AND kind='screen'").bind(mem.id),
    admitted
      ? app.db.prepare("UPDATE join_screens SET step=3, answers='', status='accepted', decided_at=? WHERE id=?").bind(at, s.id)
      : app.db.prepare("UPDATE join_screens SET step=3, answers=?, status='pending_owner' WHERE id=?").bind(JSON.stringify(answers), s.id),
  ];
  if (complete) {
    stmts.push(
      app.db
        .prepare("INSERT INTO concierge_cases(subject, mode, source_id, version, created_at, action, executed) VALUES (?, 'join', ?, ?, ?, 'admit', ?) ON CONFLICT(subject, version) DO NOTHING")
        .bind(`join:${s.id}`, s.source_id, RULES_VERSION, at, admitted ? 1 : 0),
    );
  }
  for (const code of skills) {
    stmts.push(app.db.prepare("INSERT OR IGNORE INTO skills(member_id, code, state, kind) VALUES (?, ?, 'confirmed', 'self_claim')").bind(mem.id, code));
  }
  if (skills.length) stmts.push(app.db.prepare("UPDATE members SET discoverable=1 WHERE id=?").bind(mem.id));
  await app.db.batch(stmts);
  const t = T2(langOf(mem));
  try {
    await app.tg.sendMessage(s.user_chat, admitted ? t.joinThanksAuto(escapeHtml(title)) : t.joinThanksPending);
  } catch (e) {
    if (!(e instanceof DefiniteFailure)) throw e;
  }
}

/** An admin's decision on a pending application. */
export async function decideJoin(app: App, id: string, approve: boolean, now = new Date()): Promise<"ok" | "gone" | "failed"> {
  const s = await app.db.prepare("SELECT chat_id, applicant_tg, user_chat, status FROM join_screens WHERE id=?").bind(id).first<{ chat_id: number; applicant_tg: number; user_chat: number; status: string }>();
  if (!s || s.status !== "pending_owner") return "gone";
  try {
    await app.tg.call(approve ? "approveChatJoinRequest" : "declineChatJoinRequest", { chat_id: s.chat_id, user_id: s.applicant_tg });
  } catch {
    return "failed";
  }
  await app.db
    .prepare("UPDATE join_screens SET status=?, answers='', decided_at=? WHERE id=? AND status='pending_owner'")
    .bind(approve ? "accepted" : "declined", nowIso(now), id)
    .run();
  await setVerdict(app.db, `join:${id}`, approve ? "good" : "bad", now);
  if (approve) {
    const who = await app.db.prepare("SELECT lang FROM members WHERE tg_id=?").bind(s.applicant_tg).first<{ lang: string | null }>();
    const title = (await app.db.prepare("SELECT title FROM sources WHERE id=(SELECT source_id FROM join_screens WHERE id=?)").bind(id).first<{ title: string | null }>())?.title ?? "";
    try {
      await app.tg.sendMessage(s.user_chat, T2(who?.lang === "ru" ? "ru" : "en").joinAccepted(escapeHtml(title)));
    } catch (e) {
      if (!(e instanceof DefiniteFailure)) throw e;
    }
  }
  return "ok";
}

/** Cron: applications nobody finished in three days are closed, and their pending question dropped. */
export async function expireScreens(db: D1Database, now = new Date()): Promise<number> {
  const cut = nowIso(new Date(now.getTime() - SCREEN_TTL));
  const r = await db.prepare("UPDATE join_screens SET status='expired', answers='' WHERE status='asking' AND created_at < ?").bind(cut).run();
  await db.prepare("DELETE FROM pending_inputs WHERE kind='screen' AND expires_at <= ?").bind(nowIso(now)).run();
  return r.meta.changes ?? 0;
}
