// Mini App API: same rules as the bot, reached through signed initData.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { verifyInitUser } from "../src/app";
import { handleFetch } from "../src/index";
import { enableGroup, fakeTelegram, feed, groupMsg, OWNER, testApp } from "./helpers";
import type { Env } from "../src/env";

const ALICE = 51;
const BOB = 52;
async function sign(fields: Record<string, string>, token = "123456:TEST") {
  const enc = new TextEncoder();
  const key = async (k: BufferSource) => crypto.subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const secret = await crypto.subtle.sign("HMAC", await key(enc.encode("WebAppData")), enc.encode(token));
  const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
  const hash = [...new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret), enc.encode(check)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return new URLSearchParams({ ...fields, hash }).toString();
}
const initFor = (id: number, extra: Record<string, string> = {}) => sign({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id, username: `user${id}x` }), ...extra });
const q = <T>(sql: string, ...args: unknown[]) => env.DB.prepare(sql).bind(...args).first<T>();

function client(id: number, t = fakeTelegram(), e: Env = env as unknown as Env) {
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await handleFetch(new Request(`https://bot.example/app/api/${path}`, { method, headers: { "content-type": "application/json", "x-telegram-init-data": await initFor(id) }, body: body ? JSON.stringify(body) : undefined }), e, t.fetcher);
    return { status: res.status, body: (await res.json()) as any };
  };
  return { get: (p: string) => call("GET", p), post: (p: string, b: unknown = {}) => call("POST", p, b), t };
}

async function world() {
  const { app } = testApp();
  await enableGroup(app);
  for (const [u, text] of [
    [OWNER, "hi"],
    [BOB, "Our accountant files VAT quarterly through the tax portal, bookkeeping is in spreadsheets"],
    [ALICE, "hello"],
  ] as const)
    await feed(app, groupMsg(u, text));
  return app;
}

describe("Mini App identity", () => {
  it("an owner who never wrote anything can open the app; a stranger gets a clear 403", async () => {
    expect((await client(OWNER).get("me")).status).toBe(200);
    expect((await client(424242).get("me"))).toMatchObject({ status: 403, body: { error: "unknown member" } });
  });

  it("reads username and start_param only from signed initData", async () => {
    const u = await verifyInitUser(await initFor(7, { start_param: "help" }), "123456:TEST");
    expect(u).toEqual({ id: 7, username: "user7x", startParam: "help" });
    const bad = await sign({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 7, username: "x y<script>" }) });
    expect((await verifyInitUser(bad, "123456:TEST"))?.username).toBeUndefined();
  });
  it("serves one self-contained page with a strict CSP", async () => {
    const page = await handleFetch(new Request("https://bot.example/app"), env as unknown as Env);
    const html = await page.text();
    expect(page.headers.get("content-security-policy")).toMatch(/default-src 'none'.*form-action 'none'/);
    expect(html).toContain("telegram-web-app.js");
    expect(html.match(/<script src=/g)).toHaveLength(1); // only Telegram's script
    expect(html).not.toContain("innerHTML");
    // The inline script must parse (a stray escape in the template once broke the whole app).
    const script = html.split("<script>")[1]!.split("</script>")[0]!;
    expect(() => new Function(script)).not.toThrow();
  });
});

