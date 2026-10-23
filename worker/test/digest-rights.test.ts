import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ensureMember, readable } from "../src/acl";
import { build, digestStep, dueDay } from "../src/digest";
import { applyRetention, forgetMember } from "../src/rights";
import { answer } from "../src/search";
import { GROUP, OWNER, enableGroup, feed, groupCmd, groupMsg, testApp } from "./helpers";

const TZ = "Asia/Jerusalem";
const optIn = (tg: number) => env.DB.prepare("UPDATE members SET digest=1 WHERE tg_id=?").bind(tg).run();

describe("digest (K14: visible to all, opt-in)", () => {
  it("is due at the local hour across DST", () => {
    expect(dueDay(new Date("2026-10-24T05:59:00Z"), TZ, 9)).toBeNull();
    expect(dueDay(new Date("2026-10-24T06:00:00Z"), TZ, 9)).toBe("2026-10-24"); // UTC+3
    expect(dueDay(new Date("2026-10-26T06:59:00Z"), TZ, 9)).toBeNull(); // UTC+2 after DST ends
    expect(dueDay(new Date("2026-10-26T07:00:00Z"), TZ, 9)).toBe("2026-10-26");
  });

  it("goes only to members who opted in, scoped to their readable groups", async () => {
    const { app } = testApp();
    await enableGroup(app);
    await feed(app, groupMsg(1, "Can anyone recommend a dentist?"));
    await feed(app, groupMsg(2, "hello"));
    const now = new Date(Date.now() + 60_000);
    // Nobody opted in: nothing is sent, the day is marked done.
    expect((await digestStep(env.DB, now, "UTC", 0)).keys).toEqual([]);
    await env.DB.prepare("DELETE FROM settings").run();
    await optIn(1);
    const r = await digestStep(env.DB, now, "UTC", 0);
    expect(r.keys).toHaveLength(1);
    const payload = (await env.DB.prepare("SELECT payload FROM effects").first<{ payload: string }>())!.payload;
    expect(payload).toContain("dentist");
    expect(payload).toContain("Open questions (1)");
    // Second run: no duplicates, then done.
    expect((await digestStep(env.DB, now, "UTC", 0)).done).toBe(true);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM effects WHERE key LIKE 'digest:%'").first<{ n: number }>())!.n).toBe(1);
  });

  it("never includes groups the recipient can't read", async () => {
    const { app } = testApp();
    await enableGroup(app);
    const other = groupCmd(OWNER, "/enable");
    (other.message as any).chat = { id: -1009, type: "supergroup", title: "Secret" };
    await feed(app, other);
    const s = groupMsg(2, "Can anyone recommend a lawyer?");
    (s.message as any).chat = { id: -1009, type: "supergroup", title: "Secret" };
    await feed(app, s);
    await feed(app, groupMsg(1, "Can anyone recommend a dentist?"));
    const m1 = await ensureMember(env.DB, 1);
    const text = await build(env.DB, await readable(env.DB, m1), "2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z", "d");
    expect(text).toContain("dentist");
    expect(text).not.toContain("lawyer");
    expect(text).not.toContain("Secret");
  });

  it("members with nothing new get no message", async () => {
    const { app } = testApp();
    await enableGroup(app);
    await feed(app, groupMsg(1, "old news"));
    await optIn(1);
    const later = new Date(Date.now() + 3 * 86_400_000);
    await env.DB.prepare("INSERT INTO settings(key,value) VALUES ('digest.window_end', ?)").bind(new Date(Date.now() + 86_400_000).toISOString()).run();
    expect((await digestStep(env.DB, later, "UTC", 0)).keys).toEqual([]);
    expect((await env.DB.prepare("SELECT state FROM effects").first<{ state: string }>())!.state).toBe("skipped");
  });
});

describe("data rights and history (K15)", () => {
  it("full history is kept unless an owner sets a limit", async () => {
    const { app } = testApp();
    await enableGroup(app);
    const old = groupMsg(1, "message from ten years ago about the venue");
    (old.message as any).date = Math.floor(Date.now() / 1000) - 3650 * 86400;
    await feed(app, old);
    expect(await applyRetention(env.DB)).toBe(0);
    await env.DB.prepare("UPDATE sources SET retention_days=30").run();
    expect(await applyRetention(env.DB)).toBe(1);
  });

  it("forget_me removes messages, skills, digest and stops collection", async () => {
    const { app } = testApp();
    await enableGroup(app);
    await feed(app, groupMsg(7, "my secret plan about the venue"));
    await feed(app, groupMsg(8, "public answer about the venue"));
    const m7 = await ensureMember(env.DB, 7);
    await env.DB.prepare("UPDATE members SET digest=1, discoverable=1 WHERE id=?").bind(m7.id).run();
    await env.DB.prepare("INSERT INTO skills(member_id, code, state) VALUES (?, 'python', 'confirmed')").bind(m7.id).run();
    const r = await forgetMember(env.DB, m7.id, 7);
    expect(r).toMatchObject({ passages: 1, skills: 1 });
    const a = await answer(env.DB, await readable(env.DB, await ensureMember(env.DB, 8)), "venue plan");
    expect(a.quotes.every((q) => !q.text.includes("secret"))).toBe(true);
    const after = (await ensureMember(env.DB, 7))!;
    expect([after.digest, after.discoverable, after.collection_opt_out]).toEqual([0, 0, 1]);
    await feed(app, groupMsg(7, "new message after forget"));
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM passages WHERE author_id=? AND removed_at IS NULL").bind(m7.id).first<{ n: number }>())!.n).toBe(0);
  });
});

describe("chat", () => {
  it("GROUP constant is a supergroup id", () => expect(String(GROUP).startsWith("-100")).toBe(true));
});
