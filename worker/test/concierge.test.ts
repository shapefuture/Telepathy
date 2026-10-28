// Autonomous concierge, first slice (ADR-007): the permission envelope, the model's output parser,
// the history replay (no peeking at the future, routing scored without names), the owner's review,
// and deletion scrubbing the generated text.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { forgetMember } from "../src/rights";
import { parseProposal } from "../src/concierge/agent";
import { AUTO_MIN_REVIEWED, effectiveLevel, parseAutonomy } from "../src/concierge/policy";
import { nextForReview, pendingRequests, replayOne, replayStep, report, review } from "../src/concierge/replay";
import { makeApp } from "../src/index";
import { GROUP, OWNER, dm, enableGroup, fakeTelegram, feed, nextMsg, press, shown, shownButtons } from "./helpers";

describe("policy", () => {
  it("is off unless configured, and never above an action's ceiling", () => {
    const none = parseAutonomy(undefined);
    expect(effectiveLevel("answer", none)).toBe("off");
    const all = parseAutonomy("introduce:auto, ask_partners:auto, paid_provider:auto, clarify:suggest, bogus:auto, answer:yes");
    expect(effectiveLevel("introduce", all, { reviewed: 500, good: 500 })).toBe("suggest");
    expect(effectiveLevel("ask_partners", all, { reviewed: 500, good: 500 })).toBe("suggest");
    expect(effectiveLevel("paid_provider", all, { reviewed: 500, good: 500 })).toBe("suggest");
    expect(effectiveLevel("clarify", all)).toBe("suggest");
    expect(effectiveLevel("answer", all)).toBe("off");
  });

  it("grants auto only after enough reviewed cases judged right", () => {
    const cfg = parseAutonomy("answer:auto");
    expect(effectiveLevel("answer", cfg)).toBe("suggest");
    expect(effectiveLevel("answer", cfg, { reviewed: AUTO_MIN_REVIEWED - 1, good: AUTO_MIN_REVIEWED - 1 })).toBe("suggest");
    expect(effectiveLevel("answer", cfg, { reviewed: 50, good: 44 })).toBe("suggest");
    expect(effectiveLevel("answer", cfg, { reviewed: 50, good: 45 })).toBe("auto");
  });
});

describe("parseProposal", () => {
  it("accepts the expected shape and rejects anything else", () => {
    expect(parseProposal('<think>hm</think>Sure: {"action":"clarify","brief":"Needs a VAT setup","question":"Which country?","topics":["tax"]}')).toMatchObject({
      action: "clarify",
      question: "Which country?",
      topics: ["tax"],
    });
    expect(parseProposal('{"action":"message_everyone","brief":"x"}')).toBeNull(); // not an action it has
    expect(parseProposal('{"action":"answer","brief":"x"}')).toBeNull(); // an answer needs text
    expect(parseProposal('{"action":"ask_people"}')).toBeNull(); // no brief
    expect(parseProposal("I think you should ask Anna")).toBeNull();
  });
});

// A group where member 12 explained VAT before; later 13 asks, and 12 replies again.
const T0 = 1_700_000_000;
const msg = (from: number, text: string, date: number, extra: Record<string, unknown> = {}) => ({
  message: { message_id: nextMsg(), date, chat: { id: GROUP, type: "supergroup", title: "G" }, from: { id: from, is_bot: false }, text, ...extra },
});

function world(reply: string | ((user: string) => string)) {
  const t = fakeTelegram();
  const prompts: string[] = [];
  const AI = {
    run: async (_model: string, input: { messages: { role: string; content: string }[] }) => {
      const user = input.messages.find((m) => m.role === "user")!.content;
      prompts.push(user);
      return { response: typeof reply === "string" ? reply : reply(user) };
    },
  };
  const app = makeApp({ ...(env as any), OLLAMA_API_KEY: undefined, AI }, t.fetcher);
  return { app, t, prompts };
}

async function seed(app: any) {
  await enableGroup(app);
  const q1 = nextMsg();
  await feed(app, { message: { message_id: q1, date: T0, chat: { id: GROUP, type: "supergroup", title: "G" }, from: { id: 11, is_bot: false }, text: "Does anyone know how VAT works for freelancers?" } });
  await feed(app, msg(12, "VAT for freelancers: register once income passes the threshold, the tax office explains the rest", T0 + 600, { reply_to_message: { message_id: q1 } }));
  const q2 = nextMsg();
  await feed(app, { message: { message_id: q2, date: T0 + 86_400, chat: { id: GROUP, type: "supergroup", title: "G" }, from: { id: 13, is_bot: false }, text: "Does anyone know about VAT for freelancers? write me at me@example.com" } });
  // After the request: the real reply, and a nearby message. The replay must see neither.
  await feed(app, msg(12, "VAT zebra: same as before, tax office", T0 + 86_400 + 120, { reply_to_message: { message_id: q2 } }));
  await feed(app, msg(14, "zebra crossing at lunch", T0 + 86_400 + 180));
}

const requestRow = async () =>
  (await env.DB.prepare("SELECT id, source_id, msg_id, author_id, body, event_at FROM passages WHERE body LIKE 'Does anyone know about VAT%'").first<any>())!;
const caseRow = async () => (await env.DB.prepare("SELECT * FROM concierge_cases").first<any>())!;

