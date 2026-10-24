// P14-08..P14-12: conformance vectors, SDK as an independent node, ledger, gap signals,
// key rotation, A2A transport, case tagging.

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import * as sdk from "../../contracts/sdk/nexus.mjs";
import V from "../../contracts/test-vectors/nexus-v1.json";
import { computeGaps, bucket, GAP_MIN_MEMBERS } from "../src/assist/gaps";
import { balanced, parsePrice, post, reverse, balances } from "../src/assist/ledger";
import { createDraft, transition } from "../src/assist/missions";
import { ensureMember } from "../src/acl";
import { runCron } from "../src/cron";
import type { Env } from "../src/env";
import { canonical, checkShape, generateKeys, sign, verifySignature, type FedMessage } from "../src/federation/envelope";
import { dispatchFed } from "../src/federation/gateway";
import { handleFetch, makeApp } from "../src/index";
import { dm, enableGroup, fakeTelegram, feed, groupMsg, OWNER, press } from "./helpers";

const A_ID = "https://club-a.example";
const B_ID = "https://club-b.example";
let KA: { privateKey: string; publicKey: string };
let KB: { privateKey: string; publicKey: string };
beforeAll(async () => {
  KA = await generateKeys();
  KB = await generateKeys();
});
const q = <T>(sql: string, ...args: unknown[]) => env.DB.prepare(sql).bind(...args).first<T>();

function node(manifest?: () => unknown, enabled = true) {
  const t = fakeTelegram();
  const outbound: { url: string; body: FedMessage }[] = [];
  const net = async (url: string, init: RequestInit) => {
    if (url.endsWith("/.well-known/nexus-node.json")) return Response.json(manifest?.() ?? {});
    outbound.push({ url, body: JSON.parse(String(init.body)) });
    return Response.json({ ok: true }, { status: 202 });
  };
  const e: Env = enabled ? { ...(env as unknown as Env), FEDERATION_ENABLED: "true", PUBLIC_URL: A_ID, FEDERATION_PRIVATE_KEY: KA.privateKey, FEDERATION_PUBLIC_KEY: KA.publicKey } : (env as unknown as Env);
  const app = makeApp(e, t.fetcher, net);
  const post = (path: string, msg: unknown) => handleFetch(new Request(A_ID + path, { method: "POST", body: JSON.stringify(msg) }), e, t.fetcher, net);
  const texts = (chat: number) => t.sent(chat).map((c) => c.params.text as string);
  return { app, e, t, net, outbound, post, texts };
}

async function withPartner(n: ReturnType<typeof node>, cats = "*") {
  await enableGroup(n.app);
  await feed(n.app, groupMsg(OWNER, "hi"));
  await feed(n.app, dm(OWNER, `/partner add ${B_ID} ${KB.publicKey} ${cats} Club B`));
}

/** Club B, built only with the published SDK. */
const sdkMsg = (type: sdk.MessageType, ex: string, body: Record<string, unknown>, key = KB.privateKey) => sdk.sign(sdk.buildMessage({ type, exchangeId: ex, issuer: B_ID, recipient: A_ID, body }), key);
const sdkInquiry = (ex: string, job = "accounting", key = KB.privateKey) => sdkMsg("inquiry", ex, sdk.inquiryBody({ missionRef: `r-${ex}`, job, summary: "Bookkeeping help for a bakery" }), key);
const approval = (ex: string) => sdkMsg("approval", ex, { consent: { action: "reveal", fields: ["contact"], purpose: "connect_helper" }, contact: "tg://user?id=777" });

describe("conformance vectors (P14-08)", () => {
  it("the Worker reproduces canonical form and signature, and agrees on every case", async () => {
    expect(canonical(V.message)).toBe(V.canonical);
    expect((await sign(V.message as FedMessage, V.private_key_pkcs8)).signature).toBe(V.signature);
    for (const c of V.verify_cases) expect(await verifySignature({ ...V.message, signature: V.signature, ...c.patch } as FedMessage, V.public_key)).toBe(c.expect);
    for (const c of V.shape_cases) expect(checkShape({ ...V.message, ...c.patch }, Date.parse(V.now))).toBe(c.expect);
  });
  it("the SDK agrees with the Worker", async () => {
    expect(sdk.canonical(V.message)).toBe(V.canonical);
    expect((await sdk.sign(V.message as sdk.NexusMessage, V.private_key_pkcs8)).signature).toBe(V.signature);
  });
});

