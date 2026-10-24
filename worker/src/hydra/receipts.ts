// H5: member-held proof of consent. Every follow/unfollow op is countersigned by the club's online
// key; the member keeps the receipts (their device, their export). If every club database is lost,
// a fresh node that pins the same root accepts the receipts back — and because ops carry sequence
// numbers, an old FOLLOW can never override a newer UNFOLLOW, whoever presents what.

import type { App } from "../bot";
import { audit, nowIso } from "../util";
import { countValid, signWith, type Signed } from "../continuity/crypto";
import { currentRoot, type RootMeta } from "../continuity/identity";
import { applyOp, TOPICS, type Op, type Topic } from "../continuity/people";

export interface ReceiptMeta {
  schema: "nexus.follow-receipt.v1";
  org: string;
  person_ref: string;
  seq: number;
  op: Op;
  topic: Topic | null;
  at: string;
  consent_version: number;
}

const OPS: Op[] = ["FOLLOW", "UNFOLLOW", "MUTE", "UNMUTE", "REVOKE_ENDPOINT"];

export async function receiptsFor(app: App, personId: string): Promise<Signed<ReceiptMeta>[]> {
  const root = await currentRoot(app.db);
  const priv = app.env.IDENTITY_ONLINE_KEY;
  const pub = app.env.IDENTITY_ONLINE_PUBLIC_KEY;
  if (!root || !priv || !pub) return [];
  const { results } = await app.db.prepare("SELECT seq, op, topic, at, consent_version FROM subscription_ops WHERE person_id=? AND op IN ('FOLLOW','UNFOLLOW','MUTE','UNMUTE') ORDER BY seq").bind(personId).all<{ seq: number; op: Op; topic: Topic | null; at: string; consent_version: number }>();
  return Promise.all(results.map((r) => signWith({ signed: { schema: "nexus.follow-receipt.v1", org: root.signed.org, person_ref: personId, seq: r.seq, op: r.op, topic: r.topic, at: r.at, consent_version: r.consent_version } as ReceiptMeta }, priv, pub)));
}

export async function verifyReceipt(doc: Signed<ReceiptMeta>, root: Signed<RootMeta>): Promise<boolean> {
  const r = doc?.signed;
  if (!r || r.schema !== "nexus.follow-receipt.v1" || r.org !== root.signed.org || !Number.isInteger(r.seq) || r.seq < 1 || !OPS.includes(r.op) || (r.topic !== null && !TOPICS.includes(r.topic)) || typeof r.person_ref !== "string") return false;
  return (await countValid(doc, root.signed.online_keys)) >= 1 || (await countValid(doc, root.signed.root_keys)) >= root.signed.threshold;
}

/**
 * Re-present receipts to this node for the logged-in person. Accepted when they name this person,
 * or — on a node that lost everything — a person this node has never seen, while the logged-in
 * person has no ops yet (they just re-verified an address here). Ops apply with their own
 * sequence numbers, so the newest op per topic wins; unfollows also re-suppress the addresses.
 */
export async function presentReceipts(app: App, personId: string, receipts: unknown[]): Promise<{ applied: number; rejected: number }> {
  const root = await currentRoot(app.db);
  if (!root || !Array.isArray(receipts)) return { applied: 0, rejected: receipts?.length ?? 0 };
  const valid: Signed<ReceiptMeta>[] = [];
  let rejected = 0;
  for (const r of receipts.slice(0, 500)) (await verifyReceipt(r as Signed<ReceiptMeta>, root)) ? valid.push(r as Signed<ReceiptMeta>) : rejected++;
  const refs = new Set(valid.map((r) => r.signed.person_ref));
  const mineOps = (await app.db.prepare("SELECT COUNT(*) AS n FROM subscription_ops WHERE person_id=?").bind(personId).first<{ n: number }>())?.n ?? 0;
  let foreignOk = false;
  if (refs.size === 1 && !refs.has(personId) && mineOps === 0) {
    const ref = [...refs][0]!;
    foreignOk = !(await app.db.prepare("SELECT 1 FROM people WHERE id=? AND removed_at IS NULL").bind(ref).first());
  }
  let applied = 0;
  for (const r of valid.sort((a, b) => a.signed.seq - b.signed.seq)) {
    if (r.signed.person_ref !== personId && !foreignOk) {
      rejected++;
      continue;
    }
    await applyOp(app.db, personId, r.signed.op, r.signed.topic, { seq: r.signed.seq, at: r.signed.at });
    applied++;
  }
  // Suppressions follow the resulting state, so an unfollow received back is enforced again.
  const topics = (await app.db.prepare("SELECT topic, status FROM follow_state WHERE person_id=?").bind(personId).all<{ topic: string; status: string }>()).results;
  const hashes = (await app.db.prepare("SELECT suppress_hash FROM delivery_registrations WHERE person_id=?").bind(personId).all<{ suppress_hash: string }>()).results;
  for (const t of topics.filter((x) => x.status === "unfollowed")) for (const h of hashes) await app.db.prepare("INSERT OR IGNORE INTO suppressions(address_hash, scope, created_at) VALUES (?,?,?)").bind(h.suppress_hash, t.topic, nowIso()).run();
  if (applied) await audit(app.db, "hydra.receipts.presented", personId, personId, { applied, rejected });
  return { applied, rejected };
}
