// History import: the browser parks pages (history/stage), the cron stores them in the background
// with the importer's rules, and tells the owner when it's done.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { countingDb } from "../src/cron";
import { handleFetch } from "../src/index";
import { ingestHistory, remindHistory, stagePage, storeMessages } from "../src/history";
import { localParts } from "../src/util";
import { enableGroup, fakeTelegram, feed, GROUP, groupMsg, OWNER, testApp } from "./helpers";
import type { App } from "../src/bot";
import type { Env } from "../src/env";

const ALICE = 61;
const BOB = 62;
const E = env as unknown as Env;
const q = <T>(sql: string, ...args: unknown[]) => env.DB.prepare(sql).bind(...args).first<T>();
const day = 86_400;
const now = Math.floor(Date.now() / 1000);
const msg = (id: number, text: string, from: number | null, extra: Record<string, unknown> = {}) => ({ id, date: now - 30 * day + id, text, from, edit: 0, reply: null, topic: null, ...extra });

async function sign(fields: Record<string, string>, token = "123456:TEST") {
  const enc = new TextEncoder();
  const key = async (k: BufferSource) => crypto.subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const secret = await crypto.subtle.sign("HMAC", await key(enc.encode("WebAppData")), enc.encode(token));
  const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
  const hash = [...new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret), enc.encode(check)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return new URLSearchParams({ ...fields, hash }).toString();
}
async function call(id: number, method: string, path: string, body?: unknown, e: Env = E) {
  const init = await sign({ auth_date: String(now), user: JSON.stringify({ id }) });
  const res = await handleFetch(new Request(`https://bot.example/app/api/${path}`, { method, headers: { "content-type": "application/json", "x-telegram-init-data": init }, body: body ? JSON.stringify(body) : undefined }), e, fakeTelegram().fetcher);
  return { status: res.status, body: (await res.json()) as any };
}
/** Run the cron's history step until nothing is left. */
async function drain(app: App, at = new Date()) {
  for (let i = 0; i < 50; i++) {
    await ingestHistory(app, at);
    if (!(await q("SELECT 1 FROM history_pages WHERE body IS NOT NULL"))) break;
  }
  await ingestHistory(app, at); // finish step
}

