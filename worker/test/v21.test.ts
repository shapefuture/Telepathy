import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ensureMember } from "../src/acl";
import { langFromCode, MESSAGES, setDefaultLang } from "../src/i18n";
import { answer } from "../src/search";
import { fakeTelegram, GROUP, OWNER, dm, enableGroup, feed, groupCmd, groupMsg, press, shown, shownButtons, testApp } from "./helpers";

const OTHER = -1009;
const inOther = <T extends { message: any }>(u: T): T => ({ ...u, message: { ...u.message, chat: { id: OTHER, type: "supergroup", title: "Other" } } });
const lastFor = (sent: { params: any }[]) => sent.at(-1)!.params;

describe("P13-04 Russian / English interface", () => {
  it("every message exists in both languages and Russian is actually translated", () => {
    const en = Object.keys(MESSAGES.en).sort();
    expect(Object.keys(MESSAGES.ru).sort()).toEqual(en);
    const same = en.filter((k) => typeof (MESSAGES.en as any)[k] === "string" && (MESSAGES.en as any)[k] === (MESSAGES.ru as any)[k]);
    expect(same).toEqual([]); // no untranslated copies
  });

  it("uses the deployment's default language (not Telegram's) and honours /language", async () => {
    setDefaultLang("ru");
    expect([langFromCode("ru"), langFromCode("en-US"), langFromCode(undefined)]).toEqual(["ru", "ru", "ru"]);
    const { app, texts } = testApp({}, "ru");
    await enableGroup(app);
    await feed(app, groupMsg(5, "hello"));
    await feed(app, dm(5, "/help", "en")); // an English Telegram app still gets the Russian default
    expect(texts(5).at(-1)).toContain("<b>Как пользоваться</b>");
    await feed(app, dm(5, "/language en", "ru"));
    expect(texts(5).at(-1)).toBe("Language set to English.");
    await feed(app, dm(5, "/help", "ru")); // explicit choice wins over the Telegram setting
    expect(texts(5).at(-1)).toContain("<b>How to use me</b>");
    await feed(app, press(5, "p:lang:ru"));
    expect((await env.DB.prepare("SELECT lang, lang_explicit FROM members WHERE tg_id=5").first())).toEqual({ lang: "ru", lang_explicit: 1 });
  });

  it("introduction invites go out in the expert's own language", async () => {
    const { app, sent } = testApp();
    await enableGroup(app);
    await feed(app, groupMsg(5, "hi"));
    await feed(app, groupMsg(6, "hey"));
    await feed(app, dm(6, "/language ru"));
    await feed(app, dm(6, "/optin", "ru"));
    await feed(app, dm(6, "/skills add accounting", "ru"));
    await feed(app, dm(5, "/intro need an accountant for my startup", "en"));
    expect(lastFor(sent(6)).text).toContain("Просьба о помощи");
    expect(lastFor(sent(6)).text).toContain("Бухгалтерия");
    expect(lastFor(sent(5)).text).toContain("Request sent");
  });
});

describe("P13-01 answers inside groups", () => {
  it("answers from this group only, never from other groups (C02)", async () => {
    const { app, sent, calls } = testApp();
    await enableGroup(app);
    await feed(app, inOther(groupCmd(OWNER, "/enable")));
    await feed(app, groupMsg(5, "The venue for the meetup is Hall B"));
    await feed(app, inOther(groupMsg(5, "Secret venue for the board meeting is room 7")));
    await feed(app, groupCmd(5, "/ask where is the venue?"));
    // The group sees one line; the answer itself is the asker's card, in private.
    const out = lastFor(sent(GROUP));
    expect(out.text).toContain("sent them to you privately");
    expect(out.reply_parameters.message_id).toBeGreaterThan(0);
    const card = shown(calls, 5);
    expect(card).toContain("Hall B");
    expect(card).not.toContain("room 7");
    // The same member in a DM sees both groups they can read.
    const a = await answer(env.DB, new Set((await env.DB.prepare("SELECT id FROM sources").all<{ id: string }>()).results.map((r) => r.id)), "venue");
    expect(a.quotes.length).toBe(2);
  });

  it("does nothing in groups that aren't enabled", async () => {
    const { app, calls } = testApp();
    await feed(app, groupCmd(5, "/ask anything?"));
    expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(0);
  });

  it("answers an @mention when BOT_USERNAME is set, without matching the question itself", async () => {
    const { fakeTelegram } = await import("./helpers");
    const { makeApp } = await import("../src/index");
    const t = fakeTelegram();
    const app = makeApp({ ...env, BOT_USERNAME: "telepathy_bot" } as any, t.fetcher);
    await enableGroup(app);
    await feed(app, groupMsg(5, "Parking is behind the library"));
    const q = "@telepathy_bot where is parking";
    await feed(app, groupMsg(6, q, { entities: [{ type: "mention", offset: 0, length: 14 }] }));
    const card = shown(t.calls, 6); // the asker's card, edited in place
    expect(card).toContain("behind the library");
    expect(card).not.toContain("@telepathy_bot");
  });
});

