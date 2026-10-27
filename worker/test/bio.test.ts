// Bio import: a link or pasted text becomes skills; nothing else is kept.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { htmlToText, isPrivateTrait, lonelyUrl, safeUrl } from "../src/bio";
import { handleFetch, makeApp } from "../src/index";
import { enableGroup, fakeTelegram, feed, groupMsg, dm, OWNER } from "./helpers";
import type { Fetcher } from "../src/telegram";

const USER = 71;
const SITE = `<html><head><title>Anna Petrova - bookkeeper</title><meta name="description" content="I do bookkeeping and tax filing for small shops"></head><body><script>var x="python"</script><p>Also: Figma prototyping workshops.</p></body></html>`;
const html = (body: string, status = 200, url = "https://anna.example/"): Response => Object.defineProperty(new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } }), "url", { value: url });

async function setup(net?: Fetcher, ai?: unknown) {
  const t = fakeTelegram();
  const app = makeApp({ ...env, WORKERS_AI_MODEL: ai ? "test" : "off", ...(ai ? { AI: ai } : {}) } as never, t.fetcher, net);
  await enableGroup(app);
  await feed(app, groupMsg(OWNER, "hi"));
  await feed(app, groupMsg(USER, "hello there"));
  const skills = async () => (await env.DB.prepare("SELECT code FROM skills WHERE member_id=(SELECT id FROM members WHERE tg_id=?) ORDER BY code").bind(USER).all<{ code: string }>()).results.map((r) => r.code);
  const said = () => t.sent(USER).map((c) => c.params.text as string);
  return { app, t, skills, said };
}

describe("reading a link safely", () => {
  it("accepts public https pages only", () => {
    expect(safeUrl("https://anna.example/about")?.href).toBe("https://anna.example/about");
    expect(safeUrl("http://anna.example")?.protocol).toBe("https:");
    expect(safeUrl("www.anna.example")?.hostname).toBe("www.anna.example");
    for (const bad of ["http://127.0.0.1/", "https://10.0.0.5/", "https://localhost/x", "https://[::1]/", "https://intranet/", "https://printer.local/", "https://anna.example:8443/", "https://u:p@anna.example/", "ftp://anna.example/", "javascript:alert(1)", "not a url"]) expect(safeUrl(bad)).toBeNull();
  });
  it("recognises a message that is only a link", () => {
    expect(lonelyUrl(" https://anna.example/me ")).toBe("https://anna.example/me");
    expect(lonelyUrl("www.anna.example")).toBe("www.anna.example");
    expect(lonelyUrl("who knows https://anna.example")).toBeNull();
    expect(lonelyUrl("how do I file VAT?")).toBeNull();
  });
  it("turns a page into text without scripts, keeping title and description", () => {
    const t = htmlToText(SITE);
    expect(t).toContain("Anna Petrova - bookkeeper");
    expect(t).toContain("bookkeeping and tax filing");
    expect(t).toContain("Figma prototyping");
    expect(t).not.toContain("var x");
  });
  it("never offers private traits", () => {
    expect(isPrivateTrait("Cancer survivor")).toBe(true);
    expect(isPrivateTrait("Религиозные практики")).toBe(true);
    expect(isPrivateTrait("Bookkeeping")).toBe(false);
  });
});

