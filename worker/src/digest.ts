// Daily digest (P10, K14): visible to every member, opt-in with /digest on.
// Deterministic and extractive. Built per distinct readable-source set, so members who can
// read the same groups share one build (keeps CPU and queries inside free-plan limits).

import { langOf, readableSets, type Member } from "./acl";
import { T, type Lang } from "./i18n";
import { citation } from "./ingest";
import { effectStatement } from "./outbox";
import { glavnoeFor, sharedParts, type SharedParts } from "./glavnoe";
import { escapeHtml, snippet } from "./text";
import { DAY, localParts, nowIso } from "./util";

const MAX_ITEMS = 5;
const MAX_CHARS = 3900;
export const BATCH_RECIPIENTS = 30;

export function dueDay(now: Date, tz: string, hour: number): string | null {
  const p = localParts(now, tz);
  return p.hour >= hour ? p.date : null;
}

interface Row {
  body: string | null;
  msg_id: number;
  topic_id: number | null;
  chat_id: number;
  username: string | null;
  replies?: number;
  title?: string | null;
  n?: number;
  label?: string | null;
}

export async function build(db: D1Database, readable: Set<string>, start: string, end: string, day: string, lang: Lang = "en"): Promise<string | null> {
  const m = T(lang);
  if (!readable.size) return null;
  const src = JSON.stringify([...readable].sort());
  const [perSource, questions, docs] = await db.batch([
    db
      .prepare(
        "SELECT s.title, COUNT(*) AS n FROM passages p JOIN sources s ON s.id = p.source_id WHERE p.part = 0 " +
          "AND p.source_id IN (SELECT value FROM json_each(?)) AND p.removed_at IS NULL AND p.event_at >= ? AND p.event_at < ? " +
          "GROUP BY s.id ORDER BY n DESC LIMIT 10",
      )
      .bind(src, start, end),
    db
      .prepare(
        "SELECT p.body, p.msg_id, p.topic_id, s.chat_id, s.username, " +
          "(SELECT COUNT(*) FROM passages r WHERE r.source_id = p.source_id AND r.reply_to = p.msg_id AND r.part = 0 AND r.removed_at IS NULL) AS replies " +
          "FROM passages p JOIN sources s ON s.id = p.source_id WHERE p.part = 0 AND p.source_id IN (SELECT value FROM json_each(?)) " +
          "AND p.removed_at IS NULL AND p.event_at >= ? AND p.event_at < ? AND p.intent = 'help_request' AND p.intent_conf >= 0.55 " +
          "ORDER BY replies ASC, p.event_at DESC LIMIT 40",
      )
      .bind(src, start, end),
    db
      .prepare(
        "SELECT p.label, p.msg_id, p.topic_id, s.chat_id, s.username FROM passages p JOIN sources s ON s.id = p.source_id " +
          "WHERE p.part = 1 AND p.source_id IN (SELECT value FROM json_each(?)) AND p.removed_at IS NULL " +
          "AND p.event_at >= ? AND p.event_at < ? ORDER BY p.event_at DESC LIMIT ?",
      )
      .bind(src, start, end, MAX_ITEMS),
  ]);
  const groups = perSource!.results as unknown as Row[];
  if (!groups.length) return null;
  const link = (r: Row, text: string) => {
    const url = citation(r.chat_id, r.msg_id, r.username, r.topic_id);
    return url ? `<a href="${escapeHtml(url)}">${text}</a>` : text;
  };
  const total = groups.reduce((a, g) => a + (g.n ?? 0), 0);
  const lines = [m.dTitle(day), m.dNew(total)];
  for (const g of groups) lines.push(`• ${escapeHtml(g.title ?? m.dUntitled)}: ${g.n}`);
  const qs = questions!.results as unknown as Row[];
  const open = qs.filter((q) => !q.replies);
  const answered = qs.filter((q) => (q.replies ?? 0) > 0);
  if (open.length) {
    lines.push(`\n${m.dOpen(open.length)}`);
    for (const q of open.slice(0, MAX_ITEMS)) lines.push(`• ${escapeHtml(snippet(q.body ?? "", [], 160))} (${link(q, m.dOpenLink)})`);
  }
  if (answered.length) {
    lines.push(`\n${m.dAnswered(answered.length)}`);
    for (const q of answered.slice(0, MAX_ITEMS)) {
      lines.push(`• ${escapeHtml(snippet(q.body ?? "", [], 120))} — ${m.dReplies(q.replies ?? 0)} (${link(q, m.dThread)})`);
    }
  }
  const ds = docs!.results as unknown as Row[];
  if (ds.length) {
    lines.push(`\n${m.dDocs}`);
    for (const d of ds) lines.push(`• ${link(d, escapeHtml((d.label ?? "file").split(" · ")[0]!))}`);
  }
  const footer = `\n${m.dFooter}`;
  // Telegram rejects messages over 4096 characters: drop whole lines from the end if needed.
  while (lines.join("\n").length + footer.length > MAX_CHARS && lines.length > 2) lines.pop();
  return lines.join("\n") + footer;
}

