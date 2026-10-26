// Many communities on one bot: each group's own admins connect and manage it, with no setup.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { eligibleCandidates, TAXONOMY } from "../src/experts";
import { handleFetch } from "../src/index";
import { readViaMcp, startAuto } from "../src/history-mcp";
import type { App } from "../src/bot";
import type { Env } from "../src/env";
import { fakeTelegram, feed, OWNER, type Call } from "./helpers";
import { makeApp } from "../src/index";

const E = env as unknown as Env;
const ALICE = 71; // admin of the other community; not the operator
const BOB = 72; // ordinary member
const G2 = -1002222222222;
const q = <T>(sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).first<T>();
let upd = 50_000;

/** A fake Telegram where `admins` are admins of G2 only, and private messages to `noDm` are refused. */
function world(admins: number[], opts: { noDm?: number[]; env?: Partial<Env> } = {}) {
  const t = fakeTelegram({ admins });
  const fetcher = async (url: string, init: RequestInit) => {
    const method = url.split("/").pop();
    const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
    if (method === "getChatMember" && body.chat_id !== G2) {
      t.calls.push({ method, params: body });
      return Response.json({ ok: true, result: { status: "member", user: { id: body.user_id } } });
    }
    if (method === "sendMessage" && opts.noDm?.includes(body.chat_id)) {
      t.calls.push({ method, params: body });
      return Response.json({ ok: false, error_code: 403, description: "Forbidden: bot can't initiate conversation with a user" });
    }
    return t.fetcher(url, init);
  };
  const app: App = makeApp({ ...E, BOT_USERNAME: "mindal_bot", PUBLIC_URL: "https://bot.example", ...opts.env } as Env, fetcher);
  const sent = (chatId: number) => t.calls.filter((c: Call) => c.method === "sendMessage" && c.params.chat_id === chatId).map((c) => c.params);
  return { app, calls: t.calls, sent, fetcher };
}

const added = (by: number, status = "member") => ({
  my_chat_member: { chat: { id: G2, type: "supergroup", title: "Книжный клуб" }, from: { id: by, is_bot: false, first_name: "Алиса" }, old_chat_member: { status: "left", user: { id: 1 } }, new_chat_member: { status, user: { id: 1, is_bot: true } } },
});
const say = (user: number, text: string) => ({
  message: { message_id: upd++, date: Math.floor(Date.now() / 1000), chat: { id: G2, type: "supergroup", title: "Книжный клуб" }, from: { id: user, is_bot: false }, text, entities: text.startsWith("/") ? [{ type: "bot_command", offset: 0, length: text.split(/\s/)[0]!.length }] : [] },
});
const pressIn = (user: number, data: string) => ({ callback_query: { id: String(upd++), from: { id: user, is_bot: false }, data, message: { message_id: 9, chat: { id: G2, type: "supergroup" } } } });

