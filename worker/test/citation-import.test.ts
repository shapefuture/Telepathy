// Two decisions that depend on what a chat id means: where a message link exists, and which of a
// basic group's messages an export may store (the bot has the rest, under its own ids).
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { citation, isSupergroupId } from "../src/ingest";
import { feed, testApp, OWNER } from "./helpers";
// @ts-expect-error plain JS module shared with the CLI
import { toSql } from "../scripts/import-lib.mjs";

const SUPER = -1001234567890; // a supergroup: -100 then a channel id of ten digits
const BASIC = -1001234; // a basic group whose id happens to start with -100
const BASIC_OLD = -4242; // an older basic group

const run = async (sql: string[]) => {
  for (const s of sql) await env.DB.prepare(s).run();
};

describe("message links", () => {
  it("a supergroup has links; a basic group never does, even when its id starts with -100", () => {
    expect(isSupergroupId(SUPER)).toBe(true);
    expect(isSupergroupId(BASIC)).toBe(false);
    expect(citation(SUPER, 5, null)).toBe("https://t.me/c/1234567890/5");
    expect(citation(SUPER, 5, null, 9)).toBe("https://t.me/c/1234567890/9/5");
    expect(citation(BASIC, 5, null)).toBeNull();
    expect(citation(BASIC_OLD, 5, null)).toBeNull();
  });

  it("a public username always links, whatever the id", () => {
    expect(citation(BASIC, 5, "club")).toBe("https://t.me/club/5");
  });
});

describe("importing a basic group's export", () => {
  // Desktop exports give basic groups a positive id; the importer maps it to -id.
  const EXPORT = {
    id: 4242,
    type: "private_group",
    messages: [
      { id: 1, type: "message", date_unixtime: "1577836800", from_id: "user5", text: "Written before the bot was added" }, // 2020
      { id: 2, type: "message", date_unixtime: "4102444800", from_id: "user6", text: "Written after, the bot already has it" }, // 2100
    ],
  };

  it("keeps only messages from before the group was first enabled", async () => {
    const t = testApp();
    // The owner enables the basic group now: the bot stores everything from this moment on.
    await feed(t.app, { message: { message_id: 90, date: 1, chat: { id: BASIC_OLD, type: "group", title: "Old" }, from: { id: OWNER, is_bot: false }, text: "/enable", entities: [{ type: "bot_command", offset: 0, length: 7 }] } } as never);
    await run([...toSql(EXPORT, BASIC_OLD)]);
    const rows = await env.DB.prepare("SELECT body FROM passages ORDER BY msg_id").all<{ body: string }>();
    expect(rows.results.map((r) => r.body)).toEqual(["Written before the bot was added"]);
  });
});
