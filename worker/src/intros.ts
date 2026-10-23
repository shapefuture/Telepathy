// Consent-based introductions (P09, C05).
// /intro text -> need -> best eligible expert gets an anonymous invite -> expert accepts ->
// requester confirms -> only then both receive each other's contact. Decline or expiry moves
// on to the next candidate (max 3). Every send goes through the effect ledger.

import { matchSkills, TAXONOMY, eligibleCandidates } from "./experts";
import { effectStatement } from "./outbox";
import { escapeHtml } from "./text";
import { DAY, HOUR, addMs, audit, newId, nowIso } from "./util";

export type Status = "invited" | "accepted" | "mutually_confirmed" | "completed" | "declined" | "expired" | "cancelled";
export type Event = "accept" | "decline" | "confirm" | "complete" | "expire" | "cancel";
export type Actor = "requester" | "candidate" | "system";

export const TERMINAL: ReadonlySet<Status> = new Set(["completed", "declined", "expired", "cancelled"]);
export const REVEAL: ReadonlySet<Status> = new Set(["mutually_confirmed", "completed"]);
export const INVITE_TTL = 72 * HOUR;
export const REQUEST_TTL = 14 * DAY;
export const REMINDER_AFTER = 24 * HOUR;
export const REQUESTER_WEEKLY_CAP = 2;
export const MAX_CANDIDATES = 3;

const BOTH: Actor[] = ["requester", "candidate"];
export const TRANSITIONS: Record<string, { to: Status; actors: Actor[] }> = {
  "invited:accept": { to: "accepted", actors: ["candidate"] },
  "invited:decline": { to: "declined", actors: ["candidate"] },
  "invited:expire": { to: "expired", actors: ["system"] },
  "invited:cancel": { to: "cancelled", actors: BOTH },
  "accepted:confirm": { to: "mutually_confirmed", actors: ["requester"] },
  "accepted:expire": { to: "expired", actors: ["system"] },
  "accepted:cancel": { to: "cancelled", actors: BOTH },
  "mutually_confirmed:complete": { to: "completed", actors: BOTH },
  "mutually_confirmed:cancel": { to: "cancelled", actors: BOTH },
};

/** Pure transition check. Returns the next status or null if not allowed. */
export function next(status: Status, event: Event, actor: Actor): Status | null {
  const t = TRANSITIONS[`${status}:${event}`];
  return t && t.actors.includes(actor) ? t.to : null;
}

export class IntroError extends Error {} // user-facing, safe to show

interface IntroRow {
  id: string;
  need_id: string;
  requester_id: string;
  candidate_id: string;
  status: Status;
  created_at: string;
  invite_expires_at: string;
}

async function tgId(db: D1Database, memberId: string): Promise<number> {
  const r = await db.prepare("SELECT tg_id FROM members WHERE id=?").bind(memberId).first<{ tg_id: number }>();
  if (!r) throw new IntroError("member not found");
  return r.tg_id;
}

const btn = (text: string, data: string) => ({ text, callback_data: data });

export async function requestIntro(
  db: D1Database,
  requesterId: string,
  rawText: string,
  now = nowIso(),
): Promise<{ needId: string; introId: string | null; skills: string[]; keys: string[] }> {
  const text = rawText.split(/\s+/).join(" ").trim().slice(0, 500);
  const skills = matchSkills(text);
  if (!skills.length) {
    throw new IntroError(
      "I couldn't match that to a skill. Try naming the area, e.g. <code>/intro accountant for a small startup</code>, or see /skills all.",
    );
  }
  const open = await db
    .prepare("SELECT COUNT(*) AS n FROM needs WHERE member_id=? AND created_at>=? AND status IN ('open','matching')")
    .bind(requesterId, addMs(now, -7 * DAY))
    .first<{ n: number }>();
  if ((open?.n ?? 0) >= REQUESTER_WEEKLY_CAP) {
    throw new IntroError(`You already have ${open!.n} open requests this week (limit ${REQUESTER_WEEKLY_CAP}). Cancel one with /requests or wait.`);
  }
  const needId = newId();
  await db
    .prepare("INSERT INTO needs(id, member_id, text, skills_json, status, expires_at, created_at) VALUES (?,?,?,?, 'open', ?, ?)")
    .bind(needId, requesterId, text, JSON.stringify(skills), addMs(now, REQUEST_TTL), now)
    .run();
  await audit(db, "intro.request", requesterId, needId, { skills });
  const { introId, keys } = await nextCandidate(db, needId, now, false);
  return { needId, introId, skills, keys };
}

