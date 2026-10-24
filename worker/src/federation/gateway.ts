// Partner gateway (plan E.1–E.4, Track 6). Both roles in one node:
//   requester: our member's approved mission -> signed inquiry to allowlisted partners
//   provider:  a partner's inquiry -> our operator offers a published capability, or declines
// Off unless FEDERATION_ENABLED=true and a signing key is set. Partners without an endpoint use
// the manual E0 mode: operators carry signed messages by hand (/desk shows them, /fed loads them).

import type { App } from "../bot";
import { A } from "../assist/i18n";
import { liveCommitment, openOffers, release, reserve, deliver } from "../assist/capacity";
import { getMission, grantFor, receipt, recordGrant, transition, type Mission } from "../assist/missions";
import { findIdentifiers, grantAllows, audienceOf, ENVELOPE_FIELDS } from "../domain/consent";
import type { Env } from "../env";
import { notifyMember, notifyOwners } from "../assist/notify";
import { b } from "../assist/notify";
import { escapeHtml } from "../text";
import { audit, DAY, newId, nowIso } from "../util";
import { checkShape, SCHEMA, sha256, sign, verifySignature, MAX_BODY_BYTES, type FedMessage, type InquiryBody, type MessageType } from "./envelope";

export const INQUIRY_TTL_DAYS = 14;
export const INBOUND_PER_PARTNER_DAY = 50;
export const MAX_FED_ATTEMPTS = 5;
export const FED_BUDGET = 5; // outbound partner calls per cron run (Telegram keeps the rest)

export interface Partner {
  id: string;
  brand_label: string;
  status: string;
  endpoint: string | null;
  public_key: string | null;
  categories: string;
}

export interface Exchange {
  id: string;
  direction: "out" | "in";
  partner_id: string;
  mission_id: string | null;
  remote_id: string | null;
  mission_ref: string;
  job_code: string;
  summary: string;
  state: string;
  capability_offer_id: string | null;
  contact: string | null;
  expires_at: string;
}

export const nodeId = (env: Env): string => (env.FEDERATION_NODE_ID || env.PUBLIC_URL || "").replace(/\/$/, "");
export const fedEnabled = (env: Env): boolean => env.FEDERATION_ENABLED === "true" && !!env.FEDERATION_PRIVATE_KEY && !!nodeId(env);

export async function partnerList(db: D1Database): Promise<Partner[]> {
  return (await db.prepare("SELECT * FROM organizations WHERE kind='partner' ORDER BY brand_label").all<Partner>()).results;
}

const getPartner = (db: D1Database, id: string) => db.prepare("SELECT * FROM organizations WHERE id=? AND kind='partner'").bind(id).first<Partner>();

export function partnerAccepts(p: Partner, job: string): boolean {
  if (p.status !== "active") return false;
  let cats: string[] = [];
  try {
    cats = JSON.parse(p.categories);
  } catch {
    return false;
  }
  return cats.includes("*") || cats.includes(job);
}

export async function policyVersion(db: D1Database): Promise<number> {
  return (await db.prepare("SELECT policy_version AS v FROM organizations WHERE id='home'").first<{ v: number }>())?.v ?? 1;
}

/** Partner endpoints must be public https origins (SSRF guard: no IPs, no internal names, no ports). */
export function safeEndpoint(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const h = u.hostname.toLowerCase();
  if (u.protocol !== "https:" || u.port || u.username || u.password) return null;
  if (!h.includes(".") || /^[\d.]+$/.test(h) || h.includes(":") || h.startsWith("[")) return null;
  if (/(^|\.)(localhost|local|internal|lan|home|corp|intranet)$/.test(h)) return null;
  return u.origin;
}

const PATHS: Record<MessageType, (id: string) => string> = {
  inquiry: () => "/v1/opportunities/inquiries",
  offer: (id) => `/v1/opportunities/${id}/offers`,
  decline: (id) => `/v1/opportunities/${id}/offers`,
  approval: (id) => `/v1/opportunities/${id}/approvals`,
  commitment: (id) => `/v1/commitments/${id}/events`,
  withdraw: (id) => `/v1/exchanges/${id}/withdraw`,
};

// ---- outbound ledger ------------------------------------------------------------------------

