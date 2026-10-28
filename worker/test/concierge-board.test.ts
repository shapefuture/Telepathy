// The owner's board and the rule-based and live steps behind it (ADR-007, items 1-5 and 7):
// join screening, the spam guard, best answers, live suggestions, introduction rounds, who may
// decide, the daily card and the settings toggles.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resetRateLimits } from "../src/bot";
import { bestStep } from "../src/concierge/best";
import { boardDaily } from "../src/concierge/board";
import { PROMPT_VERSION } from "../src/concierge/agent";
import { liveStep } from "../src/concierge/live";
import { RULES_VERSION } from "../src/concierge/gate";
import { roundsStep } from "../src/concierge/rounds";
import { makeApp } from "../src/index";
import { forgetMember } from "../src/rights";
import { dm, enableGroup, feed, fakeTelegram, groupCmd, groupMsg, GROUP, nextMsg, OWNER, press, shown, shownButtons } from "./helpers";

beforeEach(() => resetRateLimits());

const nowUnix = () => Math.floor(Date.now() / 1000);
const q = async <T = any>(sql: string, ...binds: unknown[]) => env.DB.prepare(sql).bind(...binds).first<T>();

/** An app whose Workers AI stub answers `reply` (or no AI at all when reply is undefined). */
function world(opts: { admins?: number[]; reply?: string; env?: Record<string, string> } = {}) {
  const t = fakeTelegram({ admins: opts.admins });
  const AI = opts.reply === undefined ? undefined : { run: async () => ({ response: opts.reply }) };
  const app = makeApp({ ...(env as any), CONCIERGE_MODEL: AI ? undefined : "off", AI, ...(opts.env ?? {}) }, t.fetcher);
  return { app, t };
}

/** Earned-looking history: `n` reviewed cases of one action, judged right. */
async function seedReviews(action: string, version: string, n: number, verdict = "good") {
  for (let i = 0; i < n; i++) {
    await env.DB.prepare("INSERT INTO concierge_cases(subject, mode, source_id, version, created_at, action, executed, verdict) VALUES (?, 'seed', 'seed-src', ?, '2026-10-01T00:00:00Z', ?, 1, ?)")
      .bind(`seed:${action}:${i}`, version, action, verdict)
      .run();
  }
}

const joinRequest = (user: number, chat = GROUP) => ({
  chat_join_request: { chat: { id: chat, type: "supergroup", title: "G" }, from: { id: user, is_bot: false }, date: nowUnix(), user_chat_id: user },
});

describe("join screening", () => {
  it("asks three questions in private, then the admin accepts from the board", async () => {
    const { app, t } = world();
    await enableGroup(app);
    await env.DB.prepare("UPDATE sources SET screen=1").run();
    await feed(app, joinRequest(21) as any);
    expect(shown(t.calls, 21)).toContain("Who are you and what do you do?");
    await feed(app, dm(21, "Designer, based in Lisbon"));
    expect(shown(t.calls, 21)).toContain("What brought you to this community?");
    await feed(app, dm(21, "A friend recommended it"));
    expect(shown(t.calls, 21)).toContain("What can you help others with?");
    await feed(app, dm(21, "I can help with VAT returns"));
    expect((await q<{ status: string }>("SELECT status FROM join_screens"))!.status).toBe("pending_owner");
    expect(await q("SELECT code, kind FROM skills WHERE code = 'tax'")).toEqual({ code: "tax", kind: "self_claim" });

    await feed(app, dm(OWNER, "/board"));
    expect(JSON.stringify(shownButtons(t.calls, OWNER))).toContain("Join requests (1)");
    await feed(app, press(OWNER, "bd:v:j:0"));
    expect(shown(t.calls, OWNER)).toContain("A friend recommended it");
    await feed(app, press(OWNER, shownButtons(t.calls, OWNER)[0]![0]!.callback_data));
    expect(t.calls.some((c) => c.method === "approveChatJoinRequest" && c.params.user_id === 21)).toBe(true);
    expect((await q<{ status: string }>("SELECT status FROM join_screens"))!.status).toBe("accepted");
    expect(await q("SELECT verdict FROM concierge_cases WHERE subject LIKE 'join:%'")).toEqual({ verdict: "good" });
  });

  it("an incomplete screening has no proposal, and a decline is never sent by the rule", async () => {
    const { app, t } = world();
    await enableGroup(app);
    await env.DB.prepare("UPDATE sources SET screen=1").run();
    await feed(app, joinRequest(22) as any);
    for (const a of ["Teacher", "Curious", "-"]) await feed(app, dm(22, a));
    expect(await q("SELECT COUNT(*) AS n FROM concierge_cases WHERE subject LIKE 'join:%'")).toEqual({ n: 0 });
    await feed(app, dm(OWNER, "/board"));
    await feed(app, press(OWNER, "bd:v:j:0"));
    expect(shown(t.calls, OWNER)).toContain("Your call.");
    await feed(app, press(OWNER, shownButtons(t.calls, OWNER)[0]![1]!.callback_data));
    expect(t.calls.some((c) => c.method === "declineChatJoinRequest" && c.params.user_id === 22)).toBe(true);
  });

  it("admits a complete screening on its own once the admit action has been earned", async () => {
    const { app, t } = world({ env: { CONCIERGE_AUTONOMY: "admit:auto" } });
    await enableGroup(app);
    await env.DB.prepare("UPDATE sources SET screen=1").run();
    await seedReviews("admit", RULES_VERSION, 50);
    await feed(app, joinRequest(23) as any);
    for (const a of ["Nurse", "Moved here", "Night shifts, first aid"]) await feed(app, dm(23, a));
    expect(t.calls.some((c) => c.method === "approveChatJoinRequest" && c.params.user_id === 23)).toBe(true);
    expect((await q<{ status: string }>("SELECT status FROM join_screens WHERE applicant_tg=23"))!.status).toBe("accepted");
    expect(await q("SELECT executed FROM concierge_cases WHERE subject LIKE 'join:%'")).toEqual({ executed: 1 });
  });

  it("forgetting an applicant removes their answers", async () => {
    const { app } = world();
    await enableGroup(app);
    await env.DB.prepare("UPDATE sources SET screen=1").run();
    await feed(app, joinRequest(24) as any);
    await feed(app, dm(24, "Gardener"));
    const member = await q<{ id: string }>("SELECT id FROM members WHERE tg_id=24");
    await forgetMember(env.DB, member!.id, 24);
    expect(await q("SELECT COUNT(*) AS n FROM join_screens WHERE applicant_tg=24")).toEqual({ n: 0 });
    expect(await q("SELECT COUNT(*) AS n FROM pending_inputs WHERE member_id=?", member!.id)).toEqual({ n: 0 });
  });
});

