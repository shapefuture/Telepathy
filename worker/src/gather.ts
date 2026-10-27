// Gatherings (plan: journey 8): before, during and after an event the bot already detected.
// «Иду» on the event, the reminder two hours before, "who's going" with three people worth meeting
// and the reason, and after it: "who would you like to see again?". Contacts open only when the
// interest is mutual, so nobody learns about one-sided interest.

import { langOf, type Member } from "./acl";
import { T, defaultLang, type Lang } from "./i18n";
import { effectStatement } from "./outbox";
import { skillName } from "./experts";
import { faceOf, namesFor } from "./thread-card";
import type { InlineButton } from "./telegram";
import { escapeHtml } from "./text";
import { HOUR, newId, nowIso, addMs } from "./util";
import type { App } from "./bot";

/** The event as the buttons name it: its message id and the first eight characters of its club. */
export const shortKey = (sourceId: string, msgId: number) => `${msgId}.${sourceId.slice(0, 8)}`;
export const fullKey = (sourceId: string, msgId: number) => `${sourceId}:${msgId}`;

export interface Event {
  source_id: string;
  msg_id: number;
  title: string;
  starts_at: string;
}

/** Resolve a button's short event key to the event, if the person can read its club. */
export async function eventByShort(db: D1Database, short: string, readable: Set<string>): Promise<Event | null> {
  const m = /^(\d{1,12})\.([0-9a-f]{8})$/.exec(short);
  if (!m) return null;
  const ev = await db
    .prepare("SELECT source_id, msg_id, title, starts_at FROM events WHERE msg_id=? AND substr(source_id,1,8)=? AND hidden=0 LIMIT 1")
    .bind(Number(m[1]), m[2])
    .first<Event>();
  return ev && readable.has(ev.source_id) ? ev : null;
}

const newToken = () => newId().slice(0, 10);

/** «Иду» / «Не иду». A person keeps one answer per event; the token stays the same. */
export async function rsvp(db: D1Database, memberId: string, eventKey: string, status: "going" | "not", now = nowIso()): Promise<void> {
  await db
    .prepare("INSERT INTO rsvps(event_key, member_id, status, token, at) VALUES (?,?,?,?,?) ON CONFLICT(event_key, member_id) DO UPDATE SET status=excluded.status, at=excluded.at")
    .bind(eventKey, memberId, status, newToken(), now)
    .run();
}

/** Who's going, and three people worth meeting (most things in common first), with the reason. */
export async function whoGoes(db: D1Database, eventKey: string, me: Member, lang: Lang): Promise<string> {
  const m = T(lang);
  const going = (
    await db.prepare("SELECT member_id AS id FROM rsvps WHERE event_key=? AND status='going' AND member_id<>? LIMIT 60").bind(eventKey, me.id).all<{ id: string }>()
  ).results.map((r) => r.id);
  if (!going.length) return m.gatherNobody;
  const mine = await mySkills(db, me.id);
  const others = await Promise.all(going.map(async (id) => ({ id, skills: await mySkills(db, id) })));
  const names = await namesFor(db, going);
  const scored = others
    .map((o) => {
      const shared = o.skills.filter((s) => mine.includes(s));
      return { id: o.id, shared };
    })
    .sort((a, b) => b.shared.length - a.shared.length || a.id.localeCompare(b.id))
    .slice(0, 3);
  const lines = [m.gatherWhoHead(going.length)];
  for (const s of scored) {
    const who = `${faceOf(s.id)} ${escapeHtml(names.get(s.id) ?? m.memberAnon)}`;
    const why = s.shared.length ? m.gatherSharedSkill(escapeHtml(skillName(s.shared[0]!, lang))) : m.gatherAlsoGoing;
    lines.push(m.gatherWhoLine(who, why));
  }
  return lines.join("\n");
}

async function mySkills(db: D1Database, memberId: string): Promise<string[]> {
  return (await db.prepare("SELECT code FROM skills WHERE member_id=? AND state='confirmed'").bind(memberId).all<{ code: string }>()).results.map((r) => r.code);
}

