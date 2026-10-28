// The conversation: what the bot says and what a press leads to. Commands that need their text ask
// for it; a request that finds nobody waits and is picked up again when a helper appears; the card
// offers the club's team when nobody can be asked; the profile is one card with a sheet; the menu is
// five things; and the wording is one voice (you, gender-neutral, correct plurals).
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { COMMANDS, COMMANDS_RU } from "../src/index";
import { ruPlural, T } from "../src/i18n";
import { quoteHtml, snippet } from "../src/text";
import { dm, enableGroup, feed, groupMsg, press, shown, shownButtons, testApp } from "./helpers";

const q = <R = any>(sql: string, ...b: unknown[]) => env.DB.prepare(sql).bind(...b).first<R>();
const all = async <R = any>(sql: string, ...b: unknown[]) => (await env.DB.prepare(sql).bind(...b).all<R>()).results;
const datas = (calls: { method: string; params: Record<string, any> }[], chat: number) =>
  shownButtons(calls, chat).flat().map((b) => b.callback_data);

/** A club with two people: one who asks (tg 1) and one who helps with accounting (tg 11). */
async function club(app: Awaited<ReturnType<typeof testApp>>["app"], helper: boolean) {
  await enableGroup(app);
  await feed(app, groupMsg(1, "hello"));
  await feed(app, groupMsg(11, "hi"));
  if (helper) {
    await env.DB.prepare("UPDATE members SET discoverable=1 WHERE tg_id=11").run();
    await env.DB.prepare("INSERT INTO skills(member_id, code, state) SELECT id, 'accounting', 'confirmed' FROM members WHERE tg_id=11").run();
  }
}

describe("a request that asks for its text", () => {
  it("/intro with no text asks for it; the next message is the request", async () => {
    const { app, calls, texts } = testApp(undefined, "ru");
    await club(app, true);
    await feed(app, dm(1, "/intro"));
    expect(texts(1).at(-1)).toContain("Кого ищете?");
    await feed(app, dm(1, "нужен бухгалтер для стартапа из трёх человек"));
    expect(texts(1).at(-1)).toContain("Запрос отправлен");
    expect((await q<{ n: number }>("SELECT COUNT(*) AS n FROM needs WHERE member_id=(SELECT id FROM members WHERE tg_id=1)"))!.n).toBe(1);
    expect(calls.length).toBeGreaterThan(0);
  });

  it("«Отмена» closes the prompt; the next message is then an ordinary question", async () => {
    const { app, texts } = testApp(undefined, "ru");
    await club(app, true);
    await feed(app, dm(1, "/intro"));
    await feed(app, press(1, "pc:x"));
    await feed(app, dm(1, "где проходит встреча?"));
    expect(texts(1).some((t) => t.includes("Запрос отправлен"))).toBe(false);
    expect((await q<{ n: number }>("SELECT COUNT(*) AS n FROM needs WHERE member_id=(SELECT id FROM members WHERE tg_id=1)"))!.n).toBe(0);
  });

  it("/ask with no question says what to do, in private", async () => {
    const { app, texts } = testApp(undefined, "ru");
    await club(app, false);
    await feed(app, dm(1, "/ask"));
    expect(texts(1).at(-1)).toContain("Что хотите узнать?");
  });

  it("a question is not taken as skills: the bio prompt hands it on", async () => {
    const { app } = testApp(undefined, "ru");
    await club(app, false);
    await feed(app, dm(11, "/optin")); // arms the «what can you help with?» prompt
    await feed(app, dm(11, "где проходит встреча?")); // a question, not an answer
    const skills = await all("SELECT code FROM skills WHERE member_id=(SELECT id FROM members WHERE tg_id=11)");
    expect(skills).toEqual([]);
    const threads = await q<{ n: number }>("SELECT COUNT(*) AS n FROM threads");
    expect(threads!.n).toBe(1);
  });
});

