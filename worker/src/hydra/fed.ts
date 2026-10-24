// H6 gossip and H7 sealed relocations: heads that live at partners, so a club can be found even
// when its own node, domain and owners are all gone.
//
// Gossip: a verified relocation we learn (from the club itself, or from a partner) is forwarded
// to our other partners, up to 3 hops. Every receiver re-verifies it against the root it carries
// and against its own pin when it has one; a relay can't change a byte.
//
// Sealed relocation ("dead man's switch"): custodians pre-sign a relocation manifest. The node
// encrypts it with a random key and gives each of n designated partners one Shamir share (k of n,
// k ≥ 2) plus the ciphertext. A partner releases its share only after it has itself seen BOTH
//   (a) no owner heartbeat for `silence_days`, AND
//   (b) the primary address unreachable on 3 separate days.
// When any partner holds k shares it decrypts, verifies the manifest against its pinned root and
// relays it. No single partner, and no single owner, can trigger it.

import type { App } from "../bot";
import { notifyOwners } from "../assist/notify";
import { escapeHtml } from "../text";
import { audit, DAY, nowIso } from "../util";
import { b64, countValid, unb64, type Signed } from "../continuity/crypto";
import { currentManifest, currentRoot, verifyDestinations, verifyRoot, type DestMeta, type RootMeta } from "../continuity/identity";
import type { FedMessage } from "../federation/envelope";
import { fedEnabled, nodeId, partnerList, sendNotice, type Partner, type Received } from "../federation/gateway";
import { combine, decodeShare, encodeShare, split } from "./shamir";
import type { HeartbeatMeta } from "./notices";

export const MAX_HOPS = 3;
export const DOWN_DAYS = 3;
type Community = { root: Signed<RootMeta>; destinations: Signed<DestMeta> };

const fail = (status: number, reason: string): Received => ({ status, body: { ok: false, reason }, keys: [] });
const ok = (keys: string[] = []): Received => ({ status: 202, body: { ok: true }, keys });

export async function applyHydraNotice(app: App, p: Partner & { root_json?: string | null }, msg: FedMessage, now: Date): Promise<Received> {
  const kind = msg.body.kind;
  if (kind === "gossip") return applyGossip(app, p, msg.body, now);
  if (kind === "seal_store") return applySealStore(app, p, msg.body, now);
  if (kind === "seal_share") return applySealShare(app, p, msg.body, now);
  return fail(400, "notice_kind");
}

// ---- gossip ----------------------------------------------------------------------------------------

async function verifyCommunity(c: Community, pinned: Signed<RootMeta> | null, last: Signed<DestMeta> | null, now: Date): Promise<{ ok: boolean; reason?: string; root?: Signed<RootMeta> }> {
  let root = c.root;
  if (pinned) {
    if (c.root.signed?.version !== pinned.signed.version) {
      const v = await verifyRoot(c.root, pinned, nowIso(now));
      if (!v.ok) return { ok: false, reason: v.reason };
    } else root = pinned;
  } else {
    const v = await verifyRoot(c.root, null, nowIso(now)); // self-consistent only; flagged unpinned
    if (!v.ok) return { ok: false, reason: v.reason };
  }
  const d = await verifyDestinations(c.destinations, root, last, nowIso(now));
  if (!d.ok) return { ok: false, reason: d.reason };
  return { ok: true, root };
}

async function pinnedRootOf(db: D1Database, org: string): Promise<Signed<RootMeta> | null> {
  const r = await db.prepare("SELECT root_json FROM organizations WHERE kind='partner' AND root_json IS NOT NULL AND (id=? OR json_extract(root_json, '$.signed.org')=?)").bind(org, org).first<{ root_json: string }>();
  return r ? (JSON.parse(r.root_json) as Signed<RootMeta>) : null;
}

async function applyGossip(app: App, p: Partner, body: Record<string, unknown>, now: Date): Promise<Received> {
  const c = body.community as Community | undefined;
  const hops = Number(body.hops ?? 1);
  if (!c?.root?.signed || !c.destinations?.signed || !Number.isInteger(hops) || hops < 1 || hops > MAX_HOPS) return fail(400, "gossip_shape");
  const org = c.root.signed.org;
  const home = await currentRoot(app.db);
  if (home && org === home.signed.org) return ok(); // about us: we know better
  const pinned = await pinnedRootOf(app.db, org);
  const prev = await app.db.prepare("SELECT manifest_version, json FROM gossip_notices WHERE org=?").bind(org).first<{ manifest_version: number; json: string }>();
  const last = prev ? (JSON.parse(prev.json) as Community).destinations : null;
  if (prev && prev.manifest_version >= c.destinations.signed.version) return ok(); // already have it (or newer)
  const v = await verifyCommunity(c, pinned, last, now);
  if (!v.ok) return fail(403, v.reason!);
  await app.db
    .prepare("INSERT INTO gossip_notices(org, manifest_version, json, via, pinned, hops, received_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(org) DO UPDATE SET manifest_version=excluded.manifest_version, json=excluded.json, via=excluded.via, pinned=excluded.pinned, hops=excluded.hops, received_at=excluded.received_at WHERE excluded.manifest_version > gossip_notices.manifest_version")
    .bind(org, c.destinations.signed.version, JSON.stringify({ root: v.root, destinations: c.destinations }), p.id, pinned ? 1 : 0, hops, nowIso(now))
    .run();
  if (hops < MAX_HOPS) await gossip(app, { root: v.root!, destinations: c.destinations }, hops + 1, new Set([p.id, org]));
  return ok();
}

