// Portal routes for Hydra heads (H1, H2, H5, H6). Mounted by continuity/portal.ts, which owns the
// session cookie and the CSRF header check.

import type { App } from "../bot";
import { dispatchPending } from "../outbox";
import { escapeHtml } from "../text";
import { nowIso } from "../util";
import { hmacHex, recoveryCode } from "../continuity/crypto";
import { currentManifest, currentRoot } from "../continuity/identity";
import { checkCode, ContinuityError, protection } from "../continuity/people";
import { availableHeads, ntfyServers } from "./deliver";
import { expandDomains, independentCount, suggestHeads } from "./domains";
import { registry } from "./graph";
import { acceptBuddy, addHead, buddiesOf, endBuddy, inviteBuddy, newNtfyTopic, type AddableKind } from "./heads";
import {
  addGuardian, answerGuardian, approveRecovery, cancelOwnRecoveries, challenge, checkHandleCode, claimRecovery, confirmTotp, enrolTotp, ensureHandle, guardianView, LoginError,
  loginDevice, loginTotp, registerDevice, removeGuardian, requestHandleLogin, revokeFactor, setGuardianK, startRecovery,
} from "./login";
import { anchorRecord } from "./notices";
import { qrSvg } from "./qr";
import { presentReceipts, receiptsFor } from "./receipts";
import { KIND_LABEL, recentlyHit } from "./regrow";

type Json = (d: unknown, status?: number) => Response;
type Login = (personId: string, method: string, extra?: Record<string, unknown>) => Promise<Response>;

const flush = (app: App, keys: string[]) => (keys.length ? dispatchPending(app.db, app.tg, 5, keys).catch(() => 0) : Promise.resolve(0));

/** Routes that start a session without email or Telegram. */
export async function hydraPublic(app: App, route: string, body: Record<string, unknown>, json: Json, login: Login): Promise<Response | null> {
  const s = (k: string) => String(body[k] ?? "");
  if (route === "login/handle") {
    const r = await requestHandleLogin(app, s("handle"));
    await flush(app, r.keys);
    return json({ ok: true, ticket: r.ticket });
  }
  if (route === "login/handle/verify") {
    const p = await checkHandleCode(app, s("ticket"), s("code"));
    return p ? login(p, "head_code") : json({ ok: false }, 401);
  }
  if (route === "login/totp") {
    const p = await loginTotp(app, s("handle"), s("code"));
    return p ? login(p, "totp") : json({ ok: false }, 401);
  }
  if (route === "login/challenge") return json(await challenge(app.db));
  if (route === "login/device") {
    const p = await loginDevice(app, s("factor"), s("challenge"), s("sig"));
    return p ? login(p, "device_key") : json({ ok: false }, 401);
  }
  if (route === "recover/guardians") {
    const r = await startRecovery(app, s("handle"));
    await flush(app, r.keys);
    return json({ ok: true, ticket: r.ticket });
  }
  if (route === "recover/guardians/claim") {
    const r = await claimRecovery(app, s("ticket"));
    if (r.status === "ready") return login(r.personId!, "guardians");
    return json({ ok: false, status: r.status, approvals: r.approvals, needed: r.needed, not_before: r.notBefore }, r.status === "invalid" ? 404 : 200);
  }
  return null;
}

export async function hydraAuthed(app: App, personId: string, method: string, route: string, body: Record<string, unknown>, json: Json): Promise<Response | null> {
  const s = (k: string) => String(body[k] ?? "");
  try {
    if (method === "GET" && route === "hydra") {
      const p = await protection(app.env, app.db, personId);
      const reg = await registry(app.db);
      const tg = !!(await app.db.prepare("SELECT 1 FROM identity_links WHERE person_id=? AND platform='telegram' AND revoked_at IS NULL").bind(personId).first());
      const heads = p.heads.filter((h) => h.status === "verified" && h.health !== "dead").map((h) => expandDomains(h.domains.length ? h.domains : [`${h.channel}:unknown`], reg));
      if (tg) heads.push(expandDomains(["telegram"], reg));
      const avail = availableHeads(app.env);
      const suggested = suggestHeads(heads, [...avail, { kind: "buddy" as const, domain: "people" }], await recentlyHit(app.db), 2);
      return json({
        handle: await ensureHandle(app.db, personId),
        independent: independentCount(heads),
        telegram: tg,
        heads: p.heads,
        factors: p.factors,
        available: avail.map((a) => a.kind),
        suggested: suggested.map((k) => ({ kind: k, label: KIND_LABEL[k] ?? k })),
        vapid: app.env.VAPID_PUBLIC_KEY ?? null,
        ntfy: ntfyServers(app.env)[0] ?? null,
        buddies: await buddiesOf(app, personId),
        guardians: await guardianView(app.db, personId),
      });
    }
    if (method === "GET" && route === "ntfy-topic") return json({ topic: newNtfyTopic(app) });
    if (method === "POST" && route === "head") {
      const r = await addHead(app, personId, s("kind") as AddableKind, s("address"), body.keys as { p256dh?: string; auth?: string } | undefined);
      return json({ ok: true, registration: r.registrationId, sent: r.sent });
    }
    if (method === "POST" && route === "head/verify") return json({ ok: (await checkCode(app, s("registration"), s("code"), "verify")) === personId });
    if (method === "POST" && route === "totp") return json({ ok: true, ...(await (async () => {
      const t = await enrolTotp(app, personId, s("label") || "Authenticator");
      return { ...t, qr: `data:image/svg+xml;base64,${btoa(qrSvg(t.uri, 4))}` };
    })()) });
    if (method === "POST" && route === "totp/confirm") return json({ ok: await confirmTotp(app, personId, s("id"), s("code")) });
    if (method === "POST" && route === "device") return json({ ok: true, id: await registerDevice(app, personId, body.jwk, s("label")) });
    if (method === "POST" && route === "factor/revoke") return json({ ok: await revokeFactor(app.db, personId, s("id")) });
    if (method === "POST" && route === "buddy/invite") return json({ ok: true, code: await inviteBuddy(app, personId, s("label")) });
    if (method === "POST" && route === "buddy/accept") return json({ ok: await acceptBuddy(app, personId, s("code"), s("label")) });
    if (method === "POST" && route === "buddy/end") return json({ ok: await endBuddy(app.db, personId, s("id")) });
    if (method === "POST" && route === "guardian/add") return json({ ok: await addGuardian(app, personId, s("handle")) });
    if (method === "POST" && route === "guardian/answer") return json({ ok: await answerGuardian(app.db, personId, s("handle"), body.accept === true) });
    if (method === "POST" && route === "guardian/remove") return json({ ok: await removeGuardian(app.db, personId, s("handle")) });
    if (method === "POST" && route === "guardian/k") return json({ ok: await setGuardianK(app.db, personId, Number(body.k)) });
    if (method === "POST" && route === "guardian/approve") return json({ ok: await approveRecovery(app.db, personId, s("request")) });
    if (method === "POST" && route === "recovery/cancel-all") return json({ ok: true, cancelled: await cancelOwnRecoveries(app.db, personId) });
    if (method === "GET" && route === "receipts") return json({ receipts: await receiptsFor(app, personId) });
    if (method === "POST" && route === "receipts") return json({ ok: true, ...(await presentReceipts(app, personId, Array.isArray(body.receipts) ? body.receipts : [])) });
  } catch (e) {
    if (e instanceof ContinuityError || e instanceof LoginError) return json({ ok: false, reason: e.message }, 400);
    throw e;
  }
  return null;
}

