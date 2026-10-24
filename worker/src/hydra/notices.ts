// H1/H6/H7: signed public notices and the places they travel.
//   /notices.json  signed notices (verify against the pinned root, like the address list)
//   /feed.xml      Atom feed: pull-only, survives any push block
//   /notices.ics   the same notices as a calendar (already in people's calendars)
//   /.well-known/nexus-anchor.txt     one-line anchor: root key ids + manifest hash + primary
//   /.well-known/nexus-heartbeat.json signed "owners last seen" (sealed relocations watch it)
// Public material only: notices are what the club chose to publish, never member data.

import type { App } from "../bot";
import { escapeHtml } from "../text";
import { audit, DAY, nowIso } from "../util";
import { canonical } from "../federation/envelope";
import { countValid, signWith, type Signed } from "../continuity/crypto";
import { currentManifest, currentRoot, type DestMeta, type RootMeta, type Verdict } from "../continuity/identity";
import { b64u } from "./webpush";

export type NoticeKind = "notice" | "incident" | "relocation" | "anchor";
export interface NoticeMeta {
  schema: "nexus.notice.v1";
  org: string;
  seq: number;
  kind: NoticeKind;
  title: string;
  body: string;
  issued_at: string;
  manifest_version: number | null;
  primary: string | null;
}
export interface HeartbeatMeta {
  schema: "nexus.heartbeat.v1";
  org: string;
  owners_seen: string;
  issued_at: string;
}

const origin = (app: App) => (app.env.PUBLIC_URL ?? "").replace(/\/$/, "");

export async function publishNotice(app: App, kind: NoticeKind, title: string, body: string, by: string): Promise<Signed<NoticeMeta> | null> {
  const root = await currentRoot(app.db);
  const priv = app.env.IDENTITY_ONLINE_KEY;
  const pub = app.env.IDENTITY_ONLINE_PUBLIC_KEY;
  if (!root || !priv || !pub) return null;
  const m = await currentManifest(app.db);
  for (let attempt = 0; attempt < 2; attempt++) {
    const seq = ((await app.db.prepare("SELECT COALESCE(MAX(seq),0)+1 AS s FROM public_notices").first<{ s: number }>())?.s ?? 1) + attempt;
    const meta: NoticeMeta = { schema: "nexus.notice.v1", org: root.signed.org, seq, kind, title: title.trim().slice(0, 140), body: body.trim().slice(0, 2000), issued_at: nowIso(), manifest_version: m?.signed.version ?? null, primary: m?.signed.destinations.find((d) => d.role === "primary")?.url ?? null };
    const doc = await signWith({ signed: meta }, priv, pub);
    const r = await app.db.prepare("INSERT OR IGNORE INTO public_notices(seq, kind, json, created_at) VALUES (?,?,?,?) RETURNING seq").bind(seq, kind, JSON.stringify(doc), meta.issued_at).first();
    if (!r) continue;
    const targets = announceTargets(app, kind);
    if (targets.length) await app.db.batch(targets.map((t) => app.db.prepare("INSERT OR IGNORE INTO announce_outbox(notice_seq, target, state, updated_at) VALUES (?,?, 'pending', ?)").bind(seq, t, meta.issued_at)));
    await audit(app.db, `hydra.notice.${kind}`, by, String(seq), { targets: targets.length });
    return doc;
  }
  return null;
}

function announceTargets(app: App, kind: NoticeKind): string[] {
  const t: string[] = [];
  if (app.env.MASTODON_URL && app.env.MASTODON_TOKEN) t.push("mastodon");
  if (app.env.BLUESKY_HANDLE && app.env.BLUESKY_APP_PASSWORD) t.push("bluesky");
  if (app.env.ARCHIVE_ANCHOR === "true" && (kind === "relocation" || kind === "anchor")) t.push("archive");
  return t;
}

export async function verifyNotice(doc: Signed<NoticeMeta>, root: Signed<RootMeta>): Promise<Verdict> {
  const n = doc?.signed;
  if (!n || n.schema !== "nexus.notice.v1" || !Number.isInteger(n.seq) || typeof n.title !== "string" || typeof n.body !== "string") return { ok: false, reason: "notice_shape" };
  if (n.org !== root.signed.org) return { ok: false, reason: "notice_org" };
  if ((await countValid(doc, root.signed.online_keys)) < 1 && (await countValid(doc, root.signed.root_keys)) < root.signed.threshold) return { ok: false, reason: "notice_signature" };
  return { ok: true };
}

export async function latestNotices(db: D1Database, limit = 50): Promise<Signed<NoticeMeta>[]> {
  return (await db.prepare("SELECT json FROM public_notices ORDER BY seq DESC LIMIT ?").bind(limit).all<{ json: string }>()).results.map((r) => JSON.parse(r.json) as Signed<NoticeMeta>);
}

