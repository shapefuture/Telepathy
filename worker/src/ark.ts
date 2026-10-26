// Ковчег (plan: journey 10): independence as a guarantee, shown plainly. The owner sees when the
// last copy was made. "Забрать всё" gives the community's memory in an open format. "Позвать всех"
// tells everyone a new address, if the community has to move. What the bot knows about each person
// is one card with a way to delete each part of it (plan: "Что бот знает обо мне").

import { escrowTargets } from "./hydra/escrow";
import { T, defaultLang, type Lang } from "./i18n";
import { effectStatement } from "./outbox";
import { escapeHtml } from "./text";
import { btn } from "./thread-card";
import type { App } from "./bot";
import type { Env } from "./env";
import type { InlineButton } from "./telegram";
import { nowIso } from "./util";

/** The newest copy that reached at least one target, or null. */
export async function lastCopy(db: D1Database): Promise<{ at: string; targets: number } | null> {
  return db.prepare("SELECT at, targets_ok AS targets FROM escrow_runs WHERE targets_ok > 0 ORDER BY at DESC LIMIT 1").first<{ at: string; targets: number }>();
}

/** The quiet line for the owner's console: honest about whether copies are set up at all. */
export async function arkLine(db: D1Database, env: Env, lang: Lang): Promise<string> {
  const m = T(lang);
  const configured = escrowTargets(env as unknown as App["env"]).length > 0 || !!env.ESCROW_R2;
  if (!configured) return m.arkNotSet;
  const last = await lastCopy(db);
  return last ? m.arkSafe(last.at.slice(0, 10)) : m.arkNoCopy;
}

/** "Забрать всё": the community's memory of the clubs this person runs, as one open JSON file. */
export async function exportFor(db: D1Database, ownerId: string, now = new Date()): Promise<{ json: string; messages: number; clubs: number }> {
  const clubs = (await db.prepare("SELECT id, title, enabled_at FROM sources WHERE enabled=1 AND enabled_by=? ORDER BY title").bind(ownerId).all<{ id: string; title: string | null; enabled_at: string }>()).results;
  const out: Record<string, unknown> = { format: "telepathy-export/1", exported_at: nowIso(now), clubs: [] };
  let messages = 0;
  const list: unknown[] = [];
  for (const c of clubs) {
    const msgs = (
      await db
        .prepare("SELECT msg_id, author_id, event_at, body, reply_to, intent FROM passages WHERE source_id=? AND part=0 AND removed_at IS NULL AND body IS NOT NULL ORDER BY event_at LIMIT 20000")
        .bind(c.id)
        .all<{ msg_id: number; author_id: string | null; event_at: string; body: string; reply_to: number | null; intent: string | null }>()
    ).results;
    messages += msgs.length;
    // Only people who said they can be found (discoverable) carry their skills; never Telegram ids.
    const people = (
      await db
        .prepare("SELECT m.id, GROUP_CONCAT(s.code) AS skills FROM members m LEFT JOIN skills s ON s.member_id = m.id AND s.state='confirmed' " +
          "WHERE m.discoverable=1 AND m.removed_at IS NULL AND m.id IN (SELECT member_id FROM source_access WHERE source_id=? AND revoked_at IS NULL) GROUP BY m.id")
        .bind(c.id)
        .all<{ id: string; skills: string | null }>()
    ).results;
    list.push({ title: c.title, enabled_at: c.enabled_at, messages: msgs, experts: people.map((p) => ({ id: p.id, skills: p.skills ? p.skills.split(",") : [] })) });
  }
  out.clubs = list;
  return { json: JSON.stringify(out, null, 2), messages, clubs: clubs.length };
}

/** "Позвать всех": the new address goes to everyone in the club, once per club per day (each send is an effect). */
export async function callEveryone(db: D1Database, sourceId: string, day: string): Promise<{ keys: string[]; url: string | null }> {
  const url = (await db.prepare("SELECT value FROM settings WHERE key=?").bind(`ark.move.${sourceId}`).first<{ value: string }>())?.value ?? null;
  if (!url) return { keys: [], url: null };
  const { results } = await db
    .prepare(
      "SELECT DISTINCT m.id, m.tg_id, m.lang FROM members m JOIN source_access a ON a.member_id = m.id AND a.source_id = ? AND a.revoked_at IS NULL " +
        "WHERE m.removed_at IS NULL AND m.collection_opt_out = 0 LIMIT 300",
    )
    .bind(sourceId)
    .all<{ id: string; tg_id: number; lang: Lang | null }>();
  const keys: string[] = [];
  for (const r of results) {
    const key = `ark-call:${sourceId}:${day}:${r.id}`;
    const m = T(r.lang ?? defaultLang());
    await effectStatement(db, key, r.tg_id, { text: m.arkCall(escapeHtml(url)) }).run();
    keys.push(key);
  }
  return { keys, url };
}

/** "Что бот знает обо мне": what is kept about this person, and what each part can remove. */
export async function knowsCard(db: D1Database, memberId: string, lang: Lang): Promise<{ text: string; buttons: InlineButton[][] }> {
  const m = T(lang);
  const [msgs, threads, skills, rsvps, needs, intros] = await db.batch([
    db.prepare("SELECT COUNT(*) AS n FROM passages WHERE author_id=? AND part=0 AND removed_at IS NULL").bind(memberId),
    db.prepare("SELECT COUNT(*) AS n FROM threads WHERE member_id=?").bind(memberId),
    db.prepare("SELECT COUNT(*) AS n FROM skills WHERE member_id=?").bind(memberId),
    db.prepare("SELECT COUNT(*) AS n FROM rsvps WHERE member_id=?").bind(memberId),
    db.prepare("SELECT COUNT(*) AS n FROM needs WHERE member_id=?").bind(memberId),
    db.prepare("SELECT COUNT(*) AS n FROM intros WHERE requester_id=? OR candidate_id=?").bind(memberId, memberId),
  ]);
  const n = (r: D1Result) => (r.results[0] as { n: number }).n;
  const lines = [
    `<b>${m.knowsTitle}</b>`,
    m.knowsMessages(n(msgs!)),
    m.knowsSkills(n(skills!)),
    m.knowsThreads(n(threads!)),
    m.knowsRsvps(n(rsvps!)),
    m.knowsIntros(n(needs!) + n(intros!)),
    "",
    m.knowsHowTo,
  ];
  const buttons: InlineButton[][] = [];
  if (n(skills!)) buttons.push([btn(m.bKnowSkills, "kn:skills")]);
  if (n(threads!)) buttons.push([btn(m.bKnowThreads, "kn:threads")]);
  if (n(rsvps!)) buttons.push([btn(m.bKnowRsvps, "kn:rsvps")]);
  return { text: lines.join("\n"), buttons };
}

/** Delete one part of what is kept about this person. Messages are removed by /forget_me, on purpose. */
export async function forgetPart(db: D1Database, memberId: string, part: string): Promise<boolean> {
  if (part === "skills") return (await db.prepare("DELETE FROM skills WHERE member_id=?").bind(memberId).run()).meta.changes > 0;
  if (part === "rsvps") return (await db.prepare("DELETE FROM rsvps WHERE member_id=?").bind(memberId).run()).meta.changes > 0;
  if (part === "threads") {
    await db.batch([
      db.prepare("DELETE FROM thread_events WHERE thread_id IN (SELECT id FROM threads WHERE member_id=?)").bind(memberId),
      db.prepare("DELETE FROM threads WHERE member_id=?").bind(memberId),
    ]);
    return true;
  }
  return false;
}
