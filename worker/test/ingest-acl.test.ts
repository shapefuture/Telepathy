import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ensureMember, readable, revoke } from "../src/acl";
import { resetRateLimits } from "../src/bot";
import { ingestMessage, removeMessage } from "../src/ingest";
import { search } from "../src/search";
import { GROUP, OWNER, dm, enableGroup, feed, groupCmd, groupMsg, testApp } from "./helpers";

const count = async (sql: string) => (await env.DB.prepare(sql).first<{ n: number }>())!.n;
const ctxFor = async (tg: number) => readable(env.DB, (await ensureMember(env.DB, tg)));

beforeEach(() => resetRateLimits());

describe("ingestion", () => {
  it("stores nothing for chats that were not enabled (C01)", async () => {
    const { app } = testApp();
    await feed(app, groupMsg(5, "hello before enable"));
    expect(await count("SELECT COUNT(*) AS n FROM passages")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM members")).toBe(0);
  });

  it("replays are idempotent", async () => {
    const { app } = testApp();
    await enableGroup(app);
    const u = groupMsg(5, "where is the meetup?");
    for (let i = 0; i < 4; i++) await ingestMessage(env.DB, u.message as any);
    expect(await count("SELECT COUNT(*) AS n FROM passages")).toBe(1);
  });

  it("out-of-order edits converge to the newest version", async () => {
    const { app } = testApp();
    await enableGroup(app);
    const base = groupMsg(5, "original").message as any;
    const v1 = { ...base, text: "first edit", edit_date: base.date + 10 };
    const v2 = { ...base, text: "second edit", edit_date: base.date + 20 };
    await ingestMessage(env.DB, v2);
    await ingestMessage(env.DB, base);
    await ingestMessage(env.DB, v1);
    const row = await env.DB.prepare("SELECT body FROM passages").first<{ body: string }>();
    expect(row!.body).toBe("second edit");
    const r = await search(env.DB, await ctxFor(5), "original");
    expect(r.hits).toHaveLength(0); // the FTS index followed the edit
  });

  it("collection opt-out stores nothing (C13)", async () => {
    const { app } = testApp();
    await enableGroup(app);
    const m = await ensureMember(env.DB, 7);
    await env.DB.prepare("UPDATE members SET collection_opt_out=1 WHERE id=?").bind(m.id).run();
    expect((await ingestMessage(env.DB, groupMsg(7, "secret").message as any)).outcome).toBe("opted_out");
    expect(await count("SELECT COUNT(*) AS n FROM passages")).toBe(0);
  });

  it("removal revokes evidence and cannot be resurrected by a late edit", async () => {
    const { app } = testApp();
    await enableGroup(app);
    const u = groupMsg(5, "delete me please");
    await ingestMessage(env.DB, u.message as any);
    const src = (await env.DB.prepare("SELECT id FROM sources").first<{ id: string }>())!.id;
    expect(await removeMessage(env.DB, src, u.message.message_id)).toBe(true);
    await ingestMessage(env.DB, { ...(u.message as any), text: "delete me please v2", edit_date: u.message.date + 5 });
    expect((await search(env.DB, await ctxFor(5), "delete please")).hits).toHaveLength(0);
  });
});

describe("access control (negative tests, QG01)", () => {
  it("members read only groups they are in", async () => {
    const { app } = testApp();
    await enableGroup(app);
    await feed(app, groupMsg(1, "budget for the hackathon is approved"));
    // A second enabled group the member never posted in.
    const other = groupCmd(OWNER, "/enable");
    (other.message as any).chat = { id: -1009, type: "supergroup", title: "Other" };
    await feed(app, other);
    const secret = groupMsg(2, "secret budget for salaries");
    (secret.message as any).chat = { id: -1009, type: "supergroup", title: "Other" };
    await feed(app, secret);
    const r = await search(env.DB, await ctxFor(1), "budget");
    expect(r.hits.map((h) => h.body)).toEqual(["budget for the hackathon is approved"]);
  });

  it("INTERNAL_RESTRICTED requires staff role", async () => {
    const { app } = testApp();
    await enableGroup(app, "INTERNAL_RESTRICTED");
    await feed(app, groupMsg(3, "moderator notes about spam"));
    expect((await search(env.DB, await ctxFor(3), "spam")).hits).toHaveLength(0);
    await env.DB.prepare("UPDATE members SET role='moderator' WHERE tg_id=3").run();
    expect((await search(env.DB, await ctxFor(3), "spam")).hits).toHaveLength(1);
  });

  it("PUBLIC_APPROVED is visible to every member", async () => {
    const { app } = testApp();
    await enableGroup(app, "PUBLIC_APPROVED");
    await feed(app, groupMsg(4, "community rules are pinned"));
    await ensureMember(env.DB, 99);
    expect((await search(env.DB, await ctxFor(99), "rules")).hits).toHaveLength(1);
  });

  it("disabling a group hides it immediately; revoked access hides it too", async () => {
    const { app } = testApp();
    await enableGroup(app);
    await feed(app, groupMsg(1, "venue is the old library"));
    const m = await ensureMember(env.DB, 1);
    const src = (await env.DB.prepare("SELECT id FROM sources").first<{ id: string }>())!.id;
    await revoke(env.DB, src, m.id);
    expect((await search(env.DB, await ctxFor(1), "venue library")).hits).toHaveLength(0);
    await feed(app, groupMsg(1, "posting again re-grants access"));
    expect((await search(env.DB, await ctxFor(1), "venue library")).hits).toHaveLength(1);
    await feed(app, groupCmd(OWNER, "/disable"));
    expect((await search(env.DB, await ctxFor(1), "venue library")).hits).toHaveLength(0);
  });

  it("removed members get nothing", async () => {
    const { app, texts } = testApp();
    await enableGroup(app);
    await feed(app, groupMsg(1, "anything at all"));
    await env.DB.prepare("UPDATE members SET removed_at='x' WHERE tg_id=1").run();
    expect((await ctxFor(1)).size).toBe(0);
    await feed(app, dm(1, "/ask anything"));
    expect(texts(1).at(-1)).toContain("don't know you");
  });
});