async function nextCandidate(db: D1Database, needId: string, now: string, notifyNone = true): Promise<{ introId: string | null; keys: string[] }> {
  const need = await db.prepare("SELECT * FROM needs WHERE id=?").bind(needId).first<{ member_id: string; text: string; skills_json: string; status: string; expires_at: string }>();
  if (!need || !["open", "matching"].includes(need.status)) return { introId: null, keys: [] };
  const tried = new Set(
    (await db.prepare("SELECT candidate_id FROM intros WHERE need_id=?").bind(needId).all<{ candidate_id: string }>()).results.map((r) => r.candidate_id),
  );
  const codes = JSON.parse(need.skills_json) as string[];
  const candidates =
    tried.size >= MAX_CANDIDATES || need.expires_at <= now ? [] : await eligibleCandidates(db, need.member_id, codes, now, tried);
  const requesterTg = await tgId(db, need.member_id);
  if (!candidates.length) {
    const key = `need:${needId}:no_match`;
    const stmts = [db.prepare("UPDATE needs SET status='no_match' WHERE id=?").bind(needId)];
    if (notifyNone) {
      stmts.push(
        effectStatement(db, key, requesterTg, {
          text: "No available expert accepted your request this time, so it is closed. You can try again later or ask in the community.",
        }),
      );
    }
    await db.batch(stmts);
    return { introId: null, keys: notifyNone ? [key] : [] };
  }
  const c = candidates[0]!;
  const id = newId();
  const key = `intro:${id}:invite`;
  const labels = codes.map((x) => TAXONOMY.get(x)?.en ?? x).join(", ");
  await db.batch([
    db
      .prepare(
        "INSERT INTO intros(id, need_id, requester_id, candidate_id, status, created_at, updated_at, invite_expires_at, score_json) " +
          "VALUES (?,?,?,?, 'invited', ?, ?, ?, ?)",
      )
      .bind(id, needId, need.member_id, c.member_id, now, now, addMs(now, INVITE_TTL), JSON.stringify({ total: c.total, ...c.components })),
    db.prepare("UPDATE needs SET status='matching' WHERE id=?").bind(needId),
    db
      .prepare("INSERT INTO audit(at, actor, action, subject, detail) VALUES (?,?,?,?,?)")
      .bind(now, "system", "intro.invite", id, JSON.stringify({ total: c.total, components: c.components })),
    effectStatement(db, key, await tgId(db, c.member_id), {
      text:
        `<b>Introduction request</b>\nA community member is looking for help with: <i>${escapeHtml(labels)}</i>\n\n` +
        `<blockquote>${escapeHtml(need.text)}</blockquote>\n` +
        "Your identity stays private unless you accept <b>and</b> they confirm. This invitation expires in 72 hours.",
      buttons: [[btn("Accept", `i:${id}:accept`), btn("Decline", `i:${id}:decline`)]],
    }),
  ]);
  return { introId: id, keys: [key] };
}

/** Apply a button press. Returns a short reply and the effect keys to dispatch. */
export async function act(db: D1Database, introId: string, memberId: string, action: string, now = nowIso()): Promise<{ reply: string; keys: string[] }> {
  const event = (["accept", "decline", "confirm", "cancel", "helpful", "noresp"].includes(action) ? (action === "helpful" || action === "noresp" ? "complete" : action) : null) as Event | null;
  if (!event) return { reply: "Unknown action.", keys: [] };
  const intro = await db.prepare("SELECT * FROM intros WHERE id=?").bind(introId).first<IntroRow>();
  if (!intro) return { reply: "This introduction no longer exists.", keys: [] };
  const actor: Actor | null = memberId === intro.requester_id ? "requester" : memberId === intro.candidate_id ? "candidate" : null;
  if (!actor) return { reply: "This introduction is not yours.", keys: [] };
  if (event === "accept" && now >= intro.invite_expires_at) return { reply: "This invitation has expired.", keys: [] };
  const to = next(intro.status, event, actor);
  if (!to) return { reply: "Already handled, or no longer available.", keys: [] };
  const outcome = event === "complete" ? (action === "helpful" ? "helpful" : "no_response") : null;
  // Optimistic write: a double click or a concurrent expiry loses the race harmlessly.
  const r = await db
    .prepare("UPDATE intros SET status=?, updated_at=?, outcome=COALESCE(?, outcome) WHERE id=? AND status=?")
    .bind(to, now, outcome, introId, intro.status)
    .run();
  if (!r.meta.changes) return { reply: "Already handled.", keys: [] };
  await audit(db, `intro.${event}`, memberId, introId);
  return after(db, intro, to, actor, now);
}

