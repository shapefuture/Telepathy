// History import from the owner's browser: the Worker only stores pages, with the importer's rules.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handleFetch } from "../src/index";
import { countingDb } from "../src/cron";
import { importPage, remindHistory } from "../src/history";
import { localParts } from "../src/util";
import { enableGroup, fakeTelegram, feed, GROUP, groupMsg, OWNER, testApp } from "./helpers";
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

describe("history import", () => {
  it("stores a page like the importer: new members, live data kept, opted-out and removed skipped", async () => {
    const { app } = testApp();
    await enableGroup(app);
    await feed(app, groupMsg(BOB, "live text wins"));
    const live = (await q<{ msg_id: number }>("SELECT msg_id FROM passages WHERE body='live text wins'"))!.msg_id;
    await feed(app, groupMsg(ALICE, "hello"));
    await env.DB.prepare("UPDATE members SET collection_opt_out=1 WHERE tg_id=?").bind(ALICE).run();
    await env.DB.prepare("INSERT INTO passages(source_id, msg_id, part, body, event_at, removed_at) SELECT id, 5, 0, NULL, '2020-01-01T00:00:00Z', '2020-01-02T00:00:00Z' FROM sources").run();

    const r = await call(OWNER, "POST", "history/page", {
      chat_id: GROUP,
      cursor: 3,
      messages: [msg(live, "imported copy", BOB), msg(9, "Our accountant files VAT quarterly", 7777), msg(8, "secret", ALICE), msg(7, "channel post", null), msg(5, "came back?", 7777), msg(3, "reply", 7777, { reply: 9, edit: 123 })],
    });
    expect(r).toMatchObject({ status: 200, body: { ok: true, stored: 3, imported: 3, done: false } });
    expect((await q<{ body: string }>("SELECT body FROM passages WHERE msg_id=?", live))!.body).toBe("live text wins");
    expect(await q("SELECT 1 FROM passages WHERE body='secret'")).toBeNull();
    expect((await q<{ body: string | null }>("SELECT body FROM passages WHERE msg_id=5"))!.body).toBeNull();
    const vat = await q<{ author_id: string; intent: string | null }>("SELECT author_id FROM passages WHERE msg_id=9");
    expect(vat!.author_id).toBe((await q<{ id: string }>("SELECT id FROM members WHERE tg_id=7777"))!.id);
    expect(await q("SELECT 1 FROM source_access a JOIN members m ON m.id=a.member_id WHERE m.tg_id=7777")).not.toBeNull();
    expect(await q("SELECT reply_to, edit_version FROM passages WHERE msg_id=3")).toEqual({ reply_to: 9, edit_version: 123 });
    expect((await q<{ author_id: string | null }>("SELECT author_id FROM passages WHERE msg_id=7"))!.author_id).toBeNull();

    // Imported words are searchable.
    expect((await call(BOB, "POST", "ask", { q: "accountant VAT" }, { ...E, AI: undefined, WORKERS_AI_MODEL: "off" })).body.status).toBe("answered");

    const list = await call(OWNER, "GET", "history");
    expect(list.body.groups[0]).toMatchObject({ chatId: GROUP, cursor: 3, imported: 3, seen: 6, done: false, left: 15000 - 6 });

    // Resume keeps the oldest cursor; the empty last page finishes the job once.
    await call(OWNER, "POST", "history/page", { chat_id: GROUP, cursor: 2, messages: [msg(2, "first ever", 7777)] });
    const end = await call(OWNER, "POST", "history/page", { chat_id: GROUP, cursor: 2, done: true, messages: [] });
    expect(end.body).toMatchObject({ ok: true, done: true, imported: 4 });
    expect(await q("SELECT cursor FROM history_jobs")).toEqual({ cursor: 2 });
    expect(await q("SELECT COUNT(*) AS n FROM audit WHERE action='history.import'")).toEqual({ n: 1 });
  });

  it("is for owners only, and only for enabled groups", async () => {
    const { app } = testApp();
    await enableGroup(app);
    await feed(app, groupMsg(BOB, "hi"));
    expect((await call(BOB, "GET", "history")).status).toBe(403);
    expect((await call(BOB, "POST", "history/page", { chat_id: GROUP, messages: [msg(1, "x", BOB)] })).status).toBe(403);
    expect((await call(OWNER, "POST", "history/page", { chat_id: -100999, messages: [msg(1, "x", BOB)] })).body).toMatchObject({ ok: false, error: "not_enabled" });
    expect(await q("SELECT COUNT(*) AS n FROM passages WHERE body='x'")).toEqual({ n: 0 });
  });

  it("accepts a full page of long messages, drops malformed entries", async () => {
    const { app } = testApp();
    await enableGroup(app);
    const long = "слово ".repeat(1500);
    const messages = [...Array.from({ length: 99 }, (_, i) => msg(1000 + i, long, 7777)), { id: "x", text: 5 }, null, msg(2000, "   ", 7777)];
    const r = await call(OWNER, "POST", "history/page", { chat_id: GROUP, cursor: 1000, messages });
    expect(r.body).toMatchObject({ ok: true, stored: 99 });
  });

  it("a full page from 100 different people costs a handful of D1 calls (free plan: 50 a request)", async () => {
    const { app } = testApp();
    await enableGroup(app);
    const c = countingDb(env.DB);
    const page = Array.from({ length: 100 }, (_, i) => msg(3000 + i, `note ${i}`, 10_000 + i));
    const r = await importPage(E, c.db, OWNER, GROUP, page, 3000, false);
    expect(r).toMatchObject({ ok: true, stored: 100 });
    expect(c.used()).toBeLessThanOrEqual(3);
    expect(await q("SELECT COUNT(*) AS n FROM source_access")).toEqual({ n: 101 }); // + the owner
  });

  it("old messages never give access back to someone who left", async () => {
    const { app } = testApp();
    await enableGroup(app);
    await feed(app, groupMsg(BOB, "hi"));
    await env.DB.prepare("UPDATE source_access SET revoked_at='2026-01-01T00:00:00Z' WHERE member_id=(SELECT id FROM members WHERE tg_id=?)").bind(BOB).run();
    await importPage(E, env.DB, OWNER, GROUP, [msg(4, "old words", BOB)], 4, false);
    expect(await q("SELECT revoked_at FROM source_access WHERE member_id=(SELECT id FROM members WHERE tg_id=?)", BOB)).toEqual({ revoked_at: "2026-01-01T00:00:00Z" });
  });

  it("pauses at the daily budget shared by all groups", async () => {
    const { app } = testApp();
    await enableGroup(app);
    const small = { ...E, HISTORY_PER_DAY: "3" };
    expect((await importPage(small, env.DB, OWNER, GROUP, [msg(9, "a", 1), msg(8, "b", 1), msg(7, "c", 1)], 7, false)).ok).toBe(true);
    const r = await importPage(small, env.DB, OWNER, GROUP, [msg(6, "d", 1)], 6, false);
    expect(r).toEqual({ ok: false, error: "paused", left: 0 });
    expect(await q("SELECT cursor FROM history_jobs")).toEqual({ cursor: 7 }); // resumes where it stopped
    const tomorrow = new Date(Date.now() + day * 1000);
    expect((await importPage(small, env.DB, OWNER, GROUP, [msg(6, "d", 1)], 6, false, tomorrow)).ok).toBe(true);
  });

  it("skips what /retention would purge and tells the browser to stop", async () => {
    const { app } = testApp();
    await enableGroup(app);
    await env.DB.prepare("UPDATE sources SET retention_days=10").run();
    const old = { ...msg(1, "too old", 7777), date: now - 20 * day };
    const r = await importPage(E, env.DB, OWNER, GROUP, [old], 1, false);
    expect(r).toMatchObject({ ok: true, stored: 0, done: true });
    expect((await call(OWNER, "GET", "history")).body.groups[0].keepFrom).toBeGreaterThan(now - 11 * day);
  });

  it("reminds the owner once a day at the digest hour until it is finished", async () => {
    const { app, sent } = testApp();
    await enableGroup(app);
    await importPage(E, env.DB, OWNER, GROUP, [msg(9, "a", 1)], 9, false, new Date(Date.now() - 2 * day * 1000));
    const at = (h: number) => {
      for (let i = 0; i < 48; i++) {
        const d = new Date(Date.now() + i * 3600_000);
        if (localParts(d, E.TIMEZONE ?? "UTC").hour === h) return d;
      }
      throw new Error("no hour");
    };
    const hour = Number(E.DIGEST_HOUR ?? 9);
    expect(await remindHistory(app, at((hour + 1) % 24))).toBe(0);
    const before = sent(OWNER).length;
    expect(await remindHistory(app, at(hour))).toBe(1);
    expect(sent(OWNER).at(-1)!.params.text).toContain("isn't finished");
    expect(await remindHistory(app, at(hour))).toBe(0); // once a day
    expect(sent(OWNER).length).toBe(before + 1);
    await importPage(E, env.DB, OWNER, GROUP, [], 9, true);
    await env.DB.prepare("UPDATE history_jobs SET reminded_day=NULL, updated_at='2000-01-01T00:00:00Z'").run();
    expect(await remindHistory(app, at(hour))).toBe(0); // finished
  });

  it("/enable offers the past messages privately, but not once they're loaded", async () => {
    const withUrl = { ...E, PUBLIC_URL: "https://bot.example" };
    const t = testApp();
    const app = { ...t.app, env: withUrl };
    await enableGroup(app);
    const guide = t.sent(OWNER).at(-1)!.params;
    expect(guide.text).toContain("Older messages");
    expect(JSON.stringify(guide.reply_markup)).toContain("https://bot.example/app?start=history");
    await importPage(E, env.DB, OWNER, GROUP, [], 0, true);
    await enableGroup(app);
    expect(t.sent(OWNER).at(-1)!.params.text).not.toContain("Older messages");
  });

  it("the page may reach Telegram's web endpoints and run WebAssembly, nothing else new", async () => {
    const page = await handleFetch(new Request("https://bot.example/app"), E);
    const csp = page.headers.get("content-security-policy")!;
    expect(csp).toContain("connect-src 'self' wss://*.web.telegram.org;");
    expect(csp).toContain("'wasm-unsafe-eval'");
    expect(await page.text()).toContain('import("/history/history.js")');
  });
});
