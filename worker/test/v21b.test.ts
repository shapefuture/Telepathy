import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ensureMember, readable } from "../src/acl";
import { verifyInitData } from "../src/app";
import { markCanonical, parseEventDate, routeUnanswered, suggestSkills, toIcs, upcomingEvents } from "../src/features";
import { handleFetch } from "../src/index";
import { answer, parseFilters } from "../src/search";
import { GROUP, OWNER, dm, enableGroup, feed, groupCmd, groupMsg, press, testApp } from "./helpers";

const OTHER = -1009;
const inOther = <T extends { message: any }>(u: T): T => ({ ...u, message: { ...u.message, chat: { id: OTHER, type: "supergroup", title: "Other" } } });
const ago = (h: number) => Math.floor(Date.now() / 1000) - h * 3600;
const srcId = async (chat = GROUP) => (await env.DB.prepare("SELECT id FROM sources WHERE chat_id=?").bind(chat).first<{ id: string }>())!.id;

async function expert(app: any, tg: number, skill = "accounting") {
  await feed(app, groupMsg(tg, "hi"));
  await feed(app, dm(tg, "/optin"));
  await feed(app, dm(tg, `/skills add ${skill}`));
}

describe("P13-03 unanswered-question routing", () => {
  it("pings at most 2 opted-in experts who can read the group, once, only when routing is on", async () => {
    const { app, sent } = testApp();
    await enableGroup(app);
    for (const tg of [11, 12, 13]) await expert(app, tg);
    await feed(app, inOther(groupCmd(OWNER, "/enable")));
    await expert(app, 14); // opted in but never in GROUP: can't read it
    await env.DB.prepare("DELETE FROM source_access WHERE member_id=(SELECT id FROM members WHERE tg_id=14) AND source_id=?").bind(await srcId()).run();
    await feed(app, groupMsg(1, "Can anyone recommend an accountant for my startup?", { date: ago(5) }));
    expect(await routeUnanswered(env.DB)).toHaveLength(0); // routing off by default
    await feed(app, groupCmd(OWNER, "/routing on"));
    const keys = await routeUnanswered(env.DB);
    expect(keys).toHaveLength(2);
    const targets = (await env.DB.prepare("SELECT chat_id FROM effects WHERE key LIKE 'route:%' AND state='pending'").all<{ chat_id: number }>()).results.map((r) => r.chat_id);
    expect(targets).not.toContain(14);
    expect(await routeUnanswered(env.DB)).toHaveLength(0); // never twice
  });

  it("skips answered or too-fresh questions and experts who turned pings off", async () => {
    const { app } = testApp();
    await enableGroup(app);
    await feed(app, groupCmd(OWNER, "/routing on"));
    await expert(app, 11);
    await feed(app, dm(11, "/pings off"));
    await expert(app, 12);
    const q = groupMsg(1, "Can anyone recommend an accountant for my startup?", { date: ago(5) });
    await feed(app, q);
    await feed(app, groupMsg(2, "Try Dana", { reply_to_message: { message_id: q.message.message_id } }));
    await feed(app, groupMsg(1, "Can anyone recommend an accountant for taxes?", { date: ago(1) }));
    expect(await routeUnanswered(env.DB)).toHaveLength(0);
  });
});

describe("P13-06 /catchup", () => {
  it("summarises the member's groups since a time, never other groups", async () => {
    const { app, texts } = testApp();
    await enableGroup(app);
    await feed(app, inOther(groupCmd(OWNER, "/enable")));
    await feed(app, groupMsg(5, "Can anyone recommend a dentist?"));
    await feed(app, inOther(groupMsg(6, "Can anyone recommend a lawyer?")));
    await feed(app, dm(5, "/catchup 12h"));
    expect(texts(5).at(-1)).toContain("dentist");
    expect(texts(5).at(-1)).not.toContain("lawyer");
    await feed(app, dm(5, "/catchup")); // since the last catchup: nothing new
    expect(texts(5).at(-1)).toContain("Nothing new");
    await feed(app, dm(5, "/catchup yesterday"));
    expect(texts(5).at(-1)).toContain("Usage");
  });
});