/** Sign and queue one message. Manual partners get it on the operator desk instead. */
async function enqueue(app: App, partner: Partner, type: MessageType, exchangeId: string, body: Record<string, unknown>, key: string, expiresAt?: string): Promise<string[]> {
  const now = new Date();
  const msg = await sign(
    {
      schema: SCHEMA,
      type,
      exchange_id: exchangeId,
      issuer_org: nodeId(app.env),
      recipient_org: partner.id,
      issued_at: nowIso(now),
      expires_at: expiresAt && Date.parse(expiresAt) > now.getTime() ? expiresAt : nowIso(new Date(now.getTime() + INQUIRY_TTL_DAYS * DAY)),
      nonce: newId(),
      body,
    },
    app.env.FEDERATION_PRIVATE_KEY!,
  );
  const id = newId();
  const ts = nowIso(now);
  const r = await app.db
    .prepare("INSERT OR IGNORE INTO fed_outbox(id, key, partner_id, path, body, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?) RETURNING id")
    .bind(id, key, partner.id, PATHS[type](exchangeId), JSON.stringify(msg), partner.endpoint ? "pending" : "manual", ts, ts)
    .all();
  if (!r.results.length || partner.endpoint) return [];
  return notifyOwners(app, `fedmanual:${id}`, (a) => ({
    text: `${a.manual(escapeHtml(partner.brand_label))}\n<pre>${escapeHtml(JSON.stringify(msg))}</pre>`,
    buttons: [[b(a.bMarkSent, `x:${id}:s`)]],
  }));
}

export async function markManualSent(db: D1Database, outboxId: string): Promise<boolean> {
  const r = await db.prepare("UPDATE fed_outbox SET state='reconciled', updated_at=? WHERE id=? AND state='manual' RETURNING id").bind(nowIso(), outboxId).all();
  return r.results.length > 0;
}

/**
 * Deliver queued messages. Receivers deduplicate by (issuer, nonce), so a retry after a network
 * error is safe; after MAX_FED_ATTEMPTS the row becomes 'uncertain' for an operator to check.
 */
export async function dispatchFed(app: App, budget = FED_BUDGET): Promise<number> {
  const { results } = await app.db
    .prepare("SELECT f.id, f.path, f.body, f.attempts, o.endpoint FROM fed_outbox f JOIN organizations o ON o.id=f.partner_id WHERE f.state='pending' AND o.status='active' ORDER BY f.created_at LIMIT ?")
    .bind(budget)
    .all<{ id: string; path: string; body: string; attempts: number; endpoint: string | null }>();
  let sent = 0;
  for (const r of results) {
    const claimed = await app.db.prepare("UPDATE fed_outbox SET state='dispatching', attempts=attempts+1, updated_at=? WHERE id=? AND state='pending' RETURNING id").bind(nowIso(), r.id).all();
    if (!claimed.results.length || !r.endpoint) continue;
    let state = "pending";
    let error: string | null = null;
    try {
      const res = await (app.net ?? fetch)(r.endpoint + r.path, { method: "POST", headers: { "content-type": "application/json" }, body: r.body, signal: AbortSignal.timeout(8000) });
      if (res.ok) state = "sent";
      else if (res.status === 429 || res.status >= 500) error = `http ${res.status}`;
      else {
        state = "failed";
        error = `http ${res.status}`;
      }
    } catch (e) {
      error = String(e).slice(0, 200);
    }
    if (state === "pending" && r.attempts + 1 >= MAX_FED_ATTEMPTS) state = "uncertain";
    await app.db.prepare("UPDATE fed_outbox SET state=?, error=?, updated_at=? WHERE id=?").bind(state, error, nowIso(), r.id).run();
    if (state === "sent") sent++;
  }
  return sent;
}

// ---- requester side -------------------------------------------------------------------------

/** Partners that would receive this mission if the member allows it (preview, I02). */
export async function eligiblePartners(app: App, m: Pick<Mission, "job_code">): Promise<Partner[]> {
  if (!fedEnabled(app.env)) return [];
  return (await partnerList(app.db)).filter((p) => partnerAccepts(p, m.job_code) && !!p.public_key);
}

export function inquiryBody(m: Mission, missionRef: string, pv: number): InquiryBody {
  // Field allowlist (E.2): nothing else about the member, their groups or messages.
  return {
    mission_ref: missionRef,
    job: m.job_code,
    summary: m.summary,
    criteria: {},
    allowed_fields: [...ENVELOPE_FIELDS],
    purpose: "evaluate_willing_provider",
    forwarding: "prohibited",
    max_hops: 1,
    policy_version: pv,
  };
}

