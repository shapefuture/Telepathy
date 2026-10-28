// The jobs people bring to a club: the census and what it counts, «Кого здесь советуют», hiring
// (one question, then people open to projects), warm introductions (people who named their doors),
// deals that count only when both confirm, newcomers without contact, and the switches behind them.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ensureMember } from "../src/acl";
import { boardDaily } from "../src/concierge/board";
import { census, kindOf, newcomersOf, recommendationsFor } from "../src/concierge/jobs";
import { handleFetch, makeApp } from "../src/index";
import { T } from "../src/i18n";
import { forgetMember } from "../src/rights";
import { pulseCard, pulseStep } from "../src/pulse";
import { wowCard } from "../src/wow";
import { nowIso } from "../src/util";
import { dm, enableGroup, feed, fakeTelegram, GROUP, nextMsg, OWNER, press, shown, shownButtons, signInit } from "./helpers";

const DAY = 86_400;
const now = () => Math.floor(Date.now() / 1000);
const q = <T = any>(sql: string, ...b: unknown[]) => env.DB.prepare(sql).bind(...b).first<T>();
const idOf = async (tg: number) => (await ensureMember(env.DB, tg)).id;
const threadOf = async (tg: number) => (await q<{ id: string }>("SELECT t.id FROM threads t JOIN members m ON m.id=t.member_id WHERE m.tg_id=? ORDER BY t.created_at DESC", tg))!.id;
const srcId = async () => (await q<{ id: string }>("SELECT id FROM sources WHERE enabled=1"))!.id;

/** A group with the bot's app and a fake Telegram. Digest at 09:00 UTC, so the daily card can be tested. */
function world() {
  const t = fakeTelegram();
  const app = makeApp({ ...(env as any), AI: undefined, CONCIERGE_MODEL: "off", DIGEST_HOUR: "9", TIMEZONE: "UTC" }, t.fetcher);
  return { app, calls: t.calls };
}

/** A group message with its own id and time. Returns the id, so a reply can point at it. */
async function post(app: any, user: number, text: string, at: number, replyTo?: number): Promise<number> {
  const message_id = nextMsg();
  await feed(app, {
    message: {
      message_id,
      date: at,
      chat: { id: GROUP, type: "supergroup", title: "G" },
      from: { id: user, is_bot: false },
      text,
      ...(replyTo ? { reply_to_message: { message_id: replyTo } } : {}),
    },
  } as any);
  return message_id;
}

/** Discoverable, with the accounting skill, in the group (members who posted are in it). */
async function expertOf(tg: number, opts: { open?: boolean; doors?: string } = {}) {
  await q("UPDATE members SET discoverable=1, open_work=?, doors=? WHERE tg_id=?", opts.open ? 1 : 0, opts.doors ?? null, tg);
  await q("INSERT INTO skills(member_id, code, state) VALUES (?, 'accounting', 'confirmed')", await idOf(tg));
}

/** Asks (in the group) for an accountant, a recommendation, a reply, thanks and a bump: the census's numbers. */
async function seedAsks(app: any, base = now() - 3 * DAY) {
  const ask1 = await post(app, 21, "Посоветуйте хорошего бухгалтера?", base);
  await post(app, 22, "Советую бухгалтера Анну, обращайтесь", base + 1800, ask1);
  await post(app, 21, "спасибо!", base + 3600);
  await post(app, 23, "Ищу исполнителя для сайта", base + DAY);
  await post(app, 23, "ап", base + 2 * DAY);
  const ask3 = await post(app, 24, "Как работает НДС?", base + 2 * DAY);
  await post(app, 25, "По НДС: подается раз в квартал", base + 2 * DAY + 300, ask3);
  await post(app, 26, "Посоветуйте бухгалтера?", base + 3 * DAY);
  return base;
}

