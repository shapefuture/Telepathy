import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ensureMember, readable } from "../src/acl";
import { answer } from "../src/search";
// @ts-expect-error plain JS module shared with the CLI
import { botApiChatId, countMessages, lit, toSql } from "../scripts/import-lib.mjs";
import { GROUP, enableGroup, testApp } from "./helpers";

const EXPORT = {
  name: "G",
  type: "private_supergroup",
  id: 1234567890,
  messages: [
    { id: 1, type: "message", date_unixtime: "1767261600", from: "Alice", from_id: "user5", text: "Our accountant is Dana.\nShe's great" },
    { id: 2, type: "message", date_unixtime: "1767261700", from_id: "user6", text: ["see ", { type: "link", text: "https://example.org" }], reply_to_message_id: 1 },
    { id: 3, type: "service", action: "join_group" },
    { id: 4, type: "message", date_unixtime: "1767261800", photo: "x.jpg", text: "" },
    { id: 5, type: "message", date_unixtime: "1767261900", from_id: "channel77", text: "channel post about the venue" },
  ],
};

async function run(sql: string[]) {
  for (const s of sql) await env.DB.prepare(s).run();
}

describe("history import", () => {
  it("maps Desktop ids and counts only text messages", () => {
    expect(botApiChatId(EXPORT)).toBe(GROUP);
    expect(countMessages(EXPORT)).toBe(3);
    expect(lit("it's\nok")).toBe("'it''s' || char(10) || 'ok'");
  });

  it("imports into an enabled source, idempotently, without names", async () => {
    const { app } = testApp();
    await enableGroup(app);
    const sql = [...toSql(EXPORT, GROUP)];
    await run(sql);
    await run(sql); // re-running is safe
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM passages").first<{ n: number }>();
    expect(n!.n).toBe(3);
    const body = await env.DB.prepare("SELECT body FROM passages WHERE msg_id=1").first<{ body: string }>();
    expect(body!.body).toBe("Our accountant is Dana.\nShe's great");
    expect(JSON.stringify(await env.DB.prepare("SELECT * FROM members").all())).not.toContain("Alice");
    const a = await answer(env.DB, await readable(env.DB, await ensureMember(env.DB, 5)), "who is the accountant");
    expect(a.status).toBe("answered");
  });

  it("stores nothing for a chat that isn't enabled, and skips opted-out members", async () => {
    await run([...toSql(EXPORT, GROUP)]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM passages").first<{ n: number }>())!.n).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM members").first<{ n: number }>())!.n).toBe(0);
    const { app } = testApp();
    await enableGroup(app);
    const m = await ensureMember(env.DB, 5);
    await env.DB.prepare("UPDATE members SET collection_opt_out=1 WHERE id=?").bind(m.id).run();
    await run([...toSql(EXPORT, GROUP)]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM passages WHERE author_id=?").bind(m.id).first<{ n: number }>())!.n).toBe(0);
  });
});
