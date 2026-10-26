// The browser's reader (history/read.ts) against a fake Telegram, parking into the real Worker code.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { readAll, type Source, type Stage } from "../history/read";
import { ingestHistory, stagePage } from "../src/history";
import { enableGroup, GROUP, OWNER, testApp } from "./helpers";

const BOT = 900;
const T0 = Math.floor(Date.now() / 1000) - 100 * 86_400;
const q = <T>(sql: string) => env.DB.prepare(sql).first<T>();

/** A chat of messages 1..n (supergroup numbering); every 10th is a service message, every 7th from a bot. */
function fakeChat(n: number, kind: "ids" | "seq" = "ids") {
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
  const calls: string[] = [];
  const users = [{ _: "user", id: BOT, bot: true }];
  let inFlight = 0;
  let peak = 0;
  const src: Source = {
    kind,
    newest: async () => n,
    byIds: async (ids) => {
      calls.push(`ids:${ids[0]}`);
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      const want = new Set(ids);
      return { _: "messages.channelMessages", messages: ids.map((id) => (want.has(id) && id <= n ? msgs[id - 1]! : { _: "messageEmpty", id })), users, chats: [], count: n, pts: 0 } as any;
    },
    history: async (offsetId) => {
      calls.push(`hist:${offsetId}`);
      const older = msgs.filter((m) => offsetId === 0 || m.id < offsetId).reverse().slice(0, 100);
      return { _: "messages.messagesSlice", messages: older, users, chats: [], count: n } as any;
    },
  };
  return { src, calls, peak: () => peak };
}

const stage = (p: Stage) => stagePage(env.DB, OWNER, GROUP, p.page, p.messages, p.done === true);
const quiet = () => {};
const opts = (src: Source, extra: Partial<Parameters<typeof readAll>[0]> = {}) => ({ chatId: GROUP, keepFrom: 0, read: [], src, stage, progress: quiet, signal: new AbortController().signal, ...extra });

async function drain() {
  const { app } = testApp();
  for (let i = 0; i < 20; i++) await ingestHistory(app);
}

describe("history reader", () => {
  it("reads a supergroup in parallel pages of ids, then the cron stores everything", async () => {
    const { app } = testApp();
    await enableGroup(app);
    const chat = fakeChat(250);
    const seen: [number, number][] = [];
    expect(await readAll(opts(chat.src, { progress: (d, t) => seen.push([d, t]) }))).toBe("done");
    expect(chat.calls.sort()).toEqual(["ids:1", "ids:101", "ids:201"]);
    expect(chat.peak()).toBeGreaterThan(1); // really in parallel
    expect(seen.at(-1)).toEqual([3, 3]);
    expect(await q("SELECT COUNT(*) AS n FROM passages")).toEqual({ n: 0 }); // reading stored nothing yet
    await drain();
    expect(await q("SELECT COUNT(*) AS n FROM passages")).toEqual({ n: 225 }); // service messages carry no text
    expect(await q("SELECT author_id FROM passages WHERE msg_id=7")).toEqual({ author_id: null }); // bot
    expect(await q("SELECT reply_to, topic_id FROM passages WHERE msg_id=42")).toEqual({ reply_to: 41, topic_id: 5 });
    expect(await q("SELECT done_at IS NOT NULL AS d, imported FROM history_jobs")).toEqual({ d: 1, imported: 225 });
  });

  it("reads a basic group page by page, newest first", async () => {
    const { app } = testApp();
    await enableGroup(app);
    const chat = fakeChat(250, "seq");
    expect(await readAll(opts(chat.src))).toBe("done");
    expect(chat.calls).toEqual(["hist:0", "hist:151", "hist:51", "hist:1"]);
    await drain();
    expect(await q("SELECT COUNT(*) AS n FROM passages")).toEqual({ n: 225 });
  });

  it("a closed screen resumes without reading parked pages again", async () => {
    const { app } = testApp();
    await enableGroup(app);
    const ctl = new AbortController();
    const first = fakeChat(1000);
    let parked = 0;
    const out = await readAll(opts(first.src, { concurrency: 2, signal: ctl.signal, stage: async (p) => { const r = await stage(p); if (++parked === 3) ctl.abort(); return r; } }));
    expect(out).toBe("stopped");
    const read = JSON.parse((await q<{ p: string }>("SELECT json_group_array(page) AS p FROM history_pages"))!.p) as number[];
    expect(read.length).toBeGreaterThanOrEqual(3);
    expect(await q("SELECT read_at FROM history_jobs")).toEqual({ read_at: null });
    const again = fakeChat(1000);
    expect(await readAll(opts(again.src, { read }))).toBe("done");
    expect(again.calls).toHaveLength(10 - read.length);
    await drain();
    expect(await q("SELECT COUNT(*) AS n FROM passages")).toEqual({ n: 900 });
  });

  it("stops at the retention horizon", async () => {
    const { app } = testApp();
    await enableGroup(app);
    const chat = fakeChat(1000);
    const keepFrom = T0 + 750 * 3600; // only ids ≥ 750 matter
    expect(await readAll(opts(chat.src, { keepFrom, concurrency: 1 }))).toBe("done");
    expect(chat.calls).toEqual(["ids:901", "ids:801", "ids:701", "ids:601"].slice(0, chat.calls.length));
    expect(chat.calls.length).toBeLessThanOrEqual(4);
    await drain();
    expect((await q<{ n: number }>("SELECT MIN(msg_id) AS n FROM passages"))!.n).toBeGreaterThanOrEqual(750);
  });

  it("a server refusal stops the reader with the error", async () => {
    const { app } = testApp();
    await enableGroup(app);
    const chat = fakeChat(500);
    await expect(readAll(opts(chat.src, { stage: async () => ({ ok: false, error: "not_enabled" }) }))).rejects.toThrow("not_enabled");
  });
});
