// «Нить»: one living card per request (plan: the main mechanism, build step 1).
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ensureMember } from "../src/acl";
import { makeApp } from "../src/index";
import { faceOf } from "../src/thread-card";
import { followupsDue } from "../src/thread";
import { wowCard, forgottenView } from "../src/wow";
import { dispatchPending } from "../src/outbox";
import { OWNER, dm, enableGroup, feed, groupCmd, groupMsg, press, shown, shownButtons, testApp } from "./helpers";
import type { Fetcher } from "../src/telegram";

const q = <T>(sql: string, ...b: unknown[]) => env.DB.prepare(sql).bind(...b).first<T>();
const threadOf = async (memberTg: number) => (await q<{ id: string }>("SELECT t.id FROM threads t JOIN members m ON m.id=t.member_id WHERE m.tg_id=? ORDER BY t.created_at DESC", memberTg))!.id;
const idOf = async (tg: number) => (await ensureMember(env.DB, tg)).id;

/** Asker 1 and a helpful member 2 share a group that has the answer. */
async function memoryWorld() {
  const t = testApp();
  await enableGroup(t.app);
  await feed(t.app, groupMsg(1, "hello")); // the asker is known to the bot, as in any real group
  await feed(t.app, groupMsg(2, "The venue for the meetup is Hall B"));
  return t;
}

