// Welcome for people joining an enabled group: privately when Telegram allows, else a group
// message that deletes itself; once per person; owners can turn it off.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handleUpdate } from "../src/bot";
import { runCron } from "../src/cron";
import { makeApp } from "../src/index";
import { dispatchPending } from "../src/outbox";
import { GROUP, OWNER, enableGroup, fakeTelegram, feed, groupCmd } from "./helpers";

let upd = 9000;
const joined = (id: number, from = "left", to = "member") => ({
  update_id: upd++,
  chat_member: { chat: { id: GROUP, type: "supergroup", title: "G" }, from: { id, is_bot: false }, old_chat_member: { status: from, user: { id, is_bot: false } }, new_chat_member: { status: to, user: { id, is_bot: false, first_name: "Анна" } } },
});

/** Telegram fake where private messages to `blocked` fail like "user hasn't started the bot". */
function world(blocked: number[] = []) {
  const t = fakeTelegram();
  const fetcher = async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body ?? "{}"));
    if (url.endsWith("/sendMessage") && blocked.includes(body.chat_id)) return Response.json({ ok: false, error_code: 403, description: "Forbidden: bot can't initiate conversation with a user" });
    return t.fetcher(url, init);
  };
  const app = makeApp({ ...(env as any), DEFAULT_LANG: "ru", BOT_USERNAME: "mindal_bot" }, fetcher);
  return { app, t, texts: (chat: number) => t.sent(chat).map((c) => c.params) };
}

describe("welcome for new members", () => {
  it("goes privately to someone who has opened the bot, once only", async () => {
    const { app, texts } = world();
    await enableGroup(app);
    await handleUpdate(app, joined(501));
    // The welcome comes first; the onboarding (questions and topics to pick from) follows it.
    expect(texts(501)[0]!.text).toContain("Помогу сориентироваться в сообществе");
    expect(texts(501).at(-1)!.text).toContain("Чем можете помочь");
    expect(texts(GROUP).some((m) => m.text.includes("добро пожаловать"))).toBe(false);
    await handleUpdate(app, joined(501, "left", "member")); // left and came back: no second welcome or onboarding
    expect(texts(501)).toHaveLength(2);
    await handleUpdate(app, joined(501, "member", "administrator")); // a promotion isn't a join
    expect(texts(501)).toHaveLength(2);
  });

  it("falls back to a tagged group message with a Start button that deletes itself", async () => {
    const { app, t, texts } = world([502]);
    await enableGroup(app);
    await handleUpdate(app, joined(502));
    const g = texts(GROUP).at(-1)!;
    expect(g.text).toContain('href="tg://user?id=502"');
    expect(JSON.stringify(g.reply_markup)).toContain("https://t.me/mindal_bot?start=welcome");
    await env.DB.prepare("UPDATE pending_deletes SET delete_at='2000-01-01T00:00:00Z'").run();
    await runCron(app);
    expect(t.calls.some((c) => c.method === "deleteMessage" && c.params.chat_id === GROUP)).toBe(true);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM pending_deletes").first()).toEqual({ n: 0 });
  });

  it("join requests get a private welcome; /welcome off stops all of it", async () => {
    const { app, texts } = world([503]);
    await enableGroup(app);
    await handleUpdate(app, { update_id: upd++, chat_join_request: { chat: { id: GROUP, type: "supergroup", title: "G" }, from: { id: 504, is_bot: false }, user_chat_id: 504 } } as any);
    expect(texts(504)[0]!.text).toContain("Здравствуйте!");
    await feed(app, groupCmd(OWNER, "/welcome off"));
    await dispatchPending(app.db, app.tg, 10);
    await handleUpdate(app, joined(503));
    expect(texts(GROUP).some((m) => m.text.includes("добро пожаловать"))).toBe(false);
    expect(texts(503)).toHaveLength(0);
  });
});