describe("one bot, many communities", () => {
  it("an admin adding the bot is the whole setup: connected, announced, guide in private", async () => {
    const { app, sent } = world([ALICE]);
    await feed(app, added(ALICE));
    const src = await q<{ enabled: number; title: string; tg: number }>("SELECT s.enabled, s.title, m.tg_id AS tg FROM sources s JOIN members m ON m.id=s.enabled_by WHERE s.chat_id=?", G2);
    expect(src).toEqual({ enabled: 1, title: "Книжный клуб", tg: ALICE });
    expect(sent(G2)[0]!.text).toContain("I'm connected to this group");
    const guide = sent(ALICE)[0]!;
    expect(guide.text).toContain("Книжный клуб");
    expect(JSON.stringify(guide.reply_markup)).toContain("https://bot.example/app?start=history");
    // Messages are collected from now on.
    await feed(app, say(BOB, "Следующая встреча клуба — про Набокова"));
    expect(await q("SELECT COUNT(*) AS n FROM passages")).toEqual({ n: 1 });
  });

  it("added by a non-admin: one Connect button that only an admin can use", async () => {
    const { app, sent, calls } = world([ALICE]);
    await feed(app, added(BOB));
    expect(await q("SELECT COUNT(*) AS n FROM sources")).toEqual({ n: 0 });
    expect(JSON.stringify(sent(G2)[0]!.reply_markup)).toContain('"callback_data":"cn"');
    await feed(app, pressIn(BOB, "cn"));
    expect(calls.filter((c) => c.method === "answerCallbackQuery").at(-1)!.params).toMatchObject({ text: "Only a group admin can connect me.", show_alert: true });
    expect(await q("SELECT COUNT(*) AS n FROM sources")).toEqual({ n: 0 });
    await feed(app, pressIn(ALICE, "cn"));
    expect(await q("SELECT enabled FROM sources WHERE chat_id=?", G2)).toEqual({ enabled: 1 });
    expect(calls.some((c) => c.method === "editMessageReplyMarkup")).toBe(true); // button gone
  });

  it("an admin who never wrote to the bot gets a one-tap link to their guide", async () => {
    const { app, sent } = world([ALICE], { noDm: [ALICE] });
    await feed(app, added(ALICE));
    const hint = sent(G2).at(-1)!;
    expect(hint.text).toContain("waiting in a private chat");
    expect(JSON.stringify(hint.reply_markup)).toContain("https://t.me/mindal_bot?start=gm1002222222222");
    // Tapping it opens the bot with that payload; now the bot may write to them.
    const open = world([ALICE]);
    await feed(open.app, { message: { message_id: 1, date: 1, chat: { id: ALICE, type: "private" }, from: { id: ALICE, is_bot: false }, text: "/start gm1002222222222", entities: [{ type: "bot_command", offset: 0, length: 6 }] } });
    expect(open.sent(ALICE)[0]!.text).toContain("Книжный клуб");
    // Someone else with the same link just gets the usual hello.
    await feed(open.app, { message: { message_id: 2, date: 1, chat: { id: BOB, type: "private" }, from: { id: BOB, is_bot: false }, text: "/start gm1002222222222", entities: [{ type: "bot_command", offset: 0, length: 6 }] } });
    expect(open.sent(BOB)[0]!.text).not.toContain("Книжный клуб");
  });

  it("group commands belong to that group's admins, not to the operator elsewhere", async () => {
    const { app, sent } = world([ALICE]); // the operator (OWNER) is not an admin here
    await feed(app, added(ALICE));
    await feed(app, say(OWNER, "/retention 30"));
    expect(await q("SELECT retention_days FROM sources WHERE chat_id=?", G2)).toEqual({ retention_days: 0 });
    await feed(app, say(BOB, "/disable"));
    expect(await q("SELECT enabled FROM sources WHERE chat_id=?", G2)).toEqual({ enabled: 1 });
    await feed(app, say(ALICE, "/retention 30"));
    expect(await q("SELECT retention_days FROM sources WHERE chat_id=?", G2)).toEqual({ retention_days: 30 });
    await feed(app, say(ALICE, "/disable"));
    expect(await q("SELECT enabled FROM sources WHERE chat_id=?", G2)).toEqual({ enabled: 0 });
    expect(sent(G2).at(-1)!.text).toContain("stopped collecting");
  });

  it("in the app, a group's admin manages that group's history and nothing else", async () => {
    const { app, fetcher } = world([ALICE], { env: { TG_API_ID: "12345", TG_API_HASH: "0123456789abcdef0123456789abcdef" } });
    await feed(app, added(ALICE));
    await env.DB.prepare("INSERT INTO sources(id, chat_id, title, visibility, enabled, enabled_at) VALUES ('other', -1003333333333, 'Чужая', 'MEMBER_CONSENTED', 1, '2026-01-01T00:00:00Z')").run();
    await feed(app, say(BOB, "привет"));
    const api = async (id: number, method: string, path: string, body?: unknown) => {
      const init = await signInit(id);
      const res = await handleFetch(new Request(`https://bot.example/app/api/${path}`, { method, headers: { "content-type": "application/json", "x-telegram-init-data": init }, body: body ? JSON.stringify(body) : undefined }), app.env, fetcher);
      return { status: res.status, body: (await res.json()) as any };
    };
    expect((await api(ALICE, "GET", "me")).body).toMatchObject({ owner: false, groupAdmin: true });
    const list = await api(ALICE, "GET", "history");
    expect(list.body.groups.map((g: { title: string }) => g.title)).toEqual(["Книжный клуб"]); // not "Чужая"
    expect(list.body.api).toEqual({ id: 12345, hash: "0123456789abcdef0123456789abcdef" });
    expect(list.body.mcp).toBe(false);
    expect((await api(ALICE, "POST", "history/stage", { chat_id: G2, page: 0, messages: [] })).status).toBe(200);
    expect((await api(ALICE, "POST", "history/stage", { chat_id: -1003333333333, page: 0, messages: [] })).status).toBe(403);
    expect((await api(BOB, "GET", "me")).body).toMatchObject({ groupAdmin: false });
    expect((await api(BOB, "GET", "history")).status).toBe(403);
    expect((await api(ALICE, "GET", "desk")).status).toBe(403); // the operator desk stays the operator's
  });

  it("the operator's MCP server only reads the operator's own groups", async () => {
    const { app } = world([ALICE, OWNER], { env: { TG_MCP_URL: "https://mcp.example", TG_MCP_KEY: "tmcp_00000000-0000-0000-0000-000000000000", TG_MCP: undefined } });
    await feed(app, added(ALICE));
    expect(await startAuto(env.DB, app.env)).toBe(0);
    expect(await readViaMcp(app, new Date("2026-10-26T10:10:00Z"))).toBe(0);
    expect(await q("SELECT COUNT(*) AS n FROM history_jobs")).toEqual({ n: 0 });
  });

  it("experts are only suggested to people who share a group with them", async () => {
    const code = [...TAXONOMY.keys()][0]!;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO sources(id, chat_id, title, visibility, enabled, enabled_at) VALUES ('a', -1001, 'A', 'MEMBER_CONSENTED', 1, '2026-01-01T00:00:00Z'), ('b', -1002, 'B', 'MEMBER_CONSENTED', 1, '2026-01-01T00:00:00Z')"),
      env.DB.prepare("INSERT INTO members(id, tg_id, created_at, discoverable, available) VALUES ('expert', 81, '2026-01-01T00:00:00Z', 1, 1), ('asker', 82, '2026-01-01T00:00:00Z', 0, 1)"),
      env.DB.prepare("INSERT INTO skills(member_id, code, state, kind) VALUES ('expert', ?, 'confirmed', 'self_claim')").bind(code),
      env.DB.prepare("INSERT INTO source_access(source_id, member_id, granted_at) VALUES ('a', 'expert', '2026-01-01T00:00:00Z'), ('b', 'asker', '2026-01-01T00:00:00Z')"),
    ]);
    const now = new Date().toISOString();
    expect(await eligibleCandidates(env.DB, "asker", [code], now)).toEqual([]); // other community
    await env.DB.prepare("INSERT INTO source_access(source_id, member_id, granted_at) VALUES ('a', 'asker', '2026-01-01T00:00:00Z')").run();
    expect((await eligibleCandidates(env.DB, "asker", [code], now)).map((c) => c.member_id)).toEqual(["expert"]);
  });

  it("a promotion or demotion is seen at once, not after the cache expires", async () => {
    const { app } = world([ALICE]);
    await env.DB.prepare("INSERT INTO chat_admins(chat_id, tg_id, is_admin, checked_at) VALUES (?, ?, 1, ?)").bind(G2, BOB, new Date().toISOString()).run();
    await feed(app, { chat_member: { chat: { id: G2, type: "supergroup" }, from: { id: ALICE }, old_chat_member: { status: "administrator", user: { id: BOB } }, new_chat_member: { status: "member", user: { id: BOB } } } });
    expect(await q("SELECT COUNT(*) AS n FROM chat_admins WHERE tg_id=?", BOB)).toEqual({ n: 0 });
  });
});

async function signInit(id: number, token = "123456:TEST") {
  const enc = new TextEncoder();
  const key = async (k: BufferSource) => crypto.subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const secret = await crypto.subtle.sign("HMAC", await key(enc.encode("WebAppData")), enc.encode(token));
  const fields: Record<string, string> = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id }) };
  const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
  const hash = [...new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret), enc.encode(check)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return new URLSearchParams({ ...fields, hash }).toString();
}