describe("the kinds of request", () => {
  it("labels a request from its own words, in Russian and English", () => {
    expect(kindOf("Посоветуйте хорошего бухгалтера?")).toBe("recommendation");
    expect(kindOf("Кого посоветуете по налогам для ИП?")).toBe("recommendation");
    expect(kindOf("Ищу исполнителя для сайта")).toBe("hiring");
    expect(kindOf("Нужен бухгалтер на аутсорс")).toBe("hiring");
    expect(kindOf("Looking for a designer for a logo")).toBe("hiring");
    expect(kindOf("Ищу проекты, я дизайнер")).toBe("looking_for_work");
    expect(kindOf("Нужен выход на директора по закупкам")).toBe("introduction");
    expect(kindOf("Can you introduce me to a VC partner?")).toBe("introduction");
    expect(kindOf("Ищу партнёра для запуска")).toBe("partner");
    expect(kindOf("Как работает НДС для фрилансеров?")).toBe("question");
    expect(kindOf("Does anyone know a good accountant?")).toBe("recommendation");
  });
});

describe("the census", () => {
  it("counts answered requests, how soon, thanks, bumps and repeats, by kind", async () => {
    const { app } = world();
    await enableGroup(app);
    const base = await seedAsks(app);
    await post(app, 27, "Посоветуйте бухгалтера?", base + 4 * DAY); // asked again on the same topic
    const c = await census(env.DB, [await srcId()], nowIso(new Date((base - DAY) * 1000)));
    const row = (k: string) => c.rows.find((r) => r.kind === k)!;
    expect(c.total).toBe(5);
    expect(row("recommendation")).toMatchObject({ n: 3, answered: 1, medianMinutes: 30, thanked: 1, repeated: 2 });
    expect(row("hiring")).toMatchObject({ n: 1, answered: 0, bumped: 1 });
    expect(row("question")).toMatchObject({ n: 1, answered: 1, medianMinutes: 5 });
  });

  it("/jobs shows the census to the operator, with the share of requests about people", async () => {
    const { app, calls } = world();
    await enableGroup(app);
    await seedAsks(app);
    await feed(app, dm(OWNER, "/jobs"));
    expect(shown(calls, OWNER)).toContain("in the last 180 days: 4 requests");
    expect(shown(calls, OWNER)).toContain("about people (advice, hiring, introductions, partners): 75%");
  });

  it("the weekly card says what closed, by kind; the import card says what is asked most", async () => {
    const { app } = world();
    await enableGroup(app);
    const base = await seedAsks(app);
    const since = nowIso(new Date((base - DAY) * 1000));
    const card = await pulseCard(env.DB, await srcId(), "G", since, "en");
    expect(card.text).toContain("answered Recommendations 1 · Questions 1");
    expect(card.text).toContain("work agreed 0");
    const wow = await wowCard(env.DB, await srcId(), "en", "Imported 12 messages");
    expect(wow.text).toContain("Asked most here (last six months): Recommendations 2");
  });
});

describe("who recommends it", () => {
  it("the card quotes recommendations from groups the asker can read, and only those", async () => {
    const { app, calls } = world();
    await enableGroup(app);
    await seedAsks(app);
    // A club the asker isn't in: its recommendation must never reach their card.
    await q("INSERT INTO sources(id, chat_id, title, username, visibility, enabled, enabled_by, enabled_at) VALUES ('other-club', -1001111111111, 'Other', NULL, 'MEMBER_CONSENTED', 1, ?, ?)", await idOf(OWNER), nowIso());
    await q("INSERT INTO passages(source_id, msg_id, part, author_id, body, event_at, reply_to) VALUES ('other-club', 5001, 0, ?, 'Советую бухгалтера Павла, обращайтесь', ?, 4999)", await idOf(22), nowIso());
    await feed(app, dm(21, "Посоветуйте хорошего бухгалтера?"));
    const card = shown(calls, 21);
    expect(card).toContain("Who here recommends it");
    expect(card).toContain("Советую бухгалтера Анну");
    expect(card).not.toContain("Павла");
    expect(await recommendationsFor(env.DB, new Set(["other-club"]), await idOf(21), "Посоветуйте хорошего бухгалтера?")).toHaveLength(1);
  });
});

