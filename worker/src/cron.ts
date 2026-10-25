// Scheduled work (every 5 minutes). Each step is idempotent and bounded so one run stays
// inside the free plan's CPU and subrequest limits; leftovers are picked up next run.

import { pruneCache } from "./ai/cache";
import type { App } from "./bot";
import { digestStep } from "./digest";
import { routeUnanswered, suggestSkills } from "./features";
import { digestHour, timezone } from "./env";
import { expireDue, sendReminders } from "./intros";
import { dispatchPending, recoverStuck } from "./outbox";
import { applyRetention } from "./rights";
import { liveCommitment, release } from "./assist/capacity";
import { expireMissions, revokeGrants } from "./assist/missions";
import { dispatchFed, expireExchanges, fedEnabled, partnerList, withdrawMission } from "./federation/gateway";
import { refreshPartner } from "./federation/keys";
import { dispatchAlerts } from "./continuity/alerts";
import { classify, dispatchInvites, runCanaries } from "./hydra/regrow";
import { dispatchAnnouncements } from "./hydra/notices";
import { runEscrow } from "./hydra/escrow";
import { deleteDue } from "./welcome";
import { remindHistory } from "./history";
import { watchSeals } from "./hydra/fed";
import { remindDrills } from "./hydra/chaos";
import { bucket, computeGaps, setGapStatus } from "./assist/gaps";
import { b, notifyOwners } from "./assist/notify";
import { escapeHtml } from "./text";
import { localParts, nowIso } from "./util";

// Subrequests per run stay under the free plan's 50: Telegram 24 + partners 5 + alert heads 5 +
// invites 3 + key checks 3 + canaries ≤4 + announcements ≤3 + one daily step (escrow ≤3 or seals ≤4).
export const SEND_BUDGET = 24;

/** Free plan: 50 subrequests per invocation. Keep a margin for D1-adjacent and retry calls. */
export const SUBREQUEST_LIMIT = 46;

/** D1 queries per cron run above which we log a warning (a batch counts once). */
export const D1_SOFT_LIMIT = 50;