/** Forward a verified community document to our active partners (except `skip`). */
export async function gossip(app: App, community: Community, hops: number, skip: Set<string> = new Set()): Promise<number> {
  if (!fedEnabled(app.env)) return 0;
  let n = 0;
  const v = community.destinations.signed.version;
  for (const p of await partnerList(app.db)) {
    if (p.status !== "active" || !p.public_key || skip.has(p.id) || p.id === community.root.signed.org) continue;
    await sendNotice(app, p, `gossip-${v}`, { kind: "gossip", community, hops }, `gossip:${community.root.signed.org}:${v}:${p.id}`);
    n++;
  }
  return n;
}

export async function gossipList(db: D1Database): Promise<unknown[]> {
  const { results } = await db.prepare("SELECT org, manifest_version, json, via, pinned, hops, received_at FROM gossip_notices ORDER BY received_at DESC LIMIT 50").all<{ org: string; manifest_version: number; json: string; via: string; pinned: number; hops: number; received_at: string }>();
  return results.map((r) => ({ org: r.org, version: r.manifest_version, via: r.via, pinned: !!r.pinned, hops: r.hops, primary: (JSON.parse(r.json) as Community).destinations.signed.destinations.find((d) => d.role === "primary")?.url, community: JSON.parse(r.json) }));
}

// ---- sealed relocation: origin side ----------------------------------------------------------------

export interface SealPolicy {
  quorum: number;
  silence_days: number;
  partners: string[];
  heartbeat: string;
  primary: string;
}

/**
 * Seal a root-signed relocation for later (admin). The manifest must verify as a relocation from
 * the current address; it should expire far ahead (custodians re-seal yearly, and after a root
 * rotation). Returns how many partners got a share.
 */
export async function sealRelocation(app: App, manifest: Signed<DestMeta>, opts: { quorum: number; silenceDays: number; partners: string[] }): Promise<{ ok: boolean; reason?: string; sent?: number }> {
  const root = await currentRoot(app.db);
  const cur = await currentManifest(app.db);
  if (!root || !cur) return { ok: false, reason: "no_identity" };
  if (!fedEnabled(app.env)) return { ok: false, reason: "federation_off" };
  const v = await verifyDestinations(manifest, root, cur);
  if (!v.ok) return { ok: false, reason: v.reason };
  if (!v.relocation) return { ok: false, reason: "not_a_relocation" };
  const all = new Map((await partnerList(app.db)).filter((p) => p.status === "active" && p.public_key).map((p) => [p.id, p]));
  const partners = [...new Set(opts.partners)].filter((id) => all.has(id));
  if (partners.length < 2 || partners.length !== new Set(opts.partners).size) return { ok: false, reason: "partners_must_be_active" };
  if (!Number.isInteger(opts.quorum) || opts.quorum < 2 || opts.quorum > partners.length) return { ok: false, reason: "quorum" };
  if (!Number.isInteger(opts.silenceDays) || opts.silenceDays < 7 || opts.silenceDays > 365) return { ok: false, reason: "silence_days" };
  const origin = (app.env.PUBLIC_URL ?? "").replace(/\/$/, "");
  const policy: SealPolicy = { quorum: opts.quorum, silence_days: opts.silenceDays, partners, heartbeat: `${origin}/.well-known/nexus-heartbeat.json`, primary: cur.signed.destinations.find((d) => d.role === "primary")!.url };
  const key = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ck = await crypto.subtle.importKey("raw", key, { name: "AES-GCM" }, false, ["encrypt"]);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, ck, new TextEncoder().encode(JSON.stringify({ root, destinations: manifest })));
  const shares = split(key, partners.length, opts.quorum);
  for (let i = 0; i < partners.length; i++) {
    const p = all.get(partners[i]!)!;
    await sendNotice(app, p, `seal-${manifest.signed.version}`, { kind: "seal_store", sealed: { org: root.signed.org, version: manifest.signed.version, policy, iv: b64(iv), ct: b64(ct), share: encodeShare(shares[i]!) } }, `seal:${manifest.signed.version}:${p.id}`);
  }
  await audit(app.db, "hydra.seal", "admin", root.signed.org, { version: manifest.signed.version, partners: partners.length, quorum: opts.quorum });
  return { ok: true, sent: partners.length };
}

