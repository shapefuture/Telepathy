// Mini App: the living cards, the constellation and the pulse, through the same signed identity
// as the rest of the app. A press in the app is the bot's own handler, for the signed person only.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handleFetch } from "../src/index";
import { enableGroup, feed, groupMsg, OWNER, testApp } from "./helpers";
import type { Env } from "../src/env";
import type { Fetcher } from "../src/telegram";

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
const initFor = (id: number) => sign({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id, username: `user${id}x` }) });
const q = <T>(sql: string, ...args: unknown[]) => env.DB.prepare(sql).bind(...args).first<T>();

function client(id: number, t: { fetcher: Fetcher } = testApp()) {
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await handleFetch(
      new Request(`https://bot.example/app/api/${path}`, { method, headers: { "content-type": "application/json", "x-telegram-init-data": await initFor(id) }, body: body ? JSON.stringify(body) : undefined }),
      env as unknown as Env,
      t.fetcher,
    );
    return { status: res.status, body: (await res.json()) as any };
  };
  return { get: (p: string) => call("GET", p), post: (p: string, b: unknown = {}) => call("POST", p, b), t };
}

async function world() {
  const t = testApp();
  await enableGroup(t.app);
  for (const [u, text] of [
    [OWNER, "hi"],
    [BOB, "The venue for the meetup is Hall B, behind the library"],
    [ALICE, "hello"],
  ] as const)
    await feed(t.app, groupMsg(u, text));
  return t;
}

describe("Нить in the app", () => {
  it("a question asked in the app is the same living card as in the chat", async () => {
    const t = await world();
    const alice = client(ALICE, t);
    const asked = await alice.post("thread", { q: "where is the venue?" });
    expect(asked.body).toMatchObject({ ok: true, status: "answered" });
    const cards = (await alice.get("threads")).body as { id: string; state: string; card: { html: string; buttons: { text: string; data: string }[][] } }[];
    expect(cards).toHaveLength(1);
    expect(cards[0]!.state).toBe("memory");
    expect(cards[0]!.card.html).toContain("Hall B");
    expect(cards[0]!.card.buttons[0]!.map((b) => b.data.replace(/^t:[^:]+:/, ""))).toEqual(["ok", "ask"]);
  });

  it("a press runs the bot's own handler: 'Это то, что нужно' closes the card", async () => {
    const t = await world();
    const alice = client(ALICE, t);
    await alice.post("thread", { q: "where is the venue?" });
    const [card] = (await alice.get("threads")).body as { id: string; card: { buttons: { data: string }[][] } }[];
    const ok = card!.card.buttons[0]![0]!.data;
    expect((await alice.post("press", { data: ok })).body).toEqual({ ok: true });
    const [after] = (await alice.get("threads")).body as { state: string; outcome: string }[];
    expect(after).toMatchObject({ state: "closed", outcome: "solved" });
  });

  it("someone else's card can't be pressed from here", async () => {
    const t = await world();
    await client(ALICE, t).post("thread", { q: "where is the venue?" });
    const alice = (await client(ALICE, t).get("threads")).body as { id: string }[];
    const bob = client(BOB, t);
    await bob.post("press", { data: `t:${alice[0]!.id}:ok` });
    expect((await q<{ outcome: string | null }>("SELECT outcome FROM threads WHERE id=?", alice[0]!.id))!.outcome).toBeNull();
  });

  it("an empty question is refused, not sent", async () => {
    const t = await world();
    const r = await client(ALICE, t).post("thread", { q: "   " });
    expect(r.status).toBe(400);
  });
});

describe("Созвездие and Пульс and Союзы in the app", () => {
  it("the constellation lists the club's topics, and a topic says who knows it", async () => {
    const t = await world();
    // A topic becomes a star once two messages mention it.
    await feed(t.app, groupMsg(BOB, "Our accountant files VAT quarterly, bookkeeping is in spreadsheets"));
    await feed(t.app, groupMsg(OWNER, "The accountant can also help with the tax return"));
    const stars = (await client(ALICE, t).get("constellation")).body as { code: string; label: string; n: number }[];
    expect(Array.isArray(stars)).toBe(true);
    const accounting = stars.find((s) => s.code === "accounting");
    expect(accounting).toBeTruthy();
    const detail = (await client(ALICE, t).get(`constellation/${accounting!.code}`)).body as { label: string; quotes: { text: string }[]; people: unknown[] };
    expect(detail.label).toBe("Accounting");
    expect(detail.quotes.length).toBeGreaterThan(0);
  });

  it("the owner sees the pulse of their own clubs; others see none", async () => {
    const t = await world();
    const owner = (await client(OWNER, t).get("pulse")).body as { title: string; html: string }[];
    expect(owner).toHaveLength(1);
    expect(owner[0]!.html).toContain("Pulse");
    expect((await client(ALICE, t).get("pulse")).body).toEqual([]);
  });

  it("the union view lists clubs the person manages, and no alliances yet", async () => {
    const t = await world();
    const u = (await client(OWNER, t).get("union")).body as { alliances: unknown[]; clubs: { id: string }[] };
    expect(u.alliances).toEqual([]);
    expect(u.clubs).toHaveLength(1);
  });

  it("me lists the clubs this person can read, for the club chips", async () => {
    const t = await world();
    const me = (await client(ALICE, t).get("me")).body as { groups: { id: string; title: string }[] };
    expect(me.groups).toHaveLength(1);
  });
});