describe("spam guard", () => {
  it("flags a new member's scheme to the admins, and deletes only when the owner says so", async () => {
    const { app, t } = world();
    await enableGroup(app);
    await feed(app, groupMsg(31, "Earn money fast, write me at t.me/quick_cash_help"));
    const flag = await q<{ id: number; status: string }>("SELECT id, status FROM spam_flags");
    expect(flag!.status).toBe("pending");
    expect(await q("SELECT key FROM effects WHERE key = ?", `spam:${flag!.id}:${OWNER}`)).not.toBeNull();
    expect(t.calls.some((c) => c.method === "deleteMessage")).toBe(false);

    await feed(app, dm(OWNER, "/board"));
    expect(JSON.stringify(shownButtons(t.calls, OWNER))).toContain("Suspicious messages (1)");
    await feed(app, press(OWNER, `bd:p:y:${flag!.id}`));
    expect(t.calls.some((c) => c.method === "deleteMessage")).toBe(true);
    expect(t.calls.some((c) => c.method === "restrictChatMember" && c.params.user_id === 31)).toBe(true);
    expect((await q<{ status: string }>("SELECT status FROM spam_flags"))!.status).toBe("removed");
    expect(await q("SELECT verdict FROM concierge_cases WHERE subject LIKE 'spam:%'")).toEqual({ verdict: "good" });
  });

  it("leaves an established member's link and the admins' posts alone, and reads a plain address as no mention", async () => {
    const { app } = world();
    await enableGroup(app);
    await feed(app, groupMsg(32, "Hello everyone, nice to be here"));
    await feed(app, groupMsg(32, "Here is the guide https://example.com/guide"));
    await env.DB.prepare("INSERT INTO chat_admins(chat_id, tg_id, is_admin, checked_at) VALUES (?, 60, 1, '2026-10-28T00:00:00Z')").bind(GROUP).run();
    await feed(app, groupMsg(60, "Earn money fast, t.me/quick_cash_help"));
    await feed(app, groupMsg(33, "Write to ann@example.com about the venue"));
    expect(await q("SELECT COUNT(*) AS n FROM spam_flags")).toEqual({ n: 0 });
  });

  it("removes at once when moderation has been earned", async () => {
    const { app, t } = world({ env: { CONCIERGE_AUTONOMY: "moderate:auto" } });
    await enableGroup(app);
    await seedReviews("moderate", RULES_VERSION, 50);
    await feed(app, groupMsg(34, "Earn money fast, t.me/quick_cash_help"));
    expect(t.calls.some((c) => c.method === "deleteMessage")).toBe(true);
    expect((await q<{ status: string }>("SELECT status FROM spam_flags"))!.status).toBe("removed");
    expect(await q("SELECT key FROM effects WHERE key LIKE 'spam:%'")).toBeNull();
  });

  it("notes a heated exchange to the admins once, and does nothing about it", async () => {
    const { app, t } = world();
    await enableGroup(app);
    await feed(app, groupMsg(35, "ты идиот"));
    expect(await q("SELECT key FROM effects WHERE key LIKE 'heat:%'")).toBeNull();
    await feed(app, groupMsg(36, "сам идиот"));
    expect(await q("SELECT COUNT(*) AS n FROM effects WHERE key LIKE 'heat:%'")).toEqual({ n: 1 });
    expect(t.calls.some((c) => c.method === "deleteMessage" || c.method === "restrictChatMember")).toBe(false);
  });
});

