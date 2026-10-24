// Missions: the member's request lifecycle (plan D.1, Track 3, Track 8). All transitions go
// through `transition`, which checks the pure state machine and writes the status history.

import { CONSENT_TTL_DAYS, type ConsentAction, type Grant } from "../domain/consent";
import { MISSION_TERMINAL, MISSION_TTL_DAYS, nextMission, type MissionActor, type MissionStatus } from "../domain/mission";
import { matchSkills } from "../experts";
import { DAY, newId, nowIso } from "../util";

export interface Mission {
  id: string;
  member_id: string;
  job_code: string;
  summary: string;
  criteria: string;
  status: MissionStatus;
  version: number;
  handler: string;
  local_hits: number;
  reason: string | null;
  case_type?: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

export const MAX_OPEN_MISSIONS = 5;
export const MIN_SUMMARY = 10;
export const MAX_SUMMARY = 500;

export class MissionError extends Error {}

export const getMission = (db: D1Database, id: string) => db.prepare("SELECT * FROM missions WHERE id=?").bind(id).first<Mission>();

export async function openMissions(db: D1Database, memberId: string): Promise<Mission[]> {
  return (
    await db
      .prepare("SELECT * FROM missions WHERE member_id=? AND status NOT IN ('closed','cancelled','expired','failed_with_explanation','draft') ORDER BY created_at DESC LIMIT 10")
      .bind(memberId)
      .all<Mission>()
  ).results;
}

/** Draft from free text. Older drafts are dropped: a new /help replaces an unconfirmed one. */
export async function createDraft(db: D1Database, memberId: string, text: string, now = new Date()): Promise<Mission> {
  const summary = text.trim().replace(/\s+/g, " ").slice(0, MAX_SUMMARY);
  if (summary.length < MIN_SUMMARY) throw new MissionError("too short");
  const open = await db.prepare("SELECT COUNT(*) AS n FROM missions WHERE member_id=? AND status NOT IN ('closed','cancelled','expired','failed_with_explanation','draft')").bind(memberId).first<{ n: number }>();
  if ((open?.n ?? 0) >= MAX_OPEN_MISSIONS) throw new MissionError("too many");
  const id = newId();
  const ts = nowIso(now);
  await db.batch([
    db.prepare("DELETE FROM missions WHERE member_id=? AND status='draft'").bind(memberId),
    db
      .prepare("INSERT INTO missions(id, member_id, job_code, summary, status, created_at, updated_at, expires_at) VALUES (?,?,?,?,'draft',?,?,?)")
      .bind(id, memberId, matchSkills(summary, 1)[0] ?? "general", summary, ts, ts, nowIso(new Date(now.getTime() + MISSION_TTL_DAYS * DAY))),
    db.prepare("INSERT INTO mission_events(mission_id, from_status, to_status, actor, at) VALUES (?,NULL,'draft','member',?)").bind(id, ts),
  ]);
  return (await getMission(db, id))!;
}

/**
 * Move a mission if the state machine allows it and nobody moved it meanwhile (optimistic:
 * the UPDATE matches the status we read). Returns the updated mission, or null.
 */
export async function transition(
  db: D1Database,
  id: string,
  to: MissionStatus,
  actor: MissionActor,
  extra: { handler?: string; reason?: string; localHits?: number; from?: MissionStatus } = {},
  now = nowIso(),
): Promise<Mission | null> {
  const m = await getMission(db, id);
  if (!m || (extra.from && m.status !== extra.from) || !nextMission(m.status, to, actor)) return null;
  const [u] = await db.batch([
    db
      .prepare(
        "UPDATE missions SET status=?, updated_at=?, handler=COALESCE(?, handler), reason=COALESCE(?, reason), local_hits=COALESCE(?, local_hits) WHERE id=? AND status=? RETURNING id",
      )
      .bind(to, now, extra.handler ?? null, extra.reason ?? null, extra.localHits ?? null, id, m.status),
    db.prepare("INSERT INTO mission_events(mission_id, from_status, to_status, actor, at) SELECT ?,?,?,?,? WHERE changes()=1").bind(id, m.status, to, actor, now),
  ]);
  return u!.results.length ? { ...m, status: to, updated_at: now, handler: extra.handler ?? m.handler } : null;
}

export async function recordGrant(
  db: D1Database,
  m: Pick<Mission, "id" | "member_id" | "version">,
  action: ConsentAction,
  audience: string,
  fields: string[],
  purpose: string,
  policyVersion: number,
  now = new Date(),
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO consent_grants(id, mission_id, member_id, action, audience, purpose, fields, mission_version, policy_version, expires_at, recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) " +
        "ON CONFLICT(mission_id, action, mission_version) DO UPDATE SET audience=excluded.audience, fields=excluded.fields, purpose=excluded.purpose, " +
        "policy_version=excluded.policy_version, expires_at=excluded.expires_at, revoked_at=NULL, recorded_at=excluded.recorded_at",
    )
    .bind(newId(), m.id, m.member_id, action, audience, purpose, JSON.stringify(fields), m.version, policyVersion, nowIso(new Date(now.getTime() + CONSENT_TTL_DAYS * DAY)), nowIso(now))
    .run();
}

