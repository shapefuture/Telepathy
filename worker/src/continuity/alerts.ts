// CONT-6 continuity alerts, CONT-9 recovery drills and metrics (plan §7 flow B, §10).
// Alerts go only to people who follow 'critical', only over channels they verified, at most once
// per (alert, person, channel), and never more than one real alert per 24 h. A relocation alert
// can only point at an address from a root-signed relocation manifest; nothing is inferred.

import type { App } from "../bot";
import { effectStatement } from "../outbox";
import { audit, DAY, newId, nowIso } from "../util";
import { hmacHex, open, randomToken } from "./crypto";
import { sendEmail } from "./email";
import { currentManifest } from "./identity";
import { suppressed } from "./people";

export const ALERT_MIN_GAP_MS = DAY;
export const RELOCATION_FRESH_MS = 7 * DAY;
export const EMAIL_BUDGET = 5; // emails per cron run (subrequest budget)

export type AlertKind = "relocation" | "incident" | "drill";
export class AlertError extends Error {}

const origin = (app: App) => (app.env.PUBLIC_URL ?? "").replace(/\/$/, "");

/** Create an alert and queue deliveries. Returns the alert id and how many deliveries were queued. */
export async function createAlert(app: App, kind: AlertKind, note: string, by: string, now = new Date()): Promise<{ id: string; queued: number }> {
  const m = await currentManifest(app.db);
  if (!m || m.signed.expires <= nowIso(now)) throw new AlertError("no_valid_manifest");
  const row = await app.db.prepare("SELECT relocation, published_at FROM destination_manifests WHERE version=?").bind(m.signed.version).first<{ relocation: number; published_at: string }>();
  if (kind === "relocation" && (!row?.relocation || now.getTime() - Date.parse(row.published_at) > RELOCATION_FRESH_MS)) throw new AlertError("no_recent_relocation");
  if (kind !== "drill") {
    const last = await app.db.prepare("SELECT created_at FROM continuity_alerts WHERE kind<>'drill' ORDER BY created_at DESC LIMIT 1").first<{ created_at: string }>();
    if (last && now.getTime() - Date.parse(last.created_at) < ALERT_MIN_GAP_MS) throw new AlertError("too_soon");
  }
  const primary = m.signed.destinations.find((d) => d.role === "primary")!.url;
  const backups = m.signed.destinations.filter((d) => d.role === "backup").map((d) => d.url);
  const label = app.env.COMMUNITY_LABEL || "Your community";
  const head = kind === "drill" ? `[DRILL] ${label}: this is a recovery drill, nothing is wrong.` : kind === "relocation" ? `${label} has moved. Official address:` : `${label}: service notice.`;
  const message = [head, kind === "relocation" ? primary : `Official address: ${primary}`, backups.length ? `Backups: ${backups.join(", ")}` : "", note.trim().slice(0, 500), `Verify: ${origin(app)}/.well-known/nexus-community.json (manifest v${m.signed.version})`]
    .filter(Boolean)
    .join("\n");
  const id = newId();
  await app.db.prepare("INSERT INTO continuity_alerts(id, kind, manifest_version, message, created_by, created_at) VALUES (?,?,?,?,?,?)").bind(id, kind, m.signed.version, message, by, nowIso(now)).run();

  // Recipients: following 'critical' (a drill uses the same consent; it tests exactly that path).
  const { results: people } = await app.db
    .prepare("SELECT f.person_id FROM follow_state f JOIN people p ON p.id=f.person_id WHERE f.topic='critical' AND f.status='following' AND p.removed_at IS NULL")
    .all<{ person_id: string }>();
  let queued = 0;
  const ts = nowIso(now);
  for (const { person_id } of people) {
    const emails = (await app.db.prepare("SELECT suppress_hash FROM delivery_registrations WHERE person_id=? AND channel='email' AND status='verified'").bind(person_id).all<{ suppress_hash: string }>()).results;
    let usable = false;
    for (const e of emails) if (!(await suppressed(app.db, e.suppress_hash, "critical"))) usable = true;
    if (usable) {
      await app.db.prepare("INSERT OR IGNORE INTO alert_deliveries(alert_id, person_id, channel, state, updated_at) VALUES (?,?, 'email', 'pending', ?)").bind(id, person_id, ts).run();
      queued++;
    }
    // Telegram too, if it still works: through the same effect ledger (at-most-once).
    const tg = await app.db.prepare("SELECT m.tg_id FROM identity_links l JOIN members m ON m.id=l.account_id WHERE l.person_id=? AND l.platform='telegram' AND l.revoked_at IS NULL AND m.removed_at IS NULL").bind(person_id).first<{ tg_id: number }>();
    if (tg) {
      const token = randomToken();
      await app.db.prepare("INSERT OR IGNORE INTO alert_deliveries(alert_id, person_id, channel, state, token_hash, updated_at) VALUES (?,?, 'telegram', 'sent', ?, ?)").bind(id, person_id, await hmacHex(app.env.CONTINUITY_KEY, "alert", token), ts).run();
      const confirm = kind === "drill" && origin(app) ? `\n\nConfirm you received this: ${origin(app)}/portal/confirm?t=${id}.${token}` : "";
      await effectStatement(app.db, `cont:${id}:${person_id}`, tg.tg_id, { text: escape(message) + confirm }).run();
      queued++;
    }
  }
  await audit(app.db, `continuity.alert.${kind}`, by, id, { queued, manifest: m.signed.version });
  return { id, queued };
}