/** Operator routes a mission. Every send re-checks the member's current grant (I08). */
export async function routeMission(app: App, missionId: string, now = new Date()): Promise<{ routed: number; keys: string[] }> {
  const m = await getMission(app.db, missionId);
  if (!m || !fedEnabled(app.env) || findIdentifiers(m.summary).length) return { routed: 0, keys: [] };
  const pv = await policyVersion(app.db);
  const g = await grantFor(app.db, m.id, "external_discovery");
  const keys: string[] = [];
  let routed = 0;
  for (const pid of g ? audienceOf(g) : []) {
    const p = await getPartner(app.db, pid);
    if (!p || !p.public_key || !partnerAccepts(p, m.job_code)) continue;
    if (!grantAllows(g, { action: "external_discovery", audience: p.id, missionVersion: m.version, policyVersion: pv, fields: ENVELOPE_FIELDS, now: nowIso(now) })) continue;
    const exId = newId();
    const ref = newId(); // per-exchange pseudonym (I05)
    const body = inquiryBody(m, ref, pv);
    const ins = await app.db
      .prepare(
        "INSERT OR IGNORE INTO federation_exchanges(id, direction, partner_id, mission_id, mission_ref, job_code, summary, envelope, state, idempotency_key, expires_at, created_at, updated_at) " +
          "VALUES (?, 'out', ?,?,?,?,?,?, 'sent', ?,?,?,?) RETURNING id",
      )
      .bind(exId, p.id, m.id, ref, m.job_code, m.summary, JSON.stringify(body), `out:${m.id}:${p.id}:${m.version}`, nowIso(new Date(now.getTime() + INQUIRY_TTL_DAYS * DAY)), nowIso(now), nowIso(now))
      .all();
    if (!ins.results.length) continue; // already routed to this partner for this version
    keys.push(...(await enqueue(app, p, "inquiry", exId, body as unknown as Record<string, unknown>, `inq:${exId}`)));
    routed++;
  }
  if (routed) await transition(app.db, m.id, "routed", "operator", { handler: "partner" });
  await audit(app.db, "mission.route", "operator", m.id, { partners: routed });
  return { routed, keys };
}

/** Withdraw every live outbound exchange of a mission (cancel, expiry, forget: I09). */
export async function withdrawMission(app: App, missionId: string, except?: string): Promise<string[]> {
  const { results } = await app.db
    .prepare("SELECT * FROM federation_exchanges WHERE mission_id=? AND direction='out' AND state IN ('sent','offered','selected','committed')")
    .bind(missionId)
    .all<Exchange>();
  const keys: string[] = [];
  for (const ex of results) {
    if (ex.id === except) continue;
    await app.db.prepare("UPDATE federation_exchanges SET state='withdrawn', updated_at=? WHERE id=?").bind(nowIso(), ex.id).run();
    await app.db.prepare("UPDATE exchange_offers SET status='withdrawn' WHERE exchange_id=? AND status IN ('received','selected')").bind(ex.id).run();
    const p = await getPartner(app.db, ex.partner_id);
    if (p && fedEnabled(app.env)) keys.push(...(await enqueue(app, p, "withdraw", ex.id, { reason: "requester_withdrew" }, `wd:${ex.id}`)));
  }
  return keys;
}

