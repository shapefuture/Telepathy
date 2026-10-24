// Conversation grouping, redaction, content-keyed cache, quote checks and the Beam summary.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ensureMember, readable } from "../src/acl";
import { checkQuotes } from "../src/ai/verify";
import { redact } from "../src/ai/redact";
import { conversation } from "../src/ai/threads";
import { resetRateLimits } from "../src/bot";
import { makeApp } from "../src/index";
import { GROUP, dm, press, enableGroup, fakeTelegram, feed, groupMsg, nextMsg } from "./helpers";

beforeEach(() => resetRateLimits());

describe("redact", () => {
  it("masks contacts, links and tokens but keeps the meaning", () => {
    const r = redact("Пиши @anna_k или anna@mail.ru, звони +7 (912) 345-67-89, см. https://t.me/x/1 ключ abc123XYZ789def456GHI012jkl");
    expect(r).not.toMatch(/anna|mail\.ru|912|t\.me|abc123XYZ/);
    expect(r).toContain("[user]");
    expect(r).toContain("[email]");
    expect(r).toContain("[phone]");
    expect(r).toContain("[link]");
    expect(r).toContain("[token]");
    expect(redact("Виза делается 3 недели")).toBe("Виза делается 3 недели");
  });
});

describe("checkQuotes", () => {
  it("keeps verbatim quotes and drops made-up ones", () => {
    const c = checkQuotes("Говорят «виза делается три недели», а ещё «бесплатно для всех».", ["Ну, виза  делается ТРИ недели обычно"]);
    expect(c.verified).toBe(1);
    expect(c.failed).toEqual(["бесплатно для всех"]);
    expect(c.text).toContain("«виза делается три недели»");
    expect(c.text).not.toContain("бесплатно");
  });
});

function world(reply: string) {
  const t = fakeTelegram();
  const calls: { url: string; body: any }[] = [];
  const net = async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return Response.json({ message: { role: "assistant", content: reply } });
  };
  const app = makeApp({ ...(env as any), OLLAMA_API_KEY: "test-key" }, t.fetcher, net);
  return { app, t, calls, texts: (c: number) => t.sent(c).map((x) => x.params.text as string) };
}

async function seed(app: any) {
  await enableGroup(app);
  const q = nextMsg();
  await feed(app, { message: { message_id: q, date: 1_700_000_000, chat: { id: GROUP, type: "supergroup", title: "G" }, from: { id: 11, is_bot: false }, text: "How long does visa paperwork take? write me at ann@example.com" } });
  await feed(app, { message: { message_id: nextMsg(), date: 1_700_000_060, chat: { id: GROUP, type: "supergroup", title: "G" }, from: { id: 12, is_bot: false }, text: "Visa paperwork took three weeks at the city office", reply_to_message: { message_id: q } } });
  await feed(app, groupMsg(13, "unrelated lunch chat"));
}

describe("conversation", () => {
  it("groups a message with what it replies to, inside the readable set only", async () => {
    const { app } = world("x");
    await seed(app);
    const id = (await env.DB.prepare("SELECT id FROM passages WHERE body LIKE 'Visa paperwork took%'").first<{ id: number }>())!.id;
    const mine = await readable(env.DB, await ensureMember(env.DB, 12));
    const turns = await conversation(env.DB, mine, id);
    expect(turns.map((t) => t.body)[0]).toContain("How long does visa");
    expect(turns.length).toBeLessThanOrEqual(4);
    expect(await conversation(env.DB, new Set(), id)).toEqual([]);
  });
});

describe("Beam summary on /ask", () => {
  it("adds a checked summary, sends only redacted text, and caches by content", async () => {
    const { app, calls, texts } = world('It took "three weeks at the city office". It is "always free".');
    await seed(app);
    await feed(app, dm(12, "/ask visa paperwork"));
    const out = texts(12).at(-1)!;
    expect(out).toContain("💡");
    expect(out).toContain("three weeks at the city office");
    expect(out).not.toContain("always free"); // not in the sources, removed
    expect(calls).toHaveLength(1);
    const sent = JSON.stringify(calls[0]!.body);
    expect(sent).not.toContain("ann@example.com");
    expect(sent).not.toMatch(/"?(11|12|13)"?,|tg_id|-100/);
    expect(calls[0]!.body.model).toBe("beam");
    await feed(app, dm(12, "/ask visa paperwork"));
    expect(calls).toHaveLength(1); // same input: served from cache
  });

  it("is off without a key and falls back silently on errors", async () => {
    const t = fakeTelegram();
    let called = 0;
    const off = makeApp(env as any, t.fetcher, async () => (called++, new Response("x")));
    await seed(off);
    await feed(off, dm(12, "/ask visa paperwork"));
    expect(called).toBe(0);
    const broken = makeApp({ ...(env as any), OLLAMA_API_KEY: "k" }, t.fetcher, async () => new Response("down", { status: 503 }));
    await feed(broken, dm(12, "/ask visa"));
    const last = t.sent(12).at(-1)!.params.text as string;
    expect(last).not.toContain("💡");
    expect(last).toContain("paperwork");
  });
});

describe("forgetting clears AI summaries", () => {
  it("/forget_me and /forget drop cached summaries that could quote the person", async () => {
    const { app, calls } = world('It took "three weeks at the city office".');
    await seed(app);
    await feed(app, dm(12, "/ask visa paperwork"));
    const n = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM ai_cache").first<{ n: number }>())!.n;
    expect(await n()).toBe(1);
    await feed(app, dm(12, "/forget_me"));
    await feed(app, press(12, "fm:yes"));
    expect(await n()).toBe(0);
    expect(calls).toHaveLength(1);
  });
});