const xml = (s: string) => escapeHtml(s).replaceAll('"', "&quot;");
const ics = (s: string) => s.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\r?\n/g, "\\n");
const icsDate = (iso: string) => iso.replace(/[-:]/g, "").replace(/\.\d+/, "");

/** Public feed routes. Returns null when the path isn't one of them. */
export async function handleFeeds(req: Request, app: App): Promise<Response | null> {
  const p = new URL(req.url).pathname;
  if (req.method !== "GET") return null;
  const pub = { "access-control-allow-origin": "*", "cache-control": "max-age=300" };
  if (p === "/notices.json") {
    const root = await currentRoot(app.db);
    if (!root) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify({ schema: "nexus.notices.v1", org: root.signed.org, notices: await latestNotices(app.db) }), { headers: { "content-type": "application/json", ...pub } });
  }
  if (p === "/feed.xml") {
    const root = await currentRoot(app.db);
    if (!root) return new Response("not found", { status: 404 });
    const o = origin(app);
    const items = await latestNotices(app.db, 30);
    const label = app.env.COMMUNITY_LABEL || root.signed.org;
    const body = `<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom"><title>${xml(label)}: official notices</title><id>${xml(`${o}/feed.xml`)}</id><updated>${items[0]?.signed.issued_at ?? nowIso()}</updated><link rel="self" href="${xml(`${o}/feed.xml`)}"/>` +
      items.map((n) => `<entry><id>${xml(`${o}/notices.json#${n.signed.seq}`)}</id><title>${xml(n.signed.title)}</title><updated>${n.signed.issued_at}</updated><content type="text">${xml(`${n.signed.body}\n\nSigned notice #${n.signed.seq}; verify at ${o}/notices.json against the club key (${o}/.well-known/nexus-community.json).`)}</content></entry>`).join("") +
      "</feed>";
    return new Response(body, { headers: { "content-type": "application/atom+xml; charset=utf-8", ...pub } });
  }
  if (p === "/notices.ics") {
    const root = await currentRoot(app.db);
    if (!root) return new Response("not found", { status: 404 });
    const items = await latestNotices(app.db, 30);
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", `PRODID:-//nexus//${root.signed.org}//EN`, `X-WR-CALNAME:${ics(app.env.COMMUNITY_LABEL || root.signed.org)} notices`];
    for (const n of items) lines.push("BEGIN:VEVENT", `UID:notice-${n.signed.seq}@${root.signed.org}`, `DTSTAMP:${icsDate(n.signed.issued_at)}`, `DTSTART:${icsDate(n.signed.issued_at)}`, `SUMMARY:${ics(n.signed.title)}`, `DESCRIPTION:${ics(n.signed.body)}`, "END:VEVENT");
    lines.push("END:VCALENDAR");
    return new Response(lines.join("\r\n") + "\r\n", { headers: { "content-type": "text/calendar; charset=utf-8", ...pub } });
  }
  if (p === "/.well-known/nexus-anchor.txt") {
    const rec = await anchorRecord(app.db);
    return rec ? new Response(rec + "\n", { headers: { "content-type": "text/plain; charset=utf-8", ...pub } }) : new Response("not found", { status: 404 });
  }
  if (p === "/.well-known/nexus-heartbeat.json") {
    const hb = await heartbeat(app);
    return hb ? new Response(JSON.stringify(hb), { headers: { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "max-age=60" } }) : new Response("not found", { status: 404 });
  }
  return null;
}

// ---- H6 anchors: a short record any public place can carry --------------------------------------

export async function manifestHash(m: Signed<DestMeta>): Promise<string> {
  return b64u(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(m.signed))));
}

/** `nexus1 org=… root=<v>:<keyid,…>/<threshold> man=<v>:<sha256> primary=<url>` */
export async function anchorRecord(db: D1Database): Promise<string | null> {
  const root = await currentRoot(db);
  const m = await currentManifest(db);
  if (!root || !m) return null;
  const r = root.signed;
  const primary = m.signed.destinations.find((d) => d.role === "primary")!.url;
  return `nexus1 org=${r.org} root=${r.version}:${r.root_keys.map((k) => k.keyid).sort().join(",")}/${r.threshold} man=${m.signed.version}:${await manifestHash(m)} primary=${primary}`;
}

export function parseAnchor(rec: string): Record<string, string> | null {
  const parts = rec.trim().split(/\s+/);
  if (parts[0] !== "nexus1") return null;
  return Object.fromEntries(parts.slice(1).map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)]));
}