describe("a request that finds nobody waits", () => {
  it("waits, offers the team and a way out, and is matched when a helper appears", async () => {
    const { app, calls, texts } = testApp(undefined, "ru");
    await club(app, false);
    await feed(app, dm(1, "/intro нужен бухгалтер для стартапа из трёх человек"));
    expect(texts(1).at(-1)).toContain("Сейчас никто");
    const need = await q<{ id: string; status: string }>("SELECT id, status FROM needs WHERE member_id=(SELECT id FROM members WHERE tg_id=1)");
    expect(need!.status).toBe("waiting");
    expect(datas(calls, 1)).toEqual(expect.arrayContaining([`n:${need!.id}:team`, `n:${need!.id}:cancel`]));

    await feed(app, dm(11, "/optin"));
    await feed(app, dm(11, "/skills add accounting"));
    expect(texts(1).at(-1)).toContain("Нашёлся тот, кто может помочь");
    expect((await q<{ status: string }>("SELECT status FROM needs WHERE id=?", need!.id))!.status).toBe("matching");
  });

  it("the team gets it, once the person confirms the draft", async () => {
    const { app, calls } = testApp(undefined, "ru");
    await club(app, false);
    await feed(app, dm(1, "/intro нужен юрист для договора аренды офиса"));
    const need = await q<{ id: string }>("SELECT id FROM needs WHERE member_id=(SELECT id FROM members WHERE tg_id=1)");
    await feed(app, press(1, `n:${need!.id}:team`));
    expect(datas(calls, 1).some((d) => d.startsWith("m:"))).toBe(true);
  });

  it("two requests are the weekly limit, waiting ones included", async () => {
    const { app, texts } = testApp(undefined, "ru");
    await club(app, false);
    await feed(app, dm(1, "/intro нужен бухгалтер для стартапа из трёх человек"));
    await feed(app, dm(1, "/intro нужен юрист для договора аренды офиса"));
    await feed(app, dm(1, "/intro нужен дизайнер для лендинга компании"));
    expect(texts(1).at(-1)).toContain("У вас уже 2 открытых запроса");
  });
});

describe("the card offers what can work", () => {
  it("with nobody to ask, the card offers the club's team, not «Спросить людей»", async () => {
    const { app, calls } = testApp(undefined, "ru");
    await enableGroup(app);
    await feed(app, groupMsg(2, "The venue for the meetup is Hall B, behind the library"));
    await feed(app, groupMsg(1, "hello"));
    await feed(app, dm(1, "where is the venue?"));
    const id = (await q<{ id: string }>("SELECT id FROM threads WHERE member_id=(SELECT id FROM members WHERE tg_id=1)"))!.id;
    expect(datas(calls, 1)).toEqual(expect.arrayContaining([`t:${id}:ok`, `t:${id}:team`]));
    expect(datas(calls, 1)).not.toContain(`t:${id}:ask`);
  });
});

describe("thanks", () => {
  it("asks once what the person can help with", async () => {
    const { app, texts } = testApp(undefined, "ru");
    await enableGroup(app);
    await feed(app, groupMsg(2, "The venue for the meetup is Hall B, behind the library"));
    await feed(app, groupMsg(1, "hello"));
    await feed(app, dm(1, "where is the venue?"));
    const id = (await q<{ id: string }>("SELECT id FROM threads WHERE member_id=(SELECT id FROM members WHERE tg_id=1)"))!.id;
    await feed(app, press(1, `t:${id}:ok`));
    expect(texts(1).some((t) => t.includes("Вы тоже можете помогать"))).toBe(true);
    await feed(app, dm(1, "where is the venue again?"));
    await feed(app, press(1, `t:${(await q<{ id: string }>("SELECT id FROM threads WHERE member_id=(SELECT id FROM members WHERE tg_id=1) ORDER BY created_at DESC"))!.id}:ok`));
    expect(texts(1).filter((t) => t.includes("Вы тоже можете помогать")).length).toBe(1);
  });
});

describe("the profile is one card", () => {
  it("shows what matters, a sheet for the rest, and pause", async () => {
    const { app, calls, texts } = testApp(undefined, "ru");
    await club(app, true);
    await feed(app, dm(11, "/profile"));
    const main = texts(11).at(-1)!;
    expect(main).toContain("Помогаю с");
    expect(main).toContain("Помогли людям: 0");
    expect(datas(calls, 11)).toEqual(expect.arrayContaining(["p:helpwith", "dr:ask", "p:more"]));
    expect(datas(calls, 11)).not.toContain("p:discoverable:0:m");
    await feed(app, press(11, "p:available:0"));
    expect(shown(calls, 11)).toContain("на паузе");
  });

  it("/digest and the profile's sheet say the same thing", async () => {
    const { app, calls, texts } = testApp(undefined, "ru");
    await club(app, false);
    await env.DB.prepare("UPDATE members SET digest=0 WHERE tg_id=1").run();
    await feed(app, dm(1, "/digest"));
    expect(texts(1).at(-1)).toContain("выключена");
    await feed(app, dm(1, "/profile"));
    await feed(app, press(1, "p:more"));
    expect(shown(calls, 1)).toContain("Сводка каждый день: <b>выкл</b>");
  });

  it("saying «already» when nothing changes", async () => {
    const { app, texts } = testApp(undefined, "ru");
    await club(app, true);
    await feed(app, dm(11, "/optin"));
    expect(texts(11).at(-1)).toContain("Вас уже могут позвать на помощь");
    await feed(app, dm(11, "/skills add accounting"));
    expect(texts(11).at(-1)).toContain("уже в вашем профиле");
    await feed(app, dm(11, "/digest on"));
    await feed(app, dm(11, "/digest on"));
    expect(texts(11).at(-1)).toContain("Сводка уже включена");
  });

  it("a newcomer's start button asks what they can help with", async () => {
    const { app, calls, texts } = testApp(undefined, "ru");
    await enableGroup(app);
    await feed(app, dm(30, "/start"));
    expect(datas(calls, 30)).toContain("p:helpme");
    await feed(app, press(30, "p:helpme"));
    expect(texts(30).at(-1)).toContain("С чем ещё можете помочь?");
    await feed(app, dm(30, "бухгалтерия для ИП"));
    expect((await all("SELECT code FROM skills WHERE member_id=(SELECT id FROM members WHERE tg_id=30)")).length).toBe(1);
  });
});

