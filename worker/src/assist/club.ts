// Clubs answer their own members first. A member's escalated request (the local memory had no
// answer and they asked for more) is seen by the admins of the groups the member belongs to; the
// operator's desk still sees everything. A club admin can introduce an expert or say "no provider"
// for those requests, and nothing else: routing, offers and delivery stay with the operator.
// Pure queries here; the actions and notifications are in ./actions.

import { MISSION_NEEDS_DESK } from "../domain/mission";
import type { Mission } from "./missions";

/** The buttons a club admin may press on a request (the card itself is `show`). */
export const CLUB_ACTS = new Set(["i", "np"]);

/** Connected groups the member belongs to (they have not left them). */
export async function missionClubs(db: D1Database, memberId: string): Promise<number[]> {
  const { results } = await db
    .prepare("SELECT DISTINCT s.chat_id FROM source_access a JOIN sources s ON s.id=a.source_id WHERE a.member_id=? AND a.revoked_at IS NULL AND s.enabled=1")
    .bind(memberId)
    .all<{ chat_id: number }>();
  return results.map((r) => r.chat_id);
}

/** Is this an escalated request from a member of one of these groups? */
export async function inClubs(db: D1Database, m: Pick<Mission, "member_id" | "status">, chats: number[]): Promise<boolean> {
  if (!chats.length || !MISSION_NEEDS_DESK.has(m.status)) return false;
  const mine = await missionClubs(db, m.member_id);
  return mine.some((c) => chats.includes(c));
}

/** The escalated requests from members of these groups, oldest first. */
export async function clubMissions(db: D1Database, chats: number[]): Promise<Mission[]> {
  if (!chats.length) return [];
  const { results } = await db
    .prepare(
      "SELECT * FROM missions WHERE status IN ('external_permission_needed','no_eligible_provider') AND member_id IN " +
        "(SELECT a.member_id FROM source_access a JOIN sources s ON s.id=a.source_id WHERE a.revoked_at IS NULL AND s.enabled=1 AND s.chat_id IN (SELECT value FROM json_each(?))) " +
        "ORDER BY updated_at LIMIT 20",
    )
    .bind(JSON.stringify(chats))
    .all<Mission>();
  return results;
}
