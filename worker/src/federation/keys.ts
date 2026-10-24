// Partner key rotation (P14-12). A node announces a new key in its manifest together with a
// proof signed by its old key. We accept the new key only if that proof verifies against the key
// we already trust; the old key stays valid for ROTATION_GRACE_DAYS. Fetching the manifest over
// https alone is never enough to change a key.

import type { App } from "../bot";
import { audit, DAY, nowIso } from "../util";
import { canonical } from "./envelope";
import type { Partner } from "./gateway";

export const ROTATION_GRACE_DAYS = 7;
export const REFRESH_MIN_INTERVAL_MS = 10 * 60_000;

export interface RotationProof {
  schema: "nexus.rotation.v1";
  node_id: string;
  old_key: string;
  new_key: string;
  issued_at: string;
  signature: string;
}

const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function verifyRotation(p: unknown, trustedKey: string, nodeId: string): Promise<boolean> {
  if (!p || typeof p !== "object") return false;
  const r = p as RotationProof;
  if (r.schema !== "nexus.rotation.v1" || r.node_id !== nodeId || r.old_key !== trustedKey || typeof r.new_key !== "string" || r.new_key === r.old_key) return false;
  try {
    if (unb64(r.new_key).length !== 32) return false;
    const key = await crypto.subtle.importKey("raw", unb64(trustedKey), { name: "Ed25519" }, false, ["verify"]);
    const { signature, ...rest } = r;
    return await crypto.subtle.verify({ name: "Ed25519" }, key, unb64(signature), new TextEncoder().encode(canonical(rest)));
  } catch {
    return false;
  }
}

export async function applyRotation(db: D1Database, partnerId: string, proof: RotationProof, by: string, now = new Date()): Promise<void> {
  await db
    .prepare("UPDATE organizations SET prev_public_key=public_key, prev_valid_until=?, public_key=? WHERE id=? AND public_key=?")
    .bind(nowIso(new Date(now.getTime() + ROTATION_GRACE_DAYS * DAY)), proof.new_key, partnerId, proof.old_key)
    .run();
  await audit(db, "partner.key_rotated", by, partnerId);
}

export type RefreshResult = "unchanged" | "rotated" | "mismatch" | "unreachable" | "manual" | "skipped";

/** Read a partner's manifest and adopt a properly proven new key. */
export async function refreshPartner(app: App, p: Partner & { manifest_checked_at?: string | null }, now = new Date(), force = false): Promise<RefreshResult> {
  if (!p.endpoint || !p.public_key) return "manual";
  if (!force && p.manifest_checked_at && now.getTime() - Date.parse(p.manifest_checked_at) < REFRESH_MIN_INTERVAL_MS) return "skipped";
  await app.db.prepare("UPDATE organizations SET manifest_checked_at=? WHERE id=?").bind(nowIso(now), p.id).run();
  let man: { node_id?: string; public_keys?: { key?: string }[]; key_rotation?: unknown };
  try {
    const res = await (app.net ?? fetch)(`${p.endpoint}/.well-known/nexus-node.json`, { method: "GET", signal: AbortSignal.timeout(5000) } as RequestInit);
    if (!res.ok) return "unreachable";
    man = await res.json();
  } catch {
    return "unreachable";
  }
  const key = man.public_keys?.[0]?.key;
  if (key === p.public_key) return "unchanged";
  if (key && (await verifyRotation(man.key_rotation, p.public_key, p.id)) && (man.key_rotation as RotationProof).new_key === key) {
    await applyRotation(app.db, p.id, man.key_rotation as RotationProof, "manifest", now);
    return "rotated";
  }
  return "mismatch";
}

/** Keys to try for a partner right now: current, then the previous one during its grace period. */
export function partnerKeys(p: { public_key: string | null; prev_public_key?: string | null; prev_valid_until?: string | null }, now = nowIso()): string[] {
  const keys = p.public_key ? [p.public_key] : [];
  if (p.prev_public_key && p.prev_valid_until && p.prev_valid_until > now) keys.push(p.prev_public_key);
  return keys;
}