describe("best answers", () => {
  it("proposes the club's own reply to a question that keeps coming back; yes makes it canonical and turns hints on", async () => {
    const { app, t } = world();
    await enableGroup(app);
    const questions = [
      "Does anyone know how to file a VAT return as a freelancer?",
      "Does anyone know when the VAT return is due for freelancers?",
      "Does anyone know if freelancers must register for VAT?",
    ];
    let user = 11;
    for (const text of questions) {
      const qid = nextMsg();
      await feed(app, { message: { message_id: qid, date: nowUnix(), chat: { id: GROUP, type: "supergroup", title: "G" }, from: { id: user++, is_bot: false }, text } } as any);
      await feed(app, groupMsg(40, "Register for VAT once your income passes the threshold; the tax office explains the rest.", { reply_to_message: { message_id: qid } }));
    }
    expect(await bestStep(env.DB)).toBe(1);
    const p = await q<{ id: string; answer_msg: number; status: string }>("SELECT id, answer_msg, status FROM answer_proposals");
    expect(p!.status).toBe("pending");
    expect(await bestStep(env.DB)).toBe(0); // not proposed again within the repeat window

    await feed(app, dm(OWNER, "/board"));
    expect(JSON.stringify(shownButtons(t.calls, OWNER))).toContain("Repeated questions (1)");
    await feed(app, press(OWNER, `bd:b:y:${p!.id}`));
    expect(await q<{ canonical: number }>("SELECT canonical FROM passages WHERE msg_id = ? AND source_id = (SELECT id FROM sources WHERE chat_id = ?)", p!.answer_msg, GROUP)).toEqual({ canonical: 1 });
    expect(await q<{ hints: number }>("SELECT hints FROM sources")).toEqual({ hints: 1 });
  });
});

describe("live suggestions", () => {
  const notary = { message_id: 0, date: 0, chat: { id: GROUP, type: "supergroup", title: "G" }, from: { id: 11, is_bot: false }, text: "Does anyone know a notary in Lisbon?" };
  const clarify = JSON.stringify({ action: "clarify", brief: "Find a notary in Lisbon", question: "Is it for a company or a personal document?", topics: [] });

  it("proposes a step for a request unanswered for four hours; yes sends it under the request", async () => {
    const { app, t } = world({ reply: clarify });
    await enableGroup(app);
    const qid = nextMsg();
    await feed(app, { message: { ...notary, message_id: qid, date: nowUnix() - 5 * 3600 } } as any);
    expect(await liveStep(app, new Date())).toBe(1);
    const c = await q<{ id: number; mode: string; action: string; executed: number }>("SELECT id, mode, action, executed FROM concierge_cases");
    expect(c).toMatchObject({ mode: "live", action: "clarify", executed: 0 });

    await feed(app, dm(OWNER, "/board"));
    expect(JSON.stringify(shownButtons(t.calls, OWNER))).toContain("Unanswered requests (1)");
    await feed(app, press(OWNER, `bd:l:y:${c!.id}`));
    const sent = await q<{ payload: string }>("SELECT payload FROM effects WHERE key = ?", `concierge:${c!.id}`);
    expect(JSON.parse(sent!.payload)).toMatchObject({ reply_to: qid, text: "Is it for a company or a personal document?" });
    expect(await q("SELECT verdict FROM concierge_cases WHERE id = ?", c!.id)).toEqual({ verdict: "good" });
  });

  it("sends at once when the action has been earned", async () => {
    const { app } = world({ reply: clarify, env: { CONCIERGE_AUTONOMY: "clarify:auto" } });
    await enableGroup(app);
    await seedReviews("clarify", PROMPT_VERSION, 50);
    await feed(app, { message: { ...notary, message_id: nextMsg(), date: nowUnix() - 5 * 3600 } } as any);
    await liveStep(app, new Date());
    expect(await q<{ executed: number }>("SELECT executed FROM concierge_cases WHERE mode = 'live'")).toEqual({ executed: 1 });
    expect(await q("SELECT COUNT(*) AS n FROM effects WHERE key LIKE 'concierge:%'")).toEqual({ n: 1 });
  });

  it("does nothing when the model is off", async () => {
    const { app } = world();
    await enableGroup(app);
    await feed(app, { message: { ...notary, message_id: nextMsg(), date: nowUnix() - 5 * 3600 } } as any);
    expect(await liveStep(app, new Date())).toBe(0);
    expect(await q("SELECT COUNT(*) AS n FROM concierge_cases")).toEqual({ n: 0 });
  });
});

