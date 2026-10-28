// The expert's side and the weekly pulse (plan: build step 2, journeys 4 and 9).
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ensureMember } from "../src/acl";
import { eligibleCandidates, helpCount } from "../src/experts";
import { act, requestIntro } from "../src/intros";
import { pulseCard, pulseStep } from "../src/pulse";
import { answerPending, openThread } from "../src/thread";
import { dispatchPending } from "../src/outbox";
import { OWNER, dm, enableGroup, feed, groupMsg, press, shown, testApp, type Call } from "./helpers";

const q = <T>(sql: string, ...b: unknown[]) => env.DB.prepare(sql).bind(...b).first<T>();
const idOf = async (tg: number) => (await ensureMember(env.DB, tg)).id;
const sentTo = (calls: Call[], chat: number) => calls.filter((c) => c.method === "sendMessage" && c.params.chat_id === chat);

/** Expert 11 is discoverable, knows accounting, and shares a group with asker 1. */
async function expertWorld() {
  const t = testApp();
  await enableGroup(t.app);
  for (const tg of [1, 11]) await feed(t.app, groupMsg(tg, `hello from ${tg}`));
  await env.DB.prepare("UPDATE members SET discoverable=1 WHERE tg_id=11").run();
  await env.DB.prepare("INSERT INTO skills(member_id, code, state) VALUES (?, 'accounting', 'confirmed')").bind(await idOf(11)).run();
  return t;
}

describe("the expert's side", () => {
  it("the invite says why this person was picked, in their own words", async () => {
    const { app, calls } = await expertWorld();
    const src = (await q<{ id: string }>("SELECT id FROM sources"))!.id;
    for (let i = 0; i < 6; i++) {
      await env.DB.prepare("INSERT INTO passages(source_id, msg_id, part, author_id, body, event_at, reply_to) VALUES (?,?,0,?,?,?,?)")
        .bind(src, 5000 + i, await idOf(11), `accountant answer ${i}: file the VAT return before the deadline`, "2026-10-01T10:00:00Z", 1)
        .run();
    }
    expect(await helpCount(env.DB, await idOf(11), "accounting")).toBe(6);
    const asked = await requestIntro(env.DB, await idOf(1), "I need an accountant for VAT");
    await dispatchPending(app.db, app.tg, 40, asked.keys);
    const invite = sentTo(calls, 11).at(-1)!;
    expect(invite.params.text).toContain("Request for help");
    expect(invite.params.text).toContain("Why you");
    expect(invite.params.text).toContain("6 time(s)");
    expect(JSON.stringify(invite.params.reply_markup)).toContain("Not now");
  });

  it("'Not now' has no penalty; two in a row offer a pause, once", async () => {
    await expertWorld();
    const first = await requestIntro(env.DB, await idOf(1), "accountant for VAT, first request");
    const introA = (await q<{ id: string }>("SELECT id FROM intros WHERE need_id=?", first.needId))!.id;
    const keysA = await act(env.DB, introA, await idOf(11), "decline");
    expect(keysA.keys.some((k) => k.startsWith("pause:"))).toBe(false); // one decline: nothing
    const second = await requestIntro(env.DB, await idOf(1), "accountant for VAT, second request");
    const introB = (await q<{ id: string }>("SELECT id FROM intros WHERE need_id=? AND status='invited'", second.needId))!.id;
    const keysB = await act(env.DB, introB, await idOf(11), "decline");
    const pauses = keysB.keys.filter((k) => k.startsWith("pause:"));
    expect(pauses).toHaveLength(1);
    const pause = await q<{ payload: string }>("SELECT payload FROM effects WHERE key=?", pauses[0]!);
    expect(pause!.payload).toContain("p:available:0");
    expect(pause!.payload).toContain("p:available:1");
  });

  it("quiet hours keep an expert out of the matcher, and only then", async () => {
    await expertWorld();
    const me = await idOf(1);
    await env.DB.prepare("UPDATE members SET quiet_from=22, quiet_to=8 WHERE tg_id=11").run(); // 22:00–08:00 UTC
    expect(await eligibleCandidates(env.DB, me, ["accounting"], "2026-10-26T23:00:00Z")).toHaveLength(0);
    expect(await eligibleCandidates(env.DB, me, ["accounting"], "2026-10-26T03:00:00Z")).toHaveLength(0);
    expect(await eligibleCandidates(env.DB, me, ["accounting"], "2026-10-26T12:00:00Z")).toHaveLength(1);
  });

  it("🙏 without words thanks the helper plainly", async () => {
    const { app, calls } = testApp();
    await enableGroup(app);
    await feed(app, groupMsg(1, "hello"));
    await feed(app, groupMsg(2, "The venue for the meetup is Hall B"));
    await feed(app, dm(1, "where is the venue?"));
    const me = await idOf(1);
    const id = (await q<{ id: string }>("SELECT id FROM threads WHERE member_id=?", me))!.id;
    await feed(app, press(1, `t:${id}:ok`));
    // An outcome needs an introduction; use a bare helper link to test the words path directly.
    await env.DB.prepare("UPDATE threads SET helper_id=?, outcome='advice' WHERE id=?").bind(await idOf(2), id).run();
    await feed(app, press(1, `t:${id}:thx0`));
    const thanks = sentTo(calls, 2).at(-1)!;
    expect(thanks.params.text).toContain("Someone thanked you");
    expect(thanks.params.text).not.toContain("”: “"); // no words quoted
  });

  it("the pending words expire after an hour, and commands are never taken as words", async () => {
    const { app } = testApp();
    await enableGroup(app);
    await feed(app, groupMsg(1, "hello"));
    const me = await q<{ id: string }>("SELECT id FROM members WHERE tg_id=1");
    await env.DB.prepare("INSERT INTO pending_inputs(member_id, kind, ref, expires_at) VALUES (?, 'thanks', 'nope', '2000-01-01T00:00:00Z')").bind(me!.id).run();
    const member = (await q<any>("SELECT * FROM members WHERE tg_id=1"))!;
    expect(await answerPending(app, member, "too late")).toBeNull();
    expect(await q("SELECT COUNT(*) AS n FROM pending_inputs")).toEqual({ n: 0 });
  });
});