/** Wraps D1 so the cron can see how many queries it has used. */
export function countingDb(db: D1Database): { db: D1Database; used: () => number } {
  let n = 0;
  const real = new WeakMap<object, D1PreparedStatement>();
  const stmt = (s: D1PreparedStatement): D1PreparedStatement => {
    const p = new Proxy(s, {
      get(t, k) {
        const v = Reflect.get(t, k, t);
        if (k === "bind") return (...a: unknown[]) => stmt((v as Function).apply(t, a));
        if (k === "first" || k === "all" || k === "run" || k === "raw") return (...a: unknown[]) => ((n += 1), (v as Function).apply(t, a));
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    real.set(p, s);
    return p;
  };
  const wrapped = new Proxy(db, {
    get(t, k) {
      const v = Reflect.get(t, k, t);
      if (k === "prepare") return (sql: string) => stmt((v as Function).call(t, sql));
      // Hand D1 its own statement objects; a batch counts as one query.
      if (k === "batch") return (list: D1PreparedStatement[]) => ((n += 1), (v as Function).call(t, list.map((x) => real.get(x) ?? x)));
      if (k === "exec") return (...a: unknown[]) => ((n += 1), (v as Function).apply(t, a));
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  return { db: wrapped, used: () => n };
}

export async function runCron(base: App, now = new Date()): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  // Count every outbound fetch (partners, email, push, ntfy, Matrix, escrow…) plus Telegram calls,
  // so later steps stop before the platform limit instead of recording false failures.
  let used = 0;
  const raw = base.net ?? ((u: string, i: RequestInit) => fetch(u, i));
  const d1 = countingDb(base.db);
  const app: App = { ...base, db: d1.db, net: (u, i) => ((used += 1), raw(u, i)) };
  app.budget = { left: () => SUBREQUEST_LIMIT - used - app.tg.calls };
  const step = async (name: string, fn: () => Promise<number>) => {
    try {
      out[name] = await fn();
    } catch (e) {
      console.error(`cron step ${name} failed`, String(e));
      out[name] = -1;
    }
  };
  await step("recovered", () => recoverStuck(app.db, now));
  await step("expired", async () => (await expireDue(app.db, nowIso(now))).length);
  await step("reminders", async () => (await sendReminders(app.db, nowIso(now))).length);
  await step("digest", async () => (await digestStep(app.db, now, timezone(app.env), digestHour(app.env))).keys.length);
  await step("ai_cache", () => pruneCache(app.db, now));
  await step("history_remind", () => remindHistory(app, now));
  await step("retention", async () => {
    const today = localParts(now, timezone(app.env)).date;
    const last = await app.db.prepare("SELECT value FROM settings WHERE key='retention.day'").first<{ value: string }>();
    if (last?.value === today) return 0;
    const n = await applyRetention(app.db, now);
    await app.db.prepare("INSERT INTO settings(key, value) VALUES ('retention.day', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(today).run();
    return n;
  });
  await step("routed", async () => (await routeUnanswered(app.db, now)).length);
  await step("suggestions", async () => {
    const today = localParts(now, timezone(app.env)).date;
    const last = await app.db.prepare("SELECT value FROM settings WHERE key='suggest.day'").first<{ value: string }>();
    if (last?.value === today) return 0;
    const n = (await suggestSkills(app.db, now)).length;
    await app.db.prepare("INSERT INTO settings(key, value) VALUES ('suggest.day', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(today).run();
    return n;
  });
  await step("missions_expired", async () => {
    const ids = await expireMissions(app.db, nowIso(now));
    for (const id of ids) {
      await revokeGrants(app.db, id);
      const c = await liveCommitment(app.db, { missionId: id });
      if (c) await release(app.db, c.id, "cancelled");
      await withdrawMission(app, id);
    }
    return ids.length;
  });
  await step("gaps", async () => {
    const today = localParts(now, timezone(app.env)).date;
    const last = await app.db.prepare("SELECT value FROM settings WHERE key='gaps.day'").first<{ value: string }>();
    if (last?.value === today) return 0;
    await app.db.prepare("INSERT INTO settings(key, value) VALUES ('gaps.day', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(today).run();
    const fresh = await computeGaps(app.db, now);
    for (const job of fresh) {
      const g = await app.db.prepare("SELECT members FROM gap_signals WHERE job_code=?").bind(job).first<{ members: number }>();
      await notifyOwners(app, `gap:${job}:${today}`, (a) => ({ text: a.gap(escapeHtml(job), bucket(g?.members ?? 0)), buttons: [[b(a.bGapOffer, `g:${job}:off`), b(a.bGapDismiss, `g:${job}:dis`)]] }));
      await setGapStatus(app.db, job, "notified");
    }
    return fresh.length;
  });
  await step("keys_checked", async () => {
    // Daily manifest check picks up proven key rotations (at most 3 partners per day per run).
    if (!fedEnabled(app.env)) return 0;
    const today = localParts(now, timezone(app.env)).date;
    const due = (await partnerList(app.db)).filter((p) => p.endpoint && p.status === "active" && (!p.manifest_checked_at || p.manifest_checked_at.slice(0, 10) < today)).slice(0, 3);
    for (const p of due) await refreshPartner(app, p, now, true);
    return due.length;
  });
  await step("exchanges_expired", () => expireExchanges(app.db, nowIso(now)));
  await step("fed_sent", () => dispatchFed(app));
  await step("alert_emails", () => (app.env.CONTINUITY_KEY ? dispatchAlerts(app, 5) : Promise.resolve(0)));
  if (app.env.CONTINUITY_KEY) {
    // Hydra: detect dead paths, invite regrowth, probe canaries, publish, and the daily duties.
    await step("hydra_incidents", () => classify(app, now));
    await step("hydra_invites", () => dispatchInvites(app, 3));
    await step("hydra_canaries", () => runCanaries(app, 2, now));
    await step("hydra_announce", () => dispatchAnnouncements(app, 1));
    const today = localParts(now, timezone(app.env)).date;
    const daily = (await app.db.prepare("SELECT value FROM settings WHERE key='hydra.day'").first<{ value: string }>())?.value;
    if (daily !== today && app.budget!.left() >= 10) {
      // Daily duties run on the first minute with room left; otherwise the next minute tries.
      await app.db.prepare("INSERT INTO settings(key, value) VALUES ('hydra.day', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(today).run();
      await step("hydra_escrow", () => runEscrow(app, now));
      await step("hydra_drills_due", () => remindDrills(app, now));
    } else await step("hydra_seals", () => watchSeals(app, now));
  }
  await step("welcome_cleanup", () => deleteDue(app, 5, now));
  await step("sent", () => dispatchPending(app.db, app.tg, Math.min(SEND_BUDGET, app.tg.calls + Math.max(0, app.budget!.left()))));
  // Cloudflare's docs disagree on the free-plan D1 cap (50 on the D1 page, 1000 for internal
  // services on the Workers page). Measure it, so a busy run is visible in the logs.
  out.d1_queries = d1.used();
  if (out.d1_queries > D1_SOFT_LIMIT) console.warn(`cron used ${out.d1_queries} D1 queries (free-plan D1 docs say 50)`);
  return out;
}
