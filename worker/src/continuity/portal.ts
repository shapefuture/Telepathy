// Independent portal (CONT-3/4/6): works with Telegram down. Login by email code or a one-time
// recovery code; session cookie is HttpOnly + Secure + SameSite=Strict, scoped to /portal, and
// every POST also needs the x-portal header (no cross-site forms). Owners can send a continuity
// alert only with two different factors used within 15 minutes.

import type { App } from "../bot";
import { ownerIds } from "../env";
import { defaultLang } from "../i18n";
import { confirmAlert, createAlert, AlertError } from "./alerts";
import { hmacHex } from "./crypto";
import { currentManifest } from "./identity";
import { activeAttestations, addEmail, forgetPerson, checkCode, ContinuityError, endSession, newSession, personalExport, protection, requestLogin, revokeEndpoint, sessionPerson, setTopic, TOPICS, useRecoveryCode, type Topic } from "./people";
import { hydraAuthed, hydraPublic, recoveryCard, SERVICE_WORKER } from "../hydra/portal";
import { cancelRecovery } from "../hydra/login";
import { receiptsFor } from "../hydra/receipts";
import { touchOwners } from "../hydra/notices";

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
  if (req.method === "GET" && p === "/portal/sw.js") return new Response(SERVICE_WORKER, { headers: { "content-type": "application/javascript; charset=utf-8", "service-worker-allowed": "/portal/", "cache-control": "no-cache" } });
  if (p === "/portal/recovery/cancel") {
    const t = url.searchParams.get("t") ?? "";
    if (req.method === "POST") return html((await cancelRecovery(app, t)) ? simple(L("Stopped", "Отменено"), L("The recovery request was cancelled. Nobody can use it now.", "Запрос на восстановление отменён. Им больше никто не воспользуется.")) : simple(L("Nothing to stop", "Нечего отменять"), L("This request was already finished, cancelled or isn't valid.", "Этот запрос уже завершён, отменён или недействителен.")));
    return html(simple(L("Stop this recovery?", "Отменить восстановление?"), L("Someone asked to recover your access through your guardians. If it wasn't you, stop it.", "Кто-то пытается вернуть доступ к твоему аккаунту через доверенных людей. Если это не ты — отмени."), `<form method="post"><button>${L("Stop it", "Отменить")}</button></form>`));
  }
  if (req.method === "GET" && p === "/portal/card") {
    const sc = await sessionPerson(app.env, app.db, cookieOf(req));
    if (!sc) return html(simple(L("Log in first", "Сначала войди"), L("Open the portal, log in, then print your card.", "Открой кабинет, войди и распечатай карточку.")), 401);
    return html(await recoveryCard(app, sc.personId));
  }

  // One-click unsubscribe (RFC 8058): GET shows a button, POST does it. Token is an HMAC; no login.
  if (p === "/portal/unsub") {
    const t = url.searchParams.get("t") ?? "";
    const [reg, topic, mac] = t.split(".");
    const valid = !!reg && TOPICS.includes(topic as Topic) && mac === (await hmacHex(app.env.CONTINUITY_KEY, "unsub", `${reg}:${topic}`)).slice(0, 32);
    if (!valid) return html(simple(L("Link not valid", "Ссылка не работает"), L("This unsubscribe link is not valid or has expired.", "Ссылка для отписки устарела или неверна.")), 400);
    if (req.method === "POST") {
      const r = await app.db.prepare("SELECT person_id FROM delivery_registrations WHERE id=?").bind(reg).first<{ person_id: string }>();
      if (r) await setTopic(app, r.person_id, topic as Topic, false);
      return html(simple(L("Unsubscribed", "Готово, ты отписан"), L(`You won't receive “${topic}” messages any more. Restoring an old backup can't turn this back on.`, `Сообщения «${topic}» больше не придут.`)));
    }
    return html(simple(L("Unsubscribe?", "Отписаться?"), L(`Stop “${topic}” messages from this community.`, `Больше не присылать сообщения «${topic}».`), `<form method="post"><button>${L("Unsubscribe", "Отписаться")}</button></form>`));
  }
  if (req.method === "GET" && p === "/portal/confirm") {
    const ok = await confirmAlert(app, url.searchParams.get("t") ?? "");
    return html(ok ? simple(L("Thank you", "Спасибо!"), L("Confirmed: you can reach your community without Telegram.", "Готово: теперь ты на связи с сообществом и без Telegram.")) : simple(L("Already confirmed", "Уже подтверждено"), L("This link was used or isn't valid.", "Ссылка уже использована или неверна.")));
  }
  if (!p.startsWith("/portal/api/")) return new Response("not found", { status: 404 });
  if (req.method === "POST" && req.headers.get("x-portal") !== "1") return json({ error: "forbidden" }, 403);
  const parsed: unknown = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const body = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  const route = p.slice("/portal/api/".length);

  // ---- unauthenticated: start a login ----
  if (route === "login" && req.method === "POST") {
    const r = await requestLogin(app, String(body.email ?? ""));
    // Same answer whether or not the address is registered: a ticket either way.
    // The fake has the shape of a real one (newId: a UUID v4 without dashes).
    const f = await hmacHex(app.env.CONTINUITY_KEY, "fake", String(body.email ?? ""));
    const ticket = r.registrationId ?? `${f.slice(0, 12)}4${f.slice(13, 16)}${"89ab"[parseInt(f[16]!, 16) & 3]}${f.slice(17, 32)}`;
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

  // Hydra login heads: passport id + code over any head, authenticator, device key, guardians.
  if (req.method === "POST") {
    const login = async (personId: string, method: string) => {
      const tk = await newSession(app.env, app.db, personId, method);
      if (await isOwnerPerson(app, personId)) await touchOwners(app.db);
      return json({ ok: true }, 200, { "set-cookie": setCookie(tk, 30 * 86400) });
    };
    const r = await hydraPublic(app, route, body, json, login);
    if (r) return r;
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
      strong: new Set(s.methods).size >= 2,
    });
  }
  const hy = await hydraAuthed(app, s.personId, req.method, route, body, json);
  if (hy) return hy;
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
  if (route === "email/verify" && req.method === "POST") return json({ ok: !!(await checkCode(app, String(body.registration ?? ""), String(body.code ?? ""), "verify", new Date(), s.personId)) });
  if (route === "revoke" && req.method === "POST") return json({ ok: await revokeEndpoint(app.db, s.personId, String(body.registration ?? "")) });
  if (route === "export" && req.method === "GET") return json({ ...(await personalExport(app.env, app.db, s.personId)), receipts: await receiptsFor(app, s.personId) }, 200, { "content-disposition": "attachment; filename=my-community-relationship.json" });
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
    if (new Set(s.methods).size < 2) return json({ ok: false, reason: "strong_auth_required" }, 403);
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