describe("/bio in the bot", () => {
  it("adds skills from pasted text, keeps no copy, and says so", async () => {
    const { app, skills, said } = await setup();
    await feed(app, dm(USER, "/bio I run a small bakery and do bookkeeping and tax filing for local shops, plus python scripting"));
    const got = await skills();
    expect(got).toContain("accounting");
    expect(said().at(-1)).toMatch(/Added to your skills/);
    expect(JSON.stringify(await env.DB.prepare("SELECT * FROM passages WHERE body LIKE '%bakery%' AND source_id NOT IN (SELECT id FROM sources WHERE enabled=1)").all())).not.toContain("bakery");
  });
  it("reads a link sent on its own", async () => {
    const seen: string[] = [];
    const { app, skills } = await setup(async (url) => {
      seen.push(url);
      return html(SITE);
    });
    await feed(app, dm(USER, "https://anna.example/"));
    expect(seen).toEqual(["https://anna.example/"]);
    expect(await skills()).toContain("accounting");
  });
  it("asks for text when the site can't be read (LinkedIn), without fetching it", async () => {
    let fetched = 0;
    const { app, said, skills } = await setup(async () => {
      fetched++;
      return html("x");
    });
    await feed(app, dm(USER, "https://www.linkedin.com/in/anna"));
    expect(fetched).toBe(0);
    expect(said().at(-1)).toMatch(/LinkedIn/);
    expect(await skills()).toEqual([]);
  });
  it("refuses private addresses and a login wall, and explains how to use it with no arguments", async () => {
    const { app, said } = await setup(async () => html("login", 403));
    await feed(app, dm(USER, "https://127.0.0.1/"));
    expect(said().at(-1)).toMatch(/https:\/\//);
    await feed(app, dm(USER, "https://anna.example/private"));
    expect(said().at(-1)).toMatch(/doesn't let me read/);
    await feed(app, dm(USER, "/bio"));
    expect(said().at(-1)).toMatch(/link to your site/);
  });
  it("shows own skills in /skills without failing", async () => {
    const { app, said } = await setup();
    await env.DB.prepare("INSERT INTO skills(member_id, code, state) SELECT id, 'my:Sourdough', 'confirmed' FROM members WHERE tg_id=?").bind(USER).run();
    await feed(app, dm(USER, "/skills"));
    expect(said().at(-1)).toContain("Sourdough");
  });
});

describe("a model adds the person's own wording", () => {
  it("keeps skills outside the list as own skills and drops private traits", async () => {
    const ai = { run: async () => ({ response: 'Sure: ["Sourdough baking", "bookkeeping", "Cancer survivor", "Figma"]' }) };
    const { app, skills } = await setup(undefined, ai);
    await feed(app, dm(USER, "/bio I bake sourdough bread and keep the books for three shops in town"));
    const got = await skills();
    expect(got).toContain("my:Sourdough baking");
    expect(got).toContain("accounting");
    expect(got.some((c) => /cancer/i.test(c))).toBe(false);
  });
  it("falls back to the taxonomy when the model is down", async () => {
    const ai = { run: async () => { throw new Error("down"); } };
    const { app, skills } = await setup(undefined, ai);
    await feed(app, dm(USER, "/bio bookkeeping and tax filing for small shops, every quarter"));
    expect(await skills()).toContain("accounting");
  });
});

async function sign(fields: Record<string, string>) {
  const enc = new TextEncoder();
  const key = async (k: BufferSource) => crypto.subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const secret = await crypto.subtle.sign("HMAC", await key(enc.encode("WebAppData")), enc.encode("123456:TEST"));
  const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
  const hash = [...new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret), enc.encode(check)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return new URLSearchParams({ ...fields, hash }).toString();
}

describe("Mini App import", () => {
  it("reads a link or text and answers with the skills added, or why not", async () => {
    const t = fakeTelegram();
    const e = { ...env, WORKERS_AI_MODEL: "off" } as never;
    const app = makeApp(e, t.fetcher);
    await enableGroup(app);
    await feed(app, groupMsg(OWNER, "hi"));
    await feed(app, groupMsg(72, "hello there"));
    const net: Fetcher = async (url) => (url.includes("anna") ? html(SITE) : html("", 403, url));
    const call = async (text: string) => {
      const init = await sign({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 72, username: "u72x" }) });
      const res = await handleFetch(new Request("https://bot.example/app/api/skills/bio", { method: "POST", headers: { "content-type": "application/json", "x-telegram-init-data": init }, body: JSON.stringify({ text }) }), e, t.fetcher, net);
      return { status: res.status, body: (await res.json()) as any };
    };
    expect((await call("https://anna.example/")).body).toMatchObject({ ok: true, added: expect.arrayContaining([expect.stringMatching(/accounting|Accounting|бухгалтер/i)]) });
    expect((await call("https://closed.example/")).body).toEqual({ ok: false, status: "blocked" });
    expect((await call("hi")).body).toEqual({ ok: false, status: "short" });
    expect((await call("http://10.0.0.1/")).body).toEqual({ ok: false, status: "bad_url" });
  });
});