/** "I want to keep in touch with them." Mutual: both get the other's contact. One-sided: nothing is said. */
export async function wantToSee(app: App, me: Member, eventKey: string, token: string, now = nowIso()): Promise<{ text: string; keys: string[] }> {
  const db = app.db;
  const m = T(langOf(me));
  const other = await db
    .prepare("SELECT r.member_id AS id FROM rsvps r WHERE r.event_key=? AND r.token=? AND r.status='going' AND r.member_id<>?")
    .bind(eventKey, token, me.id)
    .first<{ id: string }>();
  if (!other) return { text: m.gatherGone, keys: [] };
  await db.prepare("INSERT OR IGNORE INTO wants(event_key, from_member, to_member, at) VALUES (?,?,?,?)").bind(eventKey, me.id, other.id, now).run();
  const back = await db.prepare("SELECT 1 FROM wants WHERE event_key=? AND from_member=? AND to_member=?").bind(eventKey, other.id, me.id).first();
  if (!back) return { text: m.gatherWantSaved, keys: [] };
  const people = await db.prepare("SELECT id, tg_id, lang FROM members WHERE id IN (?, ?)").bind(me.id, other.id).all<{ id: string; tg_id: number; lang: Lang | null }>();
  const keys: string[] = [];
  for (const p of people.results) {
    const other2 = people.results.find((x) => x.id !== p.id)!;
    const key = `gather:${eventKey}:mutual:${p.id}`;
    await effectStatement(db, key, p.tg_id, { text: T(p.lang ?? defaultLang()).gatherMutual, reveal_tg_id: other2.tg_id }).run();
    keys.push(key);
  }
  return { text: m.gatherMutualHere, keys };
}

/** Cron: two hours before a gathering, remind the people who said they're going. Once each. */
export async function remindStep(db: D1Database, now: Date): Promise<string[]> {
  const { results } = await db
    .prepare(
      "SELECT e.source_id, e.msg_id, e.title, e.starts_at, r.member_id, m.tg_id, m.lang FROM events e JOIN rsvps r ON r.event_key = e.source_id || ':' || e.msg_id AND r.status='going' " +
        "JOIN members m ON m.id = r.member_id WHERE e.hidden=0 AND e.starts_at > ? AND e.starts_at <= ? LIMIT 50",
    )
    .bind(addMs(nowIso(now), 2 * HOUR), addMs(nowIso(now), 2 * HOUR + 15 * 60_000))
    .all<{ source_id: string; msg_id: number; title: string; starts_at: string; member_id: string; tg_id: number; lang: Lang | null }>();
  const keys: string[] = [];
  for (const r of results) {
    const key = `gather:${fullKey(r.source_id, r.msg_id)}:remind:${r.member_id}`;
    const m = T(r.lang ?? defaultLang());
    await effectStatement(db, key, r.tg_id, { text: m.gatherRemind(escapeHtml(r.title)) }).run();
    keys.push(key);
  }
  return keys;
}

/** Cron: after a gathering (2 to 3 hours on), ask each attendee once who they'd like to see again. */
export async function afterStep(db: D1Database, now: Date): Promise<string[]> {
  const { results } = await db
    .prepare(
      "SELECT e.source_id, e.msg_id, e.title, r.member_id, r.token, m.tg_id, m.lang FROM events e JOIN rsvps r ON r.event_key = e.source_id || ':' || e.msg_id AND r.status='going' " +
        "JOIN members m ON m.id = r.member_id WHERE e.hidden=0 AND e.starts_at <= ? AND e.starts_at > ? LIMIT 40",
    )
    .bind(addMs(nowIso(now), -2 * HOUR), addMs(nowIso(now), -3 * HOUR))
    .all<{ source_id: string; msg_id: number; title: string; member_id: string; token: string; tg_id: number; lang: Lang | null }>();
  const keys: string[] = [];
  for (const r of results) {
    const key = `gather:${fullKey(r.source_id, r.msg_id)}:after:${r.member_id}`;
    const others = (
      await db
        .prepare("SELECT x.member_id AS id, x.token FROM rsvps x WHERE x.event_key=? AND x.status='going' AND x.member_id<>? LIMIT 6")
        .bind(fullKey(r.source_id, r.msg_id), r.member_id)
        .all<{ id: string; token: string }>()
    ).results;
    const names = await namesFor(db, others.map((o) => o.id));
    const m = T(r.lang ?? defaultLang());
    const buttons: InlineButton[][] = others.map((o) => [{ text: `${faceOf(o.id)} ${names.get(o.id) ?? m.memberAnon}`, callback_data: `wn:${shortKey(r.source_id, r.msg_id)}:${o.token}` }]);
    const claimed = await effectStatement(db, key, r.tg_id, { text: m.gatherAfterAsk(escapeHtml(r.title)), buttons: buttons.length ? buttons : undefined }).run();
    if (claimed.meta.changes) keys.push(key);
  }
  return keys;
}
