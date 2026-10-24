// Telegram edge cases and privacy floors found in review: each test reproduces one bug.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handleUpdate } from "../src/bot";
import { redact } from "../src/ai/redact";
import { makeApp } from "../src/index";
import { GROUP, OWNER, enableGroup, feed, groupCmd, groupMsg, nextMsg, nextUpdate, testApp } from "./helpers";

/** Telegram's HTML parse mode: every '<' opens a supported tag, every '&' starts an entity. */
const TG_TAGS = new Set(["b", "strong", "i", "em", "u", "ins", "s", "strike", "del", "a", "code", "pre", "blockquote", "tg-spoiler", "span", "tg-emoji"]);
function telegramHtmlErrors(s: string): string[] {
  const errs: string[] = [];
  for (const m of s.matchAll(/<\/?([^\s>/]*)/g)) if (!TG_TAGS.has(m[1]!.toLowerCase())) errs.push(`unsupported tag <${m[1]}`);
  for (const m of s.matchAll(/&(?!(?:lt|gt|amp|quot|#\d+);)/g)) errs.push(`bare & at ${m.index}`);
  return errs;
}

const access = async (tgId: number) =>
  env.DB.prepare("SELECT a.revoked_at FROM source_access a JOIN members m ON m.id=a.member_id JOIN sources s ON s.id=a.source_id WHERE m.tg_id=? AND s.chat_id=?")
    .bind(tgId, GROUP)
    .first<{ revoked_at: string | null }>();

const memberUpdate = (id: number, from: Record<string, unknown>, to: Record<string, unknown>) => ({
  update_id: nextUpdate(),
  chat_member: {
    chat: { id: GROUP, type: "supergroup", title: "G" },
    from: { id, is_bot: false },
    old_chat_member: { user: { id, is_bot: false }, ...from },
    new_chat_member: { user: { id, is_bot: false, first_name: "A" }, ...to },
  },
});

describe("leaving a group revokes access (C06)", () => {
  it("also when the person was restricted: Telegram reports status 'restricted' with is_member false", async () => {
    const { app } = testApp();
    await enableGroup(app);
    await feed(app, groupMsg(41, "hello everyone"));
    expect((await access(41))?.revoked_at).toBeNull();
    await handleUpdate(app, memberUpdate(41, { status: "restricted", is_member: true }, { status: "restricted", is_member: false }) as any);
    expect((await access(41))?.revoked_at).not.toBeNull();
  });
});

describe("/forget by the author", () => {
  it("does not treat two different channels (same fake sender @Channel_Bot) as the same author", async () => {
    const { app } = testApp();
    await enableGroup(app);
    const CHANNEL_BOT = { id: 136817688, is_bot: true, first_name: "Channel" };
    const victim = nextMsg();
    await feed(app, { message: { message_id: victim, date: Math.floor(Date.now() / 1000), chat: { id: GROUP, type: "supergroup", title: "G" }, from: CHANNEL_BOT, sender_chat: { id: -1009001, type: "channel" }, text: "Official schedule for the spring meetup" } } as any);
    const cmd = groupCmd(0, "/forget", { from: CHANNEL_BOT, sender_chat: { id: -1009002, type: "channel" }, reply_to_message: { message_id: victim, from: CHANNEL_BOT, sender_chat: { id: -1009001, type: "channel" } } });
    await feed(app, cmd as any);
    const row = await env.DB.prepare("SELECT body, removed_at FROM passages WHERE msg_id=?").bind(victim).first<{ body: string | null; removed_at: string | null }>();
    expect(row?.removed_at).toBeNull();
    expect(row?.body).toContain("spring meetup");
    // The channel that posted it can still remove it.
    await feed(app, groupCmd(0, "/forget", { from: CHANNEL_BOT, sender_chat: { id: -1009001, type: "channel" }, reply_to_message: { message_id: victim, from: CHANNEL_BOT, sender_chat: { id: -1009001, type: "channel" } } }) as any);
    expect((await env.DB.prepare("SELECT removed_at FROM passages WHERE msg_id=?").bind(victim).first<{ removed_at: string | null }>())?.removed_at).not.toBeNull();
  });
});

describe("Telegram HTML in bot texts", () => {
  it("/retention usage parses as Telegram HTML (an unescaped <days …> makes Telegram refuse it)", async () => {
    for (const lang of ["en", "ru"] as const) {
      const { app, texts } = testApp(undefined, lang);
      await enableGroup(app);
      await feed(app, groupCmd(OWNER, "/retention abc"));
      const usage = texts(GROUP).at(-1)!;
      expect(usage).toContain("/retention");
      expect(telegramHtmlErrors(usage)).toEqual([]);
    }
  });
});

describe("a Telegram failure in one part of an update doesn't skip the rest", () => {
  it("a joiner gets read access even if the group welcome can't be posted", async () => {
    const t = testApp();
    await enableGroup(t.app);
    await feed(t.app, groupMsg(42, "first message")); // known member, never opened the bot
    await env.DB.prepare("UPDATE source_access SET revoked_at='2020-01-01T00:00:00Z' WHERE member_id=(SELECT id FROM members WHERE tg_id=42)").run();
    // Private messages fail (never started the bot); the group refuses too (bot may not post there).
    const fetcher = async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body ?? "{}"));
      if (url.endsWith("/sendMessage") && (body.chat_id === 42 || body.chat_id === GROUP))
        return Response.json({ ok: false, error_code: body.chat_id === 42 ? 403 : 400, description: body.chat_id === 42 ? "Forbidden: bot can't initiate conversation with a user" : "Bad Request: not enough rights to send text messages to the chat" });
      return t.fetcher(url, init);
    };
    const app = makeApp(env, fetcher);
    await handleUpdate(app, memberUpdate(42, { status: "left" }, { status: "member" }) as any).catch(() => undefined); // the webhook answers "ok" to a DefiniteFailure
    expect((await access(42))?.revoked_at).toBeNull();
  });

  it("a group message that mentions the bot is stored even if the reply can't be posted", async () => {
    const t = testApp();
    await enableGroup(t.app);
    const fetcher = async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body ?? "{}"));
      if (url.endsWith("/sendMessage") && body.chat_id === GROUP) return Response.json({ ok: false, error_code: 400, description: "Bad Request: not enough rights to send text messages to the chat" });
      return t.fetcher(url, init);
    };
    const app = makeApp({ ...(env as any), BOT_USERNAME: "tp_bot" }, fetcher);
    const text = "@tp_bot where is the bicycle parking downtown";
    const u = groupMsg(43, text, { entities: [{ type: "mention", offset: 0, length: 7 }] });
    await handleUpdate(app, { update_id: nextUpdate(), ...u } as any).catch(() => undefined); // the webhook answers "ok" to a DefiniteFailure
    const row = await env.DB.prepare("SELECT body FROM passages WHERE msg_id=?").bind(u.message.message_id).first<{ body: string }>();
    expect(row?.body).toBe(text);
  });
});
