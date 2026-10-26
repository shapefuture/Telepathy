import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { addOffer, reserve, release } from "../src/assist/capacity";
import { createDraft, transition } from "../src/assist/missions";
import { ensureMember } from "../src/acl";
import { findIdentifiers, grantAllows, type Grant } from "../src/domain/consent";
import { MISSION_TERMINAL, MISSION_TRANSITIONS, nextMission, type MissionActor, type MissionStatus } from "../src/domain/mission";
import { dm, enableGroup, feed, groupMsg, OWNER, press, testApp } from "./helpers";

const ALICE = 21;
const BOB = 22;
const q = <T>(sql: string, ...args: unknown[]) => env.DB.prepare(sql).bind(...args).first<T>();
const mission = (tg: number) => q<{ id: string; status: string; job_code: string; summary: string; handler: string }>("SELECT m.* FROM missions m JOIN members x ON x.id=m.member_id WHERE x.tg_id=? ORDER BY m.rowid DESC LIMIT 1", tg);
const lastButtons = (calls: { method: string; params: any }[], chat: number) =>
  calls.filter((c) => c.method === "sendMessage" && c.params.chat_id === chat && c.params.reply_markup).at(-1)?.params.reply_markup.inline_keyboard.flat() as { text: string; callback_data: string }[];

async function world() {
  const t = testApp();
  await enableGroup(t.app);
  await feed(t.app, groupMsg(OWNER, "hi"));
  await feed(t.app, groupMsg(BOB, "Our accountant files VAT quarterly through the tax portal, bookkeeping is done in spreadsheets"));
  await feed(t.app, groupMsg(ALICE, "hello"));
  return t;
}

describe("mission state machine (D.1)", () => {
  const all = Object.keys({ ...MISSION_TRANSITIONS, closed: 1, cancelled: 1, expired: 1, failed_with_explanation: 1 }) as MissionStatus[];
  const actors: MissionActor[] = ["member", "operator", "system", "partner", "club"];

  it("terminal states have no exits", () => {
    for (const s of MISSION_TERMINAL) for (const to of all) for (const a of actors) expect(nextMission(s, to, a)).toBe(false);
  });
  it("only listed actors move a mission", () => {
    expect(nextMission("draft", "confirmed", "member")).toBe(true);
    expect(nextMission("draft", "confirmed", "operator")).toBe(false); // nobody confirms for the member
    expect(nextMission("draft", "routed", "operator")).toBe(false); // no routing before confirmation
    expect(nextMission("external_permission_needed", "routed", "member")).toBe(false);
    expect(nextMission("offers_available", "provider_selected", "operator")).toBe(false); // member picks partner offers
    expect(nextMission("routed", "cancelled", "system")).toBe(false);
    expect(nextMission("routed", "expired", "system")).toBe(true);
    expect(nextMission("in_delivery", "cancelled", "member")).toBe(true);
    expect(nextMission("external_permission_needed", "failed_with_explanation", "club")).toBe(true); // a club says "no provider"
    expect(nextMission("external_permission_needed", "routed", "club")).toBe(false); // clubs never route
    expect(nextMission("service_committed", "delivered", "club")).toBe(false); // nor deliver
  });
  it("transition is optimistic: a stale caller can't move it twice", async () => {
    const m = await ensureMember(env.DB, 5);
    const d = await createDraft(env.DB, m.id, "need help with bookkeeping");
    const [x, y] = await Promise.all([transition(env.DB, d.id, "confirmed", "member"), transition(env.DB, d.id, "confirmed", "member")]);
    expect([x, y].filter(Boolean)).toHaveLength(1);
    const ev = await env.DB.prepare("SELECT COUNT(*) AS n FROM mission_events WHERE mission_id=?").bind(d.id).first<{ n: number }>();
    expect(ev!.n).toBe(2); // draft + one confirmed
  });
});

describe("consent grants (D.3)", () => {
  const now = "2026-10-01T00:00:00Z";
  const g: Grant = { action: "external_discovery", audience: '["https://b.example"]', fields: '["job","summary","criteria"]', mission_version: 1, policy_version: 1, expires_at: "2026-10-10T00:00:00Z", revoked_at: null };
  const want = { action: "external_discovery" as const, audience: "https://b.example", missionVersion: 1, policyVersion: 1, fields: ["job", "summary"], now };
  it("allows exactly the granted scope", () => expect(grantAllows(g, want)).toBe(true));
  it("denies stale, revoked, expired, wrong audience, wrong policy, extra fields", () => {
    expect(grantAllows(g, { ...want, missionVersion: 2 })).toBe(false);
    expect(grantAllows({ ...g, revoked_at: now }, want)).toBe(false);
    expect(grantAllows(g, { ...want, now: "2026-10-11T00:00:00Z" })).toBe(false);
    expect(grantAllows(g, { ...want, audience: "https://c.example" })).toBe(false);
    expect(grantAllows(g, { ...want, policyVersion: 2 })).toBe(false);
    expect(grantAllows(g, { ...want, fields: ["contact"] })).toBe(false);
    expect(grantAllows(g, { ...want, action: "reveal" })).toBe(false);
    expect(grantAllows(null, want)).toBe(false);
  });
  it("finds identifiers that must not leave", () => {
    expect(findIdentifiers("need a VAT accountant in Haifa")).toEqual([]);
    expect(findIdentifiers("mail me at a.b@example.com")).toContain("email");
    expect(findIdentifiers("ping @someone_here")).toContain("handle");
    expect(findIdentifiers("see t.me/xyz")).toContain("link");
    expect(findIdentifiers("call +972 50 123 4567")).toContain("phone");
  });
});

