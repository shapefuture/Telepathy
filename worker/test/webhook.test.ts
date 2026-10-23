import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { runCron } from "../src/cron";
import { handleFetch } from "../src/index";
import { GROUP, OWNER, dm, enableGroup, fakeTelegram, feed, groupCmd, groupMsg, press, testApp, webhook } from "./helpers";

describe("webhook endpoint", () => {
  it("rejects requests without the Telegram secret", async () => {
    expect((await webhook({ update_id: 1 }, "wrong")).status).toBe(403);
    expect((await webhook({ update_id: 1 })).status).toBe(200);
  });

  it("admin endpoints need the bearer token; setup registers the webhook with the secret", async () => {
    const t = fakeTelegram();
    const unauth = await handleFetch(new Request("https://bot.example/admin/setup", { method: "POST" }), env, t.fetcher);
    expect(unauth.status).toBe(401);
    const ok = await handleFetch(
      new Request("https://bot.example/admin/setup", { method: "POST", headers: { authorization: "Bearer test-admin-token" } }),
      env,
      t.fetcher,
    );
    expect(ok.status).toBe(200);
    const hook = t.calls.find((c) => c.method === "setWebhook")!;
    expect(hook.params).toMatchObject({ url: "https://bot.example/telegram", secret_token: "test-webhook-secret" });
  });

  it("end to end through the HTTP endpoint: enable, ingest, ask", async () => {
    const t = fakeTelegram();
    const cmd = groupCmd(OWNER, "/enable");
    expect((await webhook({ update_id: 10, ...cmd }, undefined, t.fetcher)).status).toBe(200);
    await webhook({ update_id: 11, ...groupMsg(5, "The meetup venue is Hall B on Rothschild") }, undefined, t.fetcher);
    await webhook({ update_id: 12, ...dm(5, "/ask where is the meetup venue?") }, undefined, t.fetcher);
    const last = t.sent(5).at(-1)!.params.text as string;
    expect(last).toContain("Hall B");
    expect(last).toContain("t.me/c/1234/");
  });
});