describe("independent SDK node talks to the gateway (S6)", () => {
  it("SDK-built inquiry and approval complete a provider-side exchange", async () => {
    const n = node();
    await withPartner(n);
    await feed(n.app, dm(OWNER, "/offer add accounting 1 reciprocal Bookkeeping review"));
    const offer = (await q<{ id: string }>("SELECT id FROM capability_offers"))!.id;
    expect((await n.post("/v1/opportunities/inquiries", await sdkInquiry("s1"))).status).toBe(202);
    const inId = (await q<{ id: string }>("SELECT id FROM federation_exchanges"))!.id;
    await feed(n.app, press(OWNER, `x:${inId}:o:${offer}`));
    await dispatchFed(n.app);
    const off = n.outbound.at(-1)!.body;
    expect(await sdk.verify(off as sdk.NexusMessage, KA.publicKey)).toBe(true); // B can verify A
    expect(off.body.terms).toEqual({ mode: "reciprocal" });
    expect((await n.post(sdk.pathFor(await approval("s1")), await approval("s1"))).status).toBe(202);
    await feed(n.app, press(OWNER, `x:${inId}:v`));
    // Ledger: B owes us one reciprocal credit; delivering again doesn't post twice.
    expect(await balances(env.DB)).toEqual([{ account: `partner:${B_ID}`, unit: "credit", amount: 1 }]);
    await feed(n.app, press(OWNER, `x:${inId}:v`));
    expect(await q("SELECT COUNT(*) AS n FROM ledger_txns")).toEqual({ n: 1 });
  });
});

describe("ledger (P14-09)", () => {
  it("only balanced transactions post, each key once, reversal once", async () => {
    expect(balanced([{ account: "home", unit: "EUR", amount: 5 }, { account: "partner:x", unit: "EUR", amount: -5 }])).toBe(true);
    expect(balanced([{ account: "home", unit: "EUR", amount: 5 }, { account: "partner:x", unit: "USD", amount: -5 }])).toBe(false);
    expect(balanced([{ account: "home", unit: "eur", amount: 5 }, { account: "x", unit: "eur", amount: -5 }])).toBe(false);
    await expect(post(env.DB, "k", "adjustment", [{ account: "home", unit: "credit", amount: 1 }], "", "t")).rejects.toThrow("unbalanced");
    const e = [{ account: "home", unit: "credit", amount: 2 }, { account: "partner:x", unit: "credit", amount: -2 }];
    const id = await post(env.DB, "k1", "adjustment", e, "m", "t");
    expect(id).not.toBeNull();
    expect(await post(env.DB, "k1", "adjustment", e, "m", "t")).toBeNull();
    expect(await q("SELECT COUNT(*) AS n FROM ledger_entries")).toEqual({ n: 2 });
    expect(await reverse(env.DB, id!, "t")).not.toBeNull();
    expect(await reverse(env.DB, id!, "t")).toBeNull();
    expect(await balances(env.DB)).toEqual([]);
  });
  it("parses prices and requires one for paid offers", async () => {
    expect(parsePrice("paid:49.9EUR")).toEqual({ amount_minor: 4990, currency: "EUR" });
    expect(parsePrice("paid:100usd")).toEqual({ amount_minor: 10000, currency: "USD" });
    expect(parsePrice("paid:0EUR")).toBeNull();
    expect(parsePrice("paid")).toBeNull();
    const n = node(undefined, false);
    await feed(n.app, dm(OWNER, "/offer add accounting 2 paid Review"));
    expect(await q("SELECT COUNT(*) AS n FROM capability_offers")).toEqual({ n: 0 });
    await feed(n.app, dm(OWNER, "/offer add accounting 2 paid:30EUR Review"));
    expect(await q("SELECT commitment_mode, price_minor, currency FROM capability_offers")).toEqual({ commitment_mode: "paid", price_minor: 3000, currency: "EUR" });
  });
  it("requester side: a delivered paid partner service is recorded as owed to the partner", async () => {
    const n = node();
    await withPartner(n);
    await feed(n.app, groupMsg(41, "hello"));
    await feed(n.app, dm(41, "/help I need an accountant for bookkeeping"));
    const mid = (await q<{ id: string }>("SELECT id FROM missions ORDER BY rowid DESC"))!.id;
    for (const s of ["ok", "more", "allow"]) await feed(n.app, press(41, `m:${mid}:${s}`));
    await feed(n.app, press(OWNER, `d:${mid}:rt`));
    const ex = (await q<{ id: string }>("SELECT id FROM federation_exchanges"))!.id;
    await n.post(`/v1/opportunities/${ex}/offers`, await sdkMsg("offer", ex, { offer_ref: "o", summary: "Paid review", terms: { mode: "paid", price: { amount_minor: 4990, currency: "EUR" } } }));
    expect(n.texts(41).at(-1)).toContain("49.90 EUR");
    const oid = (await q<{ id: string }>("SELECT id FROM exchange_offers"))!.id;
    await feed(n.app, press(41, `o:${oid}:y`));
    await n.post(`/v1/commitments/${ex}/events`, await sdkMsg("commitment", ex, { status: "committed" }));
    await n.post(`/v1/commitments/${ex}/events`, await sdkMsg("commitment", ex, { status: "delivered" }));
    expect(await balances(env.DB)).toEqual([{ account: `partner:${B_ID}`, unit: "EUR", amount: -4990 }]);
    await feed(n.app, dm(OWNER, "/ledger"));
    expect(n.texts(OWNER).at(-1)).toContain("-49.90 EUR");
  });
});

