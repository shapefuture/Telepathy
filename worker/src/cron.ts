// Scheduled work (every 5 minutes). Each step is idempotent and bounded so one run stays
// inside the free plan's CPU and subrequest limits; leftovers are picked up next run.

import type { App } from "./bot";
import { digestStep } from "./digest";
import { routeUnanswered, suggestSkills } from "./features";
import { digestHour, timezone } from "./env";
import { expireDue, sendReminders } from "./intros";
import { dispatchPending, recoverStuck } from "./outbox";
import { applyRetention } from "./rights";
import { localParts, nowIso } from "./util";

export const SEND_BUDGET = 40; // Telegram calls per run (free plan allows 50 subrequests)

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
  await step("sent", () => dispatchPending(app.db, app.tg, SEND_BUDGET));
  return out;
}
