// Gatherings (plan: build step 6, journey 8): «Иду», who's going, the reminder, and a mutual
// "keep in touch" that is the only way contacts open.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ensureMember } from "../src/acl";
import { afterStep, remindStep } from "../src/gather";
import { dispatchPending } from "../src/outbox";
import { enableGroup, feed, groupMsg, press, testApp, type Call } from "./helpers";

const q = <T>(sql: string, ...b: unknown[]) => env.DB.prepare(sql).bind(...b).first<T>();
const idOf = async (tg: number) => (await ensureMember(env.DB, tg)).id;
const sentTo = (calls: Call[], chat: number) => calls.filter((c) => c.method === "sendMessage" && c.params.chat_id === chat);
const buttonsOf = (calls: Call[], chat: number, text: string) => {
  // The card for the text is the one with buttons (the list above it has none).
  const msg = sentTo(calls, chat).filter((c) => String(c.params.text).includes(text) && c.params.reply_markup).at(-1)!;
  return (msg.params.reply_markup?.inline_keyboard ?? []).flat().map((b: { callback_data: string }) => b.callback_data) as string[];
};

async function world(startsIn: number) {
  const t = testApp();
  await enableGroup(t.app);
  for (const tg of [1, 2, 3, 4]) await feed(t.app, groupMsg(tg, `hello from ${tg}`));
  await env.DB.prepare("INSERT INTO skills(member_id, code, state) VALUES (?, 'accounting', 'confirmed'), (?, 'accounting', 'confirmed')").bind(await idOf(1), await idOf(2)).run();
  const src = (await q<{ id: string }>("SELECT id FROM sources"))!.id;
  const starts = new Date(Date.now() + startsIn).toISOString().replace(/\.\d{3}Z$/, "Z");
  // The event is announced by a stored message, as the bot records it (upcoming events need it).
  await env.DB.prepare("INSERT INTO passages(source_id, msg_id, part, author_id, body, event_at) VALUES (?, 900, 0, ?, 'Coffee walk, see you there', '2026-10-01T00:00:00Z')").bind(src, await idOf(1)).run();
  await env.DB.prepare("INSERT INTO events(source_id, msg_id, title, starts_at, hidden, created_at) VALUES (?, 900, 'Coffee walk', ?, 0, '2026-10-01T00:00:00Z')").bind(src, starts).run();
  return { ...t, short: `900.${src.slice(0, 8)}` };
}

describe("gatherings: before", () => {
  it("«Иду» on the event, and 'who's going' names three people worth meeting, with the reason", async () => {
    const { app, calls, short } = await world(10 * 3_600_000);
    await feed(app, { message: { message_id: 1, date: 1, chat: { id: 1, type: "private" }, from: { id: 1, is_bot: false }, text: "/events", entities: [{ type: "bot_command", offset: 0, length: 7 }] } } as never);
    const go = buttonsOf(calls, 1, "Coffee walk").find((d) => d.endsWith(":go"))!;
    expect(go).toBe(`rv:${short}:go`);
    for (const tg of [1, 2, 3]) await feed(app, press(tg, `rv:${short}:go`));
    await feed(app, press(4, `rv:${short}:no`));
    expect((await q<{ n: number }>("SELECT COUNT(*) AS n FROM rsvps WHERE status='going'"))!.n).toBe(3);
    await feed(app, press(1, `rw:${short}`));
    const who = sentTo(calls, 1).at(-1)!.params.text as string;
    expect(who).toContain("Going: 2");
    expect(who).toContain("you both know Accounting"); // 2 shares a skill with 1
  });
});

describe("gatherings: the reminder and after", () => {
  it("two hours before, the people who said they're going get a reminder, once", async () => {
    const { app, calls, short } = await world(2 * 3_600_000 + 5 * 60_000);
    await feed(app, press(1, `rv:${short}:go`));
    const keys = await remindStep(env.DB, new Date());
    expect(keys).toHaveLength(1);
    expect(await remindStep(env.DB, new Date())).toHaveLength(1); // same key: not sent twice by the ledger
    await dispatchPending(app.db, app.tg, 40, keys);
    expect(sentTo(calls, 1).at(-1)!.params.text).toContain("In about two hours");
  });

  it("after it, going people are asked once who they'd like to see again; contacts open only if it's mutual", async () => {
    const { app, calls, short } = await world(-2.5 * 3_600_000);
    for (const tg of [1, 2]) await feed(app, press(tg, `rv:${short}:go`));
    const keys = await afterStep(env.DB, new Date());
    expect(keys).toHaveLength(2);
    expect(await afterStep(env.DB, new Date())).toHaveLength(0);
    await dispatchPending(app.db, app.tg, 40, keys);
    const token2 = (await q<{ token: string }>("SELECT token FROM rsvps WHERE member_id=?", await idOf(2)))!.token;
    const token1 = (await q<{ token: string }>("SELECT token FROM rsvps WHERE member_id=?", await idOf(1)))!.token;
    expect(buttonsOf(calls, 1, "How was")).toContain(`wn:${short}:${token2}`);

    // One-sided: 1 would like to see 2 again. Nothing is opened.
    await feed(app, press(1, `wn:${short}:${token2}`));
    expect(await q<{ n: number }>("SELECT COUNT(*) AS n FROM wants")).toEqual({ n: 1 });
    expect(JSON.stringify(calls.filter((c) => c.method === "sendMessage" && c.params.chat_id === 2).map((c) => c.params))).not.toContain("reveal");
    expect(await q("SELECT COUNT(*) AS n FROM effects WHERE payload LIKE '%reveal_tg_id%'")).toEqual({ n: 0 });

    // Now 2 wants 1 too: mutual, and both get the other's contact.
    await feed(app, press(2, `wn:${short}:${token1}`));
    const reveals = (await env.DB.prepare("SELECT payload FROM effects WHERE payload LIKE '%reveal_tg_id%'").all<{ payload: string }>()).results;
    expect(reveals).toHaveLength(2);
    expect(reveals.map((r) => JSON.parse(r.payload).reveal_tg_id).sort()).toEqual([1, 2]);
  });
});