// ---- service worker (Web Push) ---------------------------------------------------------------

export const SERVICE_WORKER = `self.addEventListener("push",function(e){var d={};try{d=e.data.json()}catch(x){d={title:"Notice",body:e.data?e.data.text():""}}e.waitUntil(self.registration.showNotification(d.title||"Notice",{body:d.body||"",data:{url:d.url||"/portal"}}))});
self.addEventListener("notificationclick",function(e){e.notification.close();var u=(e.notification.data&&e.notification.data.url)||"/portal";e.waitUntil(clients.openWindow(u))});
`;

// ---- printed recovery card (H6: the head nothing online can cut) --------------------------------

export const MAX_UNUSED_CODES = 12;

export async function recoveryCard(app: App, personId: string): Promise<string> {
  const handle = await ensureHandle(app.db, personId);
  const o = (app.env.PUBLIC_URL ?? "").replace(/\/$/, "");
  const unused = (await app.db.prepare("SELECT COUNT(*) AS n FROM recovery_codes WHERE person_id=? AND used_at IS NULL").bind(personId).first<{ n: number }>())?.n ?? 0;
  let code: string | null = null;
  if (unused < MAX_UNUSED_CODES) {
    code = recoveryCode();
    await app.db.prepare("INSERT INTO recovery_codes(person_id, code_hash) VALUES (?,?)").bind(personId, await hmacHex(app.env.CONTINUITY_KEY, "recovery", code)).run();
  }
  const root = await currentRoot(app.db);
  const m = await currentManifest(app.db);
  const places = (m?.signed.destinations ?? []).map((d) => `<li>${d.role === "primary" ? "<b>" : ""}${escapeHtml(d.kind)}: ${escapeHtml(d.url)}${d.role === "primary" ? "</b>" : ""}</li>`).join("");
  const anchor = await anchorRecord(app.db);
  const label = app.env.COMMUNITY_LABEL || "Community";
  const qr = qrSvg(`${o}/portal#h=${handle}`, 4);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Recovery card</title><style>body{font:14px/1.4 system-ui,sans-serif;max-width:640px;margin:16px auto;padding:0 16px;color:#000;background:#fff}.card{border:2px solid #000;border-radius:12px;padding:16px;display:grid;grid-template-columns:auto 1fr;gap:16px}code,.mono{font-family:ui-monospace,monospace}h1{font-size:18px;margin:0 0 6px}ul{margin:4px 0;padding-left:18px}.big{font-size:20px;font-weight:700;letter-spacing:1px}.m{color:#444;font-size:12px}@media print{button{display:none}}</style></head><body>
<div class="card"><div>${qr}</div><div><h1>${escapeHtml(label)}: recovery card</h1>
<div>Passport id</div><div class="big mono">${escapeHtml(handle)}</div>
${code ? `<div style="margin-top:8px">One-time recovery code</div><div class="big mono">${escapeHtml(code)}</div>` : `<p class="m">You already have ${unused} unused recovery codes; no new one was added.</p>`}
<p class="m">Keep this card offline. With the passport id and the code you can log in at the portal even if Telegram, email and this website are gone (the QR opens the portal).</p></div></div>
<h3>Official places (signed${m ? ` list v${m.signed.version}` : ""})</h3><ul>${places || "<li>none published</li>"}</ul>
<h3>How to check it's really us</h3><p class="m">The club key ids are <span class="mono">${escapeHtml(root?.signed.root_keys.map((k) => k.keyid).join(", ") ?? "—")}</span> (${root?.signed.threshold ?? "?"} needed). Any official address list must be signed by them. Anchor record:</p><p class="mono m" style="word-break:break-all">${escapeHtml(anchor ?? "—")}</p>
<p class="m">Printed ${nowIso().slice(0, 10)}.</p><button onclick="print()">Print</button></body></html>`;
}
