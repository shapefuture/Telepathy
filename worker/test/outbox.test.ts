import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { dispatch, effectStatement, reconcile, recoverStuck } from "../src/outbox";
import { createTelegram } from "../src/telegram";
import { fakeTelegram } from "./helpers";

const state = async (key: string) => (await env.DB.prepare("SELECT state FROM effects WHERE key=?").bind(key).first<{ state: string }>())!.state;
const idOf = async (key: string) => (await env.DB.prepare("SELECT id FROM effects WHERE key=?").bind(key).first<{ id: string }>())!.id;

describe("effect ledger", () => {
  it("sends once even if dispatched twice; intents are idempotent by key", async () => {
    const t = fakeTelegram();
    await effectStatement(env.DB, "k1", 5, { text: "hi" }).run();
    await effectStatement(env.DB, "k1", 5, { text: "hi again" }).run();
    const tg = createTelegram("x", t.fetcher);
    expect(await dispatch(env.DB, tg, await idOf("k1"))).toBe("sent");
    expect(await dispatch(env.DB, tg, await idOf("k1"))).toBe("sent");
    expect(t.sent()).toHaveLength(1);
    expect(t.sent()[0]!.params.text).toBe("hi");
  });

  it("unknown network outcome -> uncertain, never resent automatically", async () => {
    const t = fakeTelegram({ fail: { sendMessage: "network" } });
    await effectStatement(env.DB, "k2", 5, { text: "hi" }).run();
    expect(await dispatch(env.DB, createTelegram("x", t.fetcher), await idOf("k2"))).toBe("uncertain");
    const ok = fakeTelegram();
    expect(await dispatch(env.DB, createTelegram("x", ok.fetcher), await idOf("k2"))).toBe("uncertain");
    expect(ok.sent()).toHaveLength(0);
    expect(await reconcile(env.DB, await idOf("k2"), true, "seen in chat")).toBe(true);
    expect(await state("k2")).toBe("reconciled");
  });

  it("403 is a definite failure; 429 goes back to pending", async () => {
    await effectStatement(env.DB, "k3", 5, { text: "a" }).run();
    await effectStatement(env.DB, "k4", 5, { text: "b" }).run();
    expect(await dispatch(env.DB, createTelegram("x", fakeTelegram({ fail: { sendMessage: 403 } }).fetcher), await idOf("k3"))).toBe("failed");
    expect(await dispatch(env.DB, createTelegram("x", fakeTelegram({ fail: { sendMessage: 429 } }).fetcher), await idOf("k4"))).toBe("pending");
  });

  it("a crash mid-send becomes uncertain after 5 minutes", async () => {
    await effectStatement(env.DB, "k5", 5, { text: "a" }).run();
    await env.DB.prepare("UPDATE effects SET state='dispatching', updated_at='2026-01-01T00:00:00Z' WHERE key='k5'").run();
    expect(await recoverStuck(env.DB, new Date("2026-01-01T00:04:00Z"))).toBe(0);
    expect(await recoverStuck(env.DB, new Date("2026-01-01T00:06:00Z"))).toBe(1);
    expect(await state("k5")).toBe("uncertain");
  });

  it("reveal payloads get a live contact line; username is not stored", async () => {
    const t = fakeTelegram();
    await effectStatement(env.DB, "k6", 5, { text: "connected", reveal_tg_id: 42 }).run();
    await dispatch(env.DB, createTelegram("x", t.fetcher), await idOf("k6"));
    expect(t.sent()[0]!.params.text).toContain("@expert_user");
    const row = await env.DB.prepare("SELECT payload FROM effects WHERE key='k6'").first<{ payload: string }>();
    expect(row!.payload).not.toContain("expert_user");
  });
});
