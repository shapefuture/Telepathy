// Capability offers and capacity (plan D.2, I04, I12). Capacity is a hard limit: a slot is
// reserved in the same D1 transaction that records the commitment, so overbooking is impossible.

import { DAY, newId, nowIso } from "../util";

export type CommitmentMode = "volunteer" | "paid" | "reciprocal" | "member_benefit";
export const MODES: CommitmentMode[] = ["volunteer", "paid", "reciprocal", "member_benefit"];
export const OFFER_TTL_DAYS = 90;

export interface Offer {
  id: string;
  org_id: string;
  job_code: string;
  description: string;
  capacity_total: number;
  reserved: number;
  commitment_mode: CommitmentMode;
  status: string;
  expires_at: string;
}

export async function addOffer(db: D1Database, o: { job: string; capacity: number; mode: CommitmentMode; description: string; by: string }, now = new Date()): Promise<string> {
  const id = newId().slice(0, 8); // short: it travels in callback data (64-byte limit)
  await db
    .prepare(
      "INSERT INTO capability_offers(id, job_code, description, capacity_total, commitment_mode, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)",
    )
    .bind(id, o.job, o.description.slice(0, 200), o.capacity, o.mode, o.by, nowIso(now), nowIso(new Date(now.getTime() + OFFER_TTL_DAYS * DAY)))
    .run();
  return id;
}

export async function listOffers(db: D1Database): Promise<Offer[]> {
  return (await db.prepare("SELECT * FROM capability_offers WHERE org_id='home' ORDER BY status='published' DESC, created_at DESC LIMIT 30").all<Offer>()).results;
}

/** Published home offers for this job with a free slot (never inferred people, I04). */
export async function openOffers(db: D1Database, job: string, now = nowIso()): Promise<Offer[]> {
  return (
    await db
      .prepare("SELECT * FROM capability_offers WHERE org_id='home' AND status='published' AND expires_at>? AND reserved<capacity_total AND (job_code=? OR job_code='general') ORDER BY reserved*1.0/capacity_total LIMIT 3")
      .bind(now, job)
      .all<Offer>()
  ).results;
}

export async function withdrawOffer(db: D1Database, id: string): Promise<boolean> {
  const r = await db.prepare("UPDATE capability_offers SET status='withdrawn' WHERE id=? AND org_id='home' AND status='published' RETURNING id").bind(id).all();
  return r.results.length > 0;
}

/**
 * Atomically take one slot and record the commitment. Returns the commitment id, or null when
 * the offer is full, withdrawn, expired, or this mission/exchange already holds a live slot.
 */
export async function reserve(db: D1Database, offerId: string, ref: { missionId?: string; exchangeId?: string }, now = nowIso()): Promise<string | null> {
  const id = newId();
  try {
    const [, ins] = await db.batch([
      db.prepare("UPDATE capability_offers SET reserved=reserved+1 WHERE id=? AND status='published' AND expires_at>? AND reserved<capacity_total").bind(offerId, now),
      // changes() is the row count of the UPDATE above, inside the same transaction.
      db
        .prepare(
          "INSERT INTO service_commitments(id, mission_id, exchange_id, capability_offer_id, status, created_at, updated_at) " +
            "SELECT ?,?,?,?,'committed',?,? WHERE changes()=1 RETURNING id",
        )
        .bind(id, ref.missionId ?? null, ref.exchangeId ?? null, offerId, now, now),
    ]);
    return ins!.results.length ? id : null;
  } catch (e) {
    // Unique live-commitment index: the batch rolled back, including the slot.
    if (String(e).includes("UNIQUE")) return null;
    throw e;
  }
}

/** Live commitment -> released/cancelled, returning its slot. */
export async function release(db: D1Database, commitmentId: string, to: "released" | "cancelled" = "released", now = nowIso()): Promise<boolean> {
  const [r] = await db.batch([
    db.prepare("UPDATE service_commitments SET status=?, updated_at=? WHERE id=? AND status IN ('committed','in_delivery') RETURNING capability_offer_id").bind(to, now, commitmentId),
    db
      .prepare(
        "UPDATE capability_offers SET reserved=reserved-1 WHERE changes()=1 AND reserved>0 AND id=(SELECT capability_offer_id FROM service_commitments WHERE id=?)",
      )
      .bind(commitmentId),
  ]);
  return r!.results.length > 0;
}

export async function deliver(db: D1Database, commitmentId: string, now = nowIso()): Promise<boolean> {
  const r = await db.prepare("UPDATE service_commitments SET status='delivered', updated_at=? WHERE id=? AND status IN ('committed','in_delivery') RETURNING id").bind(now, commitmentId).all();
  return r.results.length > 0;
}

export async function liveCommitment(db: D1Database, by: { missionId?: string; exchangeId?: string }): Promise<{ id: string; capability_offer_id: string | null } | null> {
  const col = by.missionId ? "mission_id" : "exchange_id";
  return db
    .prepare(`SELECT id, capability_offer_id FROM service_commitments WHERE ${col}=? AND status IN ('committed','in_delivery')`)
    .bind(by.missionId ?? by.exchangeId!)
    .first();
}
