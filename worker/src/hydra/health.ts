// H3: per-head and per-domain health from real deliveries and canaries. Deliberately simple:
// a rolling one-hour window per failure domain. A cron step turns "down" into incidents
// (regrow.ts), so senders never block on the regrowth logic.

import { HOUR, nowIso } from "../util";

export type DomainState = "up" | "degraded" | "down";
export const WINDOW_MS = HOUR;

export async function recordDomain(db: D1Database, domain: string, ok: boolean, now = new Date()): Promise<DomainState> {
  const ts = nowIso(now);
  const row = await db.prepare("SELECT state, ok, fail, window_start FROM domain_health WHERE domain=?").bind(domain).first<{ state: DomainState; ok: number; fail: number; window_start: string }>();
  const fresh = !row || now.getTime() - Date.parse(row.window_start) > WINDOW_MS;
  const okN = (fresh ? 0 : row!.ok) + (ok ? 1 : 0);
  const failN = (fresh ? 0 : row!.fail) + (ok ? 0 : 1);
  const total = okN + failN;
  const prev = row?.state ?? "up";
  let state: DomainState = prev;
  if (!ok && total >= 3 && failN / total >= 0.5) state = failN >= 5 || failN / total >= 0.8 ? "down" : "degraded";
  // Recovery needs evidence, not silence: two successes and failures under 20% in the window.
  if (ok && prev !== "up" && okN >= 2 && failN / total < 0.2) state = "up";
  await db
    .prepare("INSERT INTO domain_health(domain, state, ok, fail, window_start, changed_at) VALUES (?,?,?,?,?,?) ON CONFLICT(domain) DO UPDATE SET state=excluded.state, ok=excluded.ok, fail=excluded.fail, window_start=CASE WHEN ? THEN excluded.window_start ELSE domain_health.window_start END, changed_at=CASE WHEN domain_health.state<>excluded.state THEN excluded.changed_at ELSE domain_health.changed_at END")
    .bind(domain, state, okN, failN, ts, ts, fresh ? 1 : 0)
    .run();
  return state;
}

/** Force a state (canary verdicts, drills). */
export async function setDomainState(db: D1Database, domain: string, state: DomainState, now = new Date()): Promise<void> {
  const ts = nowIso(now);
  await db
    .prepare("INSERT INTO domain_health(domain, state, ok, fail, window_start, changed_at) VALUES (?,?,0,0,?,?) ON CONFLICT(domain) DO UPDATE SET state=excluded.state, changed_at=CASE WHEN domain_health.state<>excluded.state THEN excluded.changed_at ELSE domain_health.changed_at END")
    .bind(domain, state, ts, ts)
    .run();
}

export async function downDomains(db: D1Database): Promise<Set<string>> {
  return new Set((await db.prepare("SELECT domain FROM domain_health WHERE state='down'").all<{ domain: string }>()).results.map((r) => r.domain));
}

/** One head's result: three failures in a row = failing; "gone" (push 404/410) = dead. */
export async function recordHead(db: D1Database, registrationId: string, result: "ok" | "fail" | "gone", now = new Date()): Promise<void> {
  const ts = nowIso(now);
  if (result === "ok") await db.prepare("UPDATE delivery_registrations SET health='ok', fail_count=0, last_ok_at=? WHERE id=?").bind(ts, registrationId).run();
  else if (result === "gone") await db.prepare("UPDATE delivery_registrations SET health='dead', last_fail_at=? WHERE id=?").bind(ts, registrationId).run();
  else await db.prepare("UPDATE delivery_registrations SET fail_count=fail_count+1, last_fail_at=?, health=CASE WHEN fail_count+1>=3 THEN 'failing' ELSE health END WHERE id=?").bind(ts, registrationId).run();
}
