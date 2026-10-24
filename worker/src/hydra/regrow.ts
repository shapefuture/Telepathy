// H3: the regrowth engine. A head domain going down (from real deliveries, bounces or canaries)
// opens an incident. Then:
//   1. route around — alerts already go to every alive head; nothing waits on the dead one;
//   2. regrow ×2   — each affected person below three independent heads is invited, over a head
//                    that still works, to add TWO new heads in domains they don't have yet;
//                    the club runs pre-approved playbook steps and proposes the rest to owners;
//   3. record      — cause tag now, a human review later; recent hits steer future suggestions.
// Never: subscribing anyone to anything. Invitations go only to people following critical notices.

import type { App } from "../bot";
import { b, notifyOwners } from "../assist/notify";
import { effectStatement } from "../outbox";
import { escapeHtml } from "../text";
import { audit, DAY, newId, nowIso } from "../util";
import { open, seal } from "../continuity/crypto";
import { emailProviders, sendEmail } from "../continuity/email";
import { currentRoot, verifyDestinations, verifyRoot, type DestMeta, type RootMeta } from "../continuity/identity";
import type { Signed } from "../continuity/crypto";
import { availableHeads, deliver, ntfyServers, type RegRow } from "./deliver";
import { independentCount, suggestHeads } from "./domains";
import { loadGraph } from "./graph";
import { downDomains, setDomainState } from "./health";
import { publishNotice } from "./notices";

export const TARGET_HEADS = 3;
export const DEFAULT_PLAYBOOK = ["email_failover", "public_notice"];

export function causeOf(domain: string): string {
  const p = domain.split(":")[0]!;
  return (
    { telegram: "platform_unavailable", sender: "email_provider", mail: "mailbox_provider", push: "push_service", ntfy: "ntfy_host", matrix: "homeserver", mirror: "mirror_host", org: "provider_wide", sms: "sms_carrier", cloudflare: "hosting" } as Record<string, string>
  )[p] ?? "unknown";
}

export async function playbook(db: D1Database): Promise<string[]> {
  const r = await db.prepare("SELECT value FROM settings WHERE key='hydra.playbook'").first<{ value: string }>();
  return r ? (JSON.parse(r.value) as string[]) : DEFAULT_PLAYBOOK;
}

