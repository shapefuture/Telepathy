// Independent portal (CONT-3/4/6): works with Telegram down. Login by email code or a one-time
// recovery code; session cookie is HttpOnly + Secure + SameSite=Strict, scoped to /portal, and
// every POST also needs the x-portal header (no cross-site forms). Owners can send a continuity
// alert only with two different factors used within 15 minutes.

import type { App } from "../bot";
import { ownerIds } from "../env";
import { confirmAlert, createAlert, AlertError } from "./alerts";
import { hmacHex } from "./crypto";
import { currentManifest } from "./identity";
import { activeAttestations, addEmail, forgetPerson, checkCode, ContinuityError, endSession, newSession, personalExport, protection, requestLogin, revokeEndpoint, sessionPerson, setTopic, TOPICS, useRecoveryCode, type Topic } from "./people";

const COOKIE = "tp_s";
const json = (d: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
const html = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": CSP, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
const cookieOf = (req: Request) => /(?:^|;\s*)tp_s=([A-Za-z0-9_-]{20,100})/.exec(req.headers.get("cookie") ?? "")?.[1] ?? null;
const setCookie = (token: string, maxAge: number) => `${COOKIE}=${token}; Path=/portal; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

async function isOwnerPerson(app: App, personId: string): Promise<boolean> {
  const ids = [...ownerIds(app.env)];
  if (!ids.length) return false;
  const r = await app.db.prepare("SELECT 1 FROM identity_links l JOIN members m ON m.id=l.account_id WHERE l.person_id=? AND l.revoked_at IS NULL AND m.tg_id IN (SELECT value FROM json_each(?))").bind(personId, JSON.stringify(ids)).first();
  return !!r;
}

export async function handlePortal(req: Request, app: App): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;
  if (!app.env.CONTINUITY_KEY) return new Response("not found", { status: 404 });
  if (req.method === "GET" && p === "/portal") return html(PAGE);

  // One-click unsubscribe (RFC 8058): GET shows a button, POST does it. Token is an HMAC; no login.
  if (p === "/portal/unsub") {
    const t = url.searchParams.get("t") ?? "";
    const [reg, topic, mac] = t.split(".");
    const valid = !!reg && TOPICS.includes(topic as Topic) && mac === (await hmacHex(app.env.CONTINUITY_KEY, "unsub", `${reg}:${topic}`)).slice(0, 32);
    if (!valid) return html(simple("Link not valid", "This unsubscribe link is not valid or has expired."), 400);
    if (req.method === "POST") {
      const r = await app.db.prepare("SELECT person_id FROM delivery_registrations WHERE id=?").bind(reg).first<{ person_id: string }>();
      if (r) await setTopic(app, r.person_id, topic as Topic, false);
      return html(simple("Unsubscribed", `You won't receive “${topic}” messages any more. Restoring an old backup can't turn this back on.`));
    }
    return html(simple("Unsubscribe?", `Stop “${topic}” messages from this community.`, `<form method="post"><button>Unsubscribe</button></form>`));
  }
  if (req.method === "GET" && p === "/portal/confirm") {
    const ok = await confirmAlert(app, url.searchParams.get("t") ?? "");
    return html(ok ? simple("Thank you", "Confirmed: you can reach your community without Telegram.") : simple("Already confirmed", "This link was used or isn't valid."));
  }
  if (!p.startsWith("/portal/api/")) return new Response("not found", { status: 404 });
  if (req.method === "POST" && req.headers.get("x-portal") !== "1") return json({ error: "forbidden" }, 403);
  const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {};
  const route = p.slice("/portal/api/".length);

  // ---- unauthenticated: start a login ----
  if (route === "login" && req.method === "POST") {
    const r = await requestLogin(app, String(body.email ?? ""));
    // Same answer whether or not the address is registered: a ticket either way.
    const ticket = r.registrationId ?? (await hmacHex(app.env.CONTINUITY_KEY, "fake", String(body.email ?? ""))).slice(0, 32);
    return json({ ok: true, ticket });
  }
  if (route === "verify" && req.method === "POST") {
    const person = await checkCode(app, String(body.ticket ?? ""), String(body.code ?? ""), "login");
    if (!person) return json({ ok: false }, 401);
    const token = await newSession(app.env, app.db, person, "email_code");
    return json({ ok: true }, 200, { "set-cookie": setCookie(token, 30 * 86400) });
  }
  if (route === "recover" && req.method === "POST") {
    const person = await useRecoveryCode(app.env, app.db, String(body.code ?? ""));
    if (!person) return json({ ok: false }, 401);
    const token = await newSession(app.env, app.db, person, "recovery_code");
    return json({ ok: true }, 200, { "set-cookie": setCookie(token, 30 * 86400) });
  }

  // ---- authenticated ----
  const token = cookieOf(req);
  const s = await sessionPerson(app.env, app.db, token);
  if (!s) return json({ error: "login required" }, 401);
  const owner = await isOwnerPerson(app, s.personId);
  if (route === "me" && req.method === "GET") {
    const m = await currentManifest(app.db);
    return json({
      protection: await protection(app.env, app.db, s.personId),
      memberships: await activeAttestations(app.db, s.personId),
      destinations: m?.signed.destinations ?? [],
      manifestVersion: m?.signed.version ?? null,
      community: app.env.COMMUNITY_LABEL || "Community",
      owner,
      strong: s.methods.includes("email_code") && s.methods.includes("recovery_code"),
    });
  }
  if (route === "topic" && req.method === "POST") {
    if (!TOPICS.includes(body.topic as Topic)) return json({ ok: false }, 400);
    await setTopic(app, s.personId, body.topic as Topic, body.on === true);
    return json({ ok: true });
  }
  if (route === "email" && req.method === "POST") {
    try {
      const r = await addEmail(app, s.personId, String(body.email ?? ""));
      return json({ ok: true, registration: r.registrationId, sent: r.sent });
    } catch (e) {
      if (e instanceof ContinuityError) return json({ ok: false, reason: e.message }, 400);
      throw e;
    }
  }
  if (route === "email/verify" && req.method === "POST") return json({ ok: !!(await checkCode(app, String(body.registration ?? ""), String(body.code ?? ""), "verify")) });
  if (route === "revoke" && req.method === "POST") return json({ ok: await revokeEndpoint(app.db, s.personId, String(body.registration ?? "")) });
  if (route === "export" && req.method === "GET") return json(await personalExport(app.env, app.db, s.personId), 200, { "content-disposition": "attachment; filename=my-community-relationship.json" });
  if (route === "forget" && req.method === "POST" && body.confirm === "forget") {
    await forgetPerson(app.db, s.personId);
    return json({ ok: true }, 200, { "set-cookie": setCookie("x".repeat(20), 0) });
  }
  if (route === "logout" && req.method === "POST") {
    if (token) await endSession(app.env, app.db, token);
    return json({ ok: true }, 200, { "set-cookie": setCookie("x".repeat(20), 0) });
  }
  if (route === "alert" && req.method === "POST") {
    if (!owner) return json({ error: "owners only" }, 403);
    if (!(s.methods.includes("email_code") && s.methods.includes("recovery_code"))) return json({ ok: false, reason: "strong_auth_required" }, 403);
    const kind = body.kind === "relocation" ? "relocation" : "incident";
    try {
      const r = await createAlert(app, kind, String(body.note ?? ""), `portal:${s.personId}`);
      return json({ ok: true, ...r });
    } catch (e) {
      if (e instanceof AlertError) return json({ ok: false, reason: e.message }, 409);
      throw e;
    }
  }
  return json({ error: "not found" }, 404);
}

const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const STYLE = "<style>body{font:16px/1.45 system-ui,sans-serif;max-width:560px;margin:0 auto;padding:20px;color:#111;background:#f4f5f7}@media(prefers-color-scheme:dark){body{background:#16181c;color:#eee}.c{background:#22252b!important}input{background:#16181c;color:#eee}}.c{background:#fff;border-radius:14px;padding:16px;margin:12px 0}button{font:inherit;border:0;border-radius:10px;padding:10px 16px;background:#2a7ae2;color:#fff;cursor:pointer}button.s{background:#8882;color:inherit}input{font:inherit;width:100%;box-sizing:border-box;padding:10px;border:1px solid #8884;border-radius:10px;margin:6px 0}.m{color:#888;font-size:14px}.ok{color:#1a7f37}.w{color:#b26a00}label{display:flex;justify-content:space-between;padding:8px 0}a{color:#2a7ae2}</style>";
const simple = (title: string, text: string, extra = "") => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>${STYLE}</head><body><div class="c"><h2>${esc(title)}</h2><p>${esc(text)}</p>${extra}</div></body></html>`;

// Plain page; all dynamic text goes through textContent.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Community portal</title>${STYLE}</head><body>
<h1 id="h">Community portal</h1><div id="v"></div>
<script>
"use strict";
var v=document.getElementById("v");
function h(t,a){var e=document.createElement(t);a=a||{};for(var k in a){if(k==="text")e.textContent=a[k];else if(k.slice(0,2)==="on")e.addEventListener(k.slice(2),a[k]);else e.setAttribute(k,a[k])}
 for(var i=2;i<arguments.length;i++){var c=arguments[i];if(c==null)continue;if(Array.isArray(c))c.forEach(function(x){x&&e.append(x)});else e.append(typeof c==="string"?document.createTextNode(c):c)}return e}
function api(m,p,b){return fetch("/portal/api/"+p,{method:m,headers:{"content-type":"application/json","x-portal":"1"},credentials:"same-origin",body:b?JSON.stringify(b):undefined}).then(function(r){return r.json().then(function(j){j._status=r.status;return j})})}
var TOP={critical:"Critical notices (address changes, outages)",events:"Events",requests:"Updates on my requests",news:"Community news",commercial:"Offers from the community",partner_offers:"Offers from partner communities"};
var LV={protected:["ok","Protected: you can log in and be reached without Telegram."],login_only:["w","You can log in without Telegram, but critical notices have no verified route."],not_yet_protected:["w","Not yet protected: add and verify an email."],not_enrolled:["w","Not enrolled."]};
function login(){var email=h("input",{type:"email",placeholder:"you@example.com",autocomplete:"email"});var code=h("input",{inputmode:"numeric",placeholder:"6-digit code",style:"display:none"});var ticket=null;var msg=h("p",{class:"m"});
 var go=h("button",{text:"Send code",onclick:function(){if(!ticket){api("POST","login",{email:email.value}).then(function(r){ticket=r.ticket;code.style.display="";go.textContent="Log in";msg.textContent="If this address is registered, a code is on its way."})}
  else api("POST","verify",{ticket:ticket,code:code.value}).then(function(r){if(r.ok)load();else msg.textContent="That code didn't work."})}});
 var rc=h("input",{placeholder:"XXXX-XXXX-XXXX"});var rm=h("p",{class:"m"});
 v.replaceChildren(h("div",{class:"c"},h("b",{text:"Log in with email"}),email,code,go,msg),h("div",{class:"c"},h("b",{text:"Or use a recovery code"}),rc,h("button",{class:"s",text:"Use recovery code",onclick:function(){api("POST","recover",{code:rc.value}).then(function(r){if(r.ok)load();else rm.textContent="Not valid or already used."})}}),rm))}
function load(){api("GET","me").then(function(d){if(d._status===401){login();return}document.getElementById("h").textContent=d.community;var p=d.protection;var lv=LV[p.level];
 var dest=h("div",{class:"c"},h("b",{text:"Official places"+(d.manifestVersion?" (signed list v"+d.manifestVersion+")":"")}),d.destinations.length?d.destinations.map(function(x){return h("div",null,h("span",{class:"m",text:x.role+" · "+x.kind+" "}),h("a",{href:x.url,rel:"noopener",text:x.url}))}):h("p",{class:"m",text:"None published yet."}));
 var st=h("div",{class:"c"},h("b",{class:lv[0],text:lv[1]}),h("p",{class:"m",text:"Recovery codes left: "+p.recoveryCodes}),d.memberships.length?h("p",{text:"Member: "+d.memberships.map(function(m){return m.tier+" until "+m.expires_at.slice(0,10)}).join(", ")}):h("p",{class:"m",text:"No current membership on record. Your news subscription stays yours either way."}));
 var tops=h("div",{class:"c"},h("b",{text:"What you receive"}),Object.keys(TOP).map(function(t){var c=h("input",{type:"checkbox",style:"width:auto"});c.checked=p.topics[t]==="following";c.addEventListener("change",function(){api("POST","topic",{topic:t,on:c.checked})});return h("label",null,TOP[t],c)}));
 var em=h("div",{class:"c"},h("b",{text:"Email addresses"}),p.emails.map(function(e){return h("div",null,e.address+" · "+e.status+" ",h("button",{class:"s",text:"Remove",onclick:function(){api("POST","revoke",{registration:e.id}).then(load)}}))}));
 var own=d.owner?h("div",{class:"c"},h("b",{text:"Operator: continuity alert"}),h("p",{class:"m",text:d.strong?"Strong login confirmed.":"Needs both an email code and a recovery code in the last 15 minutes. Log out and log in with the other factor too."}),
  (function(){var note=h("input",{placeholder:"Short note (optional)"});var out=h("p",{class:"m"});return h("div",null,note,h("button",{text:"Send incident notice",onclick:function(){api("POST","alert",{kind:"incident",note:note.value}).then(function(r){out.textContent=r.ok?"Queued for "+r.queued+" deliveries.":"Not sent: "+(r.reason||r.error)})}}),
   h("button",{class:"s",text:"Send relocation notice",onclick:function(){api("POST","alert",{kind:"relocation",note:note.value}).then(function(r){out.textContent=r.ok?"Queued for "+r.queued+" deliveries.":"Not sent: "+(r.reason||r.error)})}}),out)})()):null;
 v.replaceChildren(st,dest,tops,em,own,h("div",{class:"c"},h("a",{href:"/portal/api/export",text:"Download my data"})," · ",h("a",{href:"#",text:"Log out",onclick:function(e){e.preventDefault();api("POST","logout").then(login)}})," · ",
   h("a",{href:"#",text:"Delete my relationship",onclick:function(e){e.preventDefault();if(confirm("Delete your addresses, subscriptions and login? Your addresses stay blocked from future messages."))api("POST","forget",{confirm:"forget"}).then(login)}})))})}
load();
</script></body></html>`;