export async function grantFor(db: D1Database, missionId: string, action: ConsentAction): Promise<Grant | null> {
  return db.prepare("SELECT * FROM consent_grants WHERE mission_id=? AND action=? ORDER BY mission_version DESC LIMIT 1").bind(missionId, action).first<Grant>();
}

export async function revokeGrants(db: D1Database, missionId: string, now = nowIso()): Promise<void> {
  await db.prepare("UPDATE consent_grants SET revoked_at=? WHERE mission_id=? AND revoked_at IS NULL").bind(now, missionId).run();
}

export type ServiceCode = "knowledge_answer" | "local_service" | "partner_service" | "no_provider";

/** Upsert the receipt; evidence level follows from who confirmed (unknown is never success). */
export async function receipt(
  db: D1Database,
  missionId: string,
  r: { service?: ServiceCode; commitmentId?: string | null; provider?: boolean; useful?: boolean },
  now = nowIso(),
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO outcome_receipts(mission_id, commitment_id, service_code, provider_confirmed, requester_useful, created_at, updated_at) VALUES (?,?,?,?,?,?,?) " +
        "ON CONFLICT(mission_id) DO UPDATE SET commitment_id=COALESCE(excluded.commitment_id, commitment_id), service_code=COALESCE(?, service_code), " +
        "provider_confirmed=COALESCE(excluded.provider_confirmed, provider_confirmed), requester_useful=COALESCE(excluded.requester_useful, requester_useful), updated_at=excluded.updated_at",
    )
    .bind(missionId, r.commitmentId ?? null, r.service ?? "knowledge_answer", r.provider === undefined ? null : r.provider ? 1 : 0, r.useful === undefined ? null : r.useful ? 1 : 0, now, now, r.service ?? null)
    .run();
  await db
    .prepare(
      "UPDATE outcome_receipts SET evidence_level=CASE WHEN provider_confirmed=1 AND requester_useful IS NOT NULL THEN 'both_confirmed' " +
        "WHEN requester_useful IS NOT NULL THEN 'requester_confirmed' WHEN provider_confirmed=1 THEN 'provider_confirmed' ELSE 'unverified' END WHERE mission_id=?",
    )
    .bind(missionId)
    .run();
}

/** Operator report (Track 8): every stage keeps its own count; useful = requester said so. */
export async function report(db: D1Database): Promise<{ stages: [string, number][]; receipts: [string, number][]; useful: number; notUseful: number }> {
  const [st, rc, u] = await db.batch([
    db.prepare("SELECT status AS k, COUNT(*) AS n FROM missions WHERE status<>'draft' GROUP BY status ORDER BY n DESC"),
    db.prepare("SELECT service_code || ' / ' || evidence_level AS k, COUNT(*) AS n FROM outcome_receipts GROUP BY k ORDER BY n DESC"),
    db.prepare("SELECT COALESCE(SUM(requester_useful=1),0) AS y, COALESCE(SUM(requester_useful=0),0) AS n FROM outcome_receipts"),
  ]);
  const pairs = (r: D1Result) => (r.results as { k: string; n: number }[]).map((x) => [x.k, x.n] as [string, number]);
  const yn = u!.results[0] as { y: number; n: number };
  return { stages: pairs(st!), receipts: pairs(rc!), useful: yn.y, notUseful: yn.n };
}

/** Expire overdue missions; the caller withdraws their external exchanges. */
export async function expireMissions(db: D1Database, now = nowIso()): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT id FROM missions WHERE expires_at<=? AND status NOT IN ('closed','cancelled','expired','failed_with_explanation') LIMIT 50")
    .bind(now)
    .all<{ id: string }>();
  const out: string[] = [];
  for (const r of results) if (await transition(db, r.id, "expired", "system", {}, now)) out.push(r.id);
  // Drafts nobody confirmed within a day just disappear.
  await db.prepare("DELETE FROM missions WHERE status='draft' AND created_at<=?").bind(nowIso(new Date(Date.parse(now) - DAY))).run();
  return out;
}

export const isTerminal = (m: Pick<Mission, "status">) => MISSION_TERMINAL.has(m.status);
