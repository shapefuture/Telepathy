// Scheduled work (every 5 minutes). Each step is idempotent and bounded so one run stays
// inside the free plan's CPU and subrequest limits; leftovers are picked up next run.

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
import { bucket, computeGaps, setGapStatus } from "./assist/gaps";
import { b, notifyOwners } from "./assist/notify";
import { escapeHtml } from "./text";
import { localParts, nowIso } from "./util";

export const SEND_BUDGET = 36; // Telegram calls per run; with FED_BUDGET (5) stays under the 50-subrequest free limit

export async function runCron(app: App, now = new Date()): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
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
  await step("sent", () => dispatchPending(app.db, app.tg, SEND_BUDGET));
  return out;
}
