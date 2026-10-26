// The bot's membership in a group, as Telegram sends it: `my_chat_member` updates shaped like the
// Bot API's ChatMemberUpdated, through the real HTTP webhook. Nothing here talks to Telegram; the
// live group is still the one check this repository cannot run by itself.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handleFetch } from "../src/index";
import { fakeTelegram, webhook } from "./helpers";

type User = { id: number; is_bot: boolean; first_name: string; username?: string; language_code?: string };
const BOT = { id: 7777777777, is_bot: true, first_name: "Telepathy", username: "mindal_bot" };
const ANNA = { id: 4101, is_bot: false, first_name: "Anna", username: "anna_k", language_code: "en" }; // an admin of the group
const LEO = { id: 4102, is_bot: false, first_name: "Leo", language_code: "en" }; // an ordinary member
const CHAT = { id: -1004455667788, title: "Book club", type: "supergroup" };
const ADMIN_RIGHTS = { can_be_edited: false, is_anonymous: false, can_manage_chat: true, can_delete_messages: true, can_manage_video_chats: false, can_restrict_members: false, can_promote_members: false, can_change_info: false, can_invite_users: true, can_pin_messages: true, can_manage_topics: false };
const q = <T>(sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).first<T>();
const enabled = () => q<{ enabled: number; title: string }>("SELECT enabled, title FROM sources WHERE chat_id=?", CHAT.id);

let updateId = 800_000;
const at = 1_790_000_000;

/** `by` moved the bot from `oldStatus` to `newStatus` in CHAT. */
const change = (by: User, oldStatus: string, newStatus: string, extra: Record<string, unknown> = {}) => ({
  update_id: updateId++,
  my_chat_member: {
    chat: CHAT,
    from: by,
    date: at,
    old_chat_member: { user: BOT, status: oldStatus },
    new_chat_member: { user: BOT, status: newStatus, ...(newStatus === "administrator" ? ADMIN_RIGHTS : {}), ...extra },
  },
});

/** A press on the "Connect" button under the bot's hello (callback_data "cn"). */
const tap = (by: User, data: string) => ({
  update_id: updateId++,
  callback_query: { id: String(updateId), from: by, chat_instance: "5510", data, message: { message_id: 42, date: at, chat: CHAT, text: "hello" } },
});

describe("the bot's membership in a live group", () => {
  it("setup asks Telegram for membership changes, or none of the below can happen", async () => {
    const t = fakeTelegram();
    await handleFetch(new Request("https://bot.example/admin/setup", { method: "POST", headers: { authorization: "Bearer test-admin-token" } }), env, t.fetcher);
    const hook = t.calls.find((c) => c.method === "setWebhook")!;
    expect(hook.params.allowed_updates).toEqual(expect.arrayContaining(["my_chat_member", "message", "callback_query"]));
  });

  it("an admin adds the bot as administrator: connected at once, the group is told, the admin gets the guide", async () => {
    const t = fakeTelegram({ admins: [ANNA.id] });
    expect((await webhook(change(ANNA, "left", "administrator"), undefined, t.fetcher)).status).toBe(200);
    expect(await enabled()).toEqual({ enabled: 1, title: "Book club" });
    expect(t.sent(CHAT.id).map((c) => c.params.text).join("\n")).toContain("connected");
    expect(t.sent(ANNA.id).some((c) => String(c.params.text).includes("Book club"))).toBe(true);

    // A promotion of the connected bot is not news: no second announcement.
    const before = t.sent(CHAT.id).length;
    await webhook(change(ANNA, "member", "administrator"), undefined, t.fetcher);
    expect(t.sent(CHAT.id).length).toBe(before);
  });

  it("a non-admin adds the bot: nothing connects until an admin taps Connect", async () => {
    const t = fakeTelegram({ admins: [ANNA.id] });
    await webhook(change(LEO, "left", "member"), undefined, t.fetcher);
    expect(await enabled()).toBeNull();
    const hello = t.calls.find((c) => c.method === "sendMessage" && c.params.chat_id === CHAT.id)!;
    const connect = hello.params.reply_markup.inline_keyboard[0][0].callback_data as string;

    await webhook(tap(LEO, connect), undefined, t.fetcher);
    expect(await enabled()).toBeNull(); // Leo is not an admin: refused

    await webhook(tap(ANNA, connect), undefined, t.fetcher);
    expect(await enabled()).toEqual({ enabled: 1, title: "Book club" });
  });

  it("a removed bot is switched off (and its members lose the group); an admin adding it again switches it on", async () => {
    const t = fakeTelegram({ admins: [ANNA.id] });
    await webhook(change(ANNA, "left", "administrator"), undefined, t.fetcher);
    await webhook(change(ANNA, "administrator", "kicked", { until_date: 0 }), undefined, t.fetcher);
    expect((await enabled())!.enabled).toBe(0);
    expect(await q("SELECT subject, detail FROM audit WHERE action='source.disable'")).toEqual({ subject: String(CHAT.id), detail: '{"reason":"bot removed"}' });

    await webhook(change(ANNA, "kicked", "administrator"), undefined, t.fetcher);
    expect((await enabled())!.enabled).toBe(1);
  });
});