describe("hiring", () => {
  it("asks one question first, then invites only people open to projects", async () => {
    const { app, calls } = world();
    await enableGroup(app);
    for (const tg of [41, 42, 43]) await post(app, tg, `hello from ${tg}`, now() - DAY);
    await expertOf(42, { open: true });
    await expertOf(43, { open: false });
    await feed(app, dm(41, "Ищу бухгалтера для ИП"));
    const id = await threadOf(41);
    await feed(app, press(41, `t:${id}:ask`));
    expect(shown(calls, 41)).toContain("One message will do");
    expect(await q("SELECT COUNT(*) AS n FROM intros")).toEqual({ n: 0 });
    await feed(app, dm(41, "Бюджет 50 тысяч, сдать к маю"));
    expect((await q<{ clarify: string }>("SELECT clarify FROM threads WHERE id=?", id))!.clarify).toBe("Бюджет 50 тысяч, сдать к маю");
    const invited = await env.DB.prepare("SELECT candidate_id FROM intros").all<{ candidate_id: string }>();
    expect(invited.results.map((r) => r.candidate_id)).toEqual([await idOf(42)]);
    expect(calls.filter((c) => c.method === "sendMessage" && c.params.chat_id === 42).at(-1)!.params.text).toContain("Introduction request");
  });

  it("'skip' asks people with the request as it is", async () => {
    const { app, calls } = world();
    await enableGroup(app);
    await post(app, 44, "hello", now() - DAY);
    await post(app, 42, "hello from 42", now() - DAY);
    await expertOf(42, { open: true });
    await feed(app, dm(44, "Ищу бухгалтера для ИП"));
    const id = await threadOf(44);
    await feed(app, press(44, `t:${id}:ask`));
    const skip = shownButtons(calls, 44).flat().find((b) => b.callback_data.endsWith(":clr0"));
    expect(skip).toBeDefined();
    await feed(app, press(44, skip!.callback_data));
    expect(await q("SELECT COUNT(*) AS n FROM intros WHERE requester_id=?", await idOf(44))).toEqual({ n: 1 });
  });
});

describe("open to projects", () => {
  it("/open needs /optin first, can be switched on and off, and is offered from a looking-for-work card", async () => {
    const { app, calls } = world();
    await enableGroup(app);
    await post(app, 51, "hello", now() - DAY);
    await feed(app, dm(51, "/open on"));
    expect(shown(calls, 51)).toContain("First /optin");
    await feed(app, dm(51, "/optin"));
    await feed(app, dm(51, "/open on"));
    expect(shown(calls, 51)).toContain("From now on I can offer you hiring requests");
    expect(await q("SELECT open_work FROM members WHERE tg_id=51")).toEqual({ open_work: 1 });
    await feed(app, dm(51, "/open"));
    expect(shown(calls, 51)).toContain("Open to projects: on");
    await feed(app, dm(51, "/open off"));
    expect(await q("SELECT open_work FROM members WHERE tg_id=51")).toEqual({ open_work: 0 });

    await feed(app, dm(51, "Ищу проекты, я дизайнер"));
    const id = await threadOf(51);
    const toggle = shownButtons(calls, 51).flat().find((b) => b.callback_data === `t:${id}:open`);
    expect(toggle).toBeDefined();
    await feed(app, press(51, `t:${id}:open`));
    expect(await q("SELECT open_work FROM members WHERE tg_id=51")).toEqual({ open_work: 1 });
  });
});

describe("warm introductions", () => {
  it("an introduction request goes to people who named the doors they can open, in groups that turned it on", async () => {
    const { app, calls } = world();
    await enableGroup(app);
    for (const tg of [51, 52, 53]) await post(app, tg, `hello from ${tg}`, now() - DAY);
    await q("UPDATE sources SET doors=1");
    await expertOf(52, { doors: "Знаком с директорами Яндекса и Сбера" });
    await expertOf(53, { doors: "Знаю бухгалтеров" });
    await feed(app, dm(51, "Нужен выход на директора Яндекса"));
    await feed(app, press(51, `t:${await threadOf(51)}:ask`));
    const invited = await env.DB.prepare("SELECT candidate_id FROM intros").all<{ candidate_id: string }>();
    expect(invited.results.map((r) => r.candidate_id)).toEqual([await idOf(52)]);
    expect(calls.filter((c) => c.method === "sendMessage" && c.params.chat_id === 52).at(-1)!.params.text).toContain("asks to be introduced");
  });

  it("with the group's switch off, nobody is invited", async () => {
    const { app } = world();
    await enableGroup(app);
    for (const tg of [51, 52]) await post(app, tg, `hello from ${tg}`, now() - DAY);
    await expertOf(52, { doors: "Знаком с директорами Яндекса" });
    await feed(app, dm(51, "Нужен выход на директора Яндекса"));
    await feed(app, press(51, `t:${await threadOf(51)}:ask`));
    expect(await q("SELECT COUNT(*) AS n FROM intros")).toEqual({ n: 0 });
  });

  it("/introduce saves the doors of someone with /optin, and /introduce off clears them", async () => {
    const { app, calls } = world();
    await enableGroup(app);
    await post(app, 53, "hello", now() - DAY);
    await feed(app, dm(53, "/introduce Знаю бухгалтеров"));
    expect(shown(calls, 53)).toContain("First /optin");
    await feed(app, dm(53, "/optin"));
    await feed(app, dm(53, "/introduce Знаю бухгалтеров"));
    expect(await q("SELECT doors FROM members WHERE tg_id=53")).toEqual({ doors: "Знаю бухгалтеров" });
    await feed(app, dm(53, "/introduce off"));
    expect(await q("SELECT doors FROM members WHERE tg_id=53")).toEqual({ doors: null });
  });
});

