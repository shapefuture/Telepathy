// Access control: the single place that decides which sources a member may read.
// Deny by default (C01, C02, C06):
//   PUBLIC_APPROVED     -> any active member
//   MEMBER_CONSENTED    -> members with an active grant for that source
//   INTERNAL_RESTRICTED -> active grant AND role >= moderator

import { newId, nowIso } from "./util";

export type Role = "member" | "moderator" | "admin" | "owner";
export type Visibility = "PUBLIC_APPROVED" | "MEMBER_CONSENTED" | "INTERNAL_RESTRICTED";
export const VISIBILITIES: Visibility[] = ["PUBLIC_APPROVED", "MEMBER_CONSENTED", "INTERNAL_RESTRICTED"];

export interface Member {
  id: string;
  tg_id: number;
  role: Role;
  discoverable: number;
  available: number;
  reminders: number;
  digest: number;
  collection_opt_out: number;
  removed_at: string | null;
}

export const isStaff = (role: Role): boolean => role !== "member";

export async function memberByTg(db: D1Database, tgId: number): Promise<Member | null> {
  return db.prepare("SELECT * FROM members WHERE tg_id=?").bind(tgId).first<Member>();
}

export async function memberById(db: D1Database, id: string): Promise<Member | null> {
  return db.prepare("SELECT * FROM members WHERE id=?").bind(id).first<Member>();
}

/** Return the member, creating a private, non-discoverable row if new. */
export async function ensureMember(db: D1Database, tgId: number, role?: Role): Promise<Member> {
  let m = await memberByTg(db, tgId);
  if (!m) {
    await db
      .prepare("INSERT OR IGNORE INTO members(id, tg_id, created_at) VALUES (?,?,?)")
      .bind(newId(), tgId, nowIso())
      .run();
    m = (await memberByTg(db, tgId))!;
  }
  if (role && m.role !== role) {
    await db.prepare("UPDATE members SET role=? WHERE id=?").bind(role, m.id).run();
    m = { ...m, role };
  }
  return m;
}

export function grantStatement(db: D1Database, sourceId: string, memberId: string): D1PreparedStatement {
  // Writes only for a new grant or a re-grant after revocation (saves D1 writes).
  return db
    .prepare(
      "INSERT INTO source_access(source_id, member_id, granted_at) VALUES (?,?,?) " +
        "ON CONFLICT(source_id, member_id) DO UPDATE SET revoked_at=NULL, granted_at=excluded.granted_at " +
        "WHERE source_access.revoked_at IS NOT NULL",
    )
    .bind(sourceId, memberId, nowIso());
}

export async function revoke(db: D1Database, sourceId: string, memberId: string): Promise<void> {
  await db
    .prepare("UPDATE source_access SET revoked_at=? WHERE source_id=? AND member_id=? AND revoked_at IS NULL")
    .bind(nowIso(), sourceId, memberId)
    .run();
}

interface SourceRow {
  id: string;
  visibility: Visibility;
}

/** Readable source ids for many members at once (2 queries total). */
export async function readableSets(db: D1Database, members: Member[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  const active = members.filter((m) => !m.removed_at);
  for (const m of members) out.set(m.id, new Set());
  if (!active.length) return out;
  const [sources, grants] = await db.batch([
    db.prepare("SELECT id, visibility FROM sources WHERE enabled=1"),
    db
      .prepare(
        "SELECT source_id, member_id FROM source_access WHERE revoked_at IS NULL " +
          "AND member_id IN (SELECT value FROM json_each(?))",
      )
      .bind(JSON.stringify(active.map((m) => m.id))),
  ]);
  const granted = new Set((grants!.results as { source_id: string; member_id: string }[]).map((g) => `${g.member_id}|${g.source_id}`));
  for (const m of active) {
    const set = out.get(m.id)!;
    for (const s of sources!.results as unknown as SourceRow[]) {
      const g = granted.has(`${m.id}|${s.id}`);
      if (
        s.visibility === "PUBLIC_APPROVED" ||
        (s.visibility === "MEMBER_CONSENTED" && g) ||
        (s.visibility === "INTERNAL_RESTRICTED" && g && isStaff(m.role))
      ) {
        set.add(s.id);
      }
    }
  }
  return out;
}

export async function readable(db: D1Database, m: Member): Promise<Set<string>> {
  return (await readableSets(db, [m])).get(m.id)!;
}
