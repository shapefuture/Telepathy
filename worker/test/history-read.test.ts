// The browser's page loop (history/read.ts) against a fake Telegram, posting into the real importer.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { readHistory, type Page } from "../history/read";
import { importPage } from "../src/history";
import { enableGroup, GROUP, OWNER, testApp } from "./helpers";
import type { Env } from "../src/env";

const E = env as unknown as Env;
const BOT = 900;
const T0 = Math.floor(Date.now() / 1000) - 100 * 86_400;

/** A chat of `n` messages (id = 1..n); every 10th is a service message, every 7th is from a bot. */
function fakeChat(n: number) {
  const msgs = Array.from({ length: n }, (_, i) => {
    const id = i + 1;
    if (id % 10 === 0) return { _: "messageService", id, date: T0 + id * 3600 };
    return {
      _: "message",
      id,
      date: T0 + id * 3600,
      message: `message number ${id}`,
      fromId: { _: "peerUser", userId: id % 7 === 0 ? BOT : 500 + (id % 3) },
      replyTo: id === 42 ? { _: "messageReplyHeader", forumTopic: true, replyToMsgId: 41, replyToTopId: 5 } : undefined,
    };
  });
  const calls: number[] = [];
  const fetchPage = async (offsetId: number) => {
    calls.push(offsetId);
    const older = msgs.filter((m) => offsetId === 0 || m.id < offsetId).reverse().slice(0, 100);
    return { _: "messages.messagesSlice", messages: older, users: [{ _: "user", id: BOT, bot: true }], chats: [], count: n } as any;
  };
  return { fetchPage, calls };
}

const post = (budget?: Env) => (p: Page) => importPage(budget ?? E, env.DB, OWNER, GROUP, p.messages, p.cursor, p.done);
const quiet = () => {};

describe("history page loop", () => {
  it("reads the whole chat newest-first and the server stores it", async () => {
    const { app } = testApp();
    await enableGroup(app);
    const chat = fakeChat(250);
    const out = await readHistory({ chatId: GROUP, cursor: 0, keepFrom: 0, fetchPage: chat.fetchPage, post: post(), progress: quiet, signal: new AbortController().signal, pauseMs: 0 });
    expect(out).toBe("done");
    expect(chat.calls).toEqual([0, 151, 51, 1]);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM passages").first<{ n: number }>();
    expect(n!.n).toBe(250 - 25); // service messages carry no text
    const bot = await env.DB.prepare("SELECT author_id FROM passages WHERE msg_id=7").first<{ author_id: string | null }>();
    expect(bot!.author_id).toBeNull(); // bots are stored without an author, like live messages
    expect(await env.DB.prepare("SELECT reply_to, topic_id FROM passages WHERE msg_id=42").first()).toEqual({ reply_to: 41, topic_id: 5 });
    expect(await env.DB.prepare("SELECT cursor, done_at IS NOT NULL AS done FROM history_jobs").first()).toEqual({ cursor: 1, done: 1 });
  });

  it("stops when the daily budget is used and resumes from the saved cursor", async () => {
    const { app } = testApp();
    await enableGroup(app);
    const small = { ...E, HISTORY_PER_DAY: "150" };
    const chat = fakeChat(250);
    const first = await readHistory({ chatId: GROUP, cursor: 0, keepFrom: 0, fetchPage: chat.fetchPage, post: post(small), progress: quiet, signal: new AbortController().signal, pauseMs: 0 });
    expect(first).toBe("paused");
    const job = await env.DB.prepare("SELECT cursor FROM history_jobs").first<{ cursor: number }>();
    expect(job!.cursor).toBe(51); // two pages stored (overshoot ≤ one page), the third refused
    const next = new Date(Date.now() + 86_400_000);
    const resumed = await readHistory({ chatId: GROUP, cursor: job!.cursor, keepFrom: 0, fetchPage: chat.fetchPage, post: (p) => importPage(small, env.DB, OWNER, GROUP, p.messages, p.cursor, p.done, next), progress: quiet, signal: new AbortController().signal, pauseMs: 0 });
    expect(resumed).toBe("done");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM passages").first<{ n: number }>())!.n).toBe(225);
  });

  it("stops at the retention horizon and on abort", async () => {
    const { app } = testApp();
    await enableGroup(app);
    const chat = fakeChat(250);
    const keepFrom = T0 + 200 * 3600; // only ids ≥ 200 are worth keeping
    expect(await readHistory({ chatId: GROUP, cursor: 0, keepFrom, fetchPage: chat.fetchPage, post: post(), progress: quiet, signal: new AbortController().signal, pauseMs: 0 })).toBe("done");
    expect(chat.calls).toEqual([0, 151]);

    const ctl = new AbortController();
    const again = fakeChat(250);
    const out = await readHistory({ chatId: GROUP, cursor: 0, keepFrom: 0, fetchPage: again.fetchPage, post: post(), progress: () => ctl.abort(), signal: ctl.signal, pauseMs: 0 });
    expect(out).toBe("stopped");
    expect(again.calls).toEqual([0]);
  });
});
