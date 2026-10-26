// «Главное» and onboarding (plan: build step 5, journeys 2 and 7).
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ensureMember, readable } from "../src/acl";
import { glavnoeFor } from "../src/glavnoe";
import { OWNER, enableGroup, feed, groupMsg, press, testApp, type Call } from "./helpers";

const q = <T>(sql: string, ...b: unknown[]) => env.DB.prepare(sql).bind(...b).first<T>();
const idOf = async (tg: number) => (await ensureMember(env.DB, tg)).id;
const NOW = new Date(Date.now() + 60_000);
const START = new Date(NOW.getTime() - 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
const END = new Date(NOW.getTime() + 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

async function card(tg: number) {
  const mem = await ensureMember(env.DB, tg);
  return glavnoeFor(env.DB, mem.id, await readable(env.DB, mem), START, END, NOW, "UTC", "en");
}
const doneIds = async (tg: number) => (await env.DB.prepare("SELECT passage_id FROM glavnoe_done d JOIN members m ON m.id=d.member_id WHERE m.tg_id=?").bind(tg).all<{ passage_id: number }>()).results.map((r) => r.passage_id);

describe("«Главное»: the day's card", () => {
  it("a person's own unanswered question is on it, with a Done button; Done takes it away for good", async () => {
    const { app } = testApp();
    await enableGroup(app);
    await feed(app, groupMsg(1, "Can anyone recommend a dentist?"));
    const first = await card(1);
    expect(first!.text).toContain("Your question, still unanswered");
    const btn = first!.buttons[0]![0]!;
    expect(btn.callback_data).toMatch(/^gd:\d+$/);
    const passageId = Number(btn.callback_data.slice(3));
    await feed(app, press(1, btn.callback_data));
    expect(await doneIds(1)).toEqual([passageId]);
    // The question is no longer on their card; the club's own lines may still mention it.
    expect((await card(1))?.text ?? "").not.toContain("Your question, still unanswered");
  });

  it("a reply to something they wrote is waiting for them", async () => {
    const { app } = testApp();
    await enableGroup(app);
    const mine = groupMsg(1, "Where do we pay the membership fee?");
    await feed(app, mine);
    const msgId = (mine.message as { message_id: number }).message_id;
    await feed(app, groupMsg(2, "Pay it at the front desk, cash or card", { reply_to_message: { message_id: msgId, chat: { id: -1001234, type: "supergroup" }, from: { id: 1, is_bot: false }, text: "Where do we pay" } }));
    const c = await card(1);
    expect(c!.text).toContain("Waiting for you");
    expect(c!.text).toContain("front desk");
  });

  it("money with a deadline is named as money", async () => {
    const { app } = testApp();
    await enableGroup(app);
    await feed(app, groupMsg(2, "Membership fee is 500 EUR, please pay by 1 November"));
    await feed(app, groupMsg(3, "Thanks all"));
    const c = await card(3);
    expect(c!.text).toContain("Money, with a deadline");
    expect(c!.text).toContain("500 EUR");
  });

  it("a quiet day with activity says so; no activity at all sends nothing", async () => {
    const { app } = testApp();
    await enableGroup(app);
    await feed(app, groupMsg(2, "Good morning everyone"));
    expect((await card(2))!.text).toContain("Quiet today"); // 2 is in the group, and nothing needs them
    const empty = testApp();
    await enableGroup(empty.app);
    await env.DB.prepare("DELETE FROM passages").run();
    expect(await card(OWNER)).toBeNull();
  });
});

describe("newcomer onboarding", () => {
  async function joinNina(app: ReturnType<typeof testApp>["app"]) {
    await feed(app, {
      chat_member: {
        chat: { id: -1001234, type: "supergroup", title: "G" },
        from: { id: OWNER, is_bot: false },
        old_chat_member: { status: "left", user: { id: 9, is_bot: false, first_name: "Nina" } },
        new_chat_member: { status: "member", user: { id: 9, is_bot: false, first_name: "Nina" } },
      },
    } as never);
  }

  it("the newcomer sees real questions and topics, can say what they help with, and is offered an ask", async () => {
    const t = testApp();
    await enableGroup(t.app);
    await feed(t.app, groupMsg(1, "Can anyone recommend a dentist?"));
    await feed(t.app, groupMsg(2, "Our accountant handles VAT and the tax return every quarter"));
    await feed(t.app, groupMsg(3, "Anyone can help with my accountant questions and VAT?"));
    await env.DB.prepare("UPDATE members SET discoverable=1 WHERE tg_id=3").run();
    await env.DB.prepare("INSERT INTO skills(member_id, code, state) VALUES (?, 'accounting', 'confirmed')").bind(await idOf(3)).run();
    await joinNina(t.app);
    const onboard = t.calls.filter((c: Call) => c.method === "sendMessage" && c.params.chat_id === 9).at(-1)!;
    expect(onboard.params.text).toContain("People here often ask about");
    expect(onboard.params.text).toContain("/forget_me");
    const buttons = onboard.params.reply_markup.inline_keyboard.flat().map((b: { callback_data: string }) => b.callback_data);
    expect(buttons.some((d: string) => d.startsWith("nq:"))).toBe(true);
    expect(buttons).toContain("ob:accounting");

    await feed(t.app, press(9, "ob:accounting"));
    expect(await q("SELECT state FROM skills WHERE member_id=? AND code='accounting'", await idOf(9))).toEqual({ state: "confirmed" });
    expect(t.calls.filter((c: Call) => c.method === "sendMessage" && c.params.chat_id === 9).at(-1)!.params.text).toContain("knows Accounting well");

    const nq = buttons.find((d: string) => d.startsWith("nq:"))!;
    await feed(t.app, press(9, nq));
    expect((await q<{ n: number }>("SELECT COUNT(*) AS n FROM threads t JOIN members m ON m.id=t.member_id WHERE m.tg_id=9"))!.n).toBe(1);
  });
});