export async function setPlaybook(db: D1Database, auto: string[]): Promise<void> {
  await db.prepare("INSERT INTO settings(key, value) VALUES ('hydra.playbook', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify(auto)).run();
}

/** Domains hit in the last 180 days (learning: suggest heads in other domains first). */
export async function recentlyHit(db: D1Database, now = new Date()): Promise<string[]> {
  return (await db.prepare("SELECT DISTINCT domain FROM head_incidents WHERE started_at>?").bind(nowIso(new Date(now.getTime() - 180 * DAY))).all<{ domain: string }>()).results.map((r) => r.domain);
}

export const KIND_LABEL: Record<string, string> = {
  webpush: "browser notifications",
  ntfy: "the ntfy app",
  matrix: "Matrix",
  email: "a second email at a different provider",
  sms: "SMS",
  recovery_card: "a printed recovery card",
  buddy: "a buddy who passes notices on",
};

function suggestionsFor(app: App, remaining: string[][], hit: string[]): string[] {
  const avail = [...availableHeads(app.env), { kind: "buddy" as const, domain: "people" }];
  const s = suggestHeads(remaining, avail, hit, 2);
  return s.length >= 2 ? s : [...s, "recovery_card"].slice(0, 2);
}

/** Open an incident for a failed domain (idempotent per open domain). Returns its id. */
export async function openIncident(app: App, domain: string, opts: { cause?: string; drillId?: string; cohort?: Set<string>; now?: Date; tagChannels?: boolean } = {}): Promise<string> {
  const now = opts.now ?? new Date();
  const existing = await app.db.prepare("SELECT id FROM head_incidents WHERE domain=? AND state='open'").bind(domain).first<{ id: string }>();
  if (existing) return existing.id;
  const graph = await loadGraph(app, { only: opts.cohort, tagChannels: opts.tagChannels || domain.startsWith("via:") });
  const affected = graph.filter((p) => p.heads.some((h) => h.includes(domain)));
  const lost = affected.reduce((n, p) => n + p.heads.filter((h) => h.includes(domain)).length, 0);
  const id = newId();
  const ins = await app.db
    .prepare("INSERT OR IGNORE INTO head_incidents(id, domain, cause, state, drill_id, started_at, heads_lost, people_affected) VALUES (?,?,?, 'open', ?,?,?,?) RETURNING id")
    .bind(id, domain, opts.cause ?? causeOf(domain), opts.drillId ?? null, nowIso(now), lost, affected.length)
    .first();
  if (!ins) return (await app.db.prepare("SELECT id FROM head_incidents WHERE domain=? AND state='open'").bind(domain).first<{ id: string }>())!.id;
  const hit = [...(await recentlyHit(app.db, now)), domain];
  const ts = nowIso(now);
  const stmts = affected.map((p) => {
    const remaining = p.heads.filter((h) => !h.includes(domain));
    const need = independentCount(remaining) < TARGET_HEADS;
    return app.db.prepare("INSERT OR IGNORE INTO regrowth_invites(incident_id, person_id, state, suggested, created_at) VALUES (?,?,?,?,?)").bind(id, p.id, need ? "queued" : "none", JSON.stringify(need ? suggestionsFor(app, remaining, hit) : []), ts);
  });
  for (let i = 0; i < stmts.length; i += 50) await app.db.batch(stmts.slice(i, i + 50));
  if (!opts.drillId) await clubPlaybook(app, id, domain);
  await audit(app.db, "hydra.incident", "system", id, { domain, affected: affected.length, lost });
  return id;
}

/** Club-level regrowth: run pre-approved steps, propose the rest to owners. */
async function clubPlaybook(app: App, incidentId: string, domain: string): Promise<void> {
  const auto = new Set(await playbook(app.db));
  const steps: { action: string; domain: string | null; run?: () => Promise<boolean> }[] = [];
  const kind = domain.split(":")[0];
  const o = (app.env.PUBLIC_URL ?? "").replace(/\/$/, "");
  if (kind === "sender") {
    const other = emailProviders(app.env).find((p) => p.kind !== "log" && `sender:${p.kind}` !== domain);
    if (other) steps.push({ action: "email_failover", domain: `sender:${other.kind}`, run: async () => true }); // sendEmail already fails over
    else steps.push({ action: "add_second_email_provider", domain: null });
  }
  if (kind === "telegram") {
    steps.push({
      action: "public_notice",
      domain: o ? `feed:${new URL(o).hostname}` : null,
      run: async () => !!(await publishNotice(app, "incident", "Telegram is unavailable for us", `We are still here. Official places and the member portal: ${o || "see the signed address list"}${o ? "/portal" : ""}.`, "hydra")),
    });
    steps.push({ action: "open_matrix_room", domain: app.env.MATRIX_HOMESERVER ? `matrix:${new URL(app.env.MATRIX_HOMESERVER).hostname}` : null });
  }
  if (kind === "mirror" || kind === "cloudflare") steps.push({ action: "add_mirror", domain: null });
  if (kind === "ntfy") steps.push({ action: ntfyServers(app.env).length > 1 ? "second_ntfy_server_active" : "add_ntfy_server", domain: null });
  if (kind === "matrix") steps.push({ action: "add_homeserver", domain: null });
  const proposed: string[] = [];
  for (const s of steps) {
    let state = "proposed";
    if (s.run && auto.has(s.action)) state = (await s.run().catch(() => false)) ? "done" : "proposed";
    await app.db.prepare("INSERT INTO club_regrowth(id, incident_id, action, domain, state, automatic, created_at, done_at) VALUES (?,?,?,?,?,?,?,?)").bind(newId(), incidentId, s.action, s.domain, state, state === "done" ? 1 : 0, nowIso(), state === "done" ? nowIso() : null).run();
    if (state === "proposed") proposed.push(s.action);
  }
  await notifyOwners(app, `hydra:inc:${incidentId}`, () => ({
    text: `🐉 <b>Path down:</b> <code>${escapeHtml(domain)}</code> (${escapeHtml(causeOf(domain))}). Members who lost it are being invited to add two independent paths.` + (proposed.length ? `\nProposed for you: ${proposed.map((p) => `<code>${p}</code>`).join(", ")} — mark done with <code>/hydra done &lt;action&gt; &lt;domain&gt;</code>.` : ""),
    buttons: [[b("Hydra status", "hy:status")]],
  }));
}

/** Cron: turn down domains into incidents, and mark recovered ones. */
export async function classify(app: App, now = new Date()): Promise<number> {
  const down = await downDomains(app.db);
  let opened = 0;
  for (const d of down) {
    const open_ = await app.db.prepare("SELECT 1 FROM head_incidents WHERE domain=? AND state='open'").bind(d).first();
    if (!open_) {
      await openIncident(app, d, { now });
      opened++;
    }
  }
  const { results } = await app.db.prepare("SELECT id, domain FROM head_incidents WHERE state='open' AND drill_id IS NULL").all<{ id: string; domain: string }>();
  for (const r of results) if (!down.has(r.domain)) await app.db.prepare("UPDATE head_incidents SET state='recovered', recovered_at=? WHERE id=?").bind(nowIso(now), r.id).run();
  return opened;
}

/** Cron: send "add two heads" invitations over a head that still works. */
export async function dispatchInvites(app: App, budget = 3): Promise<number> {
  const { results } = await app.db
    .prepare("SELECT i.incident_id, i.person_id, i.suggested, h.domain, h.drill_id FROM regrowth_invites i JOIN head_incidents h ON h.id=i.incident_id WHERE i.state='queued' ORDER BY i.created_at LIMIT ?")
    .bind(budget)
    .all<{ incident_id: string; person_id: string; suggested: string; domain: string; drill_id: string | null }>();
  const o = (app.env.PUBLIC_URL ?? "").replace(/\/$/, "");
  const label = app.env.COMMUNITY_LABEL || "Your community";
  let n = 0;
  for (const r of results) {
    if (app.budget && app.budget.left() < 5) break;
    const kinds = (JSON.parse(r.suggested) as string[]).map((k) => KIND_LABEL[k] ?? k);
    const title = `${r.drill_id ? "[DRILL] " : ""}${label}: one way we reach you is down`;
    const text = `One of the ways we reach you (${r.domain}) isn't working${r.drill_id ? " in this drill" : ""}. To stay reachable whatever fails next, add two more: ${kinds.join(" and ")}.${o ? `\n\nOpen your passport: ${o}/portal` : ""}`;
    const regs = (await app.db.prepare("SELECT id, person_id, channel, address_enc, meta_enc, domains FROM delivery_registrations WHERE person_id=? AND status='verified' AND health='ok' AND channel<>'telegram'").bind(r.person_id).all<RegRow>()).results.filter((g) => !(JSON.parse(g.domains ?? "[]") as string[]).includes(r.domain) && `via:${g.channel}` !== r.domain);
    let sent = false;
    for (const g of regs.slice(0, 2)) {
      const res = await deliver(app, g, { title, text, url: o ? `${o}/portal` : undefined });
      if (res === "sent" || res === "logged") {
        sent = true;
        break;
      }
    }
    if (!sent && r.domain !== "telegram" && r.domain !== "via:telegram") {
      const tg = await app.db.prepare("SELECT m.tg_id FROM identity_links l JOIN members m ON m.id=l.account_id WHERE l.person_id=? AND l.platform='telegram' AND l.revoked_at IS NULL AND m.removed_at IS NULL").bind(r.person_id).first<{ tg_id: number }>();
      if (tg) {
        await effectStatement(app.db, `hydra:inv:${r.incident_id}:${r.person_id}`, tg.tg_id, { text: escapeHtml(`${title}\n\n${text}`) }).run();
        sent = true;
      }
    }
    await app.db.prepare("UPDATE regrowth_invites SET state=? WHERE incident_id=? AND person_id=?").bind(sent ? "sent" : "unreachable", r.incident_id, r.person_id).run();
    if (sent) n++;
  }
  return n;
}

/** Owner marks a proposed club step done (with the new path's domain) or declined. */
export async function clubStep(db: D1Database, action: string, domain: string | null, state: "done" | "declined"): Promise<boolean> {
  const r = await db
    .prepare("UPDATE club_regrowth SET state=?, domain=COALESCE(?, domain), done_at=? WHERE id=(SELECT id FROM club_regrowth WHERE action=? AND state='proposed' ORDER BY created_at DESC LIMIT 1) RETURNING id")
    .bind(state, domain, nowIso(), action)
    .first();
  return !!r;
}

export async function reviewIncident(db: D1Database, id: string, cause: string, notes: string): Promise<boolean> {
  return !!(await db.prepare("UPDATE head_incidents SET state='reviewed', cause=?, review=?, recovered_at=COALESCE(recovered_at, ?) WHERE id LIKE ? || '%' RETURNING id").bind(cause.slice(0, 40), notes.slice(0, 1000), nowIso(), id).first());
}

// ---- canaries: synthetic probes that find silent blocking before a real notice needs it --------

export type CanaryKind = "email" | "ntfy" | "matrix" | "mirror" | "telegram";

export async function addCanary(app: App, kind: CanaryKind, target: string): Promise<{ ok: boolean; reason?: string; domain?: string }> {
  let domain: string;
  try {
    if (kind === "telegram") domain = "telegram";
    else if (kind === "email") {
      if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(target)) return { ok: false, reason: "email" };
      domain = "sender";
    } else if (kind === "ntfy") {
      const u = new URL(target);
      if (!ntfyServers(app.env).includes(u.origin)) return { ok: false, reason: "ntfy_server" };
      domain = `ntfy:${u.hostname}`;
    } else if (kind === "matrix") domain = app.env.MATRIX_HOMESERVER ? `matrix:${new URL(app.env.MATRIX_HOMESERVER).hostname}` : "";
    else {
      const u = new URL(target);
      if (u.protocol !== "https:") return { ok: false, reason: "https" };
      domain = `mirror:${u.hostname}`;
    }
  } catch {
    return { ok: false, reason: "url" };
  }
  if (!domain) return { ok: false, reason: "not_configured" };
  await app.db.prepare("INSERT INTO canaries(id, kind, target_enc, domain, created_at) VALUES (?,?,?,?,?)").bind(newId(), kind, target ? await seal(app.env.CONTINUITY_KEY, target) : null, domain, nowIso()).run();
  return { ok: true, domain };
}

