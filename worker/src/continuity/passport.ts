// CONT-7: Club Passport. A member can hand a partner a short-lived, signed proof of
// "current member of club X, tier T", addressed to that partner only, under a pairwise pseudonym.
// The partner verifies it against the club's pinned root; it learns nothing else and receives no
// member list. Revocation is checkable without personal data.

import type { App } from "../bot";
import { DAY, nowIso } from "../util";
import { countValid, hmacHex, signWith, type Signed } from "./crypto";
import { currentRoot, type RootMeta } from "./identity";
import { activeAttestations } from "./people";

export const PASS_TTL_DAYS = 7;

export interface PassClaim {
  schema: "nexus.attestation.v1";
  id: string; // attestation id (random), for revocation checks
  org: string;
  audience: string; // the partner node this pass is for
  subject: string; // pairwise pseudonym: same person + same partner = same value; nothing else links
  tier: string;
  scope: string;
  issued_at: string;
  expires_at: string;
}

export async function issuePass(app: App, personId: string, audience: string, now = new Date()): Promise<Signed<PassClaim> | null> {
  const root = await currentRoot(app.db);
  if (!root || !app.env.IDENTITY_ONLINE_KEY || !app.env.IDENTITY_ONLINE_PUBLIC_KEY) return null;
  const att = (await activeAttestations(app.db, personId, nowIso(now)))[0];
  if (!att) return null;
  const exp = Math.min(Date.parse(att.expires_at), now.getTime() + PASS_TTL_DAYS * DAY);
  const claim: PassClaim = {
    schema: "nexus.attestation.v1",
    id: att.id,
    org: root.signed.org,
    audience,
    subject: (await hmacHex(app.env.CONTINUITY_KEY, "pairwise", `${personId}|${audience}`)).slice(0, 32),
    tier: att.tier,
    scope: att.scope,
    issued_at: nowIso(now),
    expires_at: nowIso(new Date(exp)),
  };
  return signWith({ signed: claim }, app.env.IDENTITY_ONLINE_KEY, app.env.IDENTITY_ONLINE_PUBLIC_KEY);
}

/** Partner-side check against the issuing club's pinned root. */
export async function verifyPass(pass: Signed<PassClaim>, issuerRoot: Signed<RootMeta>, me: string, now = nowIso()): Promise<{ ok: boolean; reason?: string; claim?: PassClaim }> {
  const c = pass?.signed;
  if (!c || c.schema !== "nexus.attestation.v1") return { ok: false, reason: "shape" };
  if (c.org !== issuerRoot.signed.org) return { ok: false, reason: "org" };
  if (c.audience !== me) return { ok: false, reason: "audience" };
  if (c.expires_at <= now) return { ok: false, reason: "expired" };
  if ((await countValid(pass, issuerRoot.signed.online_keys)) < 1) return { ok: false, reason: "signature" };
  return { ok: true, claim: c };
}

export async function attestationStatus(db: D1Database, id: string, now = nowIso()): Promise<"active" | "revoked" | "expired" | "unknown"> {
  const r = await db.prepare("SELECT status, expires_at FROM membership_attestations WHERE id=?").bind(id).first<{ status: string; expires_at: string }>();
  if (!r) return "unknown";
  if (r.status === "revoked") return "revoked";
  return r.expires_at <= now ? "expired" : "active";
}

