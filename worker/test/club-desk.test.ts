// Clubs answer their own members. An escalated request reaches the admins of the member's groups
// first; those admins can introduce an expert or say "no provider" for it, and nothing else.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { App } from "../src/bot";
import type { Env } from "../src/env";
import { ensureMember } from "../src/acl";
import { handleFetch, makeApp } from "../src/index";
import { dm, feed, OWNER, press, fakeTelegram, type Call } from "./helpers";

const ALICE = 81; // admin of club A
const BOB = 82; // member of club A only
const CAROL = 83; // admin of club B, where BOB is not
const GA = -1001234567890;
const GB = -1002222222222;
const q = <T>(sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).first<T>();
const mission = (tg: number) => q<{ id: string; status: string }>("SELECT m.id, m.status FROM missions m JOIN members x ON x.id=m.member_id WHERE x.tg_id=? ORDER BY m.rowid DESC LIMIT 1", tg);
/** The callback data of the last card sent to a chat. */
const cardButtons = (calls: Call[], chat: number): string[] | undefined =>
  calls
    .filter((c) => c.method === "sendMessage" && c.params.chat_id === chat && c.params.reply_markup)
    .at(-1)
    ?.params.reply_markup.inline_keyboard.flat()
    .map((x: { callback_data: string }) => x.callback_data);

/** Club A (ALICE admins it), club B (CAROL admins it); BOB belongs to club A only. */
function world() {
  const admins: Record<number, number[]> = { [GA]: [ALICE], [GB]: [CAROL] };
  const t = fakeTelegram({ admins: [] });
  const fetcher = async (url: string, init: RequestInit) => {
    const method = url.split("/").pop()!;
    const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
    if (method === "getChatMember" || method === "getChatAdministrators") t.calls.push({ method, params: body });
    if (method === "getChatMember") return Response.json({ ok: true, result: { status: (admins[body.chat_id] ?? []).includes(body.user_id) ? "administrator" : "member", user: { id: body.user_id } } });
    if (method === "getChatAdministrators") return Response.json({ ok: true, result: (admins[body.chat_id] ?? []).map((id) => ({ status: "administrator", user: { id, is_bot: false } })) });
    return t.fetcher(url, init);
  };
  const app: App = makeApp({ ...env, BOT_USERNAME: "mindal_bot", PUBLIC_URL: "https://bot.example" } as Env, fetcher);
  return { app, calls: t.calls, sent: (chat: number) => t.sent(chat).map((c) => c.params.text as string) };
}

const added = (chat: number, title: string, by: number) => ({
  my_chat_member: { chat: { id: chat, type: "supergroup", title }, from: { id: by, is_bot: false, first_name: "Admin" }, old_chat_member: { status: "left", user: { id: 1 } }, new_chat_member: { status: "member", user: { id: 1, is_bot: true } } },
});
const say = (chat: number, user: number, text: string) => ({
  message: { message_id: Math.floor(Math.random() * 1e9), date: Math.floor(Date.now() / 1000), chat: { id: chat, type: "supergroup", title: "G" }, from: { id: user, is_bot: false }, text, entities: [] },
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

describe("club desk: each club answers its own members", () => {
  it("an escalated request reaches the member's club admins, and only them; they can intro or say no provider", async () => {
    const { app, calls, sent } = world();
    await feed(app, added(GA, "Club A", ALICE));
    await feed(app, added(GB, "Club B", CAROL));
    await feed(app, say(GA, BOB, "Our accountant files VAT quarterly through the tax portal, bookkeeping is done in spreadsheets"));

    // Local memory first: nothing reaches a club admin until the member asks for more.
    await feed(app, dm(BOB, "/help I need an accountant for bookkeeping and VAT"));
    const m0 = (await mission(BOB))!;
    await feed(app, press(BOB, `m:${m0.id}:ok`));
    expect(sent(ALICE).some((t) => t.includes(`#${m0.id.slice(0, 6)}`))).toBe(false);

    await feed(app, press(BOB, `m:${m0.id}:more`));
    const m = (await mission(BOB))!;
    expect(m.status).toBe("external_permission_needed");
    expect(sent(ALICE).at(-1)).toContain(`#${m.id.slice(0, 6)}`); // the club heard
    expect(sent(OWNER).at(-1)).toContain(`#${m.id.slice(0, 6)}`); // and so did the operator's desk
    expect(sent(CAROL).some((t) => t.includes(`#${m.id.slice(0, 6)}`))).toBe(false); // club B is not BOB's club

    // ALICE's /desk: the request, with the intro and "no provider" buttons only.
    await feed(app, dm(ALICE, "/desk"));
    const aliceButtons = cardButtons(calls, ALICE)!;
    expect(aliceButtons).toEqual(expect.arrayContaining([`d:${m.id}:i`, `d:${m.id}:np`]));
    expect(aliceButtons.some((c) => c.includes(`:${m.id}:rt`) || c.includes(`:${m.id}:a:`))).toBe(false);

    // CAROL's /desk: club B has nothing to answer.
    await feed(app, dm(CAROL, "/desk"));
    expect(sent(CAROL).at(-1)).toContain("Nothing from your groups");

    // Another club's admin, and a route or assignment from the club, change nothing.
    await feed(app, press(CAROL, `d:${m.id}:np`));
    await feed(app, press(ALICE, `d:${m.id}:rt`));
    expect((await mission(BOB))!.status).toBe("external_permission_needed");

    // The Mini App shows the same scope: ALICE sees the request, CAROL nothing, BOB no desk at all.
    const api = async (id: number, method: string, path: string) => {
      const res = await handleFetch(new Request(`https://bot.example/app/api/${path}`, { method, headers: { "content-type": "application/json", "x-telegram-init-data": await signInit(id) } }), app.env, undefined);
      return { status: res.status, body: (await res.json()) as any };
    };
    const alice = await api(ALICE, "GET", "desk");
    expect(alice.body.club).toBe(true);
    expect(alice.body.missions.map((x: { id: string; actions: { act: string }[] }) => [x.id, x.actions.map((y) => y.act)])).toEqual([[m.id, ["i", "np"]]]);
    expect((await api(CAROL, "GET", "desk")).body.missions).toEqual([]);
    expect((await api(BOB, "GET", "desk")).status).toBe(403);
    expect((await api(ALICE, "POST", "desk/offer")).status).toBe(403); // the operator's own actions stay the operator's

    // "No provider" from the club closes the request and tells the member.
    await feed(app, press(ALICE, `d:${m.id}:np`));
    expect((await mission(BOB))!.status).toBe("failed_with_explanation");
    expect(sent(BOB).at(-1)).toContain("couldn't find a willing provider");
    await feed(app, dm(ALICE, "/desk"));
    expect(sent(ALICE).at(-1)).toContain("Nothing from your groups");
  });

  it("the operator's desk still lists every request, including one from a member no club holds", async () => {
    const { app, calls, sent } = world();
    await ensureMember(env.DB, BOB); // a member of the bot who belongs to no connected group
    await feed(app, dm(BOB, "/help I need an accountant for bookkeeping and VAT"));
    const m = (await mission(BOB))!;
    await feed(app, press(BOB, `m:${m.id}:ok`));
    await feed(app, press(BOB, `m:${m.id}:more`));
    expect((await mission(BOB))!.status).toBe("external_permission_needed");
    expect(sent(OWNER).at(-1)).toContain(`#${m.id.slice(0, 6)}`);
    await feed(app, dm(OWNER, "/desk"));
    expect(cardButtons(calls, OWNER)).toEqual(expect.arrayContaining([`d:${m.id}:np`]));
  });
});