/** An accountant asked for, invited, accepted and confirmed: the connected stage of a hiring request. */
async function connectedHiring(app: any) {
  for (const tg of [41, 42]) await post(app, tg, `hello from ${tg}`, now() - DAY);
  await expertOf(42, { open: true });
  await feed(app, dm(41, "Ищу бухгалтера для ИП"));
  const id = await threadOf(41);
  await feed(app, press(41, `t:${id}:ask`));
  await feed(app, dm(41, "Бюджет 50 тысяч"));
  const introId = (await q<{ id: string }>("SELECT id FROM intros LIMIT 1"))!.id;
  await feed(app, press(42, `i:${introId}:accept`));
  await feed(app, press(41, `i:${introId}:confirm`));
  return { id, introId };
}

describe("deals", () => {
  it("'We agreed on the work' counts only when the person introduced confirms it", async () => {
    const { app, calls } = world();
    await enableGroup(app);
    const { id, introId } = await connectedHiring(app);
    expect(shownButtons(calls, 41).flat().map((b) => b.callback_data)).toContain(`t:${id}:deal`);
    await feed(app, press(41, `t:${id}:deal`));
    const ask = calls.filter((c) => c.method === "sendMessage" && c.params.chat_id === 42).at(-1)!;
    expect(ask.params.text).toContain("Do you confirm?");
    expect(ask.params.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data)).toEqual([`dl:${introId}:y`, `dl:${introId}:n`]);

    await feed(app, press(41, `dl:${introId}:y`)); // the asker can't confirm their own deal
    expect((await q<{ outcome: string | null }>("SELECT outcome FROM threads WHERE id=?", id))!.outcome).toBeNull();

    await feed(app, press(42, `dl:${introId}:y`));
    expect(await q("SELECT outcome, helper_id IS NOT NULL AS helped FROM threads WHERE id=?", id)).toEqual({ outcome: "solved", helped: 1 });
    expect(await q("SELECT status FROM deals WHERE intro_id=?", introId)).toEqual({ status: "agreed" });
    expect(shown(calls, 41)).toContain("We agreed on the work");
  });

  it("'not yet' leaves the thread open, and the asker can ask again", async () => {
    const { app, calls } = world();
    await enableGroup(app);
    const { id, introId } = await connectedHiring(app);
    await feed(app, press(41, `t:${id}:deal`));
    await feed(app, press(42, `dl:${introId}:n`));
    expect(await q("SELECT outcome FROM threads WHERE id=?", id)).toEqual({ outcome: null });
    expect(shown(calls, 41)).toContain("They haven't confirmed yet");
    expect(shownButtons(calls, 41).flat().map((b) => b.callback_data)).toContain(`t:${id}:deal`);
  });
});

