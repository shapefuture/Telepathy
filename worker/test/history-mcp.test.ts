// Reading past messages through the owner's Telegram MCP server: no app, no screen.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ingestHistory, stagePage } from "../src/history";
import { exportHistory, readViaMcp, startAuto } from "../src/history-mcp";
import { enableGroup, GROUP, OWNER, testApp } from "./helpers";
import type { App } from "../src/bot";
import type { Env } from "../src/env";

const E = env as unknown as Env;
const MCP = { ...E, TG_MCP_URL: "https://mcp.example", TG_MCP_KEY: "tmcp_00000000-0000-0000-0000-000000000000" };
const T0 = Math.floor(Date.now() / 1000) - 200 * 86_400;
const q = <T>(sql: string) => env.DB.prepare(sql).first<T>();

/** A fake telegram_mcp /webhook serving export_history over messages 1..n. */
function fakeMcp(n: number, opts: { fail?: boolean; text?: string } = {}) {
  const calls: { url: string; key: string | null; body: any }[] = [];
  const net = async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, key: new Headers(init.headers).get("X-API-Key"), body });
    if (opts.fail) return new Response("upstream down", { status: 502 });
    if (opts.text) return Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: opts.text }] } });
    const { offset_id, limit } = body.params.arguments;
    const ids = Array.from({ length: n }, (_, i) => n - i).filter((id) => offset_id === 0 || id < offset_id).slice(0, limit);
    const messages = ids.filter((id) => id % 10 !== 0).map((id) => ({ id, date: T0 + id * 3600, text: `old message ${id}`, from: 500 + (id % 4), edit: 0, reply: id > 1 ? id - 1 : null, topic: null }));
    const next = ids.length < limit || Math.min(...ids) <= 1 ? null : Math.min(...ids);
    return Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ messages, next_offset: next, scanned: ids.length }) }] } });
  };
  return { net, calls };
}

function mcpApp(n: number, opts?: Parameters<typeof fakeMcp>[1]) {
  const t = testApp();
  const fake = fakeMcp(n, opts);
  const app: App = { ...t.app, env: MCP, net: fake.net };
  return { app, ...fake, sent: t.sent };
}

const atMinute = (m: number) => {
  const d = new Date();
  d.setUTCMinutes(m, 0, 0);
  return d;
};

describe("history through the owner's MCP server", () => {
  it("/enable starts it by itself; the cron reads, stores, and tells the owner", async () => {
    const { app, calls, sent } = mcpApp(1200);
    await enableGroup(app);
    const guide = sent(OWNER).at(-1)!.params;
    expect(guide.text).toContain("by myself");
    expect(guide.reply_markup).toBeUndefined(); // nothing to tap
    expect(await q("SELECT mcp_offset FROM history_jobs")).toEqual({ mcp_offset: 0 });

    for (let i = 0; i < 4; i++) await readViaMcp(app, atMinute(1));
    expect(calls.map((c) => c.body.params.arguments.offset_id)).toEqual([0, 701, 201]); // done after 3 pages
    expect(calls[0]).toMatchObject({ url: "https://mcp.example/webhook", key: MCP.TG_MCP_KEY, body: { method: "tools/call", params: { name: "export_history", arguments: { chat_id: String(GROUP), limit: 500 } } } });
    expect(await q("SELECT read_at IS NOT NULL AS r, staged FROM history_jobs")).toEqual({ r: 1, staged: 1080 });

    for (let i = 0; i < 10; i++) await ingestHistory(app);
    expect(await q("SELECT COUNT(*) AS n FROM passages")).toEqual({ n: 1080 });
    expect(await q("SELECT reply_to FROM passages WHERE msg_id=42")).toEqual({ reply_to: 41 });
    expect(sent(OWNER).filter((c) => String(c.params.text).includes("is loaded: 1080"))).toHaveLength(1);
  });

  it("groups enabled before the key was set are picked up within ten minutes", async () => {
    const plain = testApp();
    await enableGroup(plain.app); // no MCP yet: the usual button
    expect(await q("SELECT COUNT(*) AS n FROM history_jobs")).toEqual({ n: 0 });
    const { app, calls } = mcpApp(50);
    await readViaMcp(app, atMinute(3));
    expect(calls).toHaveLength(0);
    await readViaMcp(app, atMinute(10));
    expect(calls).toHaveLength(1);
    expect(await q("SELECT owner_tg, read_at IS NOT NULL AS r FROM history_jobs")).toEqual({ owner_tg: OWNER, r: 1 });
  });

  it("while the MCP server reads a chat, the app can't read it too", async () => {
    const { app } = mcpApp(50);
    await enableGroup(app);
    expect(await stagePage(env.DB, OWNER, GROUP, 0, [], false)).toEqual({ ok: false, error: "auto" });
  });

  it("ten failed minutes in a row: stop, tell the owner, hand the chat back to the app", async () => {
    const { app, sent } = mcpApp(50, { fail: true });
    await enableGroup(app);
    for (let i = 0; i < 10; i++) expect(await readViaMcp(app, atMinute(1))).toBe(0);
    expect(await q("SELECT mcp_offset, mcp_errors FROM history_jobs")).toEqual({ mcp_offset: null, mcp_errors: 10 });
    expect(sent(OWNER).at(-1)!.params.text).toContain("couldn't read the history");
    expect(await readViaMcp(app, atMinute(1))).toBe(0);
    expect((await stagePage(env.DB, OWNER, GROUP, 0, [], false)).ok).toBe(true);
  });

  it("an old server without export_history is reported as an error, not parsed", async () => {
    const { app } = mcpApp(50, { text: "Error: Tool export_history not found. Available tools: get_messages" });
    await expect(exportHistory(app, GROUP, 0)).rejects.toThrow("Tool export_history not found");
  });

  it("stops at the retention horizon", async () => {
    const { app, calls } = mcpApp(1200);
    await enableGroup(app);
    await env.DB.prepare("UPDATE sources SET retention_days=?").bind(Math.ceil((Date.now() / 1000 - (T0 + 900 * 3600)) / 86_400)).run();
    for (let i = 0; i < 4; i++) await readViaMcp(app, atMinute(1));
    expect(calls).toHaveLength(2); // page 2 (ids 700…201) is entirely past the horizon
    expect(await q("SELECT read_at IS NOT NULL AS r FROM history_jobs")).toEqual({ r: 1 });
  });

  it("uses the service binding when both Workers share an account (workers.dev fetches are blocked there)", async () => {
    const fake = fakeMcp(5);
    let viaBinding = 0;
    const t = testApp();
    const binding = { fetch: (u: string, i: RequestInit) => ((viaBinding += 1), fake.net(u, i)) } as unknown as Fetcher;
    const app: App = { ...t.app, env: { ...MCP, TG_MCP_URL: "", TG_MCP: binding }, net: async () => { throw new Error("must not use the public URL"); } };
    const page = await exportHistory(app, GROUP, 0);
    expect(viaBinding).toBe(1);
    expect(page.next_offset).toBeNull();
    expect(page.messages).toHaveLength(5);
  });

  it("does nothing without a key", async () => {
    const t = testApp();
    await enableGroup(t.app);
    expect(await startAuto(env.DB, E)).toBe(0);
    expect(await readViaMcp(t.app, atMinute(10))).toBe(0);
  });
});