describe("the weekly pulse", () => {
  async function weekWorld() {
    const t = testApp();
    await enableGroup(t.app);
    await feed(t.app, groupMsg(1, "Who knows a good accountant for VAT?"));
    await feed(t.app, groupMsg(11, "Dana handles VAT, ask her"));
    await feed(t.app, groupMsg(1, "Where is the parking?"));
    const src = (await q<{ id: string }>("SELECT id FROM sources"))!.id;
    await env.DB.prepare("UPDATE passages SET intent='help_request', intent_conf=0.9 WHERE body LIKE 'Who%' OR body LIKE 'Where%'").run();
    await env.DB.prepare("UPDATE passages SET reply_to=(SELECT msg_id FROM passages WHERE body LIKE 'Who%') WHERE body LIKE 'Dana%'").run();
    return { ...t, src };
  }

  it("counts questions, answers, the wait, the speed and who helps most", async () => {
    const { src } = await weekWorld();
    const card = await pulseCard(env.DB, src, "Club", "2000-01-01T00:00:00Z", "en");
    expect(card.text).toContain("Questions: <b>2</b>");
    expect(card.text).toContain("Answered: <b>1</b>");
    expect(card.text).toContain("Waiting for an answer: <b>1</b>");
    expect(card.text).toContain("Helps most:");
    expect(card.quiet).toBe(false);
    expect(card.shareText).toContain("Thank you");
  });

  it("is sent on Monday, once, to the owner who connected the group", async () => {
    const { app, calls, src } = await weekWorld();
    const monday = new Date("2026-10-26T10:00:00Z"); // a Monday
    const keys = await pulseStep(env.DB, monday, "UTC", 9);
    expect(keys).toHaveLength(1);
    expect(await pulseStep(env.DB, new Date("2026-10-27T10:00:00Z"), "UTC", 9)).toHaveLength(0); // Tuesday
    expect((await q<{ tg_id: number }>("SELECT m.tg_id FROM sources s JOIN members m ON m.id=s.enabled_by WHERE s.id=?", src))!.tg_id).toBe(OWNER);
    await dispatchPending(app.db, app.tg, 40, keys);
    expect(sentTo(calls, OWNER).at(-1)!.params.text).toContain("Questions: <b>2</b>");
  });

  it("a week with no messages says nothing at all", async () => {
    const t = testApp();
    await enableGroup(t.app);
    const id = (await q<{ id: string }>("SELECT id FROM sources"))!.id;
    const card = await pulseCard(env.DB, id, "Quiet", "2000-01-01T00:00:00Z", "en");
    expect(card.text).toBe(""); // no messages stored: nothing to report
  });

  it("/pulse shows the owner their groups, and nobody else", async () => {
    const { app, calls } = await weekWorld();
    await feed(app, dm(OWNER, "/pulse"));
    expect(sentTo(calls, OWNER).at(-1)!.params.text).toContain("Pulse");
    await feed(app, dm(11, "/pulse"));
    expect(sentTo(calls, 11).some((c) => String(c.params.text).includes("Pulse"))).toBe(false);
  });
});
