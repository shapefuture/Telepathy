// The cron reports how many D1 queries a run used (Cloudflare's free-plan D1 docs say 50 per
// invocation). An ordinary minute must stay well under that.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { countingDb, runCron } from "../src/cron";
import { makeApp } from "../src/index";
import { dm, enableGroup, fakeTelegram, feed, groupMsg } from "./helpers";

describe("cron D1 queries", () => {
  it("counts queries (a batch once) and keeps an ordinary minute under 50", async () => {
    const c = countingDb(env.DB);
    await c.db.prepare("SELECT 1").first();
    await c.db.batch([c.db.prepare("SELECT 1"), c.db.prepare("SELECT 2").bind()]);
    expect(c.used()).toBe(2);

    const t = fakeTelegram();
    const app = makeApp(env as any, t.fetcher);
    await enableGroup(app);
    for (let u = 1; u <= 10; u++) {
      await feed(app, groupMsg(1000 + u, `message ${u} about visas`));
      await feed(app, dm(1000 + u, "/digest on"));
    }
    const first = await runCron(app);
    const ordinary = await runCron(app);
    expect(first.d1_queries).toBeGreaterThan(0);
    expect(ordinary.d1_queries).toBeLessThan(50);
  });
});
