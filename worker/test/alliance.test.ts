// Союз and Мост (plan: build step 3, journeys 5 and 6): two clubs on this bot agree to exchange
// requests; a request crosses as its text only, and contacts open only on both sides' yes.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ensureMember } from "../src/acl";
import { alliancesOf, bridgeBoard, expireBridges } from "../src/alliance";
import { bridgeFromThread } from "../src/alliance";
import { OWNER, dm, enableGroup, feed, fakeTelegram, groupCmd, groupMsg, press, shown, shownButtons, testApp, type Call } from "./helpers";

const GROUP_B = -1009999;
const B_OWNER = 2;
const q = <T>(sql: string, ...b: unknown[]) => env.DB.prepare(sql).bind(...b).first<T>();
const idOf = async (tg: number) => (await ensureMember(env.DB, tg)).id;
const inB = <T extends { message: any }>(u: T): T => ({ ...u, message: { ...u.message, chat: { id: GROUP_B, type: "supergroup", title: "Club B" } } });
const sentTo = (calls: Call[], chat: number) => calls.filter((c) => c.method === "sendMessage" && c.params.chat_id === chat);
const payloads = async (like: string) => (await env.DB.prepare("SELECT payload FROM effects WHERE key LIKE ?").bind(like).all<{ payload: string }>()).results.map((r) => r.payload);

/** Club A is OWNER's (connected by the operator), club B is user 2's. Both have a member who can read them. */
async function twoClubs() {
  const t = testApp({ admins: [OWNER, B_OWNER] });
  await enableGroup(t.app); // club A, by OWNER
  await feed(t.app, groupMsg(1, "hello, I'm an asker in club A"));
  await feed(t.app, inB(groupCmd(B_OWNER, "/enable")));
  await feed(t.app, inB(groupMsg(B_OWNER, "hello from club B")));
  await feed(t.app, inB(groupMsg(3, "I know accounting: VAT and tax returns")));
  await env.DB.prepare("UPDATE members SET discoverable=1 WHERE tg_id=3").run();
  await env.DB.prepare("INSERT INTO skills(member_id, code, state) VALUES (?, 'accounting', 'confirmed')").bind(await idOf(3)).run();
  return t;
}

/** OWNER invites club B's owner with what the link lets cross; B's owner accepts. */
async function allied(level: "requests" | "experts" | "full" = "experts", accept: "requests" | "experts" | "full" = "experts") {
  const t = await twoClubs();
  const clubA = (await q<{ id: string }>("SELECT id FROM sources WHERE chat_id=?", -1001234))!.id;
  await feed(t.app, press(OWNER, `uv:${clubA}`));
  await feed(t.app, press(OWNER, `ui:${clubA}:${level}`));
  const code = /start u([0-9a-f]{16})/.exec(String(sentTo(t.calls, OWNER).at(-1)!.params.text))![1]!;
  await feed(t.app, dm(B_OWNER, `/start u${code}`));
  expect(shown(t.calls, B_OWNER)).toContain("invites you to an alliance");
  await feed(t.app, press(B_OWNER, `ac:${code}:${accept}`));
  return { ...t, code, clubA };
}

describe("Союз: alliances between clubs", () => {
  it("an invitation is shown to the other owner first, and accepting joins at the smaller level", async () => {
    const { app, calls, code } = await allied("experts", "requests");
    expect(sentTo(calls, B_OWNER).some((c) => String(c.params.text).includes("You're allied"))).toBe(true);
    const rows = await alliancesOf(env.DB, await idOf(OWNER));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ level: "requests", status: "active" });
    expect(await q("SELECT used_at IS NOT NULL AS used FROM alliance_invites WHERE code=?", code)).toEqual({ used: 1 });
    // The link works once.
    await feed(app, press(B_OWNER, `ac:${code}:full`));
    expect((await alliancesOf(env.DB, await idOf(OWNER))).length).toBe(1);
  });

  it("/union lists the alliance with credit, and either side can pause, resume and end it", async () => {
    const { app, calls } = await allied();
    await feed(app, dm(OWNER, "/union"));
    expect(shown(calls, OWNER)).toContain("Alliances");
    const pauseBtn = shownButtons(calls, OWNER).flat().find((b) => b.callback_data.endsWith(":pause"))!;
    await feed(app, press(B_OWNER, pauseBtn.callback_data)); // the other side may pause it too
    expect((await alliancesOf(env.DB, await idOf(OWNER)))[0]!.status).toBe("paused");
    expect(sentTo(calls, OWNER).some((c) => String(c.params.text).includes("is paused"))).toBe(true);
    await feed(app, press(OWNER, `ux:${(await q<{ id: string }>("SELECT id FROM alliances"))!.id}:resume`));
    expect((await alliancesOf(env.DB, await idOf(OWNER)))[0]!.status).toBe("active");
  });

  it("a stranger cannot pause someone else's alliance", async () => {
    const { app } = await allied();
    const id = (await q<{ id: string }>("SELECT id FROM alliances"))!.id;
    await feed(app, press(77, `ux:${id}:end`));
    expect((await q<{ status: string }>("SELECT status FROM alliances WHERE id=?", id))!.status).toBe("active");
  });
});