describe("P13-05 answer feedback", () => {
  // The answer is a living card in the asker's private chat: 👍 is "Это то, что нужно", 👎 is "Не то".
  async function askAndGetButtons() {
    const { app, calls } = testApp();
    await enableGroup(app);
    await feed(app, groupMsg(1, "Our accountant is Dana, she handles VAT."));
    await feed(app, groupMsg(1, "The accountant meetup is on Monday."));
    await feed(app, dm(1, "/ask accountant"));
    return { app, calls, buttons: shownButtons(calls, 1) };
  }

  it("records private votes once, lets you change your mind, and counts wrong sources per quote", async () => {
    const { app, buttons } = await askAndGetButtons();
    const thatsIt = buttons[0]![0]!.callback_data;
    const notThat = buttons[1]![0]!.callback_data;
    await feed(app, press(1, thatsIt));
    await feed(app, press(1, thatsIt)); // duplicate click
    let totals = await env.DB.prepare("SELECT SUM(up) AS u, SUM(down) AS d, SUM(bad) AS b FROM passage_votes").first();
    expect(totals).toEqual({ u: 2, d: 0, b: 0 }); // 2 passages quoted, one vote each
    await feed(app, press(1, notThat)); // changing your mind replaces the earlier vote
    totals = await env.DB.prepare("SELECT SUM(up) AS u, SUM(down) AS d, SUM(bad) AS b FROM passage_votes").first();
    expect(totals).toEqual({ u: 0, d: 2, b: 0 });
    // Wrong sources are reported per quote on the answer (f:<answer>:bad<i>), not on the card.
    const answerId = (await env.DB.prepare("SELECT id FROM answers ORDER BY created_at DESC LIMIT 1").first<{ id: string }>())!.id;
    await feed(app, press(1, `f:${answerId}:bad0`));
    await feed(app, press(1, `f:${answerId}:bad0`));
    expect((await env.DB.prepare("SELECT SUM(bad) AS b FROM passage_votes").first<{ b: number }>())!.b).toBe(1);
  });

  it("votes nudge ranking but never make an irrelevant passage relevant", async () => {
    const { app, buttons } = await askAndGetButtons();
    const before = await answer(env.DB, new Set([(await env.DB.prepare("SELECT id FROM sources").first<{ id: string }>())!.id]), "accountant");
    const second = before.quotes[1]!.id;
    // Three different members mark the second quote helpful via fresh answers about it.
    for (const tg of [2, 3, 4]) {
      await feed(app, groupMsg(tg, "hi"));
      await env.DB.prepare("INSERT INTO passage_votes(passage_id, up) VALUES (?, 1) ON CONFLICT(passage_id) DO UPDATE SET up = up + 1").bind(second).run();
    }
    const after = await answer(env.DB, new Set([(await env.DB.prepare("SELECT id FROM sources").first<{ id: string }>())!.id]), "accountant");
    expect(after.quotes[0]!.id).toBe(second);
    const none = await answer(env.DB, new Set([(await env.DB.prepare("SELECT id FROM sources").first<{ id: string }>())!.id]), "kubernetes ingress");
    expect(none.status).toBe("insufficient");
    expect(buttons[1]).toHaveLength(1); // the card's "Не то"
  });

  it("forget_me deletes the member's answers, votes and living cards", async () => {
    const { app, calls, buttons } = await askAndGetButtons();
    await feed(app, press(1, buttons[0]![0]!.callback_data));
    await feed(app, dm(1, "/forget_me"));
    await feed(app, press(1, "fm:yes"));
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM answer_votes").first<{ n: number }>())!.n).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM answers").first<{ n: number }>())!.n).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM threads").first<{ n: number }>())!.n).toBe(0);
    expect(calls.some((c) => c.method === "deleteMessage" && c.params.chat_id === 1)).toBe(true);
  });
});