describe("P13-07 canonical answers", () => {
  it("ranks first, and marking a newer one labels the old one outdated", async () => {
    const { app } = testApp();
    await enableGroup(app);
    const old = groupMsg(5, "The office wifi password is on the fridge sticker");
    await feed(app, old);
    await feed(app, groupMsg(6, "wifi in the office is slow today, the password works though"));
    await feed(app, groupCmd(OWNER, "/canonical", { reply_to_message: { message_id: old.message.message_id } }));
    let a = await answer(env.DB, new Set([await srcId()]), "office wifi password");
    expect(a.quotes[0]!.tag).toBe("canonical");
    const neu = groupMsg(5, "New office wifi password is printed at the reception desk");
    await feed(app, neu);
    const r = await markCanonical(env.DB, await srcId(), neu.message.message_id);
    expect(r).toEqual({ ok: true, superseded: 1 });
    a = await answer(env.DB, new Set([await srcId()]), "office wifi password");
    expect(a.quotes[0]!.text).toContain("reception");
    expect(a.quotes.find((q) => q.text.includes("fridge"))?.tag).toBe("outdated");
  });

  it("non-owners can't mark canonical", async () => {
    const { app } = testApp();
    await enableGroup(app);
    const m = groupMsg(5, "some answer");
    await feed(app, m);
    await feed(app, groupCmd(7, "/canonical", { reply_to_message: { message_id: m.message.message_id } }));
    expect((await env.DB.prepare("SELECT MAX(canonical) AS c FROM passages").first<{ c: number }>())!.c).toBe(0);
  });
});

describe("P13-08 search filters", () => {
  it("in:/since:/has:file only narrow results", async () => {
    const { app } = testApp({ files: { F1: "venue notes: hall B" } });
    await enableGroup(app);
    await feed(app, inOther(groupCmd(OWNER, "/enable")));
    await feed(app, groupMsg(OWNER, "venue is hall A", { date: ago(24 * 40) }));
    await feed(app, groupMsg(OWNER, "venue moved", { document: { file_id: "F1", file_name: "notes.txt", file_size: 20 } }));
    await feed(app, inOther(groupMsg(OWNER, "venue for the secret board meeting")));
    const owner = await ensureMember(env.DB, OWNER);
    const all = await readable(env.DB, owner);
    const inG = await parseFilters(env.DB, all, "venue in:other");
    expect(inG.readable).toEqual(new Set([await srcId(OTHER)]));
    expect(inG.query).toBe("venue");
    const since = await parseFilters(env.DB, all, "venue since:7d");
    expect((await answer(env.DB, since.readable, since.query, since.filters)).quotes.every((q) => !q.text.includes("hall A"))).toBe(true);
    const files = await parseFilters(env.DB, all, "venue has:file");
    const fq = await answer(env.DB, files.readable, files.query, files.filters);
    expect(fq.quotes.map((q) => q.label)).toEqual(["notes.txt"]);
    // A filter can never add a group the member can't read.
    const m5 = await ensureMember(env.DB, 5);
    expect((await parseFilters(env.DB, await readable(env.DB, m5), "venue in:other")).readable.size).toBe(0);
  });
});

describe("P13-09 private skill suggestions", () => {
  it("suggests once after several helpful replies, and stores nothing unless accepted", async () => {
    const { app } = testApp();
    await enableGroup(app);
    for (let i = 0; i < 3; i++) {
      const q = groupMsg(1, `question ${i}?`);
      await feed(app, q);
      await feed(app, groupMsg(5, `As an accountant I'd file VAT quarterly ${i}`, { reply_to_message: { message_id: q.message.message_id } }));
    }
    expect(await suggestSkills(env.DB)).toHaveLength(1);
    expect(await suggestSkills(env.DB)).toHaveLength(0); // once
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM skills").first<{ n: number }>())!.n).toBe(0);
    await feed(app, press(5, "s:accounting:add"));
    expect((await env.DB.prepare("SELECT state FROM skills WHERE code='accounting'").first<{ state: string }>())!.state).toBe("confirmed");
  });
});

