// Group a found message into its short conversation: the message it replies to, replies to it,
// and close neighbours in the same chat. At most 4 messages and ~1800 characters.

export const MAX_MESSAGES = 4;
export const MAX_CHARS = 1800;
const NEAR_MS = 10 * 60_000;

export interface Turn {
  id: number;
  msg_id: number;
  body: string;
  event_at: string;
}

interface Row extends Turn {
  source_id: string;
  reply_to: number | null;
}

const COLS = "id, msg_id, body, event_at, source_id, reply_to";
const LIVE = "removed_at IS NULL AND body IS NOT NULL";

/** Only reads within `readable`, so a conversation never pulls in hidden messages. */
export async function conversation(db: D1Database, readable: Set<string>, passageId: number): Promise<Turn[]> {
  const seed = await db.prepare(`SELECT ${COLS} FROM passages WHERE id = ? AND ${LIVE}`).bind(passageId).first<Row>();
  if (!seed || !readable.has(seed.source_id)) return [];
  const from = new Date(Date.parse(seed.event_at) - NEAR_MS).toISOString();
  const to = new Date(Date.parse(seed.event_at) + NEAR_MS).toISOString();
  const [parent, replies, near] = await db.batch([
    db.prepare(`SELECT ${COLS} FROM passages WHERE source_id = ? AND msg_id = ? AND ${LIVE} LIMIT 1`).bind(seed.source_id, seed.reply_to ?? -1),
    db.prepare(`SELECT ${COLS} FROM passages WHERE source_id = ? AND reply_to = ? AND ${LIVE} ORDER BY event_at LIMIT 3`).bind(seed.source_id, seed.msg_id),
    db.prepare(`SELECT ${COLS} FROM passages WHERE source_id = ? AND event_at BETWEEN ? AND ? AND id != ? AND ${LIVE} ORDER BY abs(julianday(event_at) - julianday(?)) LIMIT 3`)
      .bind(seed.source_id, from, to, seed.id, seed.event_at),
  ]);
  // Reply links first: they are real conversation structure; time proximity is a fallback.
  const picked = new Map<number, Row>([[seed.id, seed]]);
  for (const r of [...(parent!.results as Row[]), ...(replies!.results as Row[]), ...(near!.results as Row[])]) {
    if (picked.size >= MAX_MESSAGES) break;
    picked.set(r.id, r);
  }
  const turns = [...picked.values()].sort((a, b) => a.event_at.localeCompare(b.event_at) || a.msg_id - b.msg_id);
  let left = MAX_CHARS;
  const out: Turn[] = [];
  for (const t of turns) {
    if (left <= 0) break;
    const body = t.body.length > left ? `${t.body.slice(0, left)}…` : t.body;
    left -= body.length;
    out.push({ id: t.id, msg_id: t.msg_id, body, event_at: t.event_at });
  }
  return out;
}