describe("capacity (I12)", () => {
  it("two commitments for the last slot: exactly one wins, and release frees it", async () => {
    const a = await ensureMember(env.DB, 31);
    const b2 = await ensureMember(env.DB, 32);
    const offer = await addOffer(env.DB, { job: "accounting", capacity: 1, mode: "volunteer", description: "VAT hour", by: "x" });
    const m1 = await createDraft(env.DB, a.id, "need help with bookkeeping");
    const m2 = await createDraft(env.DB, b2.id, "need help with bookkeeping too");
    const [r1, r2] = await Promise.all([reserve(env.DB, offer, { missionId: m1.id }), reserve(env.DB, offer, { missionId: m2.id })]);
    expect([r1, r2].filter(Boolean)).toHaveLength(1);
    expect((await q<{ reserved: number }>("SELECT reserved FROM capability_offers WHERE id=?", offer))!.reserved).toBe(1);
    // Same mission can't hold two slots, and a failed attempt doesn't leak a slot.
    const off2 = await addOffer(env.DB, { job: "accounting", capacity: 5, mode: "paid", description: "Other", by: "x" });
    const winner = r1 ? m1 : m2;
    expect(await reserve(env.DB, off2, { missionId: winner.id })).toBeNull();
    expect((await q<{ reserved: number }>("SELECT reserved FROM capability_offers WHERE id=?", off2))!.reserved).toBe(0);
    expect(await release(env.DB, (r1 ?? r2)!)).toBe(true);
    expect(await release(env.DB, (r1 ?? r2)!)).toBe(false); // second release is a no-op
    expect((await q<{ reserved: number }>("SELECT reserved FROM capability_offers WHERE id=?", offer))!.reserved).toBe(0);
  });
});