describe("introduction rounds", () => {
  const monday = new Date("2026-11-02T10:00:00Z");

  async function twoMembers(candidateOptIn = 1) {
    const { app } = world();
    await enableGroup(app);
    await feed(app, groupMsg(50, "Does anyone know a good VAT accountant?"));
    await feed(app, groupMsg(51, "Happy to help with VAT for freelancers"));
    await env.DB.prepare("UPDATE members SET discoverable=1, rounds=1 WHERE tg_id = 50").run();
    await env.DB.prepare("UPDATE members SET discoverable=1, rounds=? WHERE tg_id = 51").bind(candidateOptIn).run();
    await env.DB.prepare("INSERT INTO skills(member_id, code, state, kind) SELECT id, 'tax', 'confirmed', 'self_claim' FROM members WHERE tg_id = 51").run();
    return app;
  }

  it("offers one introduction a week to two members who both opted in, then nothing more that week", async () => {
    const app = await twoMembers();
    expect(await roundsStep(app, monday)).toBeGreaterThan(0);
    expect(await q<{ status: string }>("SELECT status FROM intros")).toEqual({ status: "invited" });
    expect(await q("SELECT chat_id FROM effects WHERE key LIKE 'intro:%:invite'")).toEqual({ chat_id: 51 });
    expect(await q("SELECT COUNT(*) AS n FROM intro_rounds")).toEqual({ n: 2 });
    expect(await roundsStep(app, monday)).toBe(0);
    expect(await q("SELECT COUNT(*) AS n FROM intros")).toEqual({ n: 1 });
  });

  it("never reaches someone who has not opted in", async () => {
    const app = await twoMembers(0);
    await roundsStep(app, monday);
    expect(await q("SELECT COUNT(*) AS n FROM intros")).toEqual({ n: 0 });
  });

  it("turning rounds on needs /optin first", async () => {
    const { app, t } = world();
    await enableGroup(app);
    await feed(app, groupMsg(52, "hello there"));
    await feed(app, dm(52, "/rounds on"));
    expect(shown(t.calls, 52)).toContain("/optin");
    expect(await q("SELECT rounds FROM members WHERE tg_id = 52")).toEqual({ rounds: 0 });
  });
});

describe("who may decide, and the daily card", () => {
  it("a plain member is refused; a group admin decides for their group", async () => {
    const { app, t } = world({ admins: [OWNER, 60] });
    await enableGroup(app);
    await feed(app, groupMsg(60, "Hi, I manage this group"));
    await feed(app, groupMsg(31, "Earn money fast, write me at t.me/quick_cash_help"));
    const flag = await q<{ id: number }>("SELECT id FROM spam_flags");

    await feed(app, dm(77, "/board"));
    expect(shown(t.calls, 77)).toContain("don't manage any connected group");
    await feed(app, press(77, `bd:p:y:${flag!.id}`));
    expect(t.calls.some((c) => c.method === "deleteMessage")).toBe(false);

    await feed(app, press(60, `bd:p:y:${flag!.id}`));
    expect(t.calls.some((c) => c.method === "deleteMessage")).toBe(true);
  });

  it("sends one board a day at the digest hour, and only where something needs a decision", async () => {
    const { app } = world({ env: { DIGEST_HOUR: "9", TIMEZONE: "UTC" } });
    await enableGroup(app);
    await feed(app, groupMsg(31, "Earn money fast, write me at t.me/quick_cash_help"));
    expect(await boardDaily(app, new Date("2026-11-02T08:00:00Z"))).toBe(0);
    expect(await boardDaily(app, new Date("2026-11-02T09:00:00Z"))).toBe(1);
    expect(await q("SELECT key FROM effects WHERE key = 'board:2026-11-02:1000'")).not.toBeNull();
    expect(await boardDaily(app, new Date("2026-11-02T09:00:00Z"))).toBe(0);
  });

  it("the group settings card has the screening and spam toggles", async () => {
    const { app, t } = world();
    await enableGroup(app);
    await feed(app, groupCmd(OWNER, "/settings"));
    const card = t.calls.filter((c) => c.method === "sendMessage" && c.params.chat_id === GROUP).at(-1)!;
    expect(JSON.stringify(card.params.reply_markup)).toContain("st:screen:1");
    await feed(app, {
      callback_query: { id: "1", from: { id: OWNER, is_bot: false }, data: "st:screen:1", message: { message_id: 7, chat: { id: GROUP, type: "supergroup" } } },
    } as any);
    expect(await q<{ screen: number }>("SELECT screen FROM sources")).toEqual({ screen: 1 });
  });
});