describe("newcomers without contact", () => {
  it("the daily board offers one item per group: run a round, or introduce them", async () => {
    const { app, calls } = world();
    await enableGroup(app);
    const base = now() - 2 * DAY;
    const newcomers = [61, 62, 63];
    for (const tg of newcomers) await post(app, tg, "hello, I just joined", base);
    const ask = await post(app, 64, "Кто знает про налоги?", base); // 64 got an answer: has contact
    await post(app, 65, "Знаю про налоги, пишите", base + 60, ask);
    const src = await srcId();
    // 64 got an answer, so has contact; 65 only replied, so is still a newcomer without contact.
    expect(new Set(await newcomersOf(env.DB, src, new Date("2026-11-02T09:00:00Z")))).toEqual(new Set([await idOf(61), await idOf(62), await idOf(63), await idOf(65)]));
    expect(await boardDaily(app, new Date("2026-11-02T09:00:00Z"))).toBe(1);

    await feed(app, dm(OWNER, "/board"));
    expect(JSON.stringify(shownButtons(calls, OWNER))).toContain(`bd:v:n:0`);
    await feed(app, press(OWNER, "bd:v:n:0"));
    expect(shown(calls, OWNER)).toContain("newcomers in «G» have had no useful contact in 30 days.");
    await feed(app, press(OWNER, `bd:n:i:${src}`));
    for (const tg of newcomers) expect(calls.some((c) => c.method === "sendMessage" && c.params.chat_id === tg)).toBe(true);
    expect(calls.some((c) => c.method === "answerCallbackQuery" && String(c.params.text).includes("Sent to "))).toBe(true);

    await feed(app, press(OWNER, `bd:n:r:${src}`));
    expect(calls.some((c) => c.method === "answerCallbackQuery" && String(c.params.text).includes("Already done this week"))).toBe(true);
  });

  it("'run a round' pairs the opted-in people of that group who asked about a topic", async () => {
    const { app, calls } = world();
    await enableGroup(app);
    await post(app, 71, "Посоветуйте бухгалтера?", now() - DAY);
    await post(app, 72, "hello", now() - DAY);
    await expertOf(72);
    await q("UPDATE members SET rounds=1, discoverable=1 WHERE tg_id IN (71, 72)");
    await feed(app, dm(OWNER, "/board"));
    await feed(app, press(OWNER, `bd:n:r:${await srcId()}`));
    expect(calls.some((c) => c.method === "answerCallbackQuery" && String(c.params.text).includes("running for 2 people"))).toBe(true);
    expect(await q("SELECT candidate_id FROM intro_rounds WHERE member_id=?", await idOf(71))).toEqual({ candidate_id: await idOf(72) });
  });
});

describe("forgetting", () => {
  it("clears what someone offered to do and the doors they named", async () => {
    const { app } = world();
    await enableGroup(app);
    await post(app, 81, "hello", now() - DAY);
    await expertOf(81, { open: true, doors: "Знаю директоров" });
    await forgetMember(env.DB, await idOf(81), 81);
    expect(await q("SELECT open_work, doors FROM members WHERE tg_id=81")).toEqual({ open_work: 0, doors: null });
  });
});

describe("partners and investors", () => {
  it("a request for a partner or an investor reaches people who named their doors, like an introduction", async () => {
    const { app } = world();
    await enableGroup(app);
    for (const tg of [91, 92]) await post(app, tg, `hello from ${tg}`, now() - DAY);
    await q("UPDATE sources SET doors=1");
    await expertOf(92, { doors: "Знаю инвесторов из fintech" });
    await feed(app, dm(91, "Ищу инвестора в fintech"));
    await feed(app, press(91, `t:${await threadOf(91)}:ask`));
    const invited = await env.DB.prepare("SELECT candidate_id FROM intros").all<{ candidate_id: string }>();
    expect(invited.results.map((r) => r.candidate_id)).toEqual([await idOf(92)]);
  });
});

describe("the profile's introduction switch", () => {
  it("asks for the doors line, saves it, and stop clears it; without /optin it refuses", async () => {
    const { app, calls } = world();
    await enableGroup(app);
    await post(app, 93, "hello", now() - DAY);
    await feed(app, dm(93, "/profile"));
    expect(shownButtons(calls, 93).flat().map((b) => b.callback_data)).toContain("dr:ask");
    await feed(app, press(93, "dr:ask"));
    expect(calls.some((c) => c.method === "answerCallbackQuery" && String(c.params.text).includes("First /optin"))).toBe(true);
    await feed(app, dm(93, "/optin"));
    await feed(app, press(93, "dr:ask"));
    expect(shown(calls, 93)).toContain("Write one line");
    await feed(app, dm(93, "Знаю директоров в банках"));
    expect(await q("SELECT doors FROM members WHERE tg_id=93")).toEqual({ doors: "Знаю директоров в банках" });
    await feed(app, dm(93, "/profile"));
    expect(shownButtons(calls, 93).flat().map((b) => b.callback_data)).toContain("dr:off");
    await feed(app, press(93, "dr:off"));
    expect(await q("SELECT doors FROM members WHERE tg_id=93")).toEqual({ doors: null });
  });
});