async function after(db: D1Database, intro: IntroRow, to: Status, actor: Actor, now: string): Promise<{ reply: string; keys: string[] }> {
  const reqTg = await tgId(db, intro.requester_id);
  const candTg = await tgId(db, intro.candidate_id);
  const need = await db.prepare("SELECT text FROM needs WHERE id=?").bind(intro.need_id).first<{ text: string }>();
  const quote = `<blockquote>${escapeHtml(need?.text ?? "")}</blockquote>`;
  const id = intro.id;
  if (to === "accepted") {
    const key = `intro:${id}:accepted`;
    await effectStatement(db, key, reqTg, {
      text: `<b>Good news:</b> an expert accepted your introduction request.\n${quote}\nConfirm to exchange contacts with them.`,
      buttons: [[btn("Confirm & exchange contacts", `i:${id}:confirm`), btn("Cancel", `i:${id}:cancel`)]],
    }).run();
    return { reply: "Thanks! The requester will now be asked to confirm. Nothing is shared yet.", keys: [key] };
  }
  if (to === "declined") {
    const { keys } = await nextCandidate(db, intro.need_id, now);
    return { reply: "Declined. Nobody is told who you are.", keys };
  }
  if (to === "mutually_confirmed") {
    const buttons = [[btn("It helped", `i:${id}:helpful`), btn("Didn't happen", `i:${id}:noresp`)]];
    const k1 = `intro:${id}:reveal:req`;
    const k2 = `intro:${id}:reveal:cand`;
    await db.batch([
      effectStatement(db, k1, reqTg, { text: "<b>You're connected.</b> Here is the expert's contact:", buttons, reveal_tg_id: candTg }),
      effectStatement(db, k2, candTg, { text: `<b>You're connected.</b> The requester confirmed.\n${quote}\nTheir contact:`, buttons, reveal_tg_id: reqTg }),
    ]);
    return { reply: "Confirmed. Contacts have been shared with both of you.", keys: [k1, k2] };
  }
  if (to === "cancelled") {
    const key = `intro:${id}:cancelled`;
    await db.batch([
      db.prepare("UPDATE needs SET status='cancelled' WHERE id=? AND status IN ('open','matching')").bind(intro.need_id),
      effectStatement(db, key, actor === "requester" ? candTg : reqTg, {
        text: "An introduction you were part of was cancelled. Nothing was shared.",
      }),
    ]);
    return { reply: "Cancelled.", keys: [key] };
  }
  if (to === "completed") {
    await db.prepare("UPDATE needs SET status='closed' WHERE id=?").bind(intro.need_id).run();
    return { reply: "Thanks for the feedback! It is private and only improves future matching.", keys: [] };
  }
  return { reply: "Done.", keys: [] };
}

export async function cancelNeed(db: D1Database, requesterId: string, needId: string, now = nowIso()): Promise<{ ok: boolean; keys: string[] }> {
  const keys: string[] = [];
  const live = await db
    .prepare("SELECT id FROM intros WHERE need_id=? AND requester_id=? AND status IN ('invited','accepted','mutually_confirmed')")
    .bind(needId, requesterId)
    .all<{ id: string }>();
  for (const r of live.results) keys.push(...(await act(db, r.id, requesterId, "cancel", now)).keys);
  const res = await db
    .prepare("UPDATE needs SET status='cancelled' WHERE id=? AND member_id=? AND status IN ('open','matching','no_match')")
    .bind(needId, requesterId)
    .run();
  return { ok: res.meta.changes > 0 || live.results.length > 0, keys };
}

/** System sweep (P09-05): expire invitations after 72h and requests after 14 days. */
export async function expireDue(db: D1Database, now = nowIso()): Promise<string[]> {
  const keys: string[] = [];
  const due = await db
    .prepare(
      "SELECT i.* FROM intros i JOIN needs n ON n.id = i.need_id WHERE " +
        "(i.status='invited' AND i.invite_expires_at <= ?) OR (i.status IN ('invited','accepted') AND n.expires_at <= ?) LIMIT 50",
    )
    .bind(now, now)
    .all<IntroRow>();
  for (const intro of due.results) {
    const r = await db.prepare("UPDATE intros SET status='expired', updated_at=? WHERE id=? AND status=?").bind(now, intro.id, intro.status).run();
    if (!r.meta.changes) continue;
    await audit(db, "intro.expire", "system", intro.id);
    keys.push(...(await nextCandidate(db, intro.need_id, now)).keys);
  }
  await db.prepare("UPDATE needs SET status='expired' WHERE status IN ('open','matching') AND expires_at <= ?").bind(now).run();
  return keys;
}

/** One reminder after 24h, only for opted-in candidates of still-open invitations (P09-08). */
export async function sendReminders(db: D1Database, now = nowIso()): Promise<string[]> {
  const rows = await db
    .prepare(
      "SELECT i.id, m.tg_id FROM intros i JOIN members m ON m.id = i.candidate_id WHERE i.status='invited' " +
        "AND i.reminder_sent_at IS NULL AND i.created_at <= ? AND i.invite_expires_at > ? AND m.reminders=1 AND m.removed_at IS NULL LIMIT 50",
    )
    .bind(addMs(now, -REMINDER_AFTER), now)
    .all<{ id: string; tg_id: number }>();
  const keys: string[] = [];
  for (const r of rows.results) {
    const key = `intro:${r.id}:reminder`;
    const [upd] = await db.batch([
      db.prepare("UPDATE intros SET reminder_sent_at=? WHERE id=? AND reminder_sent_at IS NULL AND status='invited'").bind(now, r.id),
      effectStatement(db, key, r.tg_id, {
        text: "Reminder: an introduction request is waiting for your answer. Ignore this if you're not interested; it expires automatically.",
        buttons: [[btn("Accept", `i:${r.id}:accept`), btn("Decline", `i:${r.id}:decline`)]],
      }),
    ]);
    if (upd!.meta.changes) keys.push(key);
  }
  return keys;
}
