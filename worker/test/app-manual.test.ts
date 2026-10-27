// Mini App: skills typed in by hand and events added by hand.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handleFetch } from "../src/index";
import { enableGroup, fakeTelegram, feed, groupMsg, OWNER, testApp } from "./helpers";

const ALICE = 61;
const BOB = 62;
async function sign(fields: Record<string, string>) {
  const enc = new TextEncoder();
  const key = async (k: BufferSource) => crypto.subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const secret = await crypto.subtle.sign("HMAC", await key(enc.encode("WebAppData")), enc.encode("123456:TEST"));
  const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
  const hash = [...new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret), enc.encode(check)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return new URLSearchParams({ ...fields, hash }).toString();
}
function client(id: number) {
  const call = async (method: string, path: string, body?: unknown) => {
    const init = await sign({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id, username: `u${id}x` }) });
    const res = await handleFetch(new Request(`https://bot.example/app/api/${path}`, { method, headers: { "content-type": "application/json", "x-telegram-init-data": init }, body: body ? JSON.stringify(body) : undefined }), env as never, fakeTelegram().fetcher);
    return { status: res.status, body: (await res.json()) as any };
  };
  return { get: (p: string) => call("GET", p), post: (p: string, b: unknown = {}) => call("POST", p, b) };
}
async function world() {
  const { app } = testApp();
  await enableGroup(app);
  for (const u of [OWNER, ALICE, BOB]) await feed(app, groupMsg(u, "hello there"));
}
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

describe("own skills", () => {
  it("a skill outside the list is kept as typed, shown to its owner, and can be removed", async () => {
    await world();
    const alice = client(ALICE);
    expect((await alice.post("skills", { code: "Sourdough baking", on: true })).body).toMatchObject({ ok: true, code: "my:Sourdough baking" });
    expect((await alice.post("skills", { code: "bookkeeping", on: true })).body.ok).toBe(true);
    const me = (await alice.get("me")).body;
    expect(me.skillLabels.map((s: { label: string }) => s.label)).toContain("Sourdough baking");
    expect((await alice.post("skills", { code: "my:Sourdough baking", on: false })).body.ok).toBe(true);
    expect((await alice.get("me")).body.skillLabels.map((s: { label: string }) => s.label)).not.toContain("Sourdough baking");
  });
  it("rejects empty text and stops at 20 own skills", async () => {
    await world();
    const alice = client(ALICE);
    expect((await alice.post("skills", { code: " < ", on: true })).status).toBe(400);
    for (let i = 0; i < 20; i++) expect((await alice.post("skills", { code: `my:zzskill${i}`, on: true })).body.ok).toBe(true);
    expect((await alice.post("skills", { code: "my:zzskill-extra", on: true })).status).toBe(400);
  });
});

describe("events added by hand", () => {
  it("shows up for the group, with RSVP, and only its author can remove it", async () => {
    await world();
    const alice = client(ALICE);
    const bob = client(BOB);
    const group = (await alice.get("me")).body.groups[0].id;
    const add = (await alice.post("events/add", { title: "Board games night", starts_at: inDays(3), group })).body;
    expect(add.ok).toBe(true);
    const list = (await bob.get("events")).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ title: "Board games night", url: null, mine: false, going: false });
    expect((await alice.get("events")).body[0]).toMatchObject({ mine: true, going: true });
    expect((await bob.post("events/rsvp", { key: add.key, going: true })).body.ok).toBe(true);
    expect((await bob.get("events")).body[0].going).toBe(true);
    expect((await bob.post("events/remove", { key: add.key })).status).toBe(403);
    expect((await alice.post("events/remove", { key: add.key })).body.ok).toBe(true);
    expect((await bob.get("events")).body).toHaveLength(0);
  });
  it("checks title, date, group and a limit of five", async () => {
    await world();
    const alice = client(ALICE);
    const group = (await alice.get("me")).body.groups[0].id;
    for (const bad of [
      { title: "x", starts_at: inDays(2), group },
      { title: "Fine title", starts_at: "nope", group },
      { title: "Fine title", starts_at: inDays(-3), group },
      { title: "Fine title", starts_at: inDays(2), group: "not-a-group" },
    ])
      expect((await alice.post("events/add", bad)).status).toBe(400);
    for (let i = 0; i < 5; i++) expect((await alice.post("events/add", { title: `Event ${i}`, starts_at: inDays(2 + i), group })).body.ok).toBe(true);
    expect((await alice.post("events/add", { title: "One too many", starts_at: inDays(9), group })).status).toBe(429);
  });
});