/** Cron: run up to `budget` canaries that haven't run in 20 hours. */
export async function runCanaries(app: App, budget = 2, now = new Date()): Promise<number> {
  const { results } = await app.db
    .prepare("SELECT id, kind, target_enc, domain, fails FROM canaries WHERE last_run_at IS NULL OR last_run_at<? ORDER BY COALESCE(last_run_at,'') LIMIT ?")
    .bind(nowIso(new Date(now.getTime() - 20 * 3_600_000)), budget)
    .all<{ id: string; kind: CanaryKind; target_enc: string | null; domain: string; fails: number }>();
  for (const c of results) {
    if (app.budget && app.budget.left() < 3) break;
    const target = c.target_enc ? await open(app.env.CONTINUITY_KEY, c.target_enc) : "";
    const result = await probe(app, c.kind, target).catch(() => "error");
    const ok = result === "ok";
    await app.db.prepare("UPDATE canaries SET last_run_at=?, last_ok_at=CASE WHEN ? THEN ? ELSE last_ok_at END, last_result=?, fails=CASE WHEN ? THEN 0 ELSE fails+1 END WHERE id=?").bind(nowIso(now), ok ? 1 : 0, nowIso(now), result, ok ? 1 : 0, c.id).run();
    if (c.domain === "sender") continue; // sendEmail records each provider's own domain
    if (!ok && c.fails + 1 >= 2) await setDomainState(app.db, c.domain, "down", now);
    if (ok && c.fails >= 2) await setDomainState(app.db, c.domain, "up", now);
  }
  return results.length;
}

