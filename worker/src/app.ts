// Telegram Mini App (P13-11): a small web UI inside Telegram for search, profile and settings.
// Identity comes only from Telegram's signed initData, verified with the bot token (HMAC-SHA256,
// per core.telegram.org/bots/webapps). No new data is collected; the API reuses the bot's ACL.

import { langOf, memberByTg, readable } from "./acl";
import type { Env } from "./env";
import { T } from "./i18n";
import { answer, parseFilters } from "./search";
import { safeEqual } from "./util";

export const INIT_DATA_MAX_AGE_S = 24 * 3600;

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(data));
}

/** Returns the Telegram user id if initData is authentic and fresh, else null. */
export async function verifyInitData(initData: string, botToken: string, nowS = Math.floor(Date.now() / 1000)): Promise<number | null> {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = await hmac(enc.encode("WebAppData"), botToken);
  if (!safeEqual(hex(await hmac(secret, check)), hash)) return null;
  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate) || nowS - authDate > INIT_DATA_MAX_AGE_S) return null;
  try {
    const id = Number(JSON.parse(params.get("user") ?? "{}").id);
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
const FLAGS = ["digest", "discoverable", "available", "reminders", "routing"] as const;

export async function handleApp(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/app") {
    return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": CSP } });
  }
  const tgId = await verifyInitData(req.headers.get("x-telegram-init-data") ?? "", env.BOT_TOKEN);
  if (!tgId) return json({ error: "unauthorized" }, 401);
  const m = await memberByTg(env.DB, tgId);
  if (!m || m.removed_at) return json({ error: "unknown member" }, 403);
  if (req.method === "GET" && url.pathname === "/app/api/profile") {
    const skills = (await env.DB.prepare("SELECT code FROM skills WHERE member_id=? AND state='confirmed'").bind(m.id).all<{ code: string }>()).results.map((r) => r.code);
    return json({ lang: langOf(m), flags: Object.fromEntries(FLAGS.map((f) => [f, !!m[f as keyof typeof m]])), skills });
  }
  if (req.method === "POST" && url.pathname === "/app/api/settings") {
    const body = (await req.json()) as Record<string, unknown>;
    for (const f of FLAGS) if (typeof body[f] === "boolean") await env.DB.prepare(`UPDATE members SET ${f}=? WHERE id=?`).bind(body[f] ? 1 : 0, m.id).run();
    if (body.lang === "en" || body.lang === "ru") await env.DB.prepare("UPDATE members SET lang=?, lang_explicit=1 WHERE id=?").bind(body.lang, m.id).run();
    return json({ ok: true });
  }
  if (req.method === "POST" && url.pathname === "/app/api/ask") {
    const { q } = (await req.json()) as { q?: string };
    const f = await parseFilters(env.DB, await readable(env.DB, m), String(q ?? "").slice(0, 300));
    const a = await answer(env.DB, f.readable, f.query, f.filters);
    return json({ status: a.status, quotes: a.quotes.map(({ text, label, event_at, url, tag }) => ({ text, label, event_at, url, tag })), noAnswer: T(langOf(m)).insufficient.replace(/<[^>]+>/g, "") });
  }
  return json({ error: "not found" }, 404);
}

const CSP = "default-src 'none'; script-src 'self' 'unsafe-inline' https://telegram.org; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:";

// Plain HTML + inline JS (no build step). Text is inserted with textContent, never innerHTML.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Telepathy</title><script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>body{font:15px system-ui,sans-serif;margin:0;padding:16px;background:var(--tg-theme-bg-color,#fff);color:var(--tg-theme-text-color,#111)}
input,button{font:inherit;padding:10px;border-radius:10px;border:1px solid #8884;width:100%;box-sizing:border-box;margin:4px 0}
button{background:var(--tg-theme-button-color,#2a7);color:var(--tg-theme-button-text-color,#fff);border:0}
.q{border-left:3px solid var(--tg-theme-button-color,#2a7);padding:6px 10px;margin:10px 0;white-space:pre-wrap}.m{opacity:.7;font-size:13px}
label{display:flex;justify-content:space-between;align-items:center;padding:8px 0}label input{width:auto}h2{font-size:17px;margin:20px 0 6px}</style></head>
<body><h2 id="t1">Search</h2><input id="q" placeholder="…"><button id="go">↵</button><div id="res"></div>
<h2 id="t2">Settings</h2><div id="set"></div>
<script>
const tg=window.Telegram&&Telegram.WebApp; if(tg){tg.ready();tg.expand();}
const H={"x-telegram-init-data":tg?tg.initData:"","content-type":"application/json"};
const el=(t,c,x)=>{const e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e};
const L={en:{t1:"Search",t2:"Settings",digest:"Daily digest",discoverable:"Discoverable as expert",available:"Available for introductions",reminders:"Reminders",routing:"Pings about unanswered questions"},
ru:{t1:"Поиск",t2:"Настройки",digest:"Ежедневная сводка",discoverable:"Видимость как эксперта",available:"Доступен для знакомств",reminders:"Напоминания",routing:"Вопросы без ответа"}};
let lang="en";
async function load(){const r=await fetch("/app/api/profile",{headers:H});if(!r.ok){document.body.textContent="Open this from the Telepathy bot.";return}
const p=await r.json();lang=p.lang;const l=L[lang];t1.textContent=l.t1;t2.textContent=l.t2;set.replaceChildren();
for(const[f,v]of Object.entries(p.flags)){const lb=el("label",null,l[f]);const c=el("input");c.type="checkbox";c.checked=v;
c.onchange=()=>fetch("/app/api/settings",{method:"POST",headers:H,body:JSON.stringify({[f]:c.checked})});lb.append(c);set.append(lb)}}
go.onclick=async()=>{res.replaceChildren(el("p","m","…"));const r=await fetch("/app/api/ask",{method:"POST",headers:H,body:JSON.stringify({q:q.value})});
const a=await r.json();res.replaceChildren();if(a.status!=="answered"){res.append(el("p","m",a.noAnswer));return}
for(const x of a.quotes){const d=el("div","q",x.text);const m=el("div","m",(x.event_at||"").slice(0,10)+(x.label?" · "+x.label:"")+(x.tag?" · "+x.tag:""));
if(x.url){const a2=el("a",null," ↗");a2.href=x.url;a2.target="_blank";m.append(a2)}d.append(m);res.append(d)}};
q.onkeydown=e=>{if(e.key==="Enter")go.click()};load();
</script></body></html>`;