const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const L = (en: string, ru: string) => (defaultLang() === "ru" ? ru : en);
const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const STYLE = "<style>body{font:16px/1.45 system-ui,sans-serif;max-width:560px;margin:0 auto;padding:20px;color:#111;background:#f4f5f7}@media(prefers-color-scheme:dark){body{background:#16181c;color:#eee}.c{background:#22252b!important}input{background:#16181c;color:#eee}}.c{background:#fff;border-radius:14px;padding:16px;margin:12px 0}button{font:inherit;border:0;border-radius:10px;padding:10px 16px;margin:4px 4px 0 0;background:#2a7ae2;color:#fff;cursor:pointer}button.s{background:#8882;color:inherit}input{font:inherit;width:100%;box-sizing:border-box;padding:10px;border:1px solid #8884;border-radius:10px;margin:6px 0}.m{color:#888;font-size:14px}.ok{color:#1a7f37}.w{color:#b26a00}label{display:flex;justify-content:space-between;padding:8px 0}a{color:#2a7ae2}</style>";
const simple = (title: string, text: string, extra = "") => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>${STYLE}</head><body><div class="c"><h2>${esc(title)}</h2><p>${esc(text)}</p>${extra}</div></body></html>`;

// Plain page; all dynamic text goes through textContent. No template interpolation inside the
// script (no dollar-brace), and no backslash escapes: the test parses it with new Function.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Мой кабинет</title>${STYLE}</head><body>
<h1 id="h">Мой кабинет</h1><div id="v"></div>
<script>
"use strict";
var LANG=ls0();function ls0(){try{return localStorage.getItem("tp_lang")||"ru"}catch(x){return "ru"}}
var RU={"Critical notices (address changes, outages)": "Важное (переезд, сбои)", "Events": "События", "Updates on my requests": "Ответы на мои запросы", "Community news": "Новости сообщества", "Offers from the community": "Предложения от сообщества", "Offers from partner communities": "Предложения от друзей сообщества", "Protected: you can log in and be reached without Telegram.": "Всё в порядке: ты на связи даже без Telegram.", "You can log in without Telegram, but critical notices have no verified route.": "Войти без Telegram можно, но важные новости пока не дойдут.", "Not yet protected: add and verify a way to reach you.": "Добавь ещё один способ связи — на случай, если Telegram пропадёт.", "Not enrolled.": "Ты ещё не подключён.", "Browser notifications": "Уведомления в браузере", "ntfy app": "Приложение ntfy", "6-digit code": "Код из 6 цифр", "Send code": "Получить код", "Log in": "Войти", "If this address is registered, a code is on its way.": "Если эта почта у нас есть, код уже летит к тебе.", "That code didn't work.": "Код не подошёл. Попробуй ещё раз.", "Passport id, e.g. TP-7K2Q-9MXD": "Твой ID, например TP-7K2Q-9MXD", "code": "код", "Send a code to my other paths": "Прислать код в другое место", "If this passport exists, a code went to its browser, ntfy, Matrix, SMS or Telegram.": "Если такой ID есть, код придёт туда, где ты подключён.", "Authenticator code": "Код из приложения", "Log in with authenticator": "Войти по коду из приложения", "Not accepted. Check the passport id and the code.": "Не подошло. Проверь ID и код.", "This device": "Это устройство", "No device key here.": "Это устройство пока не запомнено.", "Log in with this device": "Войти с этого устройства", "This device key was not accepted.": "Устройство не узнали.", "Lost everything? Ask your guardians": "Потерял всё? Попроси доверенных людей", "Works only if you chose guardians before. They must approve, and your own paths get 24 hours to stop it.": "Работает, если ты заранее выбрал доверенных людей. Они подтверждают, а у тебя есть сутки, чтобы отменить.", "Check my recovery": "Проверить восстановление", "Start a guardian recovery": "Начать восстановление", "Asked. Tell your guardians, then come back here after 24 hours.": "Запрос отправлен. Напиши доверенным людям и вернись через сутки.", "Approvals: ": "Подтверждений: ", " of ": " из ", "; usable after ": "; можно после ", "No open request for this ticket.": "Открытых запросов нет.", "Log in with email": "Войти по почте", "Or with your passport id": "Или по своему ID", "Or a recovery code": "Или по запасному коду", "Use recovery code": "Войти по запасному коду", "Not valid or already used.": "Код неверный или уже использован.", "Add a way to reach you": "Добавь способ связи", "Suggested next (independent of what you have): ": "Советуем добавить: ", " and ": " и ", "You have independent paths covered.": "Способов связи достаточно 👍", "code from the new path": "код, который пришёл", "Confirm": "Подтвердить", "Confirmed.": "Готово!", "Not added: ": "Не получилось: ", "We sent a code over the new path. Enter it to confirm.": "Мы прислали код. Введи его, чтобы подтвердить.", "Browser notifications on this device": "Уведомления в этом браузере", "Notifications are blocked in this browser.": "Уведомления в браузере выключены.", "This browser couldn't subscribe.": "Этот браузер не смог подписаться.", "In the ntfy app, subscribe to: ": "В приложении ntfy подпишись на: ", " (keep it private). Then confirm with the code we send there.": " (никому не показывай). Потом введи код, который туда придёт.", "Add Matrix": "Добавить Matrix", "Add SMS": "Добавить SMS", "Add email": "Добавить почту", "Ways to log in without Telegram": "Как войти без Telegram", "Your passport id: ": "Твой ID: ", "Authenticator": "Приложение-аутентификатор", "Device key": "Устройство", "Remove": "Убрать", "Add authenticator app": "Добавить приложение-аутентификатор", "Or enter this key: ": "Или введи ключ: ", "Authenticator added.": "Приложение добавлено.", "Code not accepted.": "Код не подошёл.", "Remember this device": "Запомнить это устройство", "This device can now log you in.": "Теперь с этого устройства можно войти.", "This browser can't keep a device key.": "Этот браузер не умеет запоминать устройство.", "Print a recovery card": "Распечатать карточку восстановления", "How your buddy knows you, e.g. Anna from Tuesdays": "Как друг тебя знает, например «Аня со вторников»", "Buddy code": "Код друга", "Buddy: someone who passes critical notices on": "Друг, который передаст тебе важное", "End": "Завершить", "Create invite code": "Создать код приглашения", "Give this code to your buddy: ": "Отправь этот код другу: ", "Not created: ": "Не получилось: ", "Accept a code": "Принять код", "You're buddies now.": "Теперь вы друзья 🤝", "Code not valid (and fill in how they know you).": "Код не подошёл (и напиши, как вы знакомы).", "Guardian's passport id": "ID доверенного человека", "How many must approve (2 or more)": "Сколько должны подтвердить (от 2)", "Guardians (recover access if you lose everything)": "Доверенные люди (помогут вернуть доступ)", "Approvals needed: ": "Нужно подтверждений: ", "not set": "не задано", "Ask to be my guardian": "Позвать в доверенные", "Asked. They accept in their portal.": "Приглашение отправлено.", "Not found.": "Не нашли.", "Set approvals needed": "Сохранить", "Saved.": "Сохранено.", "Needs at least 2 and no more than your active guardians.": "Нужно от 2 и не больше, чем у тебя доверенных людей.", "You guard:": "Ты доверенный для:", "Accept": "Принять", "Decline": "Отказаться", "Recovery requested. Approve only if they contacted you directly. ": "Просят восстановить доступ. Подтверждай, только если человек сам тебе написал. ", "(approved)": "(подтверждено)", "Approve": "Подтвердить", "Stop any recovery of my access": "Отменить все попытки восстановления", "Stopped ": "Отменено: ", " request(s).": "", "Official places": "Официальные места", " (signed list v": " (подписанный список v", "None published yet.": "Пока ничего нет.", "Independent paths to you: ": "Способов связи с тобой: ", " (aim for 3: if one fails, the others still reach you)": " (лучше 3 — если один пропадёт, останутся другие)", "Recovery codes left: ": "Запасных кодов осталось: ", "Member: ": "Участник: ", " until ": " до ", "No current membership on record. Your news subscription stays yours either way.": "Членства сейчас нет. Подписка на новости всё равно твоя.", "What you receive": "Что тебе присылать", "Ways we reach you": "Как мы с тобой связываемся", "Telegram · linked": "Telegram · подключён", "Operator: continuity alert": "Для владельца: срочное оповещение", "Strong login confirmed.": "Надёжный вход подтверждён.", "Needs two different login methods in the last 15 minutes. Log out and log in with another method too.": "Нужно войти двумя разными способами за 15 минут. Выйди и войди ещё раз другим способом.", "Short note (optional)": "Короткая заметка (можно пропустить)", "Send incident notice": "Сообщить о сбое", "Queued for ": "Отправляем: ", " deliveries.": "", "Not sent: ": "Не отправлено: ", "Send relocation notice": "Сообщить о переезде", "Download my data": "Скачать мои данные", "Log out": "Выйти", "Delete my relationship": "Удалить мои данные", "Delete your addresses, subscriptions and login? Your addresses stay blocked from future messages.": "Удалить твои контакты, подписки и вход? Мы больше не будем тебе писать.", "Restore my choices from this device": "Вернуть мои настройки с этого устройства", "Restored ": "Восстановлено: ", " signed choices (": " (", " not accepted).": " не принято).", "Community portal": "Мой кабинет"};
function T(x){return LANG==="ru"&&RU[x]!=null?RU[x]:x}
var v=document.getElementById("v");
function h(t,a){var e=document.createElement(t);a=a||{};for(var k in a){if(k==="text")e.textContent=a[k];else if(k.slice(0,2)==="on")e.addEventListener(k.slice(2),a[k]);else e.setAttribute(k,a[k])}
 for(var i=2;i<arguments.length;i++){var c=arguments[i];if(c==null)continue;if(Array.isArray(c))c.forEach(function(x){x&&e.append(x)});else e.append(typeof c==="string"?document.createTextNode(c):c)}return e}
function api(m,p,b){return fetch("/portal/api/"+p,{method:m,headers:{"content-type":"application/json","x-portal":"1"},credentials:"same-origin",body:b?JSON.stringify(b):undefined}).then(function(r){return r.json().then(function(j){j._status=r.status;return j})})}
function inp(ph,t){return h("input",{placeholder:ph,type:t||"text"})}
function card(){return h.apply(null,["div",{class:"c"}].concat([].slice.call(arguments)))}
function msg(){return h("p",{class:"m"})}
function ls(k,val){try{if(val===undefined)return JSON.parse(localStorage.getItem(k)||"null");localStorage.setItem(k,JSON.stringify(val))}catch(x){return null}}
function b64u(buf){var s="";new Uint8Array(buf).forEach(function(x){s+=String.fromCharCode(x)});return btoa(s).split("+").join("-").split("/").join("_").split("=").join("")}
function unb64u(s){s=s.split("-").join("+").split("_").join("/");while(s.length%4)s+="=";var r=atob(s),o=new Uint8Array(r.length);for(var i=0;i<r.length;i++)o[i]=r.charCodeAt(i);return o}
function idb(){return new Promise(function(res,rej){var r=indexedDB.open("tp-portal",1);r.onupgradeneeded=function(){r.result.createObjectStore("k")};r.onsuccess=function(){res(r.result)};r.onerror=function(){rej(r.error)}})}
function kget(k){return idb().then(function(db){return new Promise(function(res){var t=db.transaction("k").objectStore("k").get(k);t.onsuccess=function(){res(t.result||null)};t.onerror=function(){res(null)}})}).catch(function(){return null})}
function kput(k,val){return idb().then(function(db){return new Promise(function(res){var t=db.transaction("k","readwrite").objectStore("k").put(val,k);t.onsuccess=function(){res(true)};t.onerror=function(){res(false)}})})}
var TOP={critical:T("Critical notices (address changes, outages)"),events:T("Events"),requests:T("Updates on my requests"),news:T("Community news"),commercial:T("Offers from the community"),partner_offers:T("Offers from partner communities")};
var LV={protected:["ok",T("Protected: you can log in and be reached without Telegram.")],login_only:["w",T("You can log in without Telegram, but critical notices have no verified route.")],not_yet_protected:["w",T("Not yet protected: add and verify a way to reach you.")],not_enrolled:["w",T("Not enrolled.")]};
var KIND={email:"Email",webpush:T("Browser notifications"),ntfy:T("ntfy app"),matrix:"Matrix",sms:"SMS"};
var hashHandle=(location.hash.match(/h=(TP-[A-Z0-9-]+)/)||[])[1]||"";
function login(){
 var email=inp("you@example.com","email");var code=inp(T("6-digit code"));code.style.display="none";var ticket=null;var m1=msg();
 var go=h("button",{text:T("Send code"),onclick:function(){if(!ticket){api("POST","login",{email:email.value}).then(function(r){ticket=r.ticket;code.style.display="";go.textContent=T("Log in");m1.textContent=T("If this address is registered, a code is on its way.")})}
  else api("POST","verify",{ticket:ticket,code:code.value}).then(function(r){if(r.ok)load();else m1.textContent=T("That code didn't work.")})}});
 var hd=inp(T("Passport id, e.g. TP-7K2Q-9MXD"));hd.value=hashHandle;var hc=inp(T("code"));hc.style.display="none";var ht=null;var m2=msg();
 var hgo=h("button",{text:T("Send a code to my other paths"),onclick:function(){if(!ht){api("POST","login/handle",{handle:hd.value}).then(function(r){ht=r.ticket;hc.style.display="";hgo.textContent=T("Log in");m2.textContent=T("If this passport exists, a code went to its browser, ntfy, Matrix, SMS or Telegram.")})}
  else api("POST","login/handle/verify",{ticket:ht,code:hc.value}).then(function(r){if(r.ok)load();else m2.textContent=T("That code didn't work.")})}});
 var tc=inp(T("Authenticator code"));var m3=msg();
 var tgo=h("button",{class:"s",text:T("Log in with authenticator"),onclick:function(){api("POST","login/totp",{handle:hd.value,code:tc.value}).then(function(r){if(r.ok)load();else m3.textContent=T("Not accepted. Check the passport id and the code.")})}});
 var dv=card(h("b",{text:T("This device")}),h("p",{class:"m",text:T("No device key here.")}));
 kget("dev").then(function(d){if(!d)return;var m4=msg();dv.replaceChildren(h("b",{text:T("This device")}),h("button",{text:T("Log in with this device"),onclick:function(){api("POST","login/challenge").then(function(c){return crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},d.key,new TextEncoder().encode("nexus-login:"+c.nonce)).then(function(sig){return api("POST","login/device",{factor:d.id,challenge:c.id,sig:b64u(sig)})})}).then(function(r){if(r.ok)load();else m4.textContent=T("This device key was not accepted.")})}}),m4)});
 var rc=inp("XXXX-XXXX-XXXX");var m5=msg();
 var gt=ls("tp_rec_ticket");var m6=msg();
 var gr=card(h("b",{text:T("Lost everything? Ask your guardians")}),h("p",{class:"m",text:T("Works only if you chose guardians before. They must approve, and your own paths get 24 hours to stop it.")}),
  h("button",{class:"s",text:gt?T("Check my recovery"):T("Start a guardian recovery"),onclick:function(){if(!gt){api("POST","recover/guardians",{handle:hd.value}).then(function(r){gt=r.ticket;ls("tp_rec_ticket",gt);m6.textContent=T("Asked. Tell your guardians, then come back here after 24 hours.")})}
   else api("POST","recover/guardians/claim",{ticket:gt}).then(function(r){if(r.ok){ls("tp_rec_ticket",null);load()}else if(r.status==="waiting")m6.textContent=T("Approvals: ")+r.approvals+T(" of ")+r.needed+T("; usable after ")+String(r.not_before).slice(0,16).replace("T"," ")+" UTC.";else{ls("tp_rec_ticket",null);gt=null;m6.textContent=T("No open request for this ticket.")}})}}),m6);
 v.replaceChildren(card(h("b",{text:T("Log in with email")}),email,code,go,m1),card(h("b",{text:T("Or with your passport id")}),hd,hgo,hc,m2,tc,tgo,m3),dv,
  card(h("b",{text:T("Or a recovery code")}),rc,h("button",{class:"s",text:T("Use recovery code"),onclick:function(){api("POST","recover",{code:rc.value}).then(function(r){if(r.ok)load();else m5.textContent=T("Not valid or already used.")})}}),m5),gr)}
function syncReceipts(){api("GET","receipts").then(function(r){if(r.receipts&&r.receipts.length)ls("tp_receipts",r.receipts)})}
function addHeadUI(d){
 var box=card(h("b",{text:T("Add a way to reach you")}),h("p",{class:"m",text:d.suggested.length?T("Suggested next (independent of what you have): ")+d.suggested.map(function(x){return x.label}).join(T(" and ")):T("You have independent paths covered.")}));
 var out=msg();var pend=null;var vc=inp(T("code from the new path"));vc.style.display="none";var vb=h("button",{text:T("Confirm"),style:"display:none",onclick:function(){api("POST","head/verify",{registration:pend,code:vc.value}).then(function(r){out.textContent=r.ok?T("Confirmed."):T("That code didn't work.");if(r.ok)load()})}});
 function started(r){if(!r.ok){out.textContent=T("Not added: ")+(r.reason||r.error);return}pend=r.registration;vc.style.display="";vb.style.display="";out.textContent=T("We sent a code over the new path. Enter it to confirm.")}
 if(d.vapid&&"serviceWorker" in navigator&&"PushManager" in window)box.append(h("button",{text:T("Browser notifications on this device"),onclick:function(){Notification.requestPermission().then(function(p){if(p!=="granted"){out.textContent=T("Notifications are blocked in this browser.");return}return navigator.serviceWorker.register("/portal/sw.js",{scope:"/portal/"}).then(function(){return navigator.serviceWorker.ready}).then(function(reg){return reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:unb64u(d.vapid)})}).then(function(sub){var j=sub.toJSON();return api("POST","head",{kind:"webpush",address:j.endpoint,keys:j.keys}).then(started)})}).catch(function(){out.textContent=T("This browser couldn't subscribe.")})}})," ");
 if(d.ntfy)box.append(h("button",{class:"s",text:T("ntfy app"),onclick:function(){api("GET","ntfy-topic").then(function(t){out.textContent=T("In the ntfy app, subscribe to: ")+t.topic+T(" (keep it private). Then confirm with the code we send there.");return api("POST","head",{kind:"ntfy",address:t.topic}).then(started)})}})," ");
 var mx=inp("@you:matrix.org");if(d.available.indexOf("matrix")>=0)box.append(mx,h("button",{class:"s",text:T("Add Matrix"),onclick:function(){api("POST","head",{kind:"matrix",address:mx.value}).then(started)}}));
 var ph=inp("+15551234567","tel");if(d.available.indexOf("sms")>=0)box.append(ph,h("button",{class:"s",text:T("Add SMS"),onclick:function(){api("POST","head",{kind:"sms",address:ph.value}).then(started)}}));
 var em=inp("another@example.com","email");box.append(em,h("button",{class:"s",text:T("Add email"),onclick:function(){api("POST","email",{email:em.value}).then(function(r){if(r.ok){r.registration=r.registration;started(r)}else out.textContent=T("Not added: ")+r.reason})}}));
 box.append(vc,vb,out);return box}
function loginHeadsUI(d){
 var out=msg();var box=card(h("b",{text:T("Ways to log in without Telegram")}),h("p",{text:T("Your passport id: ")},h("b",{text:d.handle})),
  d.factors.length?h("div",null,d.factors.map(function(f){return h("div",null,(f.kind==="totp"?T("Authenticator"):T("Device key"))+" · "+(f.label||"")+" ",h("button",{class:"s",text:T("Remove"),onclick:function(){api("POST","factor/revoke",{id:f.id}).then(load)}}))})):null);
 var tcode=inp(T("6-digit code"));var tid=null;var qr=h("div");
 box.append(h("button",{class:"s",text:T("Add authenticator app"),onclick:function(){api("POST","totp",{label:T("Authenticator")}).then(function(r){if(!r.ok){out.textContent=T("Not added: ")+r.reason;return}tid=r.id;qr.replaceChildren(h("img",{src:r.qr,alt:"QR code",width:"180"}),h("p",{class:"m",text:T("Or enter this key: ")+r.secret}),tcode,h("button",{text:T("Confirm"),onclick:function(){api("POST","totp/confirm",{id:tid,code:tcode.value}).then(function(x){out.textContent=x.ok?T("Authenticator added."):T("Code not accepted.");if(x.ok)load()})}}))})}})," ",
  h("button",{class:"s",text:T("Remember this device"),onclick:function(){crypto.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"},false,["sign","verify"]).then(function(kp){return crypto.subtle.exportKey("jwk",kp.publicKey).then(function(jwk){return api("POST","device",{jwk:{kty:jwk.kty,crv:jwk.crv,x:jwk.x,y:jwk.y},label:navigator.platform||T("This device")}).then(function(r){if(!r.ok){out.textContent=T("Not added: ")+r.reason;return}return kput("dev",{id:r.id,key:kp.privateKey}).then(function(){out.textContent=T("This device can now log you in.");load()})})})}).catch(function(){out.textContent=T("This browser can't keep a device key.")})}})," ",
  h("a",{href:"/portal/card",target:"_blank",text:T("Print a recovery card")}),qr,out);
 return box}
function peopleUI(d){
 var out=msg();var g=d.guardians;
 var bl=inp(T("How your buddy knows you, e.g. Anna from Tuesdays"));var bc=inp(T("Buddy code"));
 var buddies=card(h("b",{text:T("Buddy: someone who passes critical notices on")}),d.buddies.map(function(x){return h("div",null,x.name+" · "+x.status+" ",h("button",{class:"s",text:T("End"),onclick:function(){api("POST","buddy/end",{id:x.id}).then(load)}}))}),bl,
  h("button",{class:"s",text:T("Create invite code"),onclick:function(){api("POST","buddy/invite",{label:bl.value}).then(function(r){out.textContent=r.ok?T("Give this code to your buddy: ")+r.code:T("Not created: ")+r.reason})}})," ",bc,
  h("button",{class:"s",text:T("Accept a code"),onclick:function(){api("POST","buddy/accept",{code:bc.value,label:bl.value}).then(function(r){out.textContent=r.ok?T("You're buddies now."):T("Code not valid (and fill in how they know you).");if(r.ok)load()})}}));
 var gh=inp(T("Guardian's passport id"));var gk=inp(T("How many must approve (2 or more)"),"number");
 var guards=card(h("b",{text:T("Guardians (recover access if you lose everything)")}),h("p",{class:"m",text:T("Approvals needed: ")+(g.k||T("not set"))}),
  g.mine.map(function(x){return h("div",null,x.handle+" · "+x.status+" ",h("button",{class:"s",text:T("Remove"),onclick:function(){api("POST","guardian/remove",{handle:x.handle}).then(load)}}))}),gh,
  h("button",{class:"s",text:T("Ask to be my guardian"),onclick:function(){api("POST","guardian/add",{handle:gh.value}).then(function(r){out.textContent=r.ok?T("Asked. They accept in their portal."):T("Not found.");if(r.ok)load()})}}),gk,
  h("button",{class:"s",text:T("Set approvals needed"),onclick:function(){api("POST","guardian/k",{k:Number(gk.value)}).then(function(r){out.textContent=r.ok?T("Saved."):T("Needs at least 2 and no more than your active guardians.");if(r.ok)load()})}}),
  g.guarding.length?h("div",null,h("p",{text:T("You guard:")}),g.guarding.map(function(x){return h("div",null,x.handle+" · "+x.status+" ",x.status==="invited"?[h("button",{class:"s",text:T("Accept"),onclick:function(){api("POST","guardian/answer",{handle:x.handle,accept:true}).then(load)}}),h("button",{class:"s",text:T("Decline"),onclick:function(){api("POST","guardian/answer",{handle:x.handle,accept:false}).then(load)}})]:null,
   x.requests.map(function(q){return h("div",{class:"w"},T("Recovery requested. Approve only if they contacted you directly. "),q.approved?T("(approved)"):h("button",{text:T("Approve"),onclick:function(){api("POST","guardian/approve",{request:q.id}).then(load)}}))}))})):null,
  h("button",{class:"s",text:T("Stop any recovery of my access"),onclick:function(){api("POST","recovery/cancel-all").then(function(r){out.textContent=T("Stopped ")+r.cancelled+T(" request(s).")})}}));
 return [buddies,guards,out]}
function load(){api("GET","me").then(function(d){if(d._status===401){login();return}document.getElementById("h").textContent=d.community;var p=d.protection;var lv=LV[p.level];
 api("GET","hydra").then(function(y){
 syncReceipts();
 var dest=card(h("b",{text:T("Official places")+(d.manifestVersion?T(" (signed list v")+d.manifestVersion+")":"")}),d.destinations.length?d.destinations.map(function(x){return h("div",null,h("span",{class:"m",text:x.role+" · "+x.kind+" "}),h("a",{href:x.url,rel:"noopener",text:x.url}))}):h("p",{class:"m",text:T("None published yet.")}));
 var st=card(h("b",{class:lv[0],text:lv[1]}),h("p",{text:T("Independent paths to you: ")+y.independent+(y.independent<3?T(" (aim for 3: if one fails, the others still reach you)"):" ✓")}),h("p",{class:"m",text:T("Recovery codes left: ")+p.recoveryCodes}),d.memberships.length?h("p",{text:T("Member: ")+d.memberships.map(function(m){return m.tier+T(" until ")+m.expires_at.slice(0,10)}).join(", ")}):h("p",{class:"m",text:T("No current membership on record. Your news subscription stays yours either way.")}));
 var tops=card(h("b",{text:T("What you receive")}),Object.keys(TOP).map(function(t){var c=h("input",{type:"checkbox",style:"width:auto"});c.checked=p.topics[t]==="following";c.addEventListener("change",function(){api("POST","topic",{topic:t,on:c.checked}).then(syncReceipts)});return h("label",null,TOP[t],c)}));
 var heads=card(h("b",{text:T("Ways we reach you")}),y.telegram?h("div",null,T("Telegram · linked")):null,p.heads.map(function(e){return h("div",null,(KIND[e.channel]||e.channel)+": "+e.address+" · "+e.status+(e.health!=="ok"?" · "+e.health:"")+" ",h("button",{class:"s",text:T("Remove"),onclick:function(){api("POST","revoke",{registration:e.id}).then(load)}}))}));
 var own=d.owner?card(h("b",{text:T("Operator: continuity alert")}),h("p",{class:"m",text:d.strong?T("Strong login confirmed."):T("Needs two different login methods in the last 15 minutes. Log out and log in with another method too.")}),
  (function(){var note=inp(T("Short note (optional)"));var out=msg();return h("div",null,note,h("button",{text:T("Send incident notice"),onclick:function(){api("POST","alert",{kind:"incident",note:note.value}).then(function(r){out.textContent=r.ok?T("Queued for ")+r.queued+T(" deliveries."):T("Not sent: ")+(r.reason||r.error)})}}),
   h("button",{class:"s",text:T("Send relocation notice"),onclick:function(){api("POST","alert",{kind:"relocation",note:note.value}).then(function(r){out.textContent=r.ok?T("Queued for ")+r.queued+T(" deliveries."):T("Not sent: ")+(r.reason||r.error)})}}),out)})()):null;
 var restore=ls("tp_receipts");var rm=msg();
 var foot=card(h("a",{href:"/portal/api/export",text:T("Download my data")})," · ",h("a",{href:"#",text:T("Log out"),onclick:function(e){e.preventDefault();api("POST","logout").then(login)}})," · ",
   h("a",{href:"#",text:T("Delete my relationship"),onclick:function(e){e.preventDefault();if(confirm(T("Delete your addresses, subscriptions and login? Your addresses stay blocked from future messages.")))api("POST","forget",{confirm:"forget"}).then(login)}}),
   restore&&restore.length?h("div",null,h("button",{class:"s",text:T("Restore my choices from this device"),onclick:function(){api("POST","receipts",{receipts:restore}).then(function(r){rm.textContent=T("Restored ")+r.applied+T(" signed choices (")+r.rejected+T(" not accepted).");load()})}}),rm):null);
 v.replaceChildren.apply(v,[st,heads,addHeadUI(y),loginHeadsUI(y),tops,dest].concat(peopleUI(y),[own,foot]).filter(Boolean))})})}
document.documentElement.lang=LANG;document.title=T("Community portal");document.body.prepend(h("p",{class:"m",style:"text-align:right"},h("a",{href:"#",text:LANG==="ru"?"English":"Русский",onclick:function(e){e.preventDefault();try{localStorage.setItem("tp_lang",LANG==="ru"?"en":"ru")}catch(x){}location.reload()}})));
load();
</script></body></html>`;