describe("assistance desk flow (S1, S2)", () => {
  it("draft → local answer → desk → local offer → delivered → useful receipt", async () => {
    const { app, calls, texts } = await world();
    await feed(app, dm(ALICE, "/help I need an accountant for bookkeeping and VAT"));
    let m = (await mission(ALICE))!;
    expect(m.status).toBe("draft");
    expect(m.job_code).toBe("accounting");
    expect(texts(ALICE).at(-1)).toContain("Nothing leaves this community");

    await feed(app, press(ALICE, `m:${m.id}:ok`));
    expect((await mission(ALICE))!.status).toBe("local_investigation");
    expect(texts(ALICE).some((t) => t.includes("From your groups") && t.includes("tax portal"))).toBe(true);
    // A grant for local processing only, bound to version 1.
    expect(await q("SELECT action, audience FROM consent_grants WHERE mission_id=?", m.id)).toEqual({ action: "local", audience: "home" });

    await feed(app, press(ALICE, `m:${m.id}:more`));
    m = (await mission(ALICE))!;
    expect(m.status).toBe("external_permission_needed");
    expect(m.handler).toBe("operator");
    expect(texts(OWNER).at(-1)).toContain("bookkeeping"); // the desk was told

    await feed(app, dm(OWNER, "/offer add accounting 1 volunteer VAT office hour with Bob"));
    const offer = (await q<{ id: string }>("SELECT id FROM capability_offers"))!.id;
    await feed(app, dm(OWNER, "/desk"));
    const assign = lastButtons(calls, OWNER).find((x) => x.callback_data.startsWith(`d:${m.id}:a:`))!;
    expect(assign.callback_data).toBe(`d:${m.id}:a:${offer}`);
    expect(assign.callback_data.length).toBeLessThanOrEqual(64);

    await feed(app, press(OWNER, assign.callback_data));
    expect((await mission(ALICE))!.status).toBe("service_committed");
    expect(texts(ALICE).at(-1)).toContain("VAT office hour");

    // A second member can't get the same (full) offer.
    await feed(app, dm(BOB, "/help bookkeeping for my shop please"));
    const mb = (await mission(BOB))!;
    await feed(app, press(BOB, `m:${mb.id}:ok`));
    await feed(app, press(BOB, `m:${mb.id}:more`));
    await feed(app, press(OWNER, `d:${mb.id}:a:${offer}`));
    expect((await mission(BOB))!.status).toBe("external_permission_needed");

    await feed(app, press(OWNER, `d:${m.id}:dv`));
    expect((await mission(ALICE))!.status).toBe("delivered");
    expect(await q("SELECT evidence_level FROM outcome_receipts WHERE mission_id=?", m.id)).toEqual({ evidence_level: "provider_confirmed" });
    await feed(app, press(ALICE, `r:${m.id}:1`));
    expect((await mission(ALICE))!.status).toBe("closed");
    expect(await q("SELECT evidence_level, requester_useful FROM outcome_receipts WHERE mission_id=?", m.id)).toEqual({ evidence_level: "both_confirmed", requester_useful: 1 });

    // Report shows stages; Bob's request is still open.
    await feed(app, dm(OWNER, "/desk report"));
    expect(texts(OWNER).at(-1)).toMatch(/closed: <b>1<\/b>/);
    expect(texts(OWNER).at(-1)).toMatch(/useful \/ not useful: <b>1 \/ 0<\/b>/);

    // History is reconstructable (Track 5 gate).
    const hist = (await env.DB.prepare("SELECT to_status FROM mission_events WHERE mission_id=? ORDER BY id").bind(m.id).all<{ to_status: string }>()).results.map((r) => r.to_status);
    expect(hist).toEqual(["draft", "confirmed", "local_investigation", "external_permission_needed", "provider_selected", "service_committed", "delivered", "evaluated", "closed"]);
  });

  it("solved locally closes with a knowledge receipt", async () => {
    const { app } = await world();
    await feed(app, dm(ALICE, "/help how is VAT filed, quarterly?"));
    const m = (await mission(ALICE))!;
    await feed(app, press(ALICE, `m:${m.id}:ok`));
    await feed(app, press(ALICE, `r:${m.id}:0`)); // not delivered: no receipt can be forged
    expect(await q("SELECT COUNT(*) AS n FROM outcome_receipts")).toEqual({ n: 0 });
    await feed(app, press(ALICE, `m:${m.id}:solved`));
    expect((await mission(ALICE))!.status).toBe("closed");
    expect(await q("SELECT service_code, evidence_level FROM outcome_receipts WHERE mission_id=?", m.id)).toEqual({ service_code: "knowledge_answer", evidence_level: "requester_confirmed" });
  });

  it("cancel frees the slot and revokes grants; others can't touch someone's mission", async () => {
    const { app } = await world();
    await feed(app, dm(OWNER, "/offer add accounting 1 VAT hour"));
    const offer = (await q<{ id: string }>("SELECT id FROM capability_offers"))!.id;
    await feed(app, dm(ALICE, "/help bookkeeping for my small business"));
    const m = (await mission(ALICE))!;
    await feed(app, press(BOB, `m:${m.id}:ok`)); // not Bob's
    expect((await mission(ALICE))!.status).toBe("draft");
    await feed(app, press(ALICE, `m:${m.id}:ok`));
    await feed(app, press(OWNER, `d:${m.id}:a:${offer}`));
    expect((await q<{ reserved: number }>("SELECT reserved FROM capability_offers"))!.reserved).toBe(1);
    await feed(app, press(BOB, `d:${m.id}:np`)); // not an owner: ignored
    expect((await mission(ALICE))!.status).toBe("service_committed");
    await feed(app, press(ALICE, `m:${m.id}:x`));
    expect((await mission(ALICE))!.status).toBe("cancelled");
    expect((await q<{ reserved: number }>("SELECT reserved FROM capability_offers"))!.reserved).toBe(0);
    expect((await q<{ revoked_at: string | null }>("SELECT revoked_at FROM consent_grants WHERE mission_id=?", m.id))!.revoked_at).not.toBeNull();
  });

  it("no provider: transparent close; /forget_me scrubs mission text", async () => {
    const { app, texts } = await world();
    await feed(app, dm(ALICE, "/help bookkeeping for my small business"));
    const m = (await mission(ALICE))!;
    await feed(app, press(ALICE, `m:${m.id}:ok`));
    await feed(app, press(OWNER, `d:${m.id}:np`));
    expect((await mission(ALICE))!.status).toBe("failed_with_explanation");
    expect(texts(ALICE).at(-1)).toContain("couldn't find a willing provider");
    await feed(app, dm(ALICE, "/help another bookkeeping question here"));
    await feed(app, press(ALICE, "fm:yes"));
    const rows = (await env.DB.prepare("SELECT summary FROM missions").all<{ summary: string }>()).results;
    expect(rows.every((r) => r.summary === "[removed]")).toBe(true);
  });

  it("limits open missions per member", async () => {
    const { app, texts } = await world();
    for (let i = 0; i < 6; i++) {
      await feed(app, dm(ALICE, `/help bookkeeping question number ${i}`));
      const m = (await mission(ALICE))!;
      await feed(app, press(ALICE, `m:${m.id}:ok`));
    }
    const n = await q<{ n: number }>("SELECT COUNT(*) AS n FROM missions WHERE status<>'draft'");
    expect(n!.n).toBe(5);
    expect(texts(ALICE).some((t) => t.includes("5 open requests"))).toBe(true);
  });
});