/** Does this anchor vouch for exactly this root and manifest? (The manifest still needs verifyDestinations.) */
export async function checkAnchor(rec: string, root: Signed<RootMeta>, m: Signed<DestMeta>): Promise<Verdict> {
  const a = parseAnchor(rec);
  if (!a) return { ok: false, reason: "anchor_shape" };
  const r = root.signed;
  if (a.org !== r.org) return { ok: false, reason: "anchor_org" };
  if (a.root !== `${r.version}:${r.root_keys.map((k) => k.keyid).sort().join(",")}/${r.threshold}`) return { ok: false, reason: "anchor_root" };
  if (a.man !== `${m.signed.version}:${await manifestHash(m)}`) return { ok: false, reason: "anchor_manifest" };
  if (a.primary !== m.signed.destinations.find((d) => d.role === "primary")?.url) return { ok: false, reason: "anchor_primary" };
  return { ok: true };
}

// ---- H7 heartbeat: proof the owners are still around ---------------------------------------------

/** Record owner activity (at most one write a day). */
export async function touchOwners(db: D1Database, now = new Date()): Promise<void> {
  const day = nowIso(now).slice(0, 10);
  await db.prepare("INSERT INTO settings(key, value) VALUES ('hydra.owners_seen', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE substr(settings.value,1,10) < substr(excluded.value,1,10)").bind(day).run();
}

export async function heartbeat(app: App): Promise<Signed<HeartbeatMeta> | null> {
  const root = await currentRoot(app.db);
  if (!root || !app.env.IDENTITY_ONLINE_KEY || !app.env.IDENTITY_ONLINE_PUBLIC_KEY) return null;
  const seen = (await app.db.prepare("SELECT value FROM settings WHERE key='hydra.owners_seen'").first<{ value: string }>())?.value ?? nowIso(new Date(Date.now() - 365 * DAY)).slice(0, 10);
  return signWith({ signed: { schema: "nexus.heartbeat.v1", org: root.signed.org, owners_seen: seen, issued_at: nowIso() } as HeartbeatMeta }, app.env.IDENTITY_ONLINE_KEY, app.env.IDENTITY_ONLINE_PUBLIC_KEY);
}

// ---- announcers (cron) ---------------------------------------------------------------------------

export async function dispatchAnnouncements(app: App, budget = 2): Promise<number> {
  const { results } = await app.db.prepare("SELECT o.notice_seq, o.target, o.attempts, n.json FROM announce_outbox o JOIN public_notices n ON n.seq=o.notice_seq WHERE o.state='pending' ORDER BY o.notice_seq LIMIT ?").bind(budget).all<{ notice_seq: number; target: string; attempts: number; json: string }>();
  const net = app.net ?? fetch;
  const o = origin(app);
  let n = 0;
  for (const r of results) {
    if (app.budget && app.budget.left() < 3) break;
    const doc = JSON.parse(r.json) as Signed<NoticeMeta>;
    const text = `${doc.signed.title}\n${doc.signed.body}`.slice(0, 220) + (o ? `\nVerify: ${o}/notices.json #${doc.signed.seq}` : "");
    let ok = false;
    try {
      if (r.target === "mastodon") {
        const res = await net(`${app.env.MASTODON_URL!.replace(/\/$/, "")}/api/v1/statuses`, { method: "POST", headers: { authorization: `Bearer ${app.env.MASTODON_TOKEN}`, "content-type": "application/json", "idempotency-key": `notice-${doc.signed.org}-${doc.signed.seq}` }, body: JSON.stringify({ status: text, visibility: "public" }), signal: AbortSignal.timeout(8000) });
        ok = res.ok;
      } else if (r.target === "bluesky") {
        const pds = (app.env.BLUESKY_PDS || "https://bsky.social").replace(/\/$/, "");
        const s = await net(`${pds}/xrpc/com.atproto.server.createSession`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identifier: app.env.BLUESKY_HANDLE, password: app.env.BLUESKY_APP_PASSWORD }), signal: AbortSignal.timeout(8000) });
        if (s.ok) {
          const { accessJwt, did } = (await s.json()) as { accessJwt: string; did: string };
          const res = await net(`${pds}/xrpc/com.atproto.repo.createRecord`, { method: "POST", headers: { authorization: `Bearer ${accessJwt}`, "content-type": "application/json" }, body: JSON.stringify({ repo: did, collection: "app.bsky.feed.post", record: { $type: "app.bsky.feed.post", text: [...text].slice(0, 290).join(""), createdAt: nowIso() } }), signal: AbortSignal.timeout(8000) });
          ok = res.ok;
        }
      } else if (r.target === "archive" && o) {
        const res = await net(`https://web.archive.org/save/${o}/.well-known/nexus-community.json`, { method: "GET", signal: AbortSignal.timeout(15000) });
        ok = res.ok;
      }
    } catch {
      ok = false;
    }
    const state = ok ? "sent" : r.attempts + 1 >= 3 ? "failed" : "pending";
    await app.db.prepare("UPDATE announce_outbox SET state=?, attempts=attempts+1, updated_at=? WHERE notice_seq=? AND target=?").bind(state, nowIso(), r.notice_seq, r.target).run();
    if (ok) n++;
  }
  return n;
}
