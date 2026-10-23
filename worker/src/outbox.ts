// Outgoing Telegram messages with an effect ledger (P02-08, P09-06, C09).
// At-most-once from normal retries: 'dispatching' is written before the network call; an
// unknown outcome becomes 'uncertain' and is never resent automatically.

import { DefiniteFailure, RetryLater, type InlineButton, type Telegram } from "./telegram";
import { escapeHtml } from "./text";
import { newId, nowIso } from "./util";

export interface Payload {
  text: string;
  buttons?: InlineButton[][];
  /** Append a live contact link for this Telegram user, resolved at send time, never stored. */
  reveal_tg_id?: number;
}

export function effectStatement(db: D1Database, key: string, chatId: number, payload: Payload): D1PreparedStatement {
  const now = nowIso();
  return db
    .prepare(
      "INSERT OR IGNORE INTO effects(id, key, chat_id, payload, state, created_at, updated_at) VALUES (?,?,?,?, 'pending', ?, ?)",
    )
    .bind(newId(), key, chatId, JSON.stringify(payload), now, now);
}

async function contactLine(tg: Telegram, tgId: number): Promise<string> {
  try {
    const chat = await tg.call<{ first_name?: string; last_name?: string; username?: string }>("getChat", { chat_id: tgId });
    const name = escapeHtml([chat.first_name, chat.last_name].filter(Boolean).join(" ") || "Open profile");
    const mention = `<a href="tg://user?id=${tgId}">${name}</a>`;
    return chat.username ? `${mention} · @${escapeHtml(chat.username)}` : mention;
  } catch {
    return `<a href="tg://user?id=${tgId}">Open profile</a>`;
  }
}

async function setState(db: D1Database, id: string, from: string, to: string, extra: { ref?: string; error?: string } = {}): Promise<boolean> {
  const r = await db
    .prepare(
      "UPDATE effects SET state=?, updated_at=?, ref=COALESCE(?, ref), error=COALESCE(?, error) WHERE id=? AND state=?",
    )
    .bind(to, nowIso(), extra.ref ?? null, extra.error ?? null, id, from)
    .run();
  return r.meta.changes > 0;
}

export async function dispatch(db: D1Database, tg: Telegram, id: string): Promise<string> {
  const row = await db.prepare("SELECT chat_id, payload, state FROM effects WHERE id=?").bind(id).first<{ chat_id: number; payload: string; state: string }>();
  if (!row) throw new Error(`no effect ${id}`);
  if (!(await setState(db, id, "pending", "dispatching"))) return row.state;
  const p = JSON.parse(row.payload) as Payload;
  try {
    let text = p.text;
    if (p.reveal_tg_id) text += `\n${await contactLine(tg, p.reveal_tg_id)}`;
    const msg = await tg.sendMessage(row.chat_id, text, { buttons: p.buttons });
    await setState(db, id, "dispatching", "sent", { ref: String(msg.message_id) });
    return "sent";
  } catch (e) {
    const error = String(e).slice(0, 300);
    if (e instanceof DefiniteFailure) {
      await setState(db, id, "dispatching", "failed", { error });
      return "failed";
    }
    if (e instanceof RetryLater) {
      await setState(db, id, "dispatching", "pending", { error });
      return "pending";
    }
    await setState(db, id, "dispatching", "uncertain", { error });
    return "uncertain";
  }
}

/** Send pending effects, oldest first, within a subrequest budget. */
export async function dispatchPending(db: D1Database, tg: Telegram, budget: number, keys?: string[]): Promise<number> {
  const q = keys
    ? db.prepare("SELECT id FROM effects WHERE state='pending' AND key IN (SELECT value FROM json_each(?)) ORDER BY created_at").bind(JSON.stringify(keys))
    : db.prepare("SELECT id FROM effects WHERE state='pending' ORDER BY created_at LIMIT ?").bind(budget);
  const { results } = await q.all<{ id: string }>();
  let n = 0;
  for (const r of results) {
    if (tg.calls >= budget) break;
    const st = await dispatch(db, tg, r.id);
    if (st === "pending") break; // rate limited: stop this round
    n += 1;
  }
  return n;
}

/** A crash or timeout mid-send leaves 'dispatching'; after 5 minutes it is 'uncertain'. */
export async function recoverStuck(db: D1Database, now = new Date()): Promise<number> {
  const cutoff = nowIso(new Date(now.getTime() - 5 * 60_000));
  const r = await db
    .prepare("UPDATE effects SET state='uncertain', error='no result recorded within 5 minutes', updated_at=? WHERE state='dispatching' AND updated_at < ?")
    .bind(nowIso(now), cutoff)
    .run();
  return r.meta.changes;
}

export async function reconcile(db: D1Database, id: string, delivered: boolean, note: string): Promise<boolean> {
  return setState(db, id, "uncertain", delivered ? "reconciled" : "failed", { error: note });
}