describe("bot behaviour", () => {
  it("non-owners cannot enable and get no reply", async () => {
    const { app, calls } = testApp();
    await feed(app, groupCmd(5, "/enable"));
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM sources").first<{ n: number }>())!.n).toBe(0);
    expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(0);
  });

  it("a configured owner who is not chat admin cannot enable", async () => {
    const { app } = testApp({ admins: [] });
    await feed(app, groupCmd(OWNER, "/enable"));
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM sources").first<{ n: number }>())!.n).toBe(0);
  });

  it("private commands in a group are redirected", async () => {
    const { app, texts } = testApp();
    await enableGroup(app);
    await feed(app, groupCmd(5, "/ask venue?"));
    expect(texts(GROUP).at(-1)).toContain("private chat");
  });

  it("full introduction through the bot with buttons", async () => {
    const { app, sent, texts } = testApp();
    await enableGroup(app);
    await feed(app, groupMsg(5, "hi"));
    await feed(app, groupMsg(6, "hey"));
    await feed(app, dm(6, "/optin"));
    await feed(app, dm(6, "/skills add accounting"));
    await feed(app, dm(5, "/expert accounting"));
    expect(texts(5).at(-1)).toContain("<b>1</b>");
    await feed(app, dm(5, "/intro need an accountant for my startup"));
    expect(texts(5).at(-1)).toContain("invited");
    const invite = sent(6).at(-1)!;
    const acceptData = invite.params.reply_markup.inline_keyboard[0][0].callback_data as string;
    expect(acceptData).toMatch(/:accept$/);
    await feed(app, press(5, acceptData)); // requester can't accept for the expert
    await feed(app, press(6, acceptData));
    const confirm = sent(5).at(-1)!;
    expect(confirm.params.text).not.toContain("expert_user");
    await feed(app, press(5, confirm.params.reply_markup.inline_keyboard[0][0].callback_data));
    expect(texts(5).some((t) => t.includes("@expert_user"))).toBe(true);
    expect(texts(6).some((t) => t.includes("You're connected"))).toBe(true);
  });

  it("/forget_me via buttons deletes and stops collection", async () => {
    const { app } = testApp();
    await enableGroup(app);
    await feed(app, groupMsg(5, "personal story about my visa"));
    await feed(app, dm(5, "/forget_me"));
    await feed(app, press(5, "fm:yes"));
    await feed(app, groupMsg(5, "new message"));
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM passages WHERE removed_at IS NULL").first<{ n: number }>())!.n).toBe(0);
  });

  it("authors can /forget their own message by replying to it", async () => {
    const { app, texts } = testApp();
    await enableGroup(app);
    const original = groupMsg(5, "oops wrong chat");
    await feed(app, original);
    await feed(app, groupCmd(5, "/forget", { reply_to_message: { message_id: original.message.message_id, from: { id: 5 } } }));
    expect(texts(GROUP).at(-1)).toContain("Removed");
    // Someone else can't remove it.
    const o2 = groupMsg(5, "keep this");
    await feed(app, o2);
    await feed(app, groupCmd(9, "/forget", { reply_to_message: { message_id: o2.message.message_id, from: { id: 5 } } }));
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM passages WHERE removed_at IS NULL").first<{ n: number }>())!.n).toBeGreaterThan(0);
  });

  it("/digest on|off and profile buttons", async () => {
    const { app, texts } = testApp();
    await enableGroup(app);
    await feed(app, groupMsg(5, "hello group"));
    await feed(app, dm(5, "/digest on"));
    expect((await env.DB.prepare("SELECT digest FROM members WHERE tg_id=5").first<{ digest: number }>())!.digest).toBe(1);
    await feed(app, dm(5, "/digest"));
    expect(texts(5).at(-1)).toContain("<b>on</b>");
    await feed(app, press(5, "p:digest:0"));
    expect((await env.DB.prepare("SELECT digest FROM members WHERE tg_id=5").first<{ digest: number }>())!.digest).toBe(0);
  });

  it("/retention 0 keeps full history; bot removal disables the source", async () => {
    const { app, texts } = testApp();
    await enableGroup(app);
    await feed(app, groupCmd(OWNER, "/retention 30"));
    await feed(app, groupCmd(OWNER, "/retention 0"));
    expect(texts(GROUP).at(-1)).toContain("Full history");
    await feed(app, { my_chat_member: { chat: { id: GROUP, type: "supergroup" }, from: { id: OWNER }, new_chat_member: { status: "left", user: { id: 999, is_bot: true } } } } as any);
    expect((await env.DB.prepare("SELECT enabled FROM sources").first<{ enabled: number }>())!.enabled).toBe(0);
  });

  it("text documents posted in a group become searchable", async () => {
    const { app, texts } = testApp({ files: { F1: "WEBVTT\n\n00:02:00.000 --> 00:02:05.000\nThe parking is behind the library." } });
    await enableGroup(app);
    await feed(app, groupMsg(5, "slides", { document: { file_id: "F1", file_name: "meetup.vtt", file_size: 80 } }));
    await feed(app, dm(5, "/ask where is the parking?"));
    expect(texts(5).at(-1)).toContain("meetup.vtt · 02:00");
  });

  it("/skills all is paged under Telegram's 4096-char limit; owner-only /status", async () => {
    const { app, texts } = testApp();
    await enableGroup(app);
    await feed(app, groupMsg(5, "hi"));
    await feed(app, dm(5, "/skills all"));
    expect(texts(5).length).toBeGreaterThanOrEqual(3);
    expect(texts(5).every((t) => t.length < 4096)).toBe(true);
    await feed(app, dm(5, "/status"));
    await feed(app, dm(OWNER, "/status"));
    expect(texts(OWNER).at(-1)).toContain("enabled sources");
    expect(texts(5).some((t) => t.includes("enabled sources"))).toBe(false);
  });

  it("rate limits /ask", async () => {
    const { app, texts } = testApp();
    await enableGroup(app);
    await feed(app, groupMsg(5, "x"));
    for (let i = 0; i < 11; i++) await feed(app, dm(5, "/ask something here"));
    expect(texts(5).at(-1)).toContain("Too many");
  });

  it("cron dispatches leftovers and is safe to run twice", async () => {
    const { app } = testApp();
    await enableGroup(app);
    await env.DB.prepare("INSERT INTO effects(id,key,chat_id,payload,state,created_at,updated_at) VALUES ('e1','k',5,'{\"text\":\"x\"}','pending','t','t')").run();
    const r1 = await runCron(app);
    const r2 = await runCron(app);
    expect(r1.sent).toBe(1);
    expect(r2.sent).toBe(0);
  });
});

describe("robustness", () => {
  it("a reply Telegram permanently refuses does not cause webhook retries", async () => {
    const t = fakeTelegram({ fail: { sendMessage: 403 } });
    const res = await webhook({ update_id: 50, ...dm(5, "/start") }, undefined, t.fetcher);
    expect(res.status).toBe(200);
  });

  it("group upgraded to supergroup keeps being collected", async () => {
    const { app } = testApp();
    await enableGroup(app);
    await feed(app, { message: { message_id: 1, date: 0, chat: { id: GROUP, type: "group" }, migrate_to_chat_id: -100777 } } as any);
    expect((await env.DB.prepare("SELECT chat_id FROM sources").first<{ chat_id: number }>())!.chat_id).toBe(-100777);
  });

  it("digest stays under Telegram's message limit", async () => {
    const { build } = await import("../src/digest");
    const { app } = testApp();
    await enableGroup(app);
    for (let i = 0; i < 40; i++) await feed(app, groupMsg(5, `Can anyone recommend ${"x".repeat(150)} ${i}?`));
    const { ensureMember, readable } = await import("../src/acl");
    const text = await build(env.DB, await readable(env.DB, await ensureMember(env.DB, 5)), "2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z", "d");
    expect(text!.length).toBeLessThan(4096);
  });
});
