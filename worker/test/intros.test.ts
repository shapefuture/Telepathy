import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ensureMember } from "../src/acl";
import { eligibleCandidates, matchSkills, resolveSkill, score, TAXONOMY } from "../src/experts";
import { act, cancelNeed, expireDue, IntroError, next, REVEAL, requestIntro, sendReminders, TERMINAL, TRANSITIONS, type Actor, type Event, type Status } from "../src/intros";
import { enableGroup, feed, groupMsg, testApp } from "./helpers";

const T0 = "2026-10-01T09:00:00Z";
const at = (h: number) => new Date(Date.parse(T0) + h * 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
const id = async (tg: number) => (await ensureMember(env.DB, tg)).id;

async function world() {
  const { app } = testApp();
  await enableGroup(app);
  for (const tg of [1, 11, 12, 13, 14]) await feed(app, groupMsg(tg, `hello from ${tg}`));
  for (const tg of [11, 12, 13]) {
    await env.DB.prepare("UPDATE members SET discoverable=1 WHERE tg_id=?").bind(tg).run();
    await env.DB.prepare("INSERT INTO skills(member_id, code, state) VALUES (?, 'accounting', 'confirmed')").bind(await id(tg)).run();
  }
  // 14 has the skill but never opted in.
  await env.DB.prepare("INSERT INTO skills(member_id, code, state) VALUES (?, 'accounting', 'confirmed')").bind(await id(14)).run();
  return app;
}
const effects = async () => (await env.DB.prepare("SELECT key, chat_id, payload FROM effects ORDER BY created_at, rowid").all<{ key: string; chat_id: number; payload: string }>()).results;

describe("state machine", () => {
  const statuses: Status[] = ["invited", "accepted", "mutually_confirmed", "completed", "declined", "expired", "cancelled"];
  const events: Event[] = ["accept", "decline", "confirm", "complete", "expire", "cancel"];
  const actors: Actor[] = ["requester", "candidate", "system"];

  it("allows exactly the table's transitions for every (state, event, actor)", () => {
    for (const s of statuses) for (const e of events) for (const a of actors) {
      const t = TRANSITIONS[`${s}:${e}`];
      expect(next(s, e, a)).toBe(t && t.actors.includes(a) ? t.to : null);
    }
  });

  it("terminal states have no exits", () => {
    for (const k of Object.keys(TRANSITIONS)) expect(TERMINAL.has(k.split(":")[0] as Status)).toBe(false);
  });

  it("contacts are revealed only after the candidate accepted AND the requester confirmed", () => {
    const into = Object.entries(TRANSITIONS).filter(([k, v]) => REVEAL.has(v.to) && !REVEAL.has(k.split(":")[0] as Status));
    expect(into).toEqual([["accepted:confirm", { to: "mutually_confirmed", actors: ["requester"] }]]);
    expect(TRANSITIONS["invited:accept"]!.actors).toEqual(["candidate"]);
  });
});

describe("experts", () => {
  it("taxonomy has 100 skills and maps RU/EN text", () => {
    expect(TAXONOMY.size).toBe(100);
    expect(matchSkills("need an accountant for a startup")).toContain("accounting");
    expect(matchSkills("ищу бухгалтера для ИП")).toContain("accounting");
    expect(matchSkills("виза для родителей")).toContain("legal_immigration");
    expect(resolveSkill("Python")).toBe("python");
    expect(resolveSkill("zzzz")).toBeNull();
  });

  it("score uses the locked weights and rewards spare capacity", () => {
    const base = { matched: 1, needed: 1, helpful: 0, completed: 0, bestKind: "self_claim", shared: 1, requesterSources: 1, pending: 0 };
    const free = score(base).total;
    expect(free).toBeCloseTo(0.4 + 0.25 * 0.5 + 0.15 * 0.5 + 0.1 + 0.1, 4);
    expect(score({ ...base, pending: 1 }).total).toBeLessThan(free);
  });

  it("eligibility requires opt-in, availability and the skill; never the requester", async () => {
    await world();
    const ids = async () => new Set((await eligibleCandidates(env.DB, await id(1), ["accounting"], T0)).map((c) => c.member_id));
    expect(await ids()).toEqual(new Set([await id(11), await id(12), await id(13)]));
    await env.DB.prepare("UPDATE members SET discoverable=0 WHERE tg_id=11").run();
    await env.DB.prepare("UPDATE members SET available=0 WHERE tg_id=12").run();
    expect(await ids()).toEqual(new Set([await id(13)]));
    const self = await eligibleCandidates(env.DB, await id(13), ["accounting"], T0);
    expect(self.map((c) => c.member_id)).not.toContain(await id(13));
  });
});

describe("introduction workflow", () => {
  it("happy path: nothing is revealed until both consent", async () => {
    await world();
    const req = await id(1);
    const r = await requestIntro(env.DB, req, "need an accountant for my startup", T0);
    expect(r.introId).toBeTruthy();
    const intro = (await env.DB.prepare("SELECT candidate_id FROM intros WHERE id=?").bind(r.introId).first<{ candidate_id: string }>())!;
    const reveal = async () => (await effects()).filter((e) => e.payload.includes("reveal_tg_id"));
    expect((await effects()).map((e) => e.key)).toEqual([`intro:${r.introId}:invite`]);
    const invite = (await effects())[0]!.payload;
    expect(invite).not.toContain("reveal_tg_id"); // no contact link in the invite
    expect(invite).not.toContain(req); // nor the requester's id
    expect((await act(env.DB, r.introId!, await id(14), "accept", T0)).reply).toContain("not yours");
    expect((await act(env.DB, r.introId!, req, "accept", T0)).reply).toContain("Already handled"); // wrong actor
    await act(env.DB, r.introId!, intro.candidate_id, "accept", at(1));
    expect(await reveal()).toHaveLength(0);
    await act(env.DB, r.introId!, req, "confirm", at(2));
    expect(await reveal()).toHaveLength(2);
    expect((await act(env.DB, r.introId!, req, "confirm", at(2))).reply).toContain("Already handled"); // double click
    await act(env.DB, r.introId!, intro.candidate_id, "helpful", at(48));
    const done = await env.DB.prepare("SELECT status, outcome FROM intros WHERE id=?").bind(r.introId).first();
    expect(done).toEqual({ status: "completed", outcome: "helpful" });
  });

  it("decline moves to the next candidate, then closes after 3", async () => {
    await world();
    const r = await requestIntro(env.DB, await id(1), "need an accountant please", T0);
    const seen = new Set<string>();
    let current: string | null = r.introId;
    for (let i = 0; i < 3; i++) {
      const row = (await env.DB.prepare("SELECT candidate_id FROM intros WHERE id=?").bind(current).first<{ candidate_id: string }>())!;
      expect(seen.has(row.candidate_id)).toBe(false);
      seen.add(row.candidate_id);
      await act(env.DB, current!, row.candidate_id, "decline", T0);
      current = (await env.DB.prepare("SELECT id FROM intros WHERE status='invited'").first<{ id: string }>())?.id ?? null;
    }
    expect(current).toBeNull();
    expect((await env.DB.prepare("SELECT status FROM needs").first<{ status: string }>())!.status).toBe("no_match");
    expect((await effects()).some((e) => e.key.endsWith(":no_match"))).toBe(true);
  });

  it("requester cap: 2 open requests per 7 days", async () => {
    await world();
    const req = await id(1);
    await requestIntro(env.DB, req, "need an accountant one", T0);
    await requestIntro(env.DB, req, "need an accountant two", T0);
    await expect(requestIntro(env.DB, req, "need an accountant three", T0)).rejects.toBeInstanceOf(IntroError);
    await requestIntro(env.DB, req, "need an accountant four", at(24 * 8));
  });

  it("expert cap: 2 pending invitations per 7 days", async () => {
    await world();
    await env.DB.prepare("UPDATE members SET discoverable=0 WHERE tg_id IN (11,12)").run();
    const a = await requestIntro(env.DB, await id(1), "need an accountant a", T0);
    const b = await requestIntro(env.DB, await id(14), "need an accountant b", T0);
    const c = await requestIntro(env.DB, await id(12), "need an accountant c", T0);
    expect([!!a.introId, !!b.introId, !!c.introId]).toEqual([true, true, false]);
  });

  it("unmatched text is refused", async () => {
    await world();
    await expect(requestIntro(env.DB, await id(1), "qwerty asdfgh zxcvb", T0)).rejects.toBeInstanceOf(IntroError);
  });

  it("one reminder after 24h, expiry after 72h hands over to the next candidate", async () => {
    await world();
    const r = await requestIntro(env.DB, await id(1), "need an accountant asap", T0);
    expect(await sendReminders(env.DB, at(23))).toHaveLength(0);
    expect(await sendReminders(env.DB, at(25))).toHaveLength(1);
    expect(await sendReminders(env.DB, at(26))).toHaveLength(0);
    expect(await act(env.DB, r.introId!, (await env.DB.prepare("SELECT candidate_id FROM intros").first<{ candidate_id: string }>())!.candidate_id, "accept", at(73))).toMatchObject({ reply: "This invitation has expired." });
    await expireDue(env.DB, at(73));
    expect((await env.DB.prepare("SELECT status FROM intros WHERE id=?").bind(r.introId).first<{ status: string }>())!.status).toBe("expired");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM intros WHERE status='invited'").first<{ n: number }>())!.n).toBe(1);
  });

  it("cancelling a request notifies the invited expert without revealing anything", async () => {
    await world();
    const r = await requestIntro(env.DB, await id(1), "need an accountant asap", T0);
    const out = await cancelNeed(env.DB, await id(1), r.needId, T0);
    expect(out.ok).toBe(true);
    expect((await effects()).map((e) => e.key)).toContain(`intro:${r.introId}:cancelled`);
  });
});