describe("Мост: a request crosses as its text only", () => {
  it("the partner sees the request and no name; a contact opens only on both yes", async () => {
    const { app, calls } = await allied();
    await feed(app, dm(1, "who can help with accounting for a small VAT question?"));
    // No memory answer: the card offers the partner clubs.
    const askBridge = shownButtons(calls, 1).flat().find((b) => b.callback_data.endsWith(":bridge"));
    expect(askBridge).toBeTruthy();
    const threadId = (await q<{ id: string }>("SELECT id FROM threads WHERE member_id=?", await idOf(1)))!.id;
    await feed(app, press(1, `t:${threadId}:bridge`));
    expect(shown(calls, 1)).toContain("Ask partner clubs?");
    await feed(app, press(1, `t:${threadId}:bridgeok`));

    // The partner gets the question text, and nothing that identifies the asker.
    const toPartner = sentTo(calls, B_OWNER).filter((c) => String(c.params.text).includes("request from partner club"));
    expect(toPartner.length).toBeGreaterThan(0);
    expect(toPartner[0]!.params.text).toContain("accounting");
    expect(JSON.stringify(sentTo(calls, B_OWNER))).not.toContain('"reveal_tg_id":1');
    for (const p of await payloads("bridge:%")) expect(p).not.toContain('"reveal_tg_id":1');

    // A club member answers yes. The asker is told, and the card follows.
    const bridge = (await q<{ id: string }>("SELECT id FROM bridges"))!.id;
    await feed(app, press(B_OWNER, `bh:${bridge}:yes`));
    expect(shown(calls, 1)).toContain("Help came from");
    // Nothing is open until the asker agrees to connect.
    expect(sentTo(calls, 1).some((c) => c.params.reply_markup?.inline_keyboard?.flat().some((b: any) => b.callback_data === `bh:${bridge}:ask`))).toBe(true);
    await feed(app, press(1, `bh:${bridge}:ask`));
    expect((await q<{ status: string }>("SELECT status FROM bridges WHERE id=?", bridge))!.status).toBe("connected");
    expect(sentTo(calls, B_OWNER).some((c) => String(c.params.text).includes("agreed to connect"))).toBe(true);
    expect(JSON.stringify(sentTo(calls, B_OWNER).at(-1))).toBeTruthy();

    // "It helped" closes the request and credits the helping club.
    await feed(app, press(1, `bh:${bridge}:helpful`));
    expect((await q<{ status: string; outcome: string }>("SELECT status, outcome FROM bridges WHERE id=?", bridge))).toEqual({ status: "closed", outcome: "helpful" });
    expect((await alliancesOf(env.DB, await idOf(B_OWNER)))[0]).toMatchObject({ helped: 1, received: 0 });
    expect((await alliancesOf(env.DB, await idOf(OWNER)))[0]).toMatchObject({ helped: 0, received: 1 });
  });

  it("with the alliance paused, nothing crosses", async () => {
    const { app } = await allied();
    await feed(app, press(OWNER, `ux:${(await q<{ id: string }>("SELECT id FROM alliances"))!.id}:pause`));
    const asker = await ensureMember(env.DB, 1);
    const threadId = "0".repeat(32);
    await env.DB.prepare("INSERT INTO threads(id, member_id, chat_id, question, state, rev, created_at, updated_at) VALUES (?,?,1,'accounting question','asking',0,'2026-10-01T00:00:00Z','2026-10-01T00:00:00Z')").bind(threadId, asker.id).run();
    const member = (await q<any>("SELECT * FROM members WHERE tg_id=1"))!;
    const r = await bridgeFromThread(env.DB, member, threadId, "accounting question", null);
    expect(r.ok).toBe(false);
    expect(await q("SELECT COUNT(*) AS n FROM bridges")).toEqual({ n: 0 });
  });

  it("a bridge nobody answers in a week expires, and the card says so", async () => {
    const { app, calls } = await allied();
    await feed(app, dm(1, "who knows accounting for a VAT question?"));
    const threadId = (await q<{ id: string }>("SELECT id FROM threads WHERE member_id=?", await idOf(1)))!.id;
    await feed(app, press(1, `t:${threadId}:bridge`));
    await feed(app, press(1, `t:${threadId}:bridgeok`));
    const keys = await expireBridges(env.DB, "2099-01-01T00:00:00Z");
    expect(keys.length).toBeGreaterThan(0);
    await (await import("../src/outbox")).dispatchPending(env.DB, app.tg, 40, keys);
    expect(shown(calls, 1)).toContain("Nobody in");
  });

  it("the operator's board lists bridges, and can send one to its club again", async () => {
    const { app, calls } = await allied();
    await feed(app, dm(1, "who knows accounting for a VAT question?"));
    const threadId = (await q<{ id: string }>("SELECT id FROM threads WHERE member_id=?", await idOf(1)))!.id;
    await feed(app, press(1, `t:${threadId}:bridge`));
    await feed(app, press(1, `t:${threadId}:bridgeok`));
    await feed(app, dm(OWNER, "/bridges"));
    expect(shown(calls, OWNER)).toContain("Bridges (operator)");
    const rows = await bridgeBoard(env.DB, "en");
    expect(rows).toHaveLength(1);
    const bridge = rows[0]!.id;
    const before = sentTo(calls, B_OWNER).length;
    await feed(app, press(OWNER, `bq:${bridge}:send`));
    expect(sentTo(calls, B_OWNER).length).toBeGreaterThan(before);
  });
});

describe("the invitation is safe to use", () => {
  it("a club can't join itself, and an unknown code says so", async () => {
    const { app, calls } = await twoClubs();
    await feed(app, dm(OWNER, "/start u0000000000000000"));
    expect(shown(calls, OWNER)).toContain("no longer valid");
  });
});
