export const nowIso = (d: Date = new Date()): string => d.toISOString().replace(/\.\d{3}Z$/, "Z");

export const newId = (): string => crypto.randomUUID().replaceAll("-", "");

export const addMs = (iso: string, ms: number): string => nowIso(new Date(Date.parse(iso) + ms));

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/** Local calendar date and hour in an IANA timezone (DST-safe via Intl). */
export function localParts(d: Date, tz: string): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}

/** Minutes the timezone is ahead of UTC at that instant (e.g. +180 for Asia/Jerusalem in summer). */
export function tzOffsetMinutes(d: Date, tz: string): number {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(d);
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value);
  return Math.round((Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute")) - Math.floor(d.getTime() / 60_000) * 60_000) / 60_000);
}

/** Constant-time string comparison for secrets. */
export function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export async function audit(
  db: D1Database,
  action: string,
  actor: string | null,
  subject: string | null,
  detail?: unknown,
): Promise<void> {
  await db
    .prepare("INSERT INTO audit(at, actor, action, subject, detail) VALUES (?,?,?,?,?)")
    .bind(nowIso(), actor, action, subject, detail === undefined ? null : JSON.stringify(detail))
    .run();
}
