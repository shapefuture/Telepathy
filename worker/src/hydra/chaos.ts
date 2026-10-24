// H7 chaos practice: failure as routine.
//   head_off      monthly: one channel switched off for a random test cohort; measures who is still
//                 reached (confirmations) and how many add a head when invited (regrowth ratio)
//   telegram_down quarterly: the existing end-to-end drill (portal, two-factor owner login)
//   nexus_down    yearly: restore on the non-Cloudflare node from escrow (docs/HYDRA.md)
//   custodians    yearly: root key rotation with `npm run identity -- root-next`
// The calendar only reminds owners; a drill that messages members is always started by a human.

import type { App } from "../bot";
import { notifyOwners } from "../assist/notify";
import { DAY, newId, nowIso } from "../util";
import { AlertError, createAlert } from "../continuity/alerts";
import { openIncident } from "./regrow";
import { regrowth, type RegrowthRow } from "./graph";

export const CALENDAR: { type: string; everyDays: number; how: string }[] = [
  { type: "head_off", everyDays: 30, how: "/drill start head_off email 20" },
  { type: "telegram_down", everyDays: 91, how: "/drill start telegram_down" },
  { type: "nexus_down", everyDays: 365, how: "restore from escrow on the standby node (docs/HYDRA.md §Yearly)" },
  { type: "custodians", everyDays: 365, how: "npm run identity -- root-next (OPERATOR_GUIDE)" },
];
export const HEAD_CHANNELS = ["email", "telegram", "webpush", "ntfy", "matrix", "sms"];

export async function dueDrills(db: D1Database, now = new Date()): Promise<{ type: string; last: string | null; how: string }[]> {
  const out: { type: string; last: string | null; how: string }[] = [];
  for (const c of CALENDAR) {
    const last =
      c.type === "custodians" || c.type === "nexus_down"
        ? ((await db.prepare("SELECT value FROM settings WHERE key=?").bind(`hydra.last.${c.type}`).first<{ value: string }>())?.value ?? null)
        : ((await db.prepare("SELECT MAX(started_at) AS t FROM recovery_drills WHERE scenario=?").bind(c.type).first<{ t: string | null }>())?.t ?? null);
    if (!last || now.getTime() - Date.parse(last) > c.everyDays * DAY) out.push({ type: c.type, last, how: c.how });
  }
  return out;
}

/** Owners record an off-Worker drill (nexus_down restore, custodian rotation) as done. */
export async function markDrillDone(db: D1Database, type: string, now = new Date()): Promise<boolean> {
  if (type !== "nexus_down" && type !== "custodians") return false;
  await db.prepare("INSERT INTO settings(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(`hydra.last.${type}`, nowIso(now)).run();
  return true;
}

/** Cron (daily): remind owners once a month per overdue drill. */
export async function remindDrills(app: App, now = new Date()): Promise<number> {
  const due = await dueDrills(app.db, now);
  if (!due.length) return 0;
  const month = nowIso(now).slice(0, 7);
  await notifyOwners(app, `hydra:cal:${month}:${due.map((d) => d.type).join(",")}`, () => ({
    text: `🗓 <b>Drills due</b> (practice keeps every path alive):\n${due.map((d) => `· ${d.type}${d.last ? ` (last ${d.last.slice(0, 10)})` : " (never)"}: <code>${d.how}</code>`).join("\n")}`,
  }));
  return due.length;
}

/**
 * Start a head-off drill: pick a random cohort (pct % of people following critical notices who have
 * that channel), send a drill notice to everyone with the channel off for the cohort, and open a
 * drilled incident so the cohort gets "add two heads" invitations through their other heads.
 */
export async function startHeadOffDrill(app: App, channel: string, pct: number, by: string, now = new Date()): Promise<{ id: string; cohort: number; queued: number }> {
  if (!HEAD_CHANNELS.includes(channel)) throw new AlertError("channel");
  if (await app.db.prepare("SELECT id FROM recovery_drills WHERE ended_at IS NULL").first()) throw new AlertError("drill_running");
  const candidates =
    channel === "telegram"
      ? (await app.db.prepare("SELECT DISTINCT f.person_id AS id FROM follow_state f JOIN identity_links l ON l.person_id=f.person_id AND l.platform='telegram' AND l.revoked_at IS NULL WHERE f.topic='critical' AND f.status='following'").all<{ id: string }>()).results
      : (await app.db.prepare("SELECT DISTINCT f.person_id AS id FROM follow_state f JOIN delivery_registrations r ON r.person_id=f.person_id AND r.channel=? AND r.status='verified' WHERE f.topic='critical' AND f.status='following'").bind(channel).all<{ id: string }>()).results;
  if (!candidates.length) throw new AlertError("no_cohort");
  const size = Math.max(1, Math.round((candidates.length * Math.min(100, Math.max(1, pct))) / 100));
  const shuffled = candidates.map((c) => ({ c, r: crypto.getRandomValues(new Uint32Array(1))[0]! })).sort((a, b) => a.r - b.r).slice(0, size).map((x) => x.c.id);
  const cohort = new Set(shuffled);
  const alert = await createAlert(app, "drill", `Scenario: ${channel} unavailable for a test group.`, by, now, { without: { channel, people: cohort } });
  const id = newId();
  const incident = await openIncident(app, `via:${channel}`, { cause: "drill", drillId: id, cohort, now, tagChannels: true });
  await app.db.batch([
    app.db.prepare("INSERT INTO recovery_drills(id, scenario, alert_id, started_at, invited, channel, incident_id) VALUES (?, 'head_off', ?,?,?,?,?)").bind(id, alert.id, nowIso(now), cohort.size, channel, incident),
    ...shuffled.map((p) => app.db.prepare("INSERT INTO drill_cohort(drill_id, person_id) VALUES (?,?)").bind(id, p)),
  ]);
  return { id, cohort: cohort.size, queued: alert.queued };
}

export interface DrillResult {
  scenario: string;
  invited: number;
  confirmed: number;
  reachedPct: number | null;
  regrowth: RegrowthRow | null;
}

/** End the running drill. For head-off drills, "reached" counts only the cohort. */
export async function endAnyDrill(app: App, notes = "", now = new Date()): Promise<DrillResult | null> {
  const d = await app.db.prepare("UPDATE recovery_drills SET ended_at=?, notes=? WHERE ended_at IS NULL RETURNING id, scenario, alert_id, invited, confirmed, incident_id").bind(nowIso(now), notes.slice(0, 500)).first<{ id: string; scenario: string; alert_id: string; invited: number; confirmed: number; incident_id: string | null }>();
  if (!d) return null;
  let confirmed = d.confirmed;
  if (d.scenario === "head_off") {
    confirmed = (await app.db.prepare("SELECT COUNT(DISTINCT a.person_id) AS n FROM alert_deliveries a JOIN drill_cohort c ON c.person_id=a.person_id AND c.drill_id=? WHERE a.alert_id=? AND a.state='confirmed'").bind(d.id, d.alert_id).first<{ n: number }>())?.n ?? 0;
    await app.db.prepare("UPDATE recovery_drills SET confirmed=? WHERE id=?").bind(confirmed, d.id).run();
  }
  if (d.incident_id) await app.db.prepare("UPDATE head_incidents SET state='recovered', recovered_at=? WHERE id=? AND state='open'").bind(nowIso(now), d.incident_id).run();
  return { scenario: d.scenario, invited: d.invited, confirmed, reachedPct: d.invited ? Math.round((confirmed / d.invited) * 1000) / 10 : null, regrowth: d.incident_id ? await regrowth(app.db, d.incident_id) : null };
}
