// The memory a decision may quote: what the asker could read, up to the request's time (so a replay
// never sees the answer), grouped into short conversations. Used by replay and live suggestions.

import { answer } from "../search";
import { conversation } from "../ai/threads";

export async function conversationsFor(db: D1Database, readable: Set<string>, body: string, before?: string): Promise<{ convs: string[]; found: number }> {
  const found = await answer(db, readable, body, before ? { before } : {});
  const convs: string[] = [];
  const seen = new Set<number>();
  for (const q of found.quotes) {
    const turns = (await conversation(db, readable, q.id, before)).filter((t) => !seen.has(t.id));
    turns.forEach((t) => seen.add(t.id));
    if (turns.length) convs.push(turns.map((t) => `- ${t.body}`).join("\n"));
  }
  return { convs, found: seen.size };
}