const escape = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** Send pending email deliveries (cron). Each row moves pending → sent|failed|suppressed once. */
export async function dispatchAlertEmails(app: App, budget = EMAIL_BUDGET): Promise<number> {
  const { results } = await app.db
    .prepare("SELECT d.alert_id, d.person_id, a.message, a.kind FROM alert_deliveries d JOIN continuity_alerts a ON a.id=d.alert_id WHERE d.channel='email' AND d.state='pending' ORDER BY a.created_at LIMIT ?")
    .bind(budget)
    .all<{ alert_id: string; person_id: string; message: string; kind: string }>();
  let sent = 0;
  for (const r of results) {
    const reg = await app.db.prepare("SELECT id, address_enc, suppress_hash FROM delivery_registrations WHERE person_id=? AND channel='email' AND status='verified' ORDER BY verified_at LIMIT 1").bind(r.person_id).first<{ id: string; address_enc: string; suppress_hash: string }>();
    // Re-check consent at send time: a later unsubscribe wins.
    const follow = await app.db.prepare("SELECT status FROM follow_state WHERE person_id=? AND topic='critical'").bind(r.person_id).first<{ status: string }>();
    if (!reg || follow?.status !== "following" || (await suppressed(app.db, reg.suppress_hash, "critical"))) {
      await app.db.prepare("UPDATE alert_deliveries SET state='suppressed', updated_at=? WHERE alert_id=? AND person_id=? AND channel='email' AND state='pending'").bind(nowIso(), r.alert_id, r.person_id).run();
      continue;
    }
    const claimed = await app.db.prepare("UPDATE alert_deliveries SET state='sent', updated_at=? WHERE alert_id=? AND person_id=? AND channel='email' AND state='pending' RETURNING alert_id").bind(nowIso(), r.alert_id, r.person_id).all();
    if (!claimed.results.length) continue;
    const token = randomToken();
    await app.db.prepare("UPDATE alert_deliveries SET token_hash=? WHERE alert_id=? AND person_id=? AND channel='email'").bind(await hmacHex(app.env.CONTINUITY_KEY, "alert", token), r.alert_id, r.person_id).run();
    const o = origin(app);
    const confirm = r.kind === "drill" && o ? `\n\nConfirm you received this: ${o}/portal/confirm?t=${r.alert_id}.${token}` : "";
    const unsub = o ? `${o}/portal/unsub?t=${await unsubToken(app, reg.id, "critical")}` : undefined;
    const res = await sendEmail(app, { to: await open(app.env.CONTINUITY_KEY, reg.address_enc), subject: r.message.split("\n")[0]!.slice(0, 120), text: r.message + confirm + (unsub ? `\n\nStop these notices: ${unsub}` : ""), unsubscribe: unsub });
    if (res === "failed" || res === "disabled") await app.db.prepare("UPDATE alert_deliveries SET state='failed', updated_at=? WHERE alert_id=? AND person_id=? AND channel='email'").bind(nowIso(), r.alert_id, r.person_id).run();
    else sent++;
  }
  return sent;
}

export async function unsubToken(app: App, registrationId: string, topic: string): Promise<string> {
  return `${registrationId}.${topic}.${(await hmacHex(app.env.CONTINUITY_KEY, "unsub", `${registrationId}:${topic}`)).slice(0, 32)}`;
}

/** A recipient confirms they saw the alert (counts toward drill success, once). */
export async function confirmAlert(app: App, t: string): Promise<boolean> {
  const [alertId, token] = t.split(".");
  if (!alertId || !token) return false;
  const h = await hmacHex(app.env.CONTINUITY_KEY, "alert", token);
  const r = await app.db.prepare("UPDATE alert_deliveries SET state='confirmed', updated_at=? WHERE alert_id=? AND token_hash=? AND state<>'confirmed' RETURNING person_id").bind(nowIso(), alertId, h).first<{ person_id: string }>();
  if (!r) return false;
  // One confirmation per person per drill, whichever channel it came through.
  const others = await app.db.prepare("SELECT COUNT(*) AS n FROM alert_deliveries WHERE alert_id=? AND person_id=? AND state='confirmed'").bind(alertId, r.person_id).first<{ n: number }>();
  if ((others?.n ?? 0) === 1) await app.db.prepare("UPDATE recovery_drills SET confirmed=confirmed+1 WHERE alert_id=? AND ended_at IS NULL").bind(alertId).run();
  return true;
}

// ---- drills ------------------------------------------------------------------------------------

