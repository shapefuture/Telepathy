// CONT-1: verifiable community identity (TUF-style, plan §3 "TUF", "DNS").
//   root metadata   — custodian keys + threshold + delegated online keys; signed offline by a
//                     threshold of root keys; a new root must be signed by a threshold of the OLD
//                     root keys too (so a stolen online key can't replace the root)
//   destinations    — official addresses (web, telegram, rss, matrix…), signed by an online key;
//                     versions only go up, documents expire; moving the PRIMARY address requires
//                     root signatures (a "relocation"), never just the online key.
// Clients, partners and the relay pin the root and apply exactly these rules.

import type { App } from "../bot";
import { audit, DAY, nowIso } from "../util";
import { countValid, keyId, signWith, type PubKey, type Signed } from "./crypto";

export interface RootMeta {
  schema: "nexus.root.v1";
  org: string;
  version: number;
  expires: string;
  root_keys: PubKey[];
  threshold: number;
  online_keys: PubKey[];
}
export type DestKind = "web" | "telegram" | "rss" | "matrix" | "email_list" | "portal";
export interface Destination {
  kind: DestKind;
  url: string;
  role: "primary" | "backup";
}
export interface DestMeta {
  schema: "nexus.destinations.v1";
  org: string;
  version: number;
  root_version: number;
  expires: string;
  destinations: Destination[];
  relocation?: { from: string; to: string; reason: string };
}

export const MANIFEST_TTL_DAYS = 30;
export const KINDS: DestKind[] = ["web", "telegram", "rss", "matrix", "email_list", "portal"];

export type Verdict = { ok: true } | { ok: false; reason: string };
const bad = (reason: string): Verdict => ({ ok: false, reason });

function shapeRoot(r: unknown): r is RootMeta {
  const x = r as RootMeta;
  return (
    !!x &&
    x.schema === "nexus.root.v1" &&
    typeof x.org === "string" &&
    Number.isInteger(x.version) &&
    x.version >= 1 &&
    typeof x.expires === "string" &&
    Array.isArray(x.root_keys) &&
    Array.isArray(x.online_keys) &&
    Number.isInteger(x.threshold) &&
    x.threshold >= 1 &&
    x.threshold <= x.root_keys.length
  );
}

async function keysWellFormed(keys: PubKey[]): Promise<boolean> {
  for (const k of keys) if (typeof k.key !== "string" || k.keyid !== (await keyId(k.key))) return false;
  return true;
}

/** Verify a root on its own (first pin, trust-on-first-use by an operator) or as an update of `trusted`. */
export async function verifyRoot(doc: Signed<RootMeta>, trusted: Signed<RootMeta> | null, now = nowIso()): Promise<Verdict> {
  if (!doc || !shapeRoot(doc.signed)) return bad("root_shape");
  const r = doc.signed;
  if (!(await keysWellFormed(r.root_keys)) || !(await keysWellFormed(r.online_keys))) return bad("root_keyid");
  if (r.expires <= now) return bad("root_expired");
  if ((await countValid(doc, r.root_keys)) < r.threshold) return bad("root_threshold");
  if (trusted) {
    const t = trusted.signed;
    if (r.org !== t.org) return bad("root_org");
    if (r.version < t.version) return bad("root_rollback");
    if (r.version === t.version) return JSON.stringify(r) === JSON.stringify(t) ? { ok: true } : bad("root_fork");
    if (r.version !== t.version + 1) return bad("root_skip"); // apply rotations one at a time
    if ((await countValid(doc, t.root_keys)) < t.threshold) return bad("root_not_authorized_by_previous");
  }
  return { ok: true };
}

const primaryOf = (d: DestMeta | null) => d?.destinations.find((x) => x.role === "primary")?.url ?? null;

function shapeDest(d: unknown): d is DestMeta {
  const x = d as DestMeta;
  if (!x || x.schema !== "nexus.destinations.v1" || typeof x.org !== "string" || !Number.isInteger(x.version) || x.version < 1 || !Array.isArray(x.destinations)) return false;
  if (x.destinations.length > 20 || x.destinations.filter((y) => y.role === "primary").length !== 1) return false;
  return x.destinations.every((y) => KINDS.includes(y.kind) && (y.role === "primary" || y.role === "backup") && typeof y.url === "string" && /^(https:\/\/|tg:\/\/)[^\s]{3,300}$/.test(y.url));
}

/**
 * Verify a destinations manifest against the pinned root and the last version this verifier
 * accepted. A changed primary address needs `threshold` root signatures and a matching
 * `relocation` record; otherwise one online-key signature suffices.
 */
