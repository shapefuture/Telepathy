// Basic groups number messages per account, so the bot's live copy and the owner's history copy
// of one message have different ids. History must stop at the first /enable, and copies stored
// before that rule existed are cleaned up by migration 0014.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import cleanup from "../migrations/0014_basic_group_history_dupes.sql?raw";
import { ingestHistory, liveFrom, stagePage } from "../src/history";
import { OWNER, testApp } from "./helpers";

const BASIC = -5321510983;
const q = <T>(sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).first<T>();
const ENABLED = "2026-10-20T12:00:00Z";
const T = Date.parse(ENABLED) / 1000;

async function basicGroup(firstEnable = ENABLED, lastEnable = ENABLED) {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO sources(id, chat_id, title, visibility, enabled, enabled_at) VALUES ('b1', ?, 'Капибары', 'MEMBER_CONSENTED', 1, ?)").bind(BASIC, lastEnable),
    env.DB.prepare("INSERT INTO audit(at, actor, action, subject) VALUES (?, 'x', 'source.enable', 'b1')").bind(firstEnable),
    env.DB.prepare("INSERT INTO audit(at, actor, action, subject) VALUES (?, 'x', 'source.enable', 'b1')").bind(lastEnable),
  ]);
}

describe("history of basic groups", () => {
  it("only supergroups trust ids; basic groups stop at the first /enable", () => {
    expect(liveFrom(-1009876543210, ENABLED)).toBe(Number.POSITIVE_INFINITY);
    expect(liveFrom(-100123456, ENABLED)).toBe(T); // a basic group whose id merely starts with -100
    expect(liveFrom(BASIC, ENABLED)).toBe(T);
    expect(liveFrom(BASIC, "garbage")).toBe(Number.POSITIVE_INFINITY);
  });

  it("stores only what was written before the group was first enabled", async () => {
    const { app } = testApp();
    await basicGroup("2026-10-20T12:00:00Z", "2026-10-24T09:00:00Z"); // re-enabled later: the first one counts
    const msg = (id: number, date: number, text: string) => ({ id, date, text, from: 77, edit: 0, reply: null, topic: null });
    await stagePage(env.DB, OWNER, BASIC, 1, [msg(3, T + 86_400, "after enable: the bot has it"), msg(2, T - 60, "before"), msg(1, T - 3600, "long before")], false);
    await stagePage(env.DB, OWNER, BASIC, undefined, [], true);
    for (let i = 0; i < 3; i++) await ingestHistory(app);
    const { results } = await env.DB.prepare("SELECT body FROM passages ORDER BY msg_id").all<{ body: string }>();
    expect(results.map((r) => r.body)).toEqual(["long before", "before"]);
    expect(await q("SELECT imported, done_at IS NOT NULL AS d FROM history_jobs")).toEqual({ imported: 2, d: 1 });
  });

  it("migration 0014 removes copies stored before the fix and keeps the live message", async () => {
    await basicGroup();
    await env.DB.prepare("INSERT INTO members(id, tg_id, created_at) VALUES ('m1', 77, ?)").bind(ENABLED).run();
    await env.DB.prepare("INSERT INTO sources(id, chat_id, title, visibility, enabled, enabled_at) VALUES ('sg', -1009876543210, 'S', 'MEMBER_CONSENTED', 1, ?)").bind(ENABLED).run();
    const put = (src: string, msgId: number, body: string, at: string, author: string | null = "m1") =>
      env.DB.prepare("INSERT INTO passages(source_id, msg_id, part, author_id, body, event_at) VALUES (?,?,0,?,?,?)").bind(src, msgId, author, body, at);
    await env.DB.batch([
      put("b1", 10, "встреча в четверг", "2026-10-21T10:00:00Z"), // live (bot's id)
      put("b1", 11, "ок", "2026-10-21T10:01:00Z"), // live
      put("b1", 9001, "встреча в четверг", "2026-10-21T10:00:00Z"), // history copy (owner's id)
      put("b1", 9002, "ок", "2026-10-21T10:01:00Z", null), // other author: not a copy
      put("b1", 9003, "ок", "2026-10-21T10:02:00Z"), // other second: not a copy
      put("sg", 5, "same", "2026-10-21T10:00:00Z"), // supergroups are left alone
      put("sg", 6, "same", "2026-10-21T10:00:00Z"),
    ]);
    await env.DB.prepare("INSERT INTO ai_cache(key, kind, result, created_at) VALUES ('k', 'brief', 'встреча в четверг', ?)").bind(ENABLED).run();
    for (const stmt of cleanup.replace(/--.*$/gm, "").split(";").map((s: string) => s.trim()).filter(Boolean)) await env.DB.prepare(stmt).run();
    const { results } = await env.DB.prepare("SELECT msg_id, body IS NOT NULL AS kept FROM passages ORDER BY source_id, msg_id").all<{ msg_id: number; kept: number }>();
    expect(results).toEqual([
      { msg_id: 10, kept: 1 },
      { msg_id: 11, kept: 1 },
      { msg_id: 9001, kept: 0 },
      { msg_id: 9002, kept: 1 },
      { msg_id: 9003, kept: 1 },
      { msg_id: 5, kept: 1 },
      { msg_id: 6, kept: 1 },
    ]);
    expect(await q("SELECT COUNT(*) AS n FROM ai_cache")).toEqual({ n: 0 }); // summaries may have quoted the copies
    // The removed copy is gone from search too.
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM passages_fts WHERE passages_fts MATCH 'четверг'").first<{ n: number }>())!.n).toBe(1);
  });
});