// ---- sealed relocation: partner side ---------------------------------------------------------------

async function applySealStore(app: App, p: Partner & { root_json?: string | null }, body: Record<string, unknown>, now: Date): Promise<Received> {
  if (!p.root_json) return fail(403, "no_pinned_root");
  const s = body.sealed as { version?: number; policy?: SealPolicy; iv?: string; ct?: string; share?: string } | undefined;
  const pol = s?.policy;
  if (!s || !Number.isInteger(s.version) || !pol || typeof s.iv !== "string" || typeof s.ct !== "string" || typeof s.share !== "string" || s.ct.length > 12_000) return fail(400, "seal_shape");
  if (!Array.isArray(pol.partners) || !pol.partners.includes(nodeId(app.env)) || !Number.isInteger(pol.quorum) || pol.quorum < 2 || pol.quorum > pol.partners.length || !Number.isInteger(pol.silence_days) || pol.silence_days < 7) return fail(400, "seal_policy");
  try {
    decodeShare(s.share);
  } catch {
    return fail(400, "seal_share");
  }
  await app.db
    .prepare("INSERT INTO sealed_held(org, version, policy, iv, ct, my_share, state, received_at) VALUES (?,?,?,?,?,?, 'held', ?) ON CONFLICT(org, version) DO NOTHING")
    .bind(p.id, s.version, JSON.stringify(pol), s.iv, s.ct, s.share, nowIso(now))
    .run();
  return ok(await notifyOwners(app, `seal:${p.id}:${s.version}`, () => ({ text: `🔐 <b>${escapeHtml(p.brand_label)}</b> left a sealed relocation with us (1 of ${pol.partners.length} shares, ${pol.quorum} needed). We can't open it alone; it opens only if they go silent for ${pol.silence_days} days and their address is down.` })));
}

async function applySealShare(app: App, p: Partner, body: Record<string, unknown>, now: Date): Promise<Received> {
  const org = String(body.org ?? "");
  const version = Number(body.version);
  const share = String(body.share ?? "");
  const held = await app.db.prepare("SELECT policy FROM sealed_held WHERE org=? AND version=?").bind(org, version).first<{ policy: string }>();
  if (!held) return fail(404, "no_seal");
  const pol = JSON.parse(held.policy) as SealPolicy;
  if (!pol.partners.includes(p.id) || p.id === org) return fail(403, "not_a_designated_partner");
  try {
    decodeShare(share);
  } catch {
    return fail(400, "seal_share");
  }
  await app.db.prepare("INSERT OR IGNORE INTO seal_shares(org, version, from_partner, share, at) VALUES (?,?,?,?,?)").bind(org, version, p.id, share, nowIso(now)).run();
  return ok(await tryRelease(app, org, version, now));
}