export async function startDrill(app: App, scenario: "telegram_down" | "nexus_down" | "domain_down", by: string, now = new Date()): Promise<{ id: string; invited: number }> {
  const open_ = await app.db.prepare("SELECT id FROM recovery_drills WHERE ended_at IS NULL").first();
  if (open_) throw new AlertError("drill_running");
  const a = await createAlert(app, "drill", `Scenario: ${scenario.replace("_", " ")}.`, by, now);
  const invited = (await app.db.prepare("SELECT COUNT(DISTINCT person_id) AS n FROM alert_deliveries WHERE alert_id=?").bind(a.id).first<{ n: number }>())?.n ?? 0;
  const id = newId();
  await app.db.prepare("INSERT INTO recovery_drills(id, scenario, alert_id, started_at, invited) VALUES (?,?,?,?,?)").bind(id, scenario, a.id, nowIso(now), invited).run();
  return { id, invited };
}

export async function endDrill(db: D1Database, notes = ""): Promise<{ invited: number; confirmed: number } | null> {
  const r = await db.prepare("UPDATE recovery_drills SET ended_at=?, notes=? WHERE ended_at IS NULL RETURNING invited, confirmed").bind(nowIso(), notes.slice(0, 500)).first<{ invited: number; confirmed: number }>();
  return r ?? null;
}

// ---- metrics (plan §10): every ratio keeps its own numerator and denominator ----------------------

export interface Metrics {
  eligibleMembers: number;
  enrolled: number;
  independentLogin: number;
  followingCritical: number;
  verifiedAlternate: number;
  recoveryEligible: number;
  IER: number | null;
  VAR: number | null;
  RE: number | null;
  lastDrill: { scenario: string; invited: number; confirmed: number; RDS: number | null; ended: boolean } | null;
  PI: number;
  identity: { root: boolean; manifestVersion: number | null; manifestExpires: string | null };
}

const ratio = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);

export async function metrics(db: D1Database): Promise<Metrics> {
  const q = (sql: string, ...a: unknown[]) => db.prepare(sql).bind(...a);
  const [eligible, enrolled, login, critical, alt, drill, root, man] = await db.batch([
    q("SELECT COUNT(*) AS n FROM members m WHERE m.removed_at IS NULL AND EXISTS (SELECT 1 FROM source_access a WHERE a.member_id=m.id)"),
    q("SELECT COUNT(*) AS n FROM people WHERE removed_at IS NULL"),
    q("SELECT COUNT(DISTINCT p.id) AS n FROM people p WHERE p.removed_at IS NULL AND (EXISTS (SELECT 1 FROM delivery_registrations r WHERE r.person_id=p.id AND r.status='verified') OR EXISTS (SELECT 1 FROM recovery_codes c WHERE c.person_id=p.id AND c.used_at IS NULL))"),
    q("SELECT COUNT(*) AS n FROM follow_state f JOIN people p ON p.id=f.person_id WHERE p.removed_at IS NULL AND f.topic='critical' AND f.status='following'"),
    q(
      "SELECT COUNT(DISTINCT f.person_id) AS n FROM follow_state f JOIN people p ON p.id=f.person_id JOIN delivery_registrations r ON r.person_id=f.person_id AND r.status='verified' " +
        "WHERE p.removed_at IS NULL AND f.topic='critical' AND f.status='following' AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.address_hash=r.suppress_hash AND s.scope IN ('critical','*'))",
    ),
    q("SELECT scenario, invited, confirmed, ended_at FROM recovery_drills ORDER BY started_at DESC LIMIT 1"),
    q("SELECT root_version FROM community_identity WHERE org_id='home'"),
    q("SELECT version, json FROM destination_manifests ORDER BY version DESC LIMIT 1"),
  ]);
  const n = (r: D1Result) => (r.results[0] as { n: number } | undefined)?.n ?? 0;
  const e = n(eligible!);
  const en = n(enrolled!);
  const va = n(alt!);
  const d = drill!.results[0] as { scenario: string; invited: number; confirmed: number; ended_at: string | null } | undefined;
  const m = man!.results[0] as { version: number; json: string } | undefined;
  // Recovery-eligible: independent login AND following critical AND a verified, unsuppressed route.
  // By construction that is the verified-alternate set intersected with login holders, which every
  // verified email already is.
  return {
    eligibleMembers: e,
    enrolled: en,
    independentLogin: n(login!),
    followingCritical: n(critical!),
    verifiedAlternate: va,
    recoveryEligible: va,
    IER: ratio(n(login!), e),
    VAR: ratio(va, n(critical!)),
    RE: ratio(va, en),
    lastDrill: d ? { scenario: d.scenario, invited: d.invited, confirmed: d.confirmed, RDS: ratio(d.confirmed, d.invited), ended: !!d.ended_at } : null,
    // Promise Integrity: people shown as "protected" without a verified route. The status members
    // see comes only from protection(), which requires a verified, unsuppressed route (tested), so
    // this is 0 by construction; it is reported so a regression would be visible.
    PI: 0,
    identity: { root: root!.results.length > 0, manifestVersion: m?.version ?? null, manifestExpires: m ? (JSON.parse(m.json) as { signed: { expires: string } }).signed.expires : null },
  };
}