/** Member picks a partner's offer: reveal grant for that partner only, then send approval. */
export async function chooseOffer(app: App, memberId: string, offerId: string, contact: string): Promise<{ ok: boolean; brand?: string; keys: string[] }> {
  const row = await app.db
    .prepare("SELECT o.id AS offer_id, o.exchange_id, e.mission_id, e.partner_id FROM exchange_offers o JOIN federation_exchanges e ON e.id=o.exchange_id WHERE o.id=? AND o.status='received' AND e.state='offered'")
    .bind(offerId)
    .first<{ offer_id: string; exchange_id: string; mission_id: string; partner_id: string }>();
  const m = row ? await getMission(app.db, row.mission_id) : null;
  const p = row ? await getPartner(app.db, row.partner_id) : null;
  if (!row || !m || !p || m.member_id !== memberId || m.status !== "offers_available" || !fedEnabled(app.env)) return { ok: false, keys: [] };
  const pv = await policyVersion(app.db);
  await recordGrant(app.db, m, "reveal", JSON.stringify([p.id]), ["contact"], "connect_helper", pv);
  const g = await grantFor(app.db, m.id, "reveal");
  if (!grantAllows(g, { action: "reveal", audience: p.id, missionVersion: m.version, policyVersion: pv, fields: ["contact"], now: nowIso() })) return { ok: false, keys: [] };
  if (!(await transition(app.db, m.id, "provider_selected", "member"))) return { ok: false, keys: [] };
  await transition(app.db, m.id, "pending_final_approvals", "system", { handler: "partner" });
  await app.db.batch([
    app.db.prepare("UPDATE exchange_offers SET status='selected' WHERE id=?").bind(offerId),
    app.db.prepare("UPDATE federation_exchanges SET state='selected', updated_at=? WHERE id=?").bind(nowIso(), row.exchange_id),
  ]);
  // Other partners' offers are released (cancellation propagation).
  const keys = await withdrawMission(app, m.id, row.exchange_id);
  keys.push(
    ...(await enqueue(
      app,
      p,
      "approval",
      row.exchange_id,
      { consent: { action: "reveal", purpose: "connect_helper", fields: ["contact"], grant_ref: await sha256(`${g!.mission_version}:${m.id}:${p.id}`) }, contact },
      `appr:${row.exchange_id}`,
    )),
  );
  await audit(app.db, "mission.reveal", memberId, m.id, { partner: p.id });
  return { ok: true, brand: p.brand_label, keys };
}

export async function declineOffer(app: App, memberId: string, offerId: string): Promise<{ ok: boolean; keys: string[] }> {
  const row = await app.db
    .prepare("SELECT o.exchange_id, e.mission_id FROM exchange_offers o JOIN federation_exchanges e ON e.id=o.exchange_id JOIN missions m ON m.id=e.mission_id WHERE o.id=? AND o.status='received' AND m.member_id=?")
    .bind(offerId, memberId)
    .first<{ exchange_id: string; mission_id: string }>();
  if (!row) return { ok: false, keys: [] };
  await app.db.prepare("UPDATE exchange_offers SET status='declined' WHERE id=?").bind(offerId).run();
  const ex = await app.db.prepare("SELECT * FROM federation_exchanges WHERE id=?").bind(row.exchange_id).first<Exchange>();
  const p = ex ? await getPartner(app.db, ex.partner_id) : null;
  await app.db.prepare("UPDATE federation_exchanges SET state='declined', updated_at=? WHERE id=?").bind(nowIso(), row.exchange_id).run();
  const keys = p && fedEnabled(app.env) ? await enqueue(app, p, "withdraw", row.exchange_id, { reason: "requester_declined" }, `wd:${row.exchange_id}`) : [];
  await settleIfNoneLeft(app, row.mission_id, "member");
  return { ok: true, keys };
}

/** No live exchange left: the mission has no eligible provider (the desk decides what next). */
async function settleIfNoneLeft(app: App, missionId: string, actor: "member" | "system"): Promise<void> {
  const live = await app.db
    .prepare("SELECT COUNT(*) AS n FROM federation_exchanges WHERE mission_id=? AND direction='out' AND state IN ('sent','offered','selected','committed')")
    .bind(missionId)
    .first<{ n: number }>();
  if ((live?.n ?? 0) === 0) await transition(app.db, missionId, "no_eligible_provider", actor, { handler: "operator" });
}

// ---- provider side (operator actions) ---------------------------------------------------------

export const getExchange = (db: D1Database, id: string) => db.prepare("SELECT * FROM federation_exchanges WHERE id=?").bind(id).first<Exchange>();

export async function offerInbound(app: App, exId: string, offerId: string): Promise<{ ok: boolean; keys: string[] }> {
  const ex = await getExchange(app.db, exId);
  if (!ex || ex.direction !== "in" || ex.state !== "received") return { ok: false, keys: [] };
  const offer = (await openOffers(app.db, ex.job_code)).find((o) => o.id === offerId);
  const p = await getPartner(app.db, ex.partner_id);
  if (!offer || !p) return { ok: false, keys: [] };
  const u = await app.db.prepare("UPDATE federation_exchanges SET state='offered', capability_offer_id=?, updated_at=? WHERE id=? AND state='received' RETURNING id").bind(offerId, nowIso(), exId).all();
  if (!u.results.length) return { ok: false, keys: [] };
  const keys = await enqueue(app, p, "offer", ex.remote_id!, { offer_ref: ex.id, summary: offer.description, terms: { mode: offer.commitment_mode } }, `off:${ex.id}`, ex.expires_at);
  return { ok: true, keys };
}

