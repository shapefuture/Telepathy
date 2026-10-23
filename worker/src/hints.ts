// "Already answered" hints (P13-02). Off per group until an owner runs /hints on.
// Scope is the same group only, so nobody sees anything they couldn't already read (C02).
// At most one hint per question (effect ledger key) and one per group every 10 minutes.

import type { Lang } from "./i18n";
import { T } from "./i18n";
import { classify } from "./classify";
import type { Source, TgMessage } from "./ingest";
import { effectStatement } from "./outbox";
import { search } from "./search";
import { contentTerms, escapeHtml, normalize, termPresent } from "./text";
import { nowIso } from "./util";

export const HINT_MIN_CONFIDENCE = 0.7;
export const HINT_MIN_COVERAGE = 0.6;
export const HINT_GROUP_COOLDOWN_MS = 10 * 60_000;

interface Row {
  id: number;
  msg_id: number;
  body: string;
  replies: number;
}

/** Returns the effect key to dispatch, or null when no hint is warranted. */
export async function maybeHint(db: D1Database, source: Source, msg: TgMessage, lang: Lang, now = new Date()): Promise<string | null> {
  if (!source.hints || !msg.text) return null;
  const c = classify(msg.text);
  const terms = contentTerms(msg.text);
  if (c.intent !== "help_request" || c.confidence < HINT_MIN_CONFIDENCE || terms.length < 2) return null;
  const coolKey = `hint.last.${source.id}`;
  const last = await db.prepare("SELECT value FROM settings WHERE key=?").bind(coolKey).first<{ value: string }>();
  if (last && now.getTime() - Date.parse(last.value) < HINT_GROUP_COOLDOWN_MS) return null;

  const { hits } = await search(db, new Set([source.id]), msg.text);
  const candidates = hits.filter((h) => h.msg_id !== msg.message_id).slice(0, 10);
  if (!candidates.length) return null;
  const { results } = await db
    .prepare(
      "SELECT p.id, p.msg_id, p.body, (SELECT COUNT(*) FROM passages r WHERE r.source_id = p.source_id AND r.reply_to = p.msg_id " +
        "AND r.part = 0 AND r.removed_at IS NULL) AS replies FROM passages p WHERE p.id IN (SELECT value FROM json_each(?)) " +
        "AND p.part = 0 AND p.intent = 'help_request' AND p.removed_at IS NULL AND p.msg_id != ?",
    )
    .bind(JSON.stringify(candidates.map((h) => h.id)), msg.message_id)
    .all<Row>();
  const byId = new Map(results.map((r) => [r.id, r]));
  // Keep search order; the earlier question must cover most of the new one's terms and have replies.
  const best = candidates.find((h) => {
    const r = byId.get(h.id);
    if (!r || r.replies < 1) return false;
    const folded = normalize(r.body);
    return terms.filter((t) => termPresent(t, folded)).length / terms.length >= HINT_MIN_COVERAGE;
  });
  if (!best?.url) return null;
  const key = `hint:${source.id}:${msg.message_id}`;
  const m = T(lang);
  await db.batch([
    effectStatement(db, key, msg.chat.id, { text: m.hint(`<a href="${escapeHtml(best.url)}">${m.earlierAnswer}</a>`), reply_to: msg.message_id }),
    db.prepare("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(coolKey, nowIso(now)),
  ]);
  return key;
}