describe("the menu and the words", () => {
  it("the menu is five things, in both languages", () => {
    expect(COMMANDS_RU).toHaveLength(5);
    expect(COMMANDS).toHaveLength(5);
  });

  it("plurals follow the number", () => {
    expect(ruPlural(1, "раз", "раза", "раз")).toBe("раз");
    expect(ruPlural(2, "раз", "раза", "раз")).toBe("раза");
    expect(ruPlural(5, "раз", "раза", "раз")).toBe("раз");
    expect(ruPlural(11, "раз", "раза", "раз")).toBe("раз");
    expect(ruPlural(21, "раз", "раза", "раз")).toBe("раз");
    expect(ruPlural(22, "раз", "раза", "раз")).toBe("раза");
    expect(ruPlural(14, "раз", "раза", "раз")).toBe("раз");
  });

  it("the privacy notice tells the AI part and the Telegram ID honestly", () => {
    const ru = T("ru").privacy;
    expect(ru).toContain("Пересказ ответа пишет ИИ");
    expect(ru).toContain("Telegram-ID");
    expect(ru).not.toContain("Ничего не отправляется");
    expect(T("en").privacy).toContain("AI summary");
  });

  it("a long quote folds away; a snippet ends between words", () => {
    expect(quoteHtml("x".repeat(200))).toContain("<blockquote expandable>");
    expect(quoteHtml("short")).toBe("<blockquote>short</blockquote>");
    const body = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma";
    const cut = snippet(body, ["lambda"], 40);
    const words = body.split(" ");
    const core = cut.replace(/^…/, "").replace(/…$/, "");
    expect(words).toContain(core.split(" ").at(-1));
    expect(words).toContain(core.split(" ")[0]);
  });
});

describe("the suggestion says how many asked and nobody answered", () => {
  it("counts in words a Russian reader expects", () => {
    expect(T("ru").suggestSkillUnmet("Бухгалтерия", 3)).toContain("спрашивали 3 раза");
    expect(T("ru").suggestSkillUnmet("Бухгалтерия", 5)).toContain("спрашивали 5 раз");
    expect(T("en").suggestSkillUnmet("Accounting", 3)).toContain("came up 3 times");
    expect(T("ru").introWhy("бухгалтерия", 2)).toContain("вы отвечали про «бухгалтерия» 2 раза");
    expect(T("ru").wowForgotten(3)).toBe("Нашлось 3 вопроса без ответа");
  });
});

describe("a door opened later finds the request that waits for it", () => {
  it("/introduce on a waiting introduction request keeps the consent: the helper is asked, not contacted", async () => {
    const { app, calls, texts } = testApp(undefined, "ru");
    await club(app, false);
    await feed(app, dm(1, "/intro нужен бухгалтер для стартапа из трёх человек"));
    const need = await q<{ id: string }>("SELECT id FROM needs WHERE member_id=(SELECT id FROM members WHERE tg_id=1)");
    expect(need).toBeTruthy();
    await feed(app, dm(11, "/optin"));
    await feed(app, dm(11, "/introduce Знаю директоров в банках"));
    expect(texts(11).at(-1)).toContain("Сохранено");
    expect(calls.some((c) => c.method === "sendMessage" && c.params.chat_id === 1 && String(c.params.text).includes("Нашёлся"))).toBe(false);
  });
});