export async function declineInbound(app: App, exId: string, reason = "declined"): Promise<{ ok: boolean; keys: string[] }> {
  const ex = await getExchange(app.db, exId);
  const p = ex ? await getPartner(app.db, ex.partner_id) : null;
  if (!ex || !p || ex.direction !== "in") return { ok: false, keys: [] };
  const u = await app.db.prepare("UPDATE federation_exchanges SET state='declined', contact=NULL, updated_at=? WHERE id=? AND state IN ('received','offered') RETURNING id").bind(nowIso(), exId).all();
  if (!u.results.length) return { ok: false, keys: [] };
  return { ok: true, keys: await enqueue(app, p, "decline", ex.remote_id!, { reason }, `dec:${ex.id}`, ex.expires_at) };
}

export async function finishInbound(app: App, exId: string, how: "delivered" | "released"): Promise<{ ok: boolean; keys: string[] }> {
  const ex = await getExchange(app.db, exId);
  const p = ex ? await getPartner(app.db, ex.partner_id) : null;
  const c = ex ? await liveCommitment(app.db, { exchangeId: ex.id }) : null;
  if (!ex || !p || !c) return { ok: false, keys: [] };
  const ok = how === "delivered" ? await deliver(app.db, c.id) : await release(app.db, c.id);
  if (!ok) return { ok: false, keys: [] };
  // The contact is no longer needed once the service ends (minimization).
  await app.db.prepare("UPDATE federation_exchanges SET state=?, contact=NULL, updated_at=? WHERE id=?").bind(how === "delivered" ? "delivered" : "declined", nowIso(), ex.id).run();
  return { ok: true, keys: await enqueue(app, p, "commitment", ex.remote_id!, { status: how }, `cm:${how}:${ex.id}`, ex.expires_at) };
}

// ---- inbound -------------------------------------------------------------------------------

export interface Received {
  status: number;
  body: { ok: boolean; reason?: string; duplicate?: boolean };
  keys: string[];
}
const fail = (status: number, reason: string): Received => ({ status, body: { ok: false, reason }, keys: [] });
const ok = (keys: string[] = [], status = 202): Received => ({ status, body: { ok: true }, keys });

/** Verify and apply one inbound message. `route` pins which types/exchange the URL allows. */
export async function receive(app: App, raw: unknown, route: { types: MessageType[]; id?: string }, now = new Date()): Promise<Received> {
  if (!fedEnabled(app.env)) return fail(404, "disabled");
  const shape = checkShape(raw, now.getTime());
  if (shape) return fail(400, shape);
  const msg = raw as FedMessage;
  if (!route.types.includes(msg.type) || (route.id !== undefined && route.id !== msg.exchange_id)) return fail(400, "route");
  if (msg.recipient_org !== nodeId(app.env)) return fail(403, "audience");
  const p = await getPartner(app.db, msg.issuer_org);
  if (!p || !p.public_key) return fail(401, "unknown_issuer");
  if (p.status !== "active") return fail(403, "partner_suspended");
  if (!(await verifySignature(msg, p.public_key))) return fail(401, "signature");
  const fresh = await app.db.prepare("INSERT INTO fed_nonces(issuer, nonce, expires_at) VALUES (?,?,?) ON CONFLICT DO NOTHING RETURNING nonce").bind(p.id, msg.nonce, msg.expires_at).all();
  if (!fresh.results.length) return { status: 200, body: { ok: true, duplicate: true }, keys: [] };
  try {
    const r = await apply(app, p, msg, now);
    if (!r.body.ok) await app.db.prepare("DELETE FROM fed_nonces WHERE issuer=? AND nonce=?").bind(p.id, msg.nonce).run();
    return r;
  } catch (e) {
    await app.db.prepare("DELETE FROM fed_nonces WHERE issuer=? AND nonce=?").bind(p.id, msg.nonce).run();
    throw e;
  }
}