describe("P13-10 events", () => {
  it("parses dates in EN/RU formats", () => {
    const now = new Date("2026-10-23T12:00:00Z");
    expect(parseEventDate("Meetup on 2026-11-05 at 19:30", now)).toBe("2026-11-05T19:30:00Z");
    expect(parseEventDate("Встреча 12 ноября в 18:00", now)).toBe("2026-11-12T18:00:00Z");
    expect(parseEventDate("join us 5.11 at 10:00", now)).toBe("2026-11-05T10:00:00Z");
    expect(parseEventDate("webinar on November 3", now)).toBe("2026-11-03T12:00:00Z");
    expect(parseEventDate("join us on January 10", now)).toBe("2027-01-10T12:00:00Z"); // rolls to next year
    expect(parseEventDate("no date here", now)).toBeNull();
  });

  it("lists upcoming events from readable groups with an .ics file; moderators can hide them", async () => {
    const { app, calls, texts } = testApp();
    await enableGroup(app);
    await feed(app, inOther(groupCmd(OWNER, "/enable")));
    const y = new Date().getUTCFullYear() + 1;
    const ev = groupMsg(5, `Join us: meetup on ${y}-03-10 at 19:00 in Hall B`);
    await feed(app, ev);
    await feed(app, inOther(groupMsg(6, `Join us: secret board meeting on ${y}-03-11`)));
    await feed(app, dm(5, "/events"));
    expect(texts(5).at(-1)).toContain("Hall B");
    expect(texts(5).at(-1)).not.toContain("secret");
    const doc = calls.find((c) => c.method === "sendDocument")!;
    expect(doc.params.document.name).toBe("telepathy-events.ics");
    expect(toIcs(await upcomingEvents(env.DB, new Set([await srcId()])))).toContain(`DTSTART:${y}0310T`);
    await feed(app, groupCmd(OWNER, "/notevent", { reply_to_message: { message_id: ev.message.message_id } }));
    await feed(app, dm(5, "/events"));
    expect(texts(5).at(-1)).toContain("No upcoming events");
  });
});

describe("P13-11 Mini App", () => {
  async function sign(fields: Record<string, string>, token = "123456:TEST") {
    const enc = new TextEncoder();
    const key = async (k: BufferSource) => crypto.subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const secret = await crypto.subtle.sign("HMAC", await key(enc.encode("WebAppData")), enc.encode(token));
    const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
    const hash = [...new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret), enc.encode(check)))].map((b) => b.toString(16).padStart(2, "0")).join("");
    return new URLSearchParams({ ...fields, hash }).toString();
  }
  const now = () => String(Math.floor(Date.now() / 1000));

  it("verifies Telegram's signature and freshness", async () => {
    const good = await sign({ auth_date: now(), user: JSON.stringify({ id: 5 }) });
    expect(await verifyInitData(good, "123456:TEST")).toBe(5);
    expect(await verifyInitData(good, "999:OTHER")).toBeNull(); // wrong bot token
    expect(await verifyInitData(good.replace("%22id%22%3A5", "%22id%22%3A6"), "123456:TEST")).toBeNull(); // tampered
    const stale = await sign({ auth_date: String(Math.floor(Date.now() / 1000) - 3 * 86400), user: JSON.stringify({ id: 5 }) });
    expect(await verifyInitData(stale, "123456:TEST")).toBeNull();
  });

  it("serves the page; the API refuses unsigned calls and never leaks other groups", async () => {
    const { app } = testApp();
    await enableGroup(app);
    await feed(app, inOther(groupCmd(OWNER, "/enable")));
    await feed(app, groupMsg(5, "The venue is Hall B"));
    await feed(app, inOther(groupMsg(6, "The secret venue is room 7")));
    const page = await handleFetch(new Request("https://bot.example/app"), env);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    const call = (path: string, init: RequestInit = {}, data?: string) =>
      handleFetch(new Request(`https://bot.example${path}`, { ...init, headers: { "content-type": "application/json", ...(data ? { "x-telegram-init-data": data } : {}) } }), env);
    expect((await call("/app/api/profile")).status).toBe(401);
    const data = await sign({ auth_date: now(), user: JSON.stringify({ id: 5 }) });
    const res = (await (await call("/app/api/ask", { method: "POST", body: JSON.stringify({ q: "venue" }) }, data)).json()) as any;
    expect(res.status).toBe("answered");
    expect(JSON.stringify(res)).toContain("Hall B");
    expect(JSON.stringify(res)).not.toContain("room 7");
    await call("/app/api/settings", { method: "POST", body: JSON.stringify({ digest: true, lang: "ru" }) }, data);
    const prof = (await (await call("/app/api/profile", {}, data)).json()) as any;
    expect(prof).toMatchObject({ lang: "ru", flags: { digest: true } });
    const stranger = await sign({ auth_date: now(), user: JSON.stringify({ id: 4242 }) });
    expect((await call("/app/api/profile", {}, stranger)).status).toBe(403);
  });
});
