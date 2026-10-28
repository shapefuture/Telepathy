// Introduction rounds (ADR-007, item 7). Members who opt in with /rounds on are offered one
// introduction a week, on a topic they asked about, to someone who opted in too and can be found
// (the same eligibility as /intro). Nothing is sent to anyone who didn't opt in. The introduction
// then runs the usual two-step consent: the other person accepts, then both confirm before any
// contact is shared.

import type { App } from "../bot";
import { langOf, type Member } from "../acl";
import { eligibleCandidates, labelsFor, matchSkills } from "../experts";
import { inviteCandidate, REQUESTER_WEEKLY_CAP, REQUEST_TTL } from "../intros";
import { effectStatement } from "../outbox";
import { addMs, DAY, newId, nowIso } from "../util";
import { T2 } from "./texts";

export const ROUND_TOPICS = 2;
export const ROUND_LOOKBACK_DAYS = 30;
export const ROUNDS_PER_RUN = 10;

/** ISO week, e.g. 2026-W44. */
export function isoWeek(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / DAY + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Cron: on Mondays (UTC), one round per opted-in member, a few members per run until all are done. */
export async function roundsStep(app: App, now = new Date()): Promise<number> {
  if (now.getUTCDay() !== 1) return 0;
  const week = isoWeek(now);
  const done = await app.db.prepare("SELECT value FROM settings WHERE key='rounds.week'").first<{ value: string }>();
  if (done?.value === week) return 0;
  const { results: members } = await app.db
    .prepare(
      "SELECT m.* FROM members m WHERE m.rounds = 1 AND m.discoverable = 1 AND m.available = 1 AND m.removed_at IS NULL AND m.collection_opt_out = 0 " +
        "AND NOT EXISTS (SELECT 1 FROM intro_rounds r WHERE r.week = ? AND r.member_id = m.id) LIMIT ?",
    )
    .bind(week, ROUNDS_PER_RUN)
    .all<Member>();
  if (!members.length) {
    await app.db.prepare("INSERT INTO settings(key, value) VALUES ('rounds.week', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(week).run();
    return 0;
  }
  for (const m of members) await roundFor(app, m, week, now);
  return members.length;
}

async function roundFor(app: App, m: Member, week: string, now: Date): Promise<void> {
  const db = app.db;
  const record = async (candidate: string, intro: string): Promise<void> => {
    await db.prepare("INSERT INTO intro_rounds(week, member_id, candidate_id, intro_id, created_at) VALUES (?,?,?,?,?)").bind(week, m.id, candidate, intro, nowIso(now)).run();
  };
  const topics = await topicsOf(db, m.id, now);
  if (!topics.length) return record("", "");
  const capped = await db
    .prepare("SELECT COUNT(*) AS n FROM needs WHERE member_id=? AND created_at>=?")
    .bind(m.id, nowIso(new Date(now.getTime() - 7 * DAY)))
    .first<{ n: number }>();
  if ((capped?.n ?? 0) >= REQUESTER_WEEKLY_CAP) return record("", "");
  const cands = await eligibleCandidates(db, m.id, topics, nowIso(now));
  if (!cands.length) return record("", "");
  const optedIn = new Set((await db.prepare(`SELECT id FROM members WHERE rounds = 1 AND id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(cands.map((c) => c.member_id))).all<{ id: string }>()).results.map((r) => r.id));
  const since = nowIso(new Date(now.getTime() - ROUND_LOOKBACK_DAYS * DAY));
  const recent = new Set(
    (
      await db
        .prepare("SELECT candidate_id AS id FROM intros WHERE requester_id=? AND created_at>=? UNION SELECT requester_id AS id FROM intros WHERE candidate_id=? AND created_at>=?")
        .bind(m.id, since, m.id, since)
        .all<{ id: string }>()
    ).results.map((r) => r.id),
  );
  const pick = cands.find((c) => optedIn.has(c.member_id) && !recent.has(c.member_id));
  if (!pick) return record("", "");
  const own = await db
    .prepare("SELECT body FROM passages WHERE author_id=? AND part=0 AND removed_at IS NULL AND body IS NOT NULL AND intent='help_request' ORDER BY event_at DESC LIMIT 1")
    .bind(m.id)
    .first<{ body: string }>();
  const needId = newId();
  const text = (own?.body ?? labelsFor(topics, langOf(m))).slice(0, 200);
  const skillsJson = JSON.stringify(topics);
  const at = nowIso(now);
  await db
    .prepare("INSERT INTO needs(id, member_id, text, skills_json, status, expires_at, created_at) VALUES (?,?,?,?, 'open', ?, ?)")
    .bind(needId, m.id, text, skillsJson, addMs(at, REQUEST_TTL), at)
    .run();
  const { introId } = await inviteCandidate(db, needId, { member_id: m.id, text, skills_json: skillsJson }, pick, at);
  await record(pick.member_id, introId);
  await effectStatement(db, `round:${week}:${m.id}`, m.tg_id, { text: T2(langOf(m)).roundRequester(labelsFor(topics, langOf(m))) }).run();
}

export const LAUNCH_PER_PRESS = 50;

/**
 * "Запустить раунд" on the owner's board: this week's round now, for the opted-in people in one group
 * who don't have one yet. The same rules as the Monday round, so nobody new is reached.
 */
export async function launchRounds(app: App, sourceId: string, now = new Date()): Promise<number> {
  const week = isoWeek(now);
  const { results: members } = await app.db
    .prepare(
      "SELECT m.* FROM members m WHERE m.rounds = 1 AND m.discoverable = 1 AND m.available = 1 AND m.removed_at IS NULL AND m.collection_opt_out = 0 " +
        "AND EXISTS (SELECT 1 FROM source_access a WHERE a.member_id = m.id AND a.source_id = ? AND a.revoked_at IS NULL) " +
        "AND NOT EXISTS (SELECT 1 FROM intro_rounds r WHERE r.week = ? AND r.member_id = m.id) LIMIT ?",
    )
    .bind(sourceId, week, LAUNCH_PER_PRESS)
    .all<Member>();
  for (const m of members) await roundFor(app, m, week, now);
  return members.length;
}

/** The topics a member asked about most in the lookback window. */
async function topicsOf(db: D1Database, memberId: string, now: Date): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT body FROM passages WHERE author_id=? AND part=0 AND removed_at IS NULL AND body IS NOT NULL AND intent='help_request' AND event_at>=? ORDER BY event_at DESC LIMIT 100")
    .bind(memberId, nowIso(new Date(now.getTime() - ROUND_LOOKBACK_DAYS * DAY)))
    .all<{ body: string }>();
  const counts = new Map<string, number>();
  for (const r of results) for (const c of matchSkills(r.body, 3)) counts.set(c, (counts.get(c) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, ROUND_TOPICS).map(([c]) => c);
}

/** /rounds on | off | (status). Turning on needs /optin first: rounds only ever reach people who can be found. */
export async function roundsCommand(app: App, mem: Member, args: string): Promise<string> {
  const t = T2(langOf(mem));
  const arg = args.trim().toLowerCase();
  if (arg === "on") {
    if (!mem.discoverable) return t.roundOnNeedsOptIn;
    await app.db.prepare("UPDATE members SET rounds=1 WHERE id=?").bind(mem.id).run();
    return t.roundOn;
  }
  if (arg === "off") {
    await app.db.prepare("UPDATE members SET rounds=0 WHERE id=?").bind(mem.id).run();
    return t.roundOff;
  }
  const cur = await app.db.prepare("SELECT rounds FROM members WHERE id=?").bind(mem.id).first<{ rounds: number }>();
  return t.roundStatus(!!cur?.rounds);
}