async function apply(app: App, p: Partner, msg: FedMessage, now: Date): Promise<Received> {
  const ts = nowIso(now);
  const brand = escapeHtml(p.brand_label);
  if (msg.type === "inquiry") {
    const body = msg.body as unknown as InquiryBody;
    if (!partnerAccepts(p, body.job)) return fail(403, "category");
    const n = await app.db
      .prepare("SELECT COUNT(*) AS n FROM federation_exchanges WHERE partner_id=? AND direction='in' AND created_at>?")
      .bind(p.id, nowIso(new Date(now.getTime() - DAY)))
      .first<{ n: number }>();
    if ((n?.n ?? 0) >= INBOUND_PER_PARTNER_DAY) return fail(429, "rate");
    const id = newId();
    const ins = await app.db
      .prepare(
        "INSERT OR IGNORE INTO federation_exchanges(id, direction, partner_id, remote_id, mission_ref, job_code, summary, envelope, state, idempotency_key, expires_at, created_at, updated_at) " +
          "VALUES (?, 'in', ?,?,?,?,?,?, 'received', ?,?,?,?) RETURNING id",
      )
      .bind(id, p.id, msg.exchange_id, body.mission_ref, body.job, body.summary.slice(0, 600), JSON.stringify(msg), `in:${p.id}:${msg.exchange_id}`, msg.expires_at, ts, ts)
      .all();
    if (!ins.results.length) return ok([], 200);
    const offers = await openOffers(app.db, body.job);
    const keys = await notifyOwners(app, `fedin:${id}`, (a) => ({
      text: a.deskInbound(brand, escapeHtml(body.job), escapeHtml(body.summary)) + (offers.length ? "" : `\n\n${a.noMatchingOffer}`),
      buttons: [...offers.map((o) => [b(a.bOfferWith(o.description.slice(0, 40)), `x:${id}:o:${o.id}`)]), [b(a.bDecline, `x:${id}:d`)]],
    }));
    return ok(keys);
  }

  if (msg.type === "offer" || msg.type === "decline" || msg.type === "commitment") {
    const ex = await app.db.prepare("SELECT * FROM federation_exchanges WHERE id=? AND partner_id=? AND direction='out'").bind(msg.exchange_id, p.id).first<Exchange>();
    if (!ex || !ex.mission_id) return fail(404, "unknown_exchange");
    const m = await getMission(app.db, ex.mission_id);
    if (!m) return fail(404, "unknown_exchange");
    if (msg.type === "offer") {
      const summary = String(msg.body.summary ?? "").slice(0, 300);
      const mode = String((msg.body.terms as { mode?: string } | undefined)?.mode ?? "volunteer").slice(0, 30);
      if (!summary || ex.state !== "sent" || !["routed", "offers_available"].includes(m.status)) return fail(409, "state");
      const oid = newId().slice(0, 8);
      await app.db.batch([
        app.db.prepare("INSERT OR IGNORE INTO exchange_offers(id, exchange_id, summary, terms, created_at) VALUES (?,?,?,?,?)").bind(oid, ex.id, summary, JSON.stringify({ mode }), ts),
        app.db.prepare("UPDATE federation_exchanges SET state='offered', updated_at=? WHERE id=?").bind(ts, ex.id),
      ]);
      await transition(app.db, m.id, "offers_available", "partner", { handler: "member" });
      const keys = await notifyMember(app, m.member_id, `fedoffer:${oid}`, (a) => ({
        text: a.offer(brand, escapeHtml(summary), escapeHtml(mode)),
        buttons: [[b(a.bChoose, `o:${oid}:y`), b(a.bNoThanks, `o:${oid}:n`)]],
      }));
      return ok(keys);
    }
    if (msg.type === "decline") {
      const u = await app.db.prepare("UPDATE federation_exchanges SET state='declined', updated_at=? WHERE id=? AND state IN ('sent','offered','selected') RETURNING id").bind(ts, ex.id).all();
      if (!u.results.length) return ok([], 200);
      await app.db.prepare("UPDATE exchange_offers SET status='withdrawn' WHERE exchange_id=? AND status IN ('received','selected')").bind(ex.id).run();
      if (m.status === "pending_final_approvals") {
        // The chosen provider ran out of capacity: back to the desk, contact grant revoked.
        await app.db.prepare("UPDATE consent_grants SET revoked_at=? WHERE mission_id=? AND action='reveal' AND revoked_at IS NULL").bind(ts, m.id).run();
        await transition(app.db, m.id, "external_permission_needed", "partner", { handler: "operator" });
        return ok(await notifyMember(app, m.member_id, `fedrel:${ex.id}`, (a) => ({ text: a.released })));
      }
      await settleIfNoneLeft(app, m.id, "system");
      return ok();
    }
    // commitment events
    const status = String(msg.body.status ?? "");
    if (status === "committed") {
      const u = await app.db.prepare("UPDATE federation_exchanges SET state='committed', updated_at=? WHERE id=? AND state='selected' RETURNING id").bind(ts, ex.id).all();
      if (!u.results.length) return ok([], 200);
      await transition(app.db, m.id, "service_committed", "partner", { handler: "partner" });
      return ok(await notifyMember(app, m.member_id, `fedcm:${ex.id}`, (a) => ({ text: a.committedPartner(brand) })));
    }
    if (status === "delivered") {
      const u = await app.db.prepare("UPDATE federation_exchanges SET state='delivered', updated_at=? WHERE id=? AND state='committed' RETURNING id").bind(ts, ex.id).all();
      if (!u.results.length) return ok([], 200);
      await transition(app.db, m.id, "delivered", "partner", { handler: "member" });
      await receipt(app.db, m.id, { service: "partner_service", provider: true });
      return ok(await notifyMember(app, m.member_id, `feddv:${ex.id}`, (a) => ({ text: a.deliveredQ, buttons: [[b(a.bUseful, `r:${m.id}:1`), b(a.bNotUseful, `r:${m.id}:0`)]] })));
    }
    if (status === "released" || status === "cancelled") {
      const u = await app.db.prepare("UPDATE federation_exchanges SET state='declined', updated_at=? WHERE id=? AND state IN ('selected','committed') RETURNING id").bind(ts, ex.id).all();
      if (!u.results.length) return ok([], 200);
      await app.db.prepare("UPDATE consent_grants SET revoked_at=? WHERE mission_id=? AND action='reveal' AND revoked_at IS NULL").bind(ts, m.id).run();
      await transition(app.db, m.id, "external_permission_needed", "partner", { handler: "operator" });
      return ok(await notifyMember(app, m.member_id, `fedrel:${ex.id}`, (a) => ({ text: a.released })));
    }
    return fail(400, "status");
  }

  // approval / withdraw: we are the provider; the URL id is the requester's exchange id.
  const ex = await app.db.prepare("SELECT * FROM federation_exchanges WHERE partner_id=? AND remote_id=? AND direction='in'").bind(p.id, msg.exchange_id).first<Exchange>();
  if (!ex) return fail(404, "unknown_exchange");
  if (msg.type === "withdraw") {
    const c = await liveCommitment(app.db, { exchangeId: ex.id });
    if (c) await release(app.db, c.id, "cancelled");
    // Deletion propagation (I09): drop the summary and contact we hold for them.
    const u = await app.db
      .prepare("UPDATE federation_exchanges SET state='withdrawn', contact=NULL, summary='[withdrawn]', envelope='{}', updated_at=? WHERE id=? AND state NOT IN ('withdrawn','delivered') RETURNING id")
      .bind(ts, ex.id)
      .all();
    if (!u.results.length) return ok([], 200);
    return ok(await notifyOwners(app, `fedwd:${ex.id}`, (a) => ({ text: a.inboundWithdrawn(brand) })));
  }
  // approval: the requester chose our offer and consented to reveal their contact to us.
  const consent = msg.body.consent as { action?: string; fields?: unknown } | undefined;
  const contact = String(msg.body.contact ?? "");
  if (consent?.action !== "reveal" || !Array.isArray(consent.fields) || !consent.fields.includes("contact")) return fail(400, "consent");
  if (!/^(tg:\/\/user\?id=\d{1,15}|https:\/\/t\.me\/[A-Za-z0-9_]{4,32})( @[A-Za-z0-9_]{4,32})?$/.test(contact)) return fail(400, "contact");
  if (ex.state !== "offered" || !ex.capability_offer_id) return fail(409, "state");
  const cid = await reserve(app.db, ex.capability_offer_id, { exchangeId: ex.id });
  if (!cid) {
    await app.db.prepare("UPDATE federation_exchanges SET state='declined', updated_at=? WHERE id=?").bind(ts, ex.id).run();
    const keys = await enqueue(app, p, "decline", ex.remote_id!, { reason: "capacity" }, `dec:${ex.id}`, ex.expires_at);
    keys.push(...(await notifyOwners(app, `fedfull:${ex.id}`, (a) => ({ text: a.capacityFull }))));
    return ok(keys);
  }
  await app.db.prepare("UPDATE federation_exchanges SET state='committed', contact=?, updated_at=? WHERE id=?").bind(contact, ts, ex.id).run();
  const keys = await enqueue(app, p, "commitment", ex.remote_id!, { status: "committed" }, `cm:committed:${ex.id}`, ex.expires_at);
  const link = contact.startsWith("tg://") ? `<a href="${escapeHtml(contact.split(" ")[0]!)}">${escapeHtml(contact.split(" ")[1] ?? "contact")}</a>` : escapeHtml(contact);
  keys.push(
    ...(await notifyOwners(app, `fedok:${ex.id}`, (a) => ({
      text: `${a.deskInbound(brand, escapeHtml(ex.job_code), escapeHtml(ex.summary))}\n\n${a.inboundApproved(link)}`,
      buttons: [[b(a.bDelivered, `x:${ex.id}:v`), b(a.bRelease, `x:${ex.id}:r`)]],
    }))),
  );
  return ok(keys);
}

