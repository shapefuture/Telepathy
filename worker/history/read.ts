// The reading loop of the history import, kept free of the Telegram client so tests can drive it
// with fake pages. It only reads and parks pages (POST history/stage, one D1 row per page); the
// Worker's cron stores them in the background, so the screen is needed for seconds, not minutes.

import type { tl } from "@mtcute/web";

export const PAGE = 100;

export interface Msg {
  id: number;
  date: number;
  text: string;
  from: number | null;
  edit: number;
  reply: number | null;
  topic: number | null;
}
export interface Stage {
  chat_id: number;
  page?: number;
  done?: boolean;
  messages?: Msg[];
}
export interface StageResult {
  ok: boolean;
  error?: string;
  pending?: number;
}
export type Outcome = "done" | "stopped";

/** How to reach the chat. Supergroups number their messages 1, 2, 3…, so pages of ids can be
 *  fetched in parallel; basic groups share ids with the account, so they are read page by page. */
export interface Source {
  kind: "ids" | "seq";
  newest(): Promise<number>;
  byIds(ids: number[]): Promise<tl.messages.TypeMessages>;
  history(offsetId: number): Promise<tl.messages.TypeMessages>;
}

export interface ReadOptions {
  chatId: number;
  /** Unix seconds; older messages would be purged by /retention, so reading stops there. 0 = all. */
  keepFrom: number;
  /** Pages already parked by an earlier, interrupted run. */
  read: number[];
  src: Source;
  stage: (p: Stage) => Promise<StageResult>;
  progress: (done: number, total: number) => void;
  signal: AbortSignal;
  concurrency?: number;
}

type Raw = tl.TypeMessage;

/** Text messages only; bots are stored without an author, like live messages. */
export function convert(res: tl.messages.TypeMessages, keep: (m: Raw) => boolean = () => true): { messages: Msg[]; all: Raw[]; newest: number } {
  if (res._ === "messages.messagesNotModified") return { messages: [], all: [], newest: 0 };
  const bots = new Set(res.users.filter((u): u is tl.RawUser => u._ === "user" && !!u.bot).map((u) => u.id));
  const all = res.messages.filter(keep);
  const messages: Msg[] = [];
  let newest = 0;
  for (const m of all) {
    if (m._ === "messageEmpty") continue;
    newest = Math.max(newest, m.date);
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
  return { messages, all, newest };
}

async function park(o: ReadOptions, s: Stage): Promise<void> {
  const r = await o.stage(s);
  if (!r.ok) throw new Error(r.error ?? "stage failed");
}

/** Reads the whole chat (or up to `keepFrom`) and marks it read. Throws on Telegram or server errors. */
export async function readAll(o: ReadOptions): Promise<Outcome> {
  const out = o.src.kind === "ids" ? await readByIds(o) : await readInOrder(o);
  if (out === "stopped") return out;
  await park(o, { chat_id: o.chatId, done: true });
  return "done";
}

async function readByIds(o: ReadOptions): Promise<Outcome> {
  const top = await o.src.newest();
  const last = top > 0 ? Math.floor((top - 1) / PAGE) : -1;
  const seen = new Set(o.read);
  const keys: number[] = [];
  for (let k = last; k >= 0; k--) if (!seen.has(k)) keys.push(k); // newest first
  const total = last + 1;
  let done = total - keys.length;
  let floor = -1; // pages below this are past the retention horizon
  let next = 0;
  o.progress(done, total);
  const worker = async () => {
    for (;;) {
      if (o.signal.aborted) return;
      const k = keys[next++];
      if (k === undefined) return;
      if (k < floor) continue;
      const ids = Array.from({ length: PAGE }, (_, i) => k * PAGE + i + 1);
      const { messages, newest } = convert(await o.src.byIds(ids));
      if (o.keepFrom && newest && newest < o.keepFrom) floor = Math.max(floor, k);
      await park(o, { chat_id: o.chatId, page: k, messages: messages.filter((m) => m.date >= o.keepFrom) });
      o.progress(++done, total);
    }
  };
  const workers = Array.from({ length: Math.min(o.concurrency ?? 6, Math.max(1, keys.length)) }, () =>
    worker().catch((e) => {
      next = keys.length; // stop the others after their current page
      throw e;
    }),
  );
  await Promise.all(workers);
  return o.signal.aborted ? "stopped" : "done";
}

async function readInOrder(o: ReadOptions): Promise<Outcome> {
  let cursor = o.read.length ? Math.min(...o.read) : 0; // page key = oldest id in that page
  let done = o.read.length;
  let total = done + 1;
  const inflight = new Set<Promise<void>>();
  for (;;) {
    if (o.signal.aborted) break;
    const res = await o.src.history(cursor);
    const { messages, all, newest } = convert(res, (m) => cursor === 0 || m.id < cursor);
    if (!all.length) break;
    if (res._ !== "messages.messagesNotModified" && "count" in res) total = Math.max(total, done + Math.ceil((res.count - done * PAGE) / PAGE));
    const oldest = Math.min(...all.map((m) => m.id));
    // Park while reading the next page; at most 4 uploads at a time.
    const p: Promise<void> = park(o, { chat_id: o.chatId, page: oldest, messages: messages.filter((m) => m.date >= o.keepFrom) }).then(() => {
      inflight.delete(p);
      o.progress(++done, Math.max(total, done));
    });
    p.catch(() => {}); // surfaced by the race/all below, not as an unhandled rejection
    inflight.add(p);
    if (inflight.size >= 4) await Promise.race(inflight);
    if (o.keepFrom && newest && newest < o.keepFrom) break;
    cursor = oldest;
  }
  await Promise.all(inflight);
  return o.signal.aborted ? "stopped" : "done";
}