describe("P13-02 already-answered hints", () => {
  async function groupWithAnsweredQuestion() {
    const { app, sent } = testApp();
    await enableGroup(app);
    const q = groupMsg(1, "Can anyone recommend a good accountant for a startup?");
    await feed(app, q);
    await feed(app, groupMsg(2, "Try Dana, she is great", { reply_to_message: { message_id: q.message.message_id } }));
    return { app, sent, q };
  }
  const hints = (sent: { params: any }[]) => sent.filter((c) => String(c.params.text).includes("💡"));

  it("is off until an owner turns it on", async () => {
    const { app, sent } = await groupWithAnsweredQuestion();
    await feed(app, groupMsg(3, "Can anyone recommend an accountant for my startup?"));
    expect(hints(sent(GROUP))).toHaveLength(0);
    await feed(app, groupCmd(5, "/hints on")); // non-owner: ignored
    expect((await env.DB.prepare("SELECT hints FROM sources").first<{ hints: number }>())!.hints).toBe(0);
  });

  it("links the earlier answered thread once, with a group cooldown", async () => {
    const { app, sent, q } = await groupWithAnsweredQuestion();
    await feed(app, groupCmd(OWNER, "/hints on"));
    const ask = groupMsg(3, "Can anyone recommend an accountant for my startup?");
    await feed(app, ask);
    const h = hints(sent(GROUP));
    expect(h).toHaveLength(1);
    expect(h[0]!.params.text).toContain(`/${q.message.message_id}`);
    expect(h[0]!.params.reply_parameters.message_id).toBe(ask.message.message_id);
    await feed(app, groupMsg(4, "Can anyone recommend an accountant for a small startup?")); // within cooldown
    expect(hints(sent(GROUP))).toHaveLength(1);
  });

  it("never hints from another group, or from questions nobody answered", async () => {
    const { app, sent } = testApp();
    await enableGroup(app);
    await feed(app, inOther(groupCmd(OWNER, "/enable")));
    const other = inOther(groupMsg(1, "Can anyone recommend a good accountant for a startup?"));
    await feed(app, other);
    await feed(app, inOther(groupMsg(2, "Try Dana", { reply_to_message: { message_id: other.message.message_id } })));
    await feed(app, groupMsg(1, "Can anyone recommend a dentist near the office?")); // unanswered here
    await feed(app, groupCmd(OWNER, "/hints on"));
    await feed(app, groupMsg(3, "Can anyone recommend an accountant for my startup?"));
    await feed(app, groupMsg(4, "Can anyone recommend a dentist near the office please?"));
    expect(hints(sent(GROUP))).toHaveLength(0);
    expect(hints(sent(OTHER))).toHaveLength(0);
  });
});

it("member rows from group posts get the default language, whatever Telegram's is", async () => {
  const { app } = testApp({}, "ru");
  await enableGroup(app);
  await feed(app, groupMsg(9, "hello", { from: { id: 9, is_bot: false, language_code: "en" } }));
  expect((await ensureMember(env.DB, 9)).lang).toBe("ru");
});

it("command guides go only to the person: /start in private, /enable's admin guide by DM", async () => {
  const { app, texts } = testApp();
  await enableGroup(app);
  expect(texts(OWNER).some((t) => t.includes("Only you see this") && t.includes("/retention"))).toBe(true);
  expect(texts(GROUP).some((t) => t.includes("Only you see this"))).toBe(false);
  await feed(app, dm(7, "/start"));
  expect(texts(7).at(-1)).toContain("In a group");
  expect(texts(7).at(-1)).not.toContain("Owner");
  await feed(app, dm(OWNER, "/start"));
  expect(texts(OWNER).at(-1)).toContain("/enable");
});