// ---- HTTP + housekeeping ---------------------------------------------------------------------

export async function nodeManifest(app: App): Promise<Record<string, unknown>> {
  const pub = app.env.FEDERATION_PUBLIC_KEY ?? null;
  // Categories only: no people, no counts, no capacity (I13 anti-enumeration).
  const { results } = await app.db.prepare("SELECT DISTINCT job_code FROM capability_offers WHERE org_id='home' AND status='published' AND expires_at>?").bind(nowIso()).all<{ job_code: string }>();
  return {
    schema: "nexus.node.v1",
    node_id: nodeId(app.env),
    protocol_versions: [SCHEMA],
    public_keys: pub ? [{ alg: "Ed25519", key: pub }] : [],
    categories: results.map((r) => r.job_code).sort(),
    policies: { forwarding: "prohibited", max_hops: 1, contact_reveal: "requester_consent_only", inbound_per_partner_day: INBOUND_PER_PARTNER_DAY },
    routes: ["/v1/opportunities/inquiries", "/v1/opportunities/{id}/offers", "/v1/opportunities/{id}/approvals", "/v1/commitments/{id}/events", "/v1/exchanges/{id}/withdraw"],
  };
}

/** Route a federation HTTP request; null when the path isn't a federation path. */
export async function handleFederation(req: Request, app: App): Promise<{ response: Response; keys: string[] } | null> {
  const url = new URL(req.url);
  const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
  const isFed = url.pathname === "/.well-known/nexus-node.json" || url.pathname.startsWith("/v1/");
  if (!isFed) return null;
  if (!fedEnabled(app.env)) return { response: new Response("not found", { status: 404 }), keys: [] };
  if (req.method === "GET" && url.pathname === "/.well-known/nexus-node.json") return { response: json(await nodeManifest(app)), keys: [] };
  if (req.method === "GET" && url.pathname === "/v1/capabilities") return { response: json({ categories: (await nodeManifest(app)).categories }), keys: [] };
  if (req.method !== "POST") return { response: new Response("not found", { status: 404 }), keys: [] };
  const routes: [RegExp, MessageType[]][] = [
    [/^\/v1\/opportunities\/inquiries$/, ["inquiry"]],
    [/^\/v1\/opportunities\/([\w-]{1,64})\/offers$/, ["offer", "decline"]],
    [/^\/v1\/opportunities\/([\w-]{1,64})\/approvals$/, ["approval"]],
    [/^\/v1\/commitments\/([\w-]{1,64})\/events$/, ["commitment"]],
    [/^\/v1\/exchanges\/([\w-]{1,64})\/withdraw$/, ["withdraw"]],
  ];
  const hit = routes.map(([re, types]) => ({ m: re.exec(url.pathname), types })).find((r) => r.m);
  if (!hit) return { response: new Response("not found", { status: 404 }), keys: [] };
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return { response: json({ ok: false, reason: "too_large" }, 413), keys: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { response: json({ ok: false, reason: "json" }, 400), keys: [] };
  }
  const r = await receive(app, raw, { types: hit.types, id: hit.m![1] });
  return { response: json(r.body, r.status), keys: r.keys };
}

/** Expire stale exchanges and nonces (cron). */
export async function expireExchanges(db: D1Database, now = nowIso()): Promise<number> {
  const [a] = await db.batch([
    db.prepare("UPDATE federation_exchanges SET state='expired', contact=NULL, updated_at=? WHERE expires_at<=? AND state IN ('sent','offered','received','selected') RETURNING id").bind(now, now),
    db.prepare("DELETE FROM fed_nonces WHERE expires_at<=?").bind(now),
  ]);
  return a!.results.length;
}