/**
 * One cron step: send today's digest to the next batch of opted-in members who haven't got it.
 * Idempotent per (day, member) via the effect key. Returns keys to dispatch and whether done.
 */
export async function digestStep(db: D1Database, now: Date, tz: string, hour: number): Promise<{ keys: string[]; done: boolean }> {
  const day = dueDay(now, tz, hour);
  if (!day) return { keys: [], done: false };
  const doneDay = await db.prepare("SELECT value FROM settings WHERE key='digest.done'").first<{ value: string }>();
  if (doneDay?.value === day) return { keys: [], done: true };
  const last = await db.prepare("SELECT value FROM settings WHERE key='digest.window_end'").first<{ value: string }>();
  const end = nowIso(now);
  const startCandidate = last?.value ?? nowIso(new Date(now.getTime() - DAY));
  const start = startCandidate < nowIso(new Date(now.getTime() - 7 * DAY)) ? nowIso(new Date(now.getTime() - 7 * DAY)) : startCandidate;
  const pending = await db
    .prepare(
      "SELECT m.* FROM members m WHERE m.digest = 1 AND m.removed_at IS NULL AND m.collection_opt_out = 0 " +
        "AND NOT EXISTS (SELECT 1 FROM effects e WHERE e.key = 'digest:' || ? || ':' || m.id) LIMIT ?",
    )
    .bind(day, BATCH_RECIPIENTS)
    .all<Member>();
  if (!pending.results.length) {
    await db.batch([
      db.prepare("INSERT INTO settings(key, value) VALUES ('digest.done', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(day),
      db.prepare("INSERT INTO settings(key, value) VALUES ('digest.window_end', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(end),
    ]);
    return { keys: [], done: true };
  }
  const sets = await readableSets(db, pending.results);
  // «Главное» (plan: journey 7): the club's shared lines are built once per set of groups, and each
  // person's own lines are added for them alone.
  const cache = new Map<string, SharedParts>();
  const stmts: D1PreparedStatement[] = [];
  const keys: string[] = [];
  for (const m of pending.results) {
    const set = sets.get(m.id)!;
    const lang = langOf(m);
    const sig = `${lang}|${[...set].sort().join(",")}`;
    if (!cache.has(sig)) cache.set(sig, await sharedParts(db, set, start, end, now, tz, lang));
    const card = await glavnoeFor(db, m.id, set, start, end, now, tz, lang, cache.get(sig));
    const key = `digest:${day}:${m.id}`;
    if (card) {
      stmts.push(effectStatement(db, key, m.tg_id, { text: card.text, buttons: card.buttons }));
      keys.push(key);
    } else {
      // Nothing happened in this member's groups: record it so the batch moves on, send nothing.
      stmts.push(
        db
          .prepare("INSERT OR IGNORE INTO effects(id, key, chat_id, payload, state, created_at, updated_at) VALUES (?,?,?,'{}','skipped',?,?)")
          .bind(crypto.randomUUID(), key, m.tg_id, end, end),
      );
    }
  }
  await db.batch(stmts);
  return { keys, done: false };
}