describe("history import", () => {
  it("parks pages, stores them in the background like the importer, then tells the owner", async () => {
    const { app, sent } = testApp();
    await enableGroup(app);
    await feed(app, groupMsg(BOB, "live text wins"));
    const live = (await q<{ msg_id: number }>("SELECT msg_id FROM passages WHERE body='live text wins'"))!.msg_id;
    await feed(app, groupMsg(ALICE, "hello"));
    await env.DB.prepare("UPDATE members SET collection_opt_out=1 WHERE tg_id=?").bind(ALICE).run();
    await env.DB.prepare("INSERT INTO passages(source_id, msg_id, part, body, event_at, removed_at) SELECT id, 5, 0, NULL, '2020-01-01T00:00:00Z', '2020-01-02T00:00:00Z' FROM sources").run();

    const r = await call(OWNER, "POST", "history/stage", {
      chat_id: GROUP,
      page: 0,
      messages: [msg(live, "imported copy", BOB), msg(9, "Our accountant files VAT quarterly", 7777), msg(8, "secret", ALICE), msg(7, "channel post", null), msg(5, "came back?", 7777), msg(3, "reply", 7777, { reply: 9, edit: 123 })],
    });
    expect(r).toMatchObject({ status: 200, body: { ok: true, pending: 6 } });
    expect(await q("SELECT 1 FROM passages WHERE msg_id=9")).toBeNull(); // nothing stored yet: reading is cheap
    const reading = (await call(OWNER, "GET", "history")).body.groups[0];
    expect(reading).toMatchObject({ chatId: GROUP, staged: 6, pending: 6, read: false, done: false, pages: [0], days: 1 });

    expect((await call(OWNER, "POST", "history/stage", { chat_id: GROUP, done: true })).body).toMatchObject({ ok: true });
    await drain(app);

    expect((await q<{ body: string }>("SELECT body FROM passages WHERE msg_id=?", live))!.body).toBe("live text wins");
    expect(await q("SELECT 1 FROM passages WHERE body='secret'")).toBeNull();
    expect((await q<{ body: string | null }>("SELECT body FROM passages WHERE msg_id=5"))!.body).toBeNull();
    const vat = await q<{ author_id: string }>("SELECT author_id FROM passages WHERE msg_id=9");
    expect(vat!.author_id).toBe((await q<{ id: string }>("SELECT id FROM members WHERE tg_id=7777"))!.id);
    expect(await q("SELECT 1 FROM source_access a JOIN members m ON m.id=a.member_id WHERE m.tg_id=7777")).not.toBeNull();
    expect(await q("SELECT reply_to, edit_version FROM passages WHERE msg_id=3")).toEqual({ reply_to: 9, edit_version: 123 });
    expect((await q<{ author_id: string | null }>("SELECT author_id FROM passages WHERE msg_id=7"))!.author_id).toBeNull();
    expect((await call(BOB, "POST", "ask", { q: "accountant VAT" }, { ...E, AI: undefined, WORKERS_AI_MODEL: "off" })).body.status).toBe("answered");

    // Done: pages dropped, owner told once, audited once.
    expect(await q("SELECT COUNT(*) AS n FROM history_pages")).toEqual({ n: 0 });
    expect((await call(OWNER, "GET", "history")).body.groups[0]).toMatchObject({ done: true, imported: 3, pending: 0, pages: [] });
    expect(sent(OWNER).filter((c) => String(c.params.text).includes("is loaded: 3"))).toHaveLength(1);
    await ingestHistory(app);
    expect(await q("SELECT COUNT(*) AS n FROM audit WHERE action='history.import'")).toEqual({ n: 1 });
  });

  it("is for owners only, and only for enabled groups", async () => {
    const { app } = testApp();
    await enableGroup(app);
    await feed(app, groupMsg(BOB, "hi"));
    expect((await call(BOB, "GET", "history")).status).toBe(403);
    expect((await call(BOB, "POST", "history/stage", { chat_id: GROUP, page: 0, messages: [msg(1, "x", BOB)] })).status).toBe(403);
    expect((await call(OWNER, "POST", "history/stage", { chat_id: -100999, page: 0, messages: [msg(1, "x", BOB)] })).status).toBe(404);
    expect((await call(OWNER, "POST", "history/stage", { chat_id: GROUP, page: -1, messages: [] })).status).toBe(400);
    expect(await q("SELECT COUNT(*) AS n FROM history_pages")).toEqual({ n: 0 });
  });

  it("accepts a full page of long messages, drops malformed entries, counts a page once", async () => {
    const { app } = testApp();
    await enableGroup(app);
    const long = "слово ".repeat(1500);
    const messages = [...Array.from({ length: 97 }, (_, i) => msg(1000 + i, long, 7777)), { id: "x", text: 5 }, null, msg(2000, "   ", 7777)];
    expect((await call(OWNER, "POST", "history/stage", { chat_id: GROUP, page: 10, messages })).body).toMatchObject({ ok: true, pending: 97 });
    expect((await call(OWNER, "POST", "history/stage", { chat_id: GROUP, page: 10, messages })).body).toMatchObject({ ok: true, pending: 97 });
    expect(await q("SELECT staged FROM history_jobs")).toEqual({ staged: 97 });
    expect((await q<{ n: number }>("SELECT length(body) AS n FROM history_pages"))!.n).toBeLessThan(2_000_000); // D1 row limit
  });

  it("stores a page from 100 different people in one D1 batch (free plan: 50 queries a request)", async () => {
    const { app } = testApp();
    await enableGroup(app);
    const c = countingDb(env.DB);
    const source = (await q<{ id: string }>("SELECT id FROM sources"))!.id;
    const page = Array.from({ length: 100 }, (_, i) => ({ ...msg(3000 + i, `note ${i}`, 10_000 + i) }));
    expect(await storeMessages(c.db, source, page)).toBe(100);
    expect(c.used()).toBe(1);
    expect(await q("SELECT COUNT(*) AS n FROM source_access")).toEqual({ n: 101 }); // + the owner
  });

  it("old messages never give access back to someone who left", async () => {
    const { app } = testApp();
    await enableGroup(app);
    await feed(app, groupMsg(BOB, "hi"));
    await env.DB.prepare("UPDATE source_access SET revoked_at='2026-01-01T00:00:00Z' WHERE member_id=(SELECT id FROM members WHERE tg_id=?)").bind(BOB).run();
    await stagePage(env.DB, OWNER, GROUP, 0, [msg(4, "old words", BOB)], false);
    await drain(app);
    expect(await q("SELECT body FROM passages WHERE msg_id=4")).toEqual({ body: "old words" });
    expect(await q("SELECT revoked_at FROM source_access WHERE member_id=(SELECT id FROM members WHERE tg_id=?)", BOB)).toEqual({ revoked_at: "2026-01-01T00:00:00Z" });
  });

  it("stores at most the daily budget, shared by all groups, and carries on the next day", async () => {
    const { app } = testApp();
    await enableGroup(app);
    const small = { ...app, env: { ...E, HISTORY_PER_DAY: "3" } };
    for (const p of [0, 1, 2]) await stagePage(env.DB, OWNER, GROUP, p, [msg(p * 100 + 1, "a", 1), msg(p * 100 + 2, "b", 1)], false);
    await stagePage(env.DB, OWNER, GROUP, undefined, [], true);
    await drain(small);
    expect(await q("SELECT COUNT(*) AS n FROM passages")).toEqual({ n: 4 }); // two pages: the second one crossed 3
    expect((await call(OWNER, "GET", "history", undefined, small.env)).body.groups[0]).toMatchObject({ pending: 2, done: false });
    await drain(small, new Date(Date.now() + day * 1000));
    expect(await q("SELECT COUNT(*) AS n FROM passages")).toEqual({ n: 6 });
    expect(await q("SELECT done_at IS NOT NULL AS d FROM history_jobs")).toEqual({ d: 1 });
  });

  it("skips what /retention would purge, both when reading and when storing", async () => {
    const { app } = testApp();
    await enableGroup(app);
    await env.DB.prepare("UPDATE sources SET retention_days=10").run();
    expect((await stagePage(env.DB, OWNER, GROUP, 0, [{ ...msg(1, "too old", 7777), date: now - 20 * day }, { ...msg(2, "recent", 7777), date: now - day }], false))).toMatchObject({ ok: true, pending: 1 });
    await env.DB.prepare("UPDATE sources SET retention_days=1").run(); // tightened before storing
    await drain(app);
    expect(await q("SELECT COUNT(*) AS n FROM passages")).toEqual({ n: 0 });
    expect((await call(OWNER, "GET", "history")).body.groups[0].keepFrom).toBeGreaterThan(now - 2 * day);
  });

  it("reminds once a day at the digest hour only when reading stopped early", async () => {
    const { app, sent } = testApp();
    await enableGroup(app);
    await stagePage(env.DB, OWNER, GROUP, 4, [msg(450, "a", 1)], false, new Date(Date.now() - 2 * day * 1000));
    const at = (h: number) => {
      for (let i = 0; i < 48; i++) {
        const d = new Date(Date.now() + i * 3600_000);
        if (localParts(d, E.TIMEZONE ?? "UTC").hour === h) return d;
      }
      throw new Error("no hour");
    };
    const hour = Number(E.DIGEST_HOUR ?? 9);
    expect(await remindHistory(app, at((hour + 1) % 24))).toBe(0);
    expect(await remindHistory(app, at(hour))).toBe(1);
    expect(sent(OWNER).at(-1)!.params.text).toContain("stopped before the start");
    expect(await remindHistory(app, at(hour))).toBe(0); // once a day
    await stagePage(env.DB, OWNER, GROUP, undefined, [], true, new Date(Date.now() - 2 * day * 1000));
    await env.DB.prepare("UPDATE history_jobs SET reminded_day=NULL").run();
    expect(await remindHistory(app, at(hour))).toBe(0); // read to the end: the cron does the rest
  });

  it("/enable offers the past messages privately, but not once they're loaded", async () => {
    const withUrl = { ...E, PUBLIC_URL: "https://bot.example" };
    const t = testApp();
    const app = { ...t.app, env: withUrl };
    await enableGroup(app);
    const guide = t.sent(OWNER).at(-1)!.params;
    expect(guide.text).toContain("Older messages");
    expect(JSON.stringify(guide.reply_markup)).toContain("https://bot.example/app?start=history");
    await stagePage(env.DB, OWNER, GROUP, undefined, [], true);
    await drain(app);
    await enableGroup(app);
    expect(t.sent(OWNER).at(-1)!.params.text).not.toContain("Older messages");
  });

  it("restarting clears the parked pages and progress", async () => {
    const { app } = testApp();
    await enableGroup(app);
    await stagePage(env.DB, OWNER, GROUP, 0, [msg(1, "a", 1)], false);
    expect((await call(OWNER, "POST", "history/reset", { chat_id: GROUP })).body).toEqual({ ok: true, auto: false }); // no MCP server: back to the app
    expect(await q("SELECT (SELECT COUNT(*) FROM history_pages) + (SELECT COUNT(*) FROM history_jobs) AS n")).toEqual({ n: 0 });
  });

  it("the page may reach Telegram's web endpoints and run WebAssembly, nothing else new", async () => {
    const page = await handleFetch(new Request("https://bot.example/app"), E);
    const csp = page.headers.get("content-security-policy")!;
    expect(csp).toContain("connect-src 'self' wss://*.web.telegram.org;");
    expect(csp).toContain("'wasm-unsafe-eval'");
    expect(await page.text()).toContain('import("/history/history.js")');
  });
});