export async function verifyDestinations(doc: Signed<DestMeta>, root: Signed<RootMeta>, last: Signed<DestMeta> | null, now = nowIso()): Promise<Verdict & { relocation?: boolean }> {
  if (!doc || !shapeDest(doc.signed)) return bad("dest_shape");
  const d = doc.signed;
  const r = root.signed;
  if (d.org !== r.org) return bad("dest_org");
  if (d.root_version !== r.version) return bad("dest_root_version");
  if (d.expires <= now) return bad("dest_expired");
  if (last) {
    if (d.version < last.signed.version) return bad("dest_rollback");
    if (d.version === last.signed.version) return JSON.stringify(d) === JSON.stringify(last.signed) ? { ok: true } : bad("dest_fork");
  }
  const moved = !!last && primaryOf(d) !== primaryOf(last.signed);
  if (moved || d.relocation) {
    if (!d.relocation || d.relocation.to !== primaryOf(d) || (last && d.relocation.from !== primaryOf(last.signed))) return bad("relocation_record");
    if ((await countValid(doc, r.root_keys)) < r.threshold) return bad("relocation_needs_root");
    return { ok: true, relocation: true };
  }
  if ((await countValid(doc, r.online_keys)) < 1 && (await countValid(doc, r.root_keys)) < r.threshold) return bad("dest_signature");
  return { ok: true, relocation: false };
}

// ---- storage on this node --------------------------------------------------------------------

export async function currentRoot(db: D1Database): Promise<Signed<RootMeta> | null> {
  const r = await db.prepare("SELECT root_json FROM community_identity WHERE org_id='home'").first<{ root_json: string }>();
  return r ? (JSON.parse(r.root_json) as Signed<RootMeta>) : null;
}

export async function currentManifest(db: D1Database): Promise<Signed<DestMeta> | null> {
  const r = await db.prepare("SELECT json FROM destination_manifests ORDER BY version DESC LIMIT 1").first<{ json: string }>();
  return r ? (JSON.parse(r.json) as Signed<DestMeta>) : null;
}

/** Install or rotate the root (admin endpoint). */
export async function installRoot(db: D1Database, doc: Signed<RootMeta>, by: string): Promise<Verdict> {
  const trusted = await currentRoot(db);
  const v = await verifyRoot(doc, trusted);
  if (!v.ok) return v;
  await db
    .prepare("INSERT INTO community_identity(org_id, stable_id, root_json, root_version, updated_at) VALUES ('home',?,?,?,?) ON CONFLICT(org_id) DO UPDATE SET root_json=excluded.root_json, root_version=excluded.root_version, updated_at=excluded.updated_at")
    .bind(doc.signed.org, JSON.stringify(doc), doc.signed.version, nowIso())
    .run();
  await audit(db, "identity.root", by, doc.signed.org, { version: doc.signed.version });
  return v;
}

/** Store a manifest after full verification. */
export async function installManifest(db: D1Database, doc: Signed<DestMeta>, by: string): Promise<Verdict & { relocation?: boolean }> {
  const root = await currentRoot(db);
  if (!root) return bad("no_root");
  const v = await verifyDestinations(doc, root, await currentManifest(db));
  if (!v.ok) return v;
  await db.prepare("INSERT OR IGNORE INTO destination_manifests(version, json, relocation, published_at) VALUES (?,?,?,?)").bind(doc.signed.version, JSON.stringify(doc), v.relocation ? 1 : 0, nowIso()).run();
  await audit(db, v.relocation ? "identity.relocation" : "identity.destinations", by, doc.signed.org, { version: doc.signed.version });
  return v;
}

/**
 * Online-key edit (owner command): add or remove BACKUP destinations, or just re-sign to extend
 * expiry. Changing the primary is refused here; that needs a root-signed relocation.
 */
export async function editBackups(app: App, change: { add?: Destination; removeUrl?: string } | null, by: string, now = new Date()): Promise<Verdict & { version?: number }> {
  const root = await currentRoot(app.db);
  const priv = app.env.IDENTITY_ONLINE_KEY;
  const pub = app.env.IDENTITY_ONLINE_PUBLIC_KEY;
  if (!root || !priv || !pub) return bad("not_configured");
  if (!root.signed.online_keys.some((k) => k.key === pub)) return bad("online_key_not_delegated");
  const last = await currentManifest(app.db);
  if (!last) return bad("no_manifest");
  let dests = last.signed.destinations.slice();
  if (change?.add) {
    if (change.add.role !== "backup") return bad("primary_needs_relocation");
    dests = dests.filter((d) => d.url !== change.add!.url).concat(change.add);
  }
  if (change?.removeUrl) {
    if (dests.find((d) => d.url === change.removeUrl)?.role === "primary") return bad("primary_needs_relocation");
    dests = dests.filter((d) => d.url !== change.removeUrl);
  }
  const next: DestMeta = { ...last.signed, version: last.signed.version + 1, root_version: root.signed.version, expires: nowIso(new Date(now.getTime() + MANIFEST_TTL_DAYS * DAY)), destinations: dests };
  delete next.relocation;
  const signed = await signWith({ signed: next }, priv, pub);
  const v = await installManifest(app.db, signed, by);
  return v.ok ? { ...v, version: next.version } : v;
}

/** Public document clients pin and check: root + current manifest (+ alias claims). */
export async function publicIdentity(db: D1Database): Promise<Record<string, unknown> | null> {
  const root = await currentRoot(db);
  if (!root) return null;
  return { schema: "nexus.community.v1", root, destinations: await currentManifest(db) };
}