async function probe(app: App, kind: CanaryKind, target: string): Promise<string> {
  const net = app.net ?? fetch;
  if (kind === "telegram") {
    await app.tg.call("getMe", {});
    return "ok";
  }
  if (kind === "email") return (await sendEmail(app, { to: target, subject: "canary", text: `Delivery probe ${nowIso()}. No action needed.` })) === "sent" ? "ok" : "send_failed";
  if (kind === "ntfy") {
    const u = new URL(target);
    const nonce = `canary-${crypto.randomUUID()}`;
    const p = await net(u.origin, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ topic: u.pathname.slice(1), message: nonce }), signal: AbortSignal.timeout(8000) });
    if (!p.ok) return `publish_${p.status}`;
    const g = await net(`${u.origin}${u.pathname}/json?poll=1&since=10m`, { signal: AbortSignal.timeout(8000) } as RequestInit);
    return (await g.text()).includes(nonce) ? "ok" : "not_received";
  }
  if (kind === "matrix") {
    const r = await net(`${app.env.MATRIX_HOMESERVER!.replace(/\/$/, "")}/_matrix/client/v3/account/whoami`, { headers: { authorization: `Bearer ${app.env.MATRIX_ACCESS_TOKEN}` }, signal: AbortSignal.timeout(8000) } as RequestInit);
    return r.ok ? "ok" : `whoami_${r.status}`;
  }
  // mirror: must serve our own root and a current, valid address list.
  const url = target.endsWith(".json") ? target : `${target.replace(/\/$/, "")}/.well-known/nexus-community.json`;
  const r = await net(url, { signal: AbortSignal.timeout(8000) } as RequestInit);
  if (!r.ok) return `http_${r.status}`;
  const doc = (await r.json()) as { root?: Signed<RootMeta>; destinations?: Signed<DestMeta> };
  const ours = await currentRoot(app.db);
  if (!ours || !doc.root || !doc.destinations) return "shape";
  const vr = await verifyRoot(doc.root, ours);
  if (!vr.ok) return vr.reason;
  const ourManifest = (await app.db.prepare("SELECT json FROM destination_manifests ORDER BY version DESC LIMIT 1").first<{ json: string }>())?.json;
  const vd = await verifyDestinations(doc.destinations, doc.root, null);
  if (!vd.ok) return vd.reason;
  if (ourManifest && doc.destinations.signed.version < (JSON.parse(ourManifest) as Signed<DestMeta>).signed.version) return "stale";
  return "ok";
}