/** Cron (daily, ≤2 seals per run): watch heartbeat and primary; confirm and share when both fail. */
export async function watchSeals(app: App, now = new Date()): Promise<number> {
  if (!fedEnabled(app.env)) return 0;
  const today = nowIso(now).slice(0, 10);
  const { results } = await app.db
    .prepare("SELECT s.org, s.version, s.policy, s.my_share, s.last_heartbeat_at, s.down_checks, s.received_at, o.root_json FROM sealed_held s JOIN organizations o ON o.id=s.org WHERE s.state='held' AND (s.checked_at IS NULL OR substr(s.checked_at,1,10)<?) LIMIT 2")
    .bind(today)
    .all<{ org: string; version: number; policy: string; my_share: string; last_heartbeat_at: string | null; down_checks: number; received_at: string; root_json: string | null }>();
  const net = app.net ?? fetch;
  for (const s of results) {
    if (app.budget && app.budget.left() < 3 + JSON.parse(s.policy).partners.length) break;
    const pol = JSON.parse(s.policy) as SealPolicy;
    const pinned = s.root_json ? (JSON.parse(s.root_json) as Signed<RootMeta>) : null;
    let seen = s.last_heartbeat_at;
    try {
      const r = await net(pol.heartbeat, { signal: AbortSignal.timeout(8000) } as RequestInit);
      if (r.ok && pinned) {
        const hb = (await r.json()) as Signed<HeartbeatMeta>;
        if (hb?.signed?.schema === "nexus.heartbeat.v1" && hb.signed.org === pinned.signed.org && (await countValid(hb, pinned.signed.online_keys)) >= 1 && (!seen || hb.signed.owners_seen > seen)) seen = hb.signed.owners_seen;
      }
    } catch {
      /* unreachable heartbeat counts as no news */
    }
    let up = false;
    try {
      const r = await net(`${pol.primary.replace(/\/$/, "")}/.well-known/nexus-community.json`, { signal: AbortSignal.timeout(8000) } as RequestInit);
      up = r.ok;
    } catch {
      up = false;
    }
    const down = up ? 0 : s.down_checks + 1;
    const silentSince = seen ?? s.received_at;
    const silent = now.getTime() - Date.parse(silentSince) > pol.silence_days * DAY;
    const confirm = silent && down >= DOWN_DAYS;
    await app.db.prepare("UPDATE sealed_held SET last_heartbeat_at=?, down_checks=?, checked_at=?, state=CASE WHEN ? THEN 'confirmed' ELSE state END WHERE org=? AND version=?").bind(seen, down, nowIso(now), confirm ? 1 : 0, s.org, s.version).run();
    if (!confirm) continue;
    const me = nodeId(app.env);
    await app.db.prepare("INSERT OR IGNORE INTO seal_shares(org, version, from_partner, share, at) VALUES (?,?,?,?,?)").bind(s.org, s.version, me, s.my_share, nowIso(now)).run();
    const partners = new Map((await partnerList(app.db)).map((p) => [p.id, p]));
    for (const id of pol.partners) {
      const p = partners.get(id);
      if (!p || id === me || p.status !== "active" || !p.public_key) continue;
      await sendNotice(app, p, `seal-${s.version}`, { kind: "seal_share", org: s.org, version: s.version, share: s.my_share }, `sealshare:${s.org}:${s.version}:${id}`);
    }
    await audit(app.db, "hydra.seal.confirmed", "system", s.org, { version: s.version, down_days: down });
    await tryRelease(app, s.org, s.version, now);
  }
  return results.length;
}

/** With k shares: decrypt, verify against the pinned root, relay and gossip. */
async function tryRelease(app: App, org: string, version: number, now: Date): Promise<string[]> {
  const s = await app.db.prepare("SELECT s.policy, s.iv, s.ct, s.state, o.root_json, o.brand_label FROM sealed_held s JOIN organizations o ON o.id=s.org WHERE s.org=? AND s.version=?").bind(org, version).first<{ policy: string; iv: string; ct: string; state: string; root_json: string | null; brand_label: string }>();
  if (!s || s.state === "released" || !s.root_json) return [];
  const pol = JSON.parse(s.policy) as SealPolicy;
  const shares = (await app.db.prepare("SELECT from_partner, share FROM seal_shares WHERE org=? AND version=?").bind(org, version).all<{ from_partner: string; share: string }>()).results.filter((x) => pol.partners.includes(x.from_partner));
  if (shares.length < pol.quorum) return [];
  let community: Community;
  try {
    const key = combine(shares.map((x) => decodeShare(x.share)));
    const ck = await crypto.subtle.importKey("raw", key, { name: "AES-GCM" }, false, ["decrypt"]);
    community = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(s.iv) }, ck, unb64(s.ct)))) as Community;
  } catch {
    return [];
  }
  const last = await app.db.prepare("SELECT json FROM relay_notices WHERE partner_id=?").bind(org).first<{ json: string }>();
  const v = await verifyCommunity(community, JSON.parse(s.root_json) as Signed<RootMeta>, last ? (JSON.parse(last.json) as Community).destinations : null, now);
  if (!v.ok) {
    await app.db.prepare("UPDATE sealed_held SET state='void' WHERE org=? AND version=?").bind(org, version).run();
    return [];
  }
  await app.db.batch([
    app.db.prepare("UPDATE sealed_held SET state='released' WHERE org=? AND version=?").bind(org, version),
    app.db
      .prepare("INSERT INTO relay_notices(partner_id, manifest_version, json, received_at) VALUES (?,?,?,?) ON CONFLICT(partner_id) DO UPDATE SET manifest_version=excluded.manifest_version, json=excluded.json, received_at=excluded.received_at WHERE excluded.manifest_version > relay_notices.manifest_version")
      .bind(org, community.destinations.signed.version, JSON.stringify({ root: v.root, destinations: community.destinations }), nowIso(now)),
  ]);
  await audit(app.db, "hydra.seal.released", "system", org, { version, shares: shares.length });
  await gossip(app, { root: v.root!, destinations: community.destinations }, 1, new Set([org]));
  const primary = community.destinations.signed.destinations.find((d) => d.role === "primary")!.url;
  return notifyOwners(app, `sealrel:${org}:${version}`, () => ({ text: `🔓 <b>${escapeHtml(s.brand_label)}</b> went silent and offline; ${shares.length} partners confirmed it, so their sealed relocation opened: ${escapeHtml(primary)} (verified with their club key). We relay it.` }));
}