describe("gap signals (P14-10)", () => {
  async function unserved(count: number, job = "accounting") {
    for (let i = 0; i < count; i++) {
      const m = await ensureMember(env.DB, 500 + i);
      const d = await createDraft(env.DB, m.id, `need help with bookkeeping please ${i}`);
      await env.DB.prepare("UPDATE missions SET job_code=? WHERE id=?").bind(job, d.id).run();
      await transition(env.DB, d.id, "confirmed", "member");
      await transition(env.DB, d.id, "failed_with_explanation", "system");
    }
  }
  it("appears only from 5 distinct members, in coarse buckets", async () => {
    await unserved(GAP_MIN_MEMBERS - 1);
    expect(await computeGaps(env.DB)).toEqual([]);
    // A 5th distinct member crosses the threshold.
    const m = await ensureMember(env.DB, 999);
    const d = await createDraft(env.DB, m.id, "need help with bookkeeping please x");
    await env.DB.prepare("UPDATE missions SET job_code='accounting' WHERE id=?").bind(d.id).run();
    await transition(env.DB, d.id, "confirmed", "member");
    await transition(env.DB, d.id, "failed_with_explanation", "system");
    expect(await computeGaps(env.DB)).toEqual(["accounting"]);
    expect(await computeGaps(env.DB)).toEqual(["accounting"]); // still 'new' until notified
    expect([bucket(4), bucket(5), bucket(12), bucket(30)]).toEqual(["", "5+", "10+", "25+"]);
  });
  it("cron notifies owners once a day and the owner can act on it", async () => {
    const n = node(undefined, false);
    await feed(n.app, dm(OWNER, "/start"));
    await unserved(GAP_MIN_MEMBERS);
    const r = await runCron(n.app);
    expect(r.gaps).toBe(1);
    expect(n.texts(OWNER).at(-1)).toContain("5+");
    expect(n.texts(OWNER).at(-1)).not.toMatch(/\b5\d\d\b/); // no member ids
    expect((await runCron(n.app)).gaps).toBe(0);
    await feed(n.app, press(OWNER, "g:accounting:off"));
    expect(await q("SELECT status FROM gap_signals")).toEqual({ status: "actioned" });
    expect(n.texts(OWNER).at(-1)).toContain("/offer add accounting");
  });
});