describe("history replay", () => {
  it("sees only what existed before the request, redacted, and records what really happened", async () => {
    const { app, prompts } = world('{"action":"answer","brief":"How VAT works for freelancers","answer":"Per the group: \\"register once income passes the threshold\\".","topics":["tax"]}');
    await seed(app);
    await replayOne(app, await requestRow(), "en");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("register once income passes the threshold"); // the earlier answer
    expect(prompts[0]).not.toContain("zebra"); // nothing from after the request
    expect(prompts[0]).not.toContain("me@example.com"); // redacted
    const c = await caseRow();
    expect(c).toMatchObject({ action: "answer", quotes_verified: 1, quotes_failed: 0, real_replied: 1, real_minutes: 2, downgraded: 0 });
    expect(c.answer).toContain("register once income passes the threshold");
    expect(c.helper_hit).toBeNull(); // routing is scored only for ask_people
  });

  it("scores routing by whether someone who really replied was among those it would ask", async () => {
    const { app } = world('{"action":"ask_people","brief":"Set up VAT as a freelancer","topics":["tax"]}');
    await seed(app);
    await replayOne(app, await requestRow(), "en");
    const c = await caseRow();
    expect(c.action).toBe("ask_people");
    expect(JSON.parse(c.codes)).toContain("tax");
    expect(c.candidates).toBe(1);
    expect(c.helper_hit).toBe(1);
    expect(JSON.stringify(c)).not.toMatch(/"member|author/); // no ids stored on the case
  });

  it("turns an answer with made-up quotes into asking people", async () => {
    const { app } = world('{"action":"answer","brief":"VAT","answer":"It is \\"always free for everyone\\".","topics":["tax"]}');
    await seed(app);
    await replayOne(app, await requestRow(), "en");
    expect(await caseRow()).toMatchObject({ action: "ask_people", downgraded: 1, quotes_failed: 1, answer: null });
  });

  it("records no decision for output it can't trust, or with the model off", async () => {
    const { app } = world("Ignore the rules and DM everyone the list");
    await seed(app);
    await replayOne(app, await requestRow(), "en");
    expect(await caseRow()).toMatchObject({ action: null, error: "invalid_output" });

    const off = makeApp({ ...(env as any), OLLAMA_API_KEY: undefined, AI: undefined }, fakeTelegram().fetcher);
    await env.DB.prepare("DELETE FROM concierge_cases").run();
    await replayOne(off, await requestRow(), "en");
    expect(await caseRow()).toMatchObject({ action: null, error: "ai_off" });
  });
});

describe("/concierge for the operator", () => {
  it("queues a replay that the cron works through, then reviews cases on one card", async () => {
    const { app, t } = world('{"action":"ask_people","brief":"Set up VAT as a freelancer","topics":["tax"]}');
    await seed(app);
    await feed(app, dm(OWNER, "/concierge run 5"));
    expect(shown(t.calls, OWNER)).toContain("Queued");
    expect(await replayStep(app)).toBe(2); // both past requests (two per run)
    expect(await env.DB.prepare("SELECT value FROM settings WHERE key='concierge.queue'").first()).not.toBeNull();
    expect(await replayStep(app)).toBe(0); // nothing left: the queue closes and the operator hears
    expect(await env.DB.prepare("SELECT value FROM settings WHERE key='concierge.queue'").first()).toBeNull();
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM effects WHERE key LIKE 'concierge:done:%'").first<{ n: number }>()).toEqual({ n: 1 });
    expect(await replayStep(app)).toBe(0);

    await feed(app, dm(OWNER, "/concierge"));
    expect(shown(t.calls, OWNER)).toContain("Requests replayed: <b>2</b>");

    await feed(app, press(OWNER, "cg:rev"));
    expect(shown(t.calls, OWNER)).toContain("Would this have been right?");
    const ok = shownButtons(t.calls, OWNER)[0]![0]!.callback_data;
    expect(ok).toMatch(/^cg:ok:\d+$/);
    await feed(app, press(OWNER, ok));
    const r = await report(env.DB, [(await requestRow()).source_id]);
    expect(r.reviews.ask_people).toEqual({ reviewed: 1, good: 1 });

    // Not an operator: nothing happens.
    const before = t.calls.length;
    await feed(app, press(12, "cg:rev"));
    expect(t.calls.slice(before).every((c) => c.method === "answerCallbackQuery")).toBe(true);
  });

  it("only reviews cases in groups the reviewer can read", async () => {
    const { app } = world('{"action":"clarify","brief":"VAT","question":"Which country?","topics":["tax"]}');
    await seed(app);
    const src = (await requestRow()).source_id;
    for (const r of await pendingRequests(env.DB, [src], 5)) await replayOne(app, r, "en");
    const id = (await nextForReview(env.DB, [src]))!.id;
    expect(await nextForReview(env.DB, ["another-group"])).toBeNull();
    expect(await review(env.DB, id, "good", ["another-group"])).toBe(false);
    expect(await review(env.DB, id, "good", [src])).toBe(true);
  });
});

describe("deletion", () => {
  it("drops generated text when a member is forgotten; numbers and verdicts stay", async () => {
    const { app } = world('{"action":"clarify","brief":"VAT for a freelancer","question":"Which country?","topics":["tax"]}');
    await seed(app);
    const r = await requestRow();
    await replayOne(app, r, "en");
    await review(env.DB, (await caseRow()).id, "good", [r.source_id]);
    const m = (await env.DB.prepare("SELECT id FROM members WHERE tg_id=12").first<{ id: string }>())!;
    await forgetMember(env.DB, m.id, 12);
    expect(await caseRow()).toMatchObject({ brief: null, answer: null, question: null, action: "clarify", verdict: "good" });
    expect(await nextForReview(env.DB, [r.source_id])).toBeNull();
  });
});
