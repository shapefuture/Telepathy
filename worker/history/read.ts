// The page loop of the history import, kept free of the Telegram client so tests can drive it
// with fake pages. Reads backwards from `cursor` (0 = newest), hands each page to `post`.

import type { tl } from "@mtcute/web";

export interface Page {
  chat_id: number;
  cursor: number; // oldest message id read so far: a closed tab resumes from here
  done: boolean;
  messages: { id: number; date: number; text: string; from: number | null; edit: number; reply: number | null; topic: number | null }[];
}
export interface PageResult {
  ok: boolean;
  error?: string;
  stored?: number;
  left?: number;
  imported?: number;
  done?: boolean;
}
export type Outcome = "done" | "paused" | "stopped";

export interface ReadOptions {
  chatId: number;
  cursor: number;
  /** Unix seconds; older messages would be purged by /retention, so reading stops there. 0 = all. */
  keepFrom: number;
  fetchPage: (offsetId: number) => Promise<tl.messages.TypeMessages>;
  post: (p: Page) => Promise<PageResult>;
  progress: (read: number, oldest: number | null, r: PageResult) => void;
  signal: AbortSignal;
  pauseMs?: number;
}

/** Stops at the start of the chat, past `keepFrom`, when the server pauses (daily budget), or on abort. */
export async function readHistory(o: ReadOptions): Promise<Outcome> {
  let cursor = o.cursor;
  let read = 0;
  const outcome = (r: PageResult): Outcome => (r.ok ? "done" : r.error === "paused" ? "paused" : "stopped");
  for (;;) {
    if (o.signal.aborted) return "stopped";
    const res = await o.fetchPage(cursor);
    const all = res._ === "messages.messagesNotModified" ? [] : res.messages.filter((m) => cursor === 0 || m.id < cursor);
    if (!all.length) {
      const r = await o.post({ chat_id: o.chatId, cursor, done: true, messages: [] });
      o.progress(read, null, r);
      return outcome(r);
    }
    const users = res._ === "messages.messagesNotModified" ? [] : res.users;
    const bots = new Set(users.filter((u): u is tl.RawUser => u._ === "user" && !!u.bot).map((u) => u.id));
    const page = all.filter((m): m is tl.RawMessage | tl.RawMessageService => m._ !== "messageEmpty");
    const oldest = Math.min(...all.map((m) => m.id));
    const messages: Page["messages"] = [];
    for (const m of page) {
      if (m._ !== "message" || !m.message.trim()) continue; // service messages, media without caption
      const user = m.fromId?._ === "peerUser" ? m.fromId.userId : null;
      const head = m.replyTo?._ === "messageReplyHeader" ? m.replyTo : null;
      messages.push({
        id: m.id,
        date: m.date,
        text: m.message,
        from: user !== null && !bots.has(user) ? user : null,
        edit: m.editDate ?? 0,
        reply: head?.replyToMsgId ?? null,
        topic: head?.forumTopic ? (head.replyToTopId ?? head.replyToMsgId ?? null) : null,
      });
    }
    const newest = page.length ? Math.max(...page.map((m) => m.date)) : Infinity;
    const past = o.keepFrom > 0 && newest < o.keepFrom;
    const r = await o.post({ chat_id: o.chatId, cursor: oldest, done: past, messages });
    read += all.length;
    o.progress(read, page.length ? Math.min(...page.map((m) => m.date)) : null, r);
    if (!r.ok || r.done || past) return outcome(r);
    cursor = oldest;
    await new Promise((ok) => setTimeout(ok, o.pauseMs ?? 400));
  }
}
