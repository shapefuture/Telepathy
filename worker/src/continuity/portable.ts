// CONT-5: portable relationships. The club exports the relationships people chose to keep
// (verified addresses, follow ops, memberships, tombstones), signed by its online key, and any
// compatible install that pins the same root can import them. No passages, no chat text, no
// Telegram ids. Import never lets an older state override a newer one (plan §7 flow D).

import type { App } from "../bot";
import { audit, newId, nowIso } from "../util";
import { countValid, open, seal, signWith, type Signed } from "./crypto";
import { currentManifest, currentRoot } from "./identity";
import { addressHash, applyOp, suppressHash, type Op, type Topic } from "./people";

export interface ExportPerson {
  ref: string;
  emails: string[];
  ops: { seq: number; op: Op; topic: Topic | null; at: string }[];
  memberships: { tier: string; scope: string; basis: string; status: string; issued_at: string; expires_at: string }[];
}
export interface ExportDoc {
  schema: "nexus.continuity-export.v1";
  org: string;
  generated_at: string;
  root_version: number;
  manifest_version: number | null;
  people: ExportPerson[];
  suppressions: { hash: string; scope: string }[];
}

export class PortableError extends Error {}

export async function exportBundle(app: App): Promise<Signed<ExportDoc>> {
  const root = await currentRoot(app.db);
  if (!root || !app.env.IDENTITY_ONLINE_KEY || !app.env.IDENTITY_ONLINE_PUBLIC_KEY) throw new PortableError("identity_not_configured");
  const { results: people } = await app.db.prepare("SELECT id FROM people WHERE removed_at IS NULL ORDER BY created_at").all<{ id: string }>();
  const out: ExportPerson[] = [];
  for (const { id } of people) {
    const regs = (await app.db.prepare("SELECT address_enc FROM delivery_registrations WHERE person_id=? AND channel='email' AND status='verified'").bind(id).all<{ address_enc: string }>()).results;
    const ops = (await app.db.prepare("SELECT seq, op, topic, at FROM subscription_ops WHERE person_id=? ORDER BY seq").bind(id).all<{ seq: number; op: Op; topic: Topic | null; at: string }>()).results;
    const memberships = (await app.db.prepare("SELECT tier, scope, basis, status, issued_at, expires_at FROM membership_attestations WHERE person_id=?").bind(id).all<ExportPerson["memberships"][number]>()).results;
    // Only people who can still be reached independently are worth carrying over.
    if (!regs.length) continue;
    out.push({ ref: id, emails: await Promise.all(regs.map((r) => open(app.env.CONTINUITY_KEY, r.address_enc))), ops, memberships });
  }
  const sup = (await app.db.prepare("SELECT address_hash AS hash, scope FROM suppressions ORDER BY address_hash, scope").all<{ hash: string; scope: string }>()).results;
  const m = await currentManifest(app.db);
  const doc: ExportDoc = { schema: "nexus.continuity-export.v1", org: root.signed.org, generated_at: nowIso(), root_version: root.signed.version, manifest_version: m?.signed.version ?? null, people: out, suppressions: sup };
  await audit(app.db, "continuity.export", "admin", root.signed.org, { people: out.length });
  return signWith({ signed: doc }, app.env.IDENTITY_ONLINE_KEY, app.env.IDENTITY_ONLINE_PUBLIC_KEY);
}

/**
 * Import into this install. The bundle must be signed by an online key (or root threshold) of the
 * root pinned here, for the same org. People are matched by verified email; ops keep their
 * original sequence numbers, so whichever import runs last, the newest op per topic wins and
 * tombstones only accumulate.
 */
export async function importBundle(app: App, bundle: Signed<ExportDoc>, by: string): Promise<{ people: number; ops: number; suppressions: number }> {
  const root = await currentRoot(app.db);
  if (!root) throw new PortableError("no_root");
  const d = bundle?.signed;
  if (!d || d.schema !== "nexus.continuity-export.v1" || d.org !== root.signed.org || !Array.isArray(d.people) || !Array.isArray(d.suppressions)) throw new PortableError("bundle_shape");
  const ok = (await countValid(bundle, root.signed.online_keys)) >= 1 || (await countValid(bundle, root.signed.root_keys)) >= root.signed.threshold;
  if (!ok) throw new PortableError("bundle_signature");
  let people = 0;
  let ops = 0;
  for (const s of d.suppressions) if (/^[0-9a-f]{64}$/.test(s.hash) && typeof s.scope === "string") await app.db.prepare("INSERT OR IGNORE INTO suppressions(address_hash, scope, created_at) VALUES (?,?,?)").bind(s.hash, s.scope.slice(0, 40), nowIso()).run();
  for (const p of d.people) {
    let personId: string | null = null;
    for (const e of p.emails) {
      const r = await app.db.prepare("SELECT person_id FROM delivery_registrations WHERE channel='email' AND address_hash=?").bind(await addressHash(app.env, "email", e)).first<{ person_id: string }>();
      if (r) personId = r.person_id;
    }
    if (!personId) {
      personId = newId();
      await app.db.prepare("INSERT INTO people(id, created_at) VALUES (?,?)").bind(personId, nowIso()).run();
      people++;
    }
    for (const e of p.emails) {
      await app.db
        .prepare("INSERT OR IGNORE INTO delivery_registrations(id, person_id, channel, address_enc, address_hash, suppress_hash, status, verified_at, created_at) VALUES (?,?,'email',?,?,?,'verified',?,?)")
        .bind(newId(), personId, await seal(app.env.CONTINUITY_KEY, e), await addressHash(app.env, "email", e), await suppressHash("email", e), nowIso(), nowIso())
        .run();
    }
    for (const o of p.ops) {
      if (!Number.isInteger(o.seq) || o.seq < 1) continue;
      await applyOp(app.db, personId, o.op, o.topic, { seq: o.seq, at: o.at });
      ops++;
    }
    for (const mm of p.memberships) {
      if (mm.status !== "active") continue;
      await app.db
        .prepare("INSERT INTO membership_attestations(id, person_id, tier, scope, status, basis, issued_at, expires_at) SELECT ?,?,?,?, 'active', ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM membership_attestations WHERE person_id=? AND tier=? AND status='active')")
        .bind(newId(), personId, mm.tier, mm.scope, mm.basis, mm.issued_at, mm.expires_at, personId, mm.tier)
        .run();
    }
  }
  await audit(app.db, "continuity.import", by, d.org, { people, ops, suppressions: d.suppressions.length });
  return { people, ops, suppressions: d.suppressions.length };
}