describe("member flows in the app", () => {
  it("me, search with group filter that can only narrow, votes", async () => {
    await world();
    const c = client(ALICE);
    const me = await c.get("me");
    expect(me.body).toMatchObject({ owner: false, counts: { requests: 0, offers: 0, invites: 0 } });
    const groups = (await c.get("groups")).body;
    expect(groups).toHaveLength(1);
    const a = (await c.post("ask", { q: "VAT portal", group: groups[0].id })).body;
    expect(a.status).toBe("answered");
    expect((await c.post("vote", { answerId: a.answerId, action: "up" })).body.result).toBe("recorded");
    // A group id the member can't read yields nothing, never more.
    expect((await c.post("ask", { q: "VAT portal", group: "not-mine" })).body.status).not.toBe("answered");
    expect((await c.get("desk")).status).toBe(403);
  });

  it("request: draft → confirm with local answer → desk → solved; history and actions", async () => {
    await world();
    const c = client(ALICE);
    const d = (await c.post("requests", { text: "I need an accountant for VAT bookkeeping" })).body;
    expect(d).toMatchObject({ ok: true, job: "Accounting" });
    const ok = (await c.post(`requests/${d.id}/ok`)).body;
    expect(ok.answered).toBe(true);
    expect(JSON.stringify(ok.quotes)).toContain("tax portal");
    let list = (await c.get("requests")).body;
    expect(list.missions[0]).toMatchObject({ status: "local_investigation", actions: ["solved", "more", "x"] });
    expect((await c.post(`requests/${d.id}/more`)).body).toMatchObject({ ok: true, partners: 0 });
    list = (await c.get("requests")).body;
    expect(list.missions[0].actions).toEqual(["x"]); // no partners configured → no preview
    expect(list.missions[0].history.map((h: { status: string }) => h.status)).toEqual(["draft", "confirmed", "local_investigation", "external_permission_needed"]);
    // Someone else can't act on it.
    expect((await client(BOB).post(`requests/${d.id}/x`)).body.ok).toBe(false);
    expect((await c.post(`requests/${d.id}/x`)).body.ok).toBe(true);
    expect((await c.post(`requests/${d.id}/rate`, { useful: true })).body.ok).toBe(false);
  });

  it("owner desk in the app: assign offer, deliver, member rates; tags and offers", async () => {
    await world();
    const owner = client(OWNER);
    const alice = client(ALICE, owner.t);
    expect((await owner.post("desk/offer", { job: "accounting", slots: 1, mode: "paid", price: "", description: "VAT hour" })).status).toBe(400);
    expect((await owner.post("desk/offer", { job: "accounting", slots: 1, mode: "volunteer", description: "VAT hour" })).body.ok).toBe(true);
    const d = (await alice.post("requests", { text: "I need an accountant for VAT bookkeeping" })).body;
    await alice.post(`requests/${d.id}/ok`);
    await alice.post(`requests/${d.id}/more`);
    const desk = (await owner.get("desk")).body;
    const m = desk.missions.find((x: { id: string }) => x.id === d.id);
    const assign = m.actions.find((x: { act: string }) => x.act === "a");
    expect(assign.label).toContain("VAT hour");
    expect((await owner.post(`desk/mission/${d.id}/a/${assign.extra}`)).body.ok).toBe(true);
    expect(owner.t.sent(ALICE).at(-1)!.params.text).toContain("VAT hour");
    expect((await owner.post(`desk/tag/${d.id}`, { case_type: "warm_intro" })).body.ok).toBe(true);
    expect((await owner.post(`desk/tag/${d.id}`, { case_type: "nope" })).status).toBe(400);
    expect((await owner.post(`desk/mission/${d.id}/dv`)).body.ok).toBe(true);
    expect((await alice.get("requests")).body.missions[0].actions).toEqual(["rate"]);
    expect((await alice.post(`requests/${d.id}/rate`, { useful: true })).body.ok).toBe(true);
    const after = (await owner.get("desk")).body;
    expect(after.report.useful).toBe(1);
    expect(after.offers[0]).toMatchObject({ reserved: 1, total: 1 });
    expect(after.health["open missions"]).toBe(0);
  });

  it("intro invitation can be accepted in the app; events file goes to chat; forget needs confirmation", async () => {
    const app = await world();
    await env.DB.prepare("UPDATE members SET discoverable=1 WHERE tg_id=?").bind(BOB).run();
    await env.DB.prepare("INSERT INTO skills(member_id, code, state) SELECT id, 'accounting', 'confirmed' FROM members WHERE tg_id=?").bind(BOB).run();
    const alice = client(ALICE);
    const bob = client(BOB, alice.t);
    await feed(app, { message: { message_id: 9001, date: Math.floor(Date.now() / 1000), chat: { id: ALICE, type: "private" }, from: { id: ALICE, is_bot: false }, text: "/intro need an accountant for my bakery", entities: [{ type: "bot_command", offset: 0, length: 6 }] } } as any);
    const inv = (await bob.get("requests")).body.intros;
    expect(inv[0]).toMatchObject({ role: "candidate", status: "invited", actions: ["accept", "decline"] });
    expect(inv[0].text).toContain("bakery");
    expect((await bob.get("me")).body.counts.invites).toBe(1);
    expect((await bob.post(`intros/${inv[0].id}`, { action: "accept" })).body.ok).toBe(true);
    const req = (await alice.get("requests")).body.intros[0];
    expect(req).toMatchObject({ role: "requester", status: "accepted", text: null, actions: ["confirm", "cancel"] });

    await feed(app, groupMsg(BOB, "Meetup on 2099-11-05 at 19:30 in the library"));
    expect((await alice.get("events")).body).toHaveLength(1);
    expect((await alice.post("events/ics")).body.ok).toBe(true);
    expect(alice.t.calls.some((c) => c.method === "sendDocument")).toBe(true);

    expect((await alice.post("forget", {})).status).toBe(400);
    expect((await alice.post("forget", { confirm: "forget" })).body.ok).toBe(true);
    expect((await q<{ collection_opt_out: number }>("SELECT collection_opt_out FROM members WHERE tg_id=?", ALICE))!.collection_opt_out).toBe(1);
  });

  it("skills and settings round-trip", async () => {
    await world();
    const c = client(ALICE);
    expect((await c.post("skills", { code: "bookkeeping", on: true })).body).toEqual({ ok: true, code: "accounting" });
    expect((await c.get("me")).body.skills).toEqual(["accounting"]);
    await c.post("skills", { code: "accounting", on: false });
    expect((await c.get("me")).body.skills).toEqual([]);
    await c.post("settings", { discoverable: true, lang: "ru" });
    expect((await c.get("me")).body).toMatchObject({ lang: "ru", flags: { discoverable: true } });
    expect((await c.get("skills")).body.length).toBeGreaterThan(50);
  });
});