describe("the board's line of what closed", () => {
  it("the board shows last week's closed numbers, stored by the Monday pulse", async () => {
    const { app, calls } = world();
    await enableGroup(app);
    const base = Date.parse("2026-10-20T09:00:00Z") / 1000; // a Tuesday in the week before the Monday below
    const ask = await post(app, 21, "Посоветуйте бухгалтера?", base);
    await post(app, 22, "Советую бухгалтера Анну, обращайтесь", base + 1800, ask);
    expect(await pulseStep(env.DB, new Date("2026-10-26T10:00:00Z"), "UTC", 9)).toHaveLength(1);
    await feed(app, dm(OWNER, "/board"));
    expect(shown(calls, OWNER)).toContain("Week of 2026-10-26: answered Recommendations 1");
  });
});

describe("the help and the privacy notice name the switches", () => {
  it("in both languages; the notice says what /forget_me clears", () => {
    for (const lang of ["en", "ru"] as const) {
      for (const cmd of ["/open", "/introduce", "/jobs"]) expect(T(lang).help).toContain(cmd);
      expect(T(lang).privacy).toContain("/open");
      expect(T(lang).privacy).toContain("/introduce");
    }
    expect(T("en").privacy).toContain("/forget_me deletes your messages, your profile, your /open and /introduce settings");
    expect(T("ru").privacy).toContain("/forget_me удаляет ваши сообщения, профиль и настройки /open и /introduce");
  });
});

describe("the Mini App: the two switches and the census", () => {
  /** One call to the Mini App's API, signed the way Telegram's web app signs it. */
  async function mini(tg: number, method: string, path: string, body?: unknown) {
    const data = await signInit({ auth_date: String(now()), user: JSON.stringify({ id: tg }) });
    const res = await handleFetch(
      new Request(`https://bot.example/app/api/${path}`, {
        method,
        headers: { "content-type": "application/json", "x-telegram-init-data": data },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env,
    );
    return { status: res.status, body: (await res.json()) as any };
  }

  it("needs /optin before either switch; the line is cleaned; off clears it", async () => {
    const { app } = world();
    await enableGroup(app);
    await post(app, 31, "hello", now());
    expect((await mini(31, "GET", "profile")).body).toMatchObject({ openWork: false, doors: null });
    expect((await mini(31, "POST", "open", { on: true })).body).toEqual({ ok: false, status: "needs_optin" });
    expect((await mini(31, "POST", "doors", { text: "accountants in Kazan" })).body).toEqual({ ok: false, status: "needs_optin" });
    await mini(31, "POST", "settings", { discoverable: true });
    expect((await mini(31, "POST", "open", { on: true })).body).toEqual({ ok: true, openWork: true });
    expect((await mini(31, "POST", "doors", { text: " accountants <in> Kazan " })).body).toEqual({ ok: true, doors: "accountants in Kazan" });
    expect((await mini(31, "GET", "profile")).body).toMatchObject({ openWork: true, doors: "accountants in Kazan" });
    expect((await mini(31, "POST", "doors", { text: "   " })).body).toEqual({ ok: false, status: "empty" });
    expect((await mini(31, "POST", "doors", { off: true })).body).toEqual({ ok: true, doors: null });
    expect((await mini(31, "POST", "open", { on: false })).body).toEqual({ ok: true, openWork: false });
    expect((await mini(31, "POST", "open", { on: "yes" })).status).toBe(400);
  });

  it("the census in the app is the one /jobs sends; members are refused", async () => {
    const { app, calls } = world();
    await enableGroup(app);
    await seedAsks(app);
    expect((await mini(21, "GET", "jobs")).status).toBe(403);
    await feed(app, dm(OWNER, "/jobs"));
    const census = await mini(OWNER, "GET", "jobs");
    expect(census.status).toBe(200);
    expect(census.body.text).toContain("4 requests");
    expect(census.body.text).toBe(shown(calls, OWNER));
  });
});