describe("key rotation (P14-12)", () => {
  async function proof(oldPriv: string, oldPub: string, newPub: string, nodeId = B_ID) {
    const p = { schema: "nexus.rotation.v1", node_id: nodeId, old_key: oldPub, new_key: newPub, issued_at: new Date().toISOString() };
    return sign(p as unknown as FedMessage, oldPriv) as unknown as Record<string, unknown>;
  }
  it("adopts a new key proven by the old one; the old key keeps working for the grace period", async () => {
    const KB2 = await generateKeys();
    const pr = await proof(KB.privateKey, KB.publicKey, KB2.publicKey);
    const n = node(() => ({ node_id: B_ID, public_keys: [{ key: KB2.publicKey }], key_rotation: pr }));
    await withPartner(n);
    expect((await n.post("/v1/opportunities/inquiries", await sdkInquiry("r1", "accounting", KB2.privateKey))).status).toBe(202);
    expect(await q("SELECT public_key, prev_public_key FROM organizations WHERE id=?", B_ID)).toEqual({ public_key: KB2.publicKey, prev_public_key: KB.publicKey });
    expect((await n.post("/v1/opportunities/inquiries", await sdkInquiry("r2", "accounting", KB.privateKey))).status).toBe(202);
  });
  it("refuses a key change not signed by the trusted key", async () => {
    const evil = await generateKeys();
    const pr = await proof(evil.privateKey, KB.publicKey, evil.publicKey); // claims old key, signed by attacker
    const n = node(() => ({ node_id: B_ID, public_keys: [{ key: evil.publicKey }], key_rotation: pr }));
    await withPartner(n);
    expect((await n.post("/v1/opportunities/inquiries", await sdkInquiry("e1", "accounting", evil.privateKey))).status).toBe(401);
    expect((await q<{ public_key: string }>("SELECT public_key FROM organizations WHERE id=?", B_ID))!.public_key).toBe(KB.publicKey);
    await feed(n.app, dm(OWNER, `/partner refresh ${B_ID}`));
    expect(n.texts(OWNER).at(-1)).toContain("mismatch");
    await feed(n.app, dm(OWNER, `/partner rotate ${B_ID} ${JSON.stringify(pr)}`));
    expect(n.texts(OWNER).at(-1)).toContain("rejected");
  });
  it("our manifest publishes our rotation proof", async () => {
    const n = node();
    const e = { ...n.e, FEDERATION_ROTATION: JSON.stringify({ schema: "nexus.rotation.v1", node_id: A_ID }) };
    const man = (await (await handleFetch(new Request(`${A_ID}/.well-known/nexus-node.json`), e)).json()) as { key_rotation?: { node_id: string } };
    expect(man.key_rotation?.node_id).toBe(A_ID);
  });
});

describe("A2A transport (P14-12)", () => {
  const rpc = (n: ReturnType<typeof node>, body: unknown) => handleFetch(new Request(`${A_ID}/a2a`, { method: "POST", body: JSON.stringify(body) }), n.e, n.t.fetcher, n.net);
  it("agent card, signed message/send, and refusals", async () => {
    const n = node();
    await withPartner(n);
    const card = (await (await handleFetch(new Request(`${A_ID}/.well-known/agent-card.json`), n.e)).json()) as { url: string; skills: unknown[] };
    expect(card.url).toBe(`${A_ID}/a2a`);
    const ok = (await (await rpc(n, { jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { role: "user", messageId: "m1", parts: [{ kind: "data", data: await sdkInquiry("a1") }] } } })).json()) as any;
    expect(ok.result.parts[0].data).toMatchObject({ status: 202, ok: true });
    const forged = { ...(await sdkInquiry("a2")), nonce: "changed" };
    const bad = (await (await rpc(n, { jsonrpc: "2.0", id: 2, method: "message/send", params: { message: { parts: [{ kind: "data", data: forged }] } } })).json()) as any;
    expect(bad.result.parts[0].data).toMatchObject({ status: 401, ok: false });
    expect(((await (await rpc(n, { jsonrpc: "2.0", id: 3, method: "message/send", params: { message: { parts: [{ kind: "text", text: "find me an expert" }] } } })).json()) as any).error.code).toBe(-32602);
    expect(((await (await rpc(n, { jsonrpc: "2.0", id: 4, method: "tasks/get" })).json()) as any).error.code).toBe(-32601);
    expect(await q("SELECT COUNT(*) AS n FROM federation_exchanges")).toEqual({ n: 1 });
    expect((await handleFetch(new Request(`${A_ID}/.well-known/agent-card.json`), env as unknown as Env)).status).toBe(404);
  });
});

describe("case types (P14-11)", () => {
  it("/desk tag classifies a mission and the report counts it", async () => {
    const n = node(undefined, false);
    await enableGroup(n.app);
    await feed(n.app, groupMsg(41, "hello"));
    await feed(n.app, dm(41, "/help need an accountant for bookkeeping"));
    const mid = (await q<{ id: string }>("SELECT id FROM missions"))!.id;
    await feed(n.app, press(41, `m:${mid}:ok`));
    await feed(n.app, dm(OWNER, `/desk tag #${mid.slice(0, 6)} warm_intro`));
    expect(await q("SELECT case_type FROM missions")).toEqual({ case_type: "warm_intro" });
    await feed(n.app, dm(OWNER, `/desk tag #${mid.slice(0, 6)} nonsense`));
    expect(n.texts(OWNER).at(-1)).toContain("knowledge_answer|");
    await feed(n.app, dm(OWNER, "/desk report"));
    expect(n.texts(OWNER).at(-1)).toContain("warm_intro: <b>1</b>");
  });
});
