// Rows each cron minute reads (D1 bills row reads; the free plan stops at 5M a day).
import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { runCron } from "../src/cron";
import { makeApp } from "../src/index";
import { enableGroup, fakeTelegram } from "./helpers";

function rowCounter(db: D1Database) {
  const per = new Map<string, number>();
  let total = 0;
  const add = (sql: string, meta: any) => {
    const r = Number(meta?.rows_read ?? 0);
    total += r;
    per.set(sql, (per.get(sql) ?? 0) + r);
  };
  const sqlOf = new WeakMap<object, string>();
  const wrap = (s: any, sql: string): any => {
    const px: any = new Proxy(s, {
      get(t, k) {
        const v = Reflect.get(t, k, t);
        if (k === "bind") return (...a: unknown[]) => wrap(v.apply(t, a), sql);
        if (k === "all" || k === "run") return async () => { const r = await v.call(t); add(sql, r.meta); return r; };
        if (k === "first") return async (col?: string) => { const r = await t.all(); add(sql, r.meta); const row = r.results[0] ?? null; return col ? (row ? row[col] : null) : row; };
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    sqlOf.set(px, sql);
    return px;
  };
  const real = new WeakMap<object, any>();
  const proxied = new Proxy(db, {
    get(t, k) {
      const v = Reflect.get(t, k, t);
      if (k === "prepare") return (sql: string) => { const s = v.call(t, sql); const p = wrap(s, sql); real.set(p, s); return p; };
      if (k === "batch") return async (l: any[]) => { const rs = await v.call(t, l); rs.forEach((r: any, i: number) => add("B " + (sqlOf.get(l[i]) ?? "?"), r.meta)); return rs; };
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  return { db: proxied as D1Database, total: () => total, per };
}

// D1's free plan allows 5M row reads a day; a cron running every minute gets about 3,500 a minute.
// Seeded with a busy community's data, on a Monday evening when the weekly Пульс is due.
it("an ordinary minute reads a few thousand rows at most, Monday evening included", async () => {
  const t = fakeTelegram();
  const base = makeApp(env as any, t.fetcher);
  await enableGroup(base);
  const src = (await env.DB.prepare("SELECT id FROM sources LIMIT 1").first<{ id: string }>())!.id;
  const now = Date.parse("2026-10-26T20:00:00Z"); // a Monday, after the digest hour
  const seq = (n: number) => `WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM s WHERE i<${n})`;
  await env.DB.batch([
    env.DB.prepare(`${seq(20000)} INSERT INTO passages(source_id,msg_id,part,author_id,body,event_at,reply_to,intent,intent_conf) SELECT ?1, 500000+i, 0, NULL, 'body '||i, strftime('%Y-%m-%dT%H:%M:%fZ', ?2/1000.0 - i*60, 'unixepoch'), CASE WHEN i%3=0 THEN 500000+i+1 END, CASE WHEN i%40=0 THEN 'help_request' END, 0.9 FROM s`).bind(src, now),
    env.DB.prepare(`${seq(30000)} INSERT INTO effects(id,key,chat_id,payload,state,created_at,updated_at) SELECT 'e'||i, CASE WHEN i%4=0 THEN 'route:x:'||i||':-' ELSE 'k:'||i END, i%500, '{}', 'sent', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z' FROM s`),
    env.DB.prepare(`${seq(2000)} INSERT INTO members(id,tg_id,created_at) SELECT 'm'||i, 900000+i, '2026-01-01' FROM s`),
    env.DB.prepare(`${seq(5000)} INSERT INTO needs(id,member_id,text,skills_json,status,expires_at,created_at) SELECT 'n'||i, 'm1', 't', '[]', 'closed', '2026-01-01', '2026-01-01' FROM s`),
    env.DB.prepare(`${seq(5000)} INSERT INTO intros(id,need_id,requester_id,candidate_id,status,created_at,updated_at,invite_expires_at) SELECT 'i'||i, 'n'||i, 'm1', 'm2', 'completed', '2026-01-01', '2026-01-01', '2026-01-01' FROM s`),
    env.DB.prepare(`${seq(20000)} INSERT INTO audit(at,action,subject) SELECT '2026-01-01', 'x.y', 's'||i FROM s`),
    env.DB.prepare(`${seq(300)} INSERT INTO history_pages(source_id,page,body,n) SELECT ?1, i, NULL, 100 FROM s`).bind(src),
  ]);
  await runCron(base, new Date(now)); // first minute does the once-a-day work and routes old questions
  const c = rowCounter(env.DB);
  await runCron({ ...base, db: c.db }, new Date(now + 60_000));
  const top = [...c.per].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([s, n]) => `${n} ${s.replace(/\s+/g, " ").slice(0, 120)}`);
  expect(c.total(), top.join("\n")).toBeLessThan(3000);
});