describe("the living card", () => {
  it("one card: searching, then the answer edited into it, with a face and a month", async () => {
    const { app, calls } = await memoryWorld();
    await feed(app, dm(1, "where is the venue?"));
    const sentTo1 = calls.filter((c) => c.method === "sendMessage" && c.params.chat_id === 1);
    expect(sentTo1).toHaveLength(1); // the card is the only message: edits, not a stream of replies
    expect(sentTo1[0]!.params.text).toContain("Searching");
    const card = shown(calls, 1);
    expect(card).toContain("Hall B");
    expect(card).toContain("Found in the community");
    expect(card).toContain(faceOf(await idOf(2))); // the author's face
    expect(card).toContain("Member"); // no name unless they opted in
    expect(shownButtons(calls, 1)[0]!.map((b) => b.callback_data.replace(/^t:[^:]+:/, ""))).toEqual(["ok", "ask"]);
  });

  it("'Это то, что нужно' closes it as solved and counts the answer as useful", async () => {
    const { app, calls } = await memoryWorld();
    await feed(app, dm(1, "where is the venue?"));
    const id = await threadOf(1);
    await feed(app, press(1, `t:${id}:ok`));
    expect(shown(calls, 1)).toContain("Outcome: solved");
    expect((await q<{ outcome: string }>("SELECT outcome FROM threads WHERE id=?", id))!.outcome).toBe("solved");
    expect((await q<{ up: number }>("SELECT SUM(up) AS up FROM passage_votes"))!.up).toBeGreaterThan(0);
  });

  it("no answer in memory: the card offers to ask people, and says so when nobody is free", async () => {
    const { app, calls } = await memoryWorld();
    await feed(app, dm(1, "who knows about kubernetes ingress?"));
    expect(shown(calls, 1)).toContain("Nothing in the community's memory");
    await feed(app, press(1, `t:${await threadOf(1)}:ask`));
    expect(shown(calls, 1)).toContain("No one suitable has taken it yet");
  });

  it("asks people, an expert accepts, the asker confirms, and the outcome and thanks close the loop", async () => {
    const { app, calls } = testApp();
    await enableGroup(app);
    for (const tg of [1, 11, 12]) await feed(app, groupMsg(tg, `hello from ${tg}`));
    for (const tg of [11, 12]) {
      await env.DB.prepare("UPDATE members SET discoverable=1 WHERE tg_id=?").bind(tg).run();
      await env.DB.prepare("INSERT INTO skills(member_id, code, state) VALUES (?, 'accounting', 'confirmed')").bind(await idOf(tg)).run();
    }
    await feed(app, dm(1, "I need an accountant for VAT"));
    await feed(app, press(1, `t:${await threadOf(1)}:ask`));
    expect(shown(calls, 1)).toContain("Asked 1 people");
    const invite = calls.filter((c) => c.method === "sendMessage" && String(c.params.text).includes("Introduction request")).at(-1)!;
    const helper = invite.params.chat_id as number;
    const introId = (await q<{ id: string }>("SELECT id FROM intros LIMIT 1"))!.id;
    await feed(app, press(helper, `i:${introId}:accept`));
    expect(shown(calls, 1)).toContain("is ready to help");
    await feed(app, press(1, `i:${introId}:confirm`));
    expect(shown(calls, 1)).toContain("You're connected");
    const thread = await q<{ state: string; followup_at: string | null }>("SELECT state, followup_at FROM threads WHERE member_id=?", await idOf(1));
    expect(thread).toMatchObject({ state: "introduced" });
    expect(thread!.followup_at).toBeTruthy();

    // Three days later the asker is asked how it went, as a new message (edits are silent).
    const later = new Date(Date.parse(thread!.followup_at!) + 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const keys = await followupsDue(env.DB, later);
    expect(keys).toHaveLength(1);
    await dispatchPending(app.db, app.tg, 40, keys);
    const ask = calls.filter((c) => c.method === "sendMessage" && c.params.chat_id === 1).at(-1)!;
    expect(ask.params.text).toContain("Did it help?");
    expect(await followupsDue(env.DB, later)).toHaveLength(0); // asked once

    const id = await threadOf(1);
    await feed(app, press(1, `t:${id}:o:advice`));
    expect(shown(calls, 1)).toContain("Outcome: got advice");
    expect((await q<{ status: string; outcome: string }>("SELECT status, outcome FROM intros WHERE id=?", introId))).toEqual({ status: "completed", outcome: "helpful" });
    expect((await q<{ status: string }>("SELECT status FROM needs WHERE id=(SELECT need_id FROM intros WHERE id=?)", introId))!.status).toBe("closed");

    // 🙏 goes to the helper, anonymously, and the card says so.
    // 🙏 asks for a few words first; the next private message is them.
    expect(shownButtons(calls, 1).flat().map((b) => b.callback_data)).toContain(`t:${id}:thx`);
    await feed(app, press(1, `t:${id}:thx`));
    expect(calls.filter((c) => c.method === "sendMessage" && c.params.chat_id === 1).at(-1)!.params.text).toContain("Write a few words");
    await feed(app, dm(1, "Exactly what I needed, thank you"));
    const thanks = calls.filter((c) => c.method === "sendMessage" && c.params.chat_id === helper).at(-1)!;
    expect(thanks.params.text).toContain("Exactly what I needed, thank you");
    expect(shown(calls, 1)).toContain("Thanks sent.");
    // Pressing an outcome twice is harmless.
    await feed(app, press(1, `t:${id}:o:solved`));
    expect((await q<{ outcome: string }>("SELECT outcome FROM threads WHERE id=?", id))!.outcome).toBe("advice");
  });

  it("in a group, the answer is the asker's card and the group sees one line", async () => {
    const { app, calls } = await memoryWorld();
    await feed(app, groupCmd(1, "/ask where is the venue?"));
    const line = calls.filter((c) => c.method === "sendMessage" && c.params.chat_id === -1001234).at(-1)!;
    expect(line.params.text).toContain("sent them to you privately");
    expect(shown(calls, 1)).toContain("Hall B");
  });

  it("if the asker never opened the bot, the group gets the answer itself", async () => {
    const t = await memoryWorld();
    const blocked: Fetcher = async (url, init) => {
      const body = JSON.parse(String(init.body ?? "{}"));
      if (url.endsWith("/sendMessage") && body.chat_id === 1) return Response.json({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" });
      return t.fetcher(url, init);
    };
    const app = makeApp(env, blocked);
    await feed(app, groupCmd(1, "/ask where is the venue?"));
    expect(t.texts(-1001234).at(-1)).toContain("Hall B");
  });

  it("/start q<id> shows the card again, privately, for its owner only", async () => {
    const { app, calls } = await memoryWorld();
    await feed(app, dm(1, "where is the venue?"));
    const id = await threadOf(1);
    await feed(app, dm(1, `/start q${id}`));
    expect(calls.filter((c) => c.method === "sendMessage" && c.params.chat_id === 1).at(-1)!.params.text).toContain("Found in the community");
    await feed(app, dm(2, `/start q${id}`)); // someone else's card isn't theirs to see
    expect(calls.filter((c) => c.params.chat_id === 2 && c.method === "sendMessage")).toHaveLength(0);
  });

  it("with /name on, the author's first name shows; /name off hides it again", async () => {
    const { app, calls } = await memoryWorld();
    const named = (user: number, text: string) => ({
      message: { message_id: 900 + user, date: 1, chat: { id: user, type: "private" }, from: { id: user, is_bot: false, first_name: "Anna" }, text, entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }] },
    });
    await feed(app, named(2, "/name on"));
    await feed(app, dm(1, "where is the venue?"));
    expect(shown(calls, 1)).toContain("Anna");
    await feed(app, named(2, "/name off"));
    await feed(app, dm(1, "where is the venue?"));
    expect(shown(calls, 1)).not.toContain("Anna");
  });
});

describe("group settings card", () => {
  it("admins edit the card in place; others get a refusal", async () => {
    const { app, calls } = testApp();
    await enableGroup(app);
    await feed(app, groupCmd(OWNER, "/settings"));
    expect(calls.filter((c) => c.method === "sendMessage" && c.params.chat_id === -1001234).at(-1)!.params.reply_markup.inline_keyboard).toHaveLength(3);
    const tap = (user: number, data: string) => ({
      callback_query: { id: String(Math.random()), from: { id: user, is_bot: false }, data, message: { message_id: 7, chat: { id: -1001234, type: "supergroup" } } },
    });
    await feed(app, tap(5, "st:hints:1")); // not an admin
    expect(calls.some((c) => c.method === "editMessageText")).toBe(false);
    await feed(app, tap(OWNER, "st:hints:1"));
    expect((await q<{ hints: number }>("SELECT hints FROM sources"))!.hints).toBe(1);
    const edited = calls.filter((c) => c.method === "editMessageText").at(-1)!;
    expect(JSON.stringify(edited.params.reply_markup)).toContain("Answer repeated questions");
    expect(JSON.stringify(edited.params.reply_markup)).toContain("st:hints:0");
  });
});

describe("pilot metrics and the wow card", () => {
  it("/pilot counts requests, memory answers and outcomes for the operator only", async () => {
    const { app, calls } = await memoryWorld();
    await feed(app, dm(1, "where is the venue?"));
    await feed(app, press(1, `t:${await threadOf(1)}:ok`));
    await feed(app, dm(5, "/pilot"));
    expect(calls.filter((c) => c.params.chat_id === 5 && String(c.params.text).includes("Pilot"))).toHaveLength(0);
    await feed(app, dm(OWNER, "/pilot"));
    const text = calls.filter((c) => c.method === "sendMessage" && c.params.chat_id === OWNER).at(-1)!.params.text as string;
    expect(text).toContain("Requests: <b>1</b>");
    expect(text).toContain("Answered from memory: <b>1</b>");
    expect(text).toContain("solved / advice / contact: <b>1 / 0 / 0</b>");
  });

  it("after an import: topics, who helps, and questions nobody answered, which open as the owner's cards", async () => {
    const { app, calls } = testApp();
    await enableGroup(app);
    await feed(app, groupMsg(2, "Does anyone know a good accountant for VAT?"));
    await feed(app, groupMsg(3, "Dana handles VAT, ask her"));
    await feed(app, groupMsg(2, "Where can I rent a projector?"));
    await env.DB.prepare("UPDATE passages SET intent='help_request', intent_conf=0.9 WHERE body LIKE 'Does%' OR body LIKE 'Where%'").run();
    await env.DB.prepare("UPDATE passages SET reply_to=(SELECT msg_id FROM passages WHERE body LIKE 'Does%') WHERE body LIKE 'Dana%'").run();
    const src = (await q<{ id: string }>("SELECT id FROM sources"))!.id;
    const card = await wowCard(env.DB, src, "en", "Loaded");
    expect(card.text).toContain("Who helps most");
    expect(card.text).toContain("I found 1 question(s) nobody answered");
    expect(card.buttons?.[0]?.[0]?.callback_data).toBe(`wow:${src}`);

    const view = await forgottenView(env.DB, src, "en");
    expect(view.text).toContain("projector");
    expect(view.text).not.toContain("VAT");
    const pid = Number(view.buttons[0]![0]!.callback_data.split(":")[1]);
    await feed(app, press(OWNER, `wq:${pid}`));
    const owner = await q<{ n: number }>("SELECT COUNT(*) AS n FROM threads t JOIN members m ON m.id=t.member_id WHERE m.tg_id=?", OWNER);
    expect(owner!.n).toBe(1);
    expect(shown(calls, OWNER)).toContain("projector");
  });
});
