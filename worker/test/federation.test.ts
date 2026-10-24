// Federation contract tests. "Club B" is an independent implementation written here from the
// protocol alone (its own key, its own message builder), as the plan's conformance gate asks.

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { makeApp, handleFetch } from "../src/index";
import { canonical, checkShape, generateKeys, publicKeyOf, sign, verifySignature, type FedMessage } from "../src/federation/envelope";
import { dispatchFed, safeEndpoint } from "../src/federation/gateway";
import { dm, enableGroup, fakeTelegram, feed, groupMsg, OWNER, press } from "./helpers";
import type { Env } from "../src/env";

const A_ID = "https://club-a.example";
const B_ID = "https://club-b.example";
const ALICE = 41;
let KA: { privateKey: string; publicKey: string };
let KB: { privateKey: string; publicKey: string };
beforeAll(async () => {
  KA = await generateKeys();
  KB = await generateKeys();
});

const fedEnv = (): Env => ({ ...(env as unknown as Env), FEDERATION_ENABLED: "true", PUBLIC_URL: A_ID, FEDERATION_PRIVATE_KEY: KA.privateKey, FEDERATION_PUBLIC_KEY: KA.publicKey });
const q = <T>(sql: string, ...args: unknown[]) => env.DB.prepare(sql).bind(...args).first<T>();

function node() {
  const t = fakeTelegram();
  const outbound: { url: string; body: FedMessage }[] = [];
  const net = async (url: string, init: RequestInit) => {
    outbound.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ ok: true }), { status: 202 });
  };
  const e = fedEnv();
  const app = makeApp(e, t.fetcher, net);
  const post = async (path: string, msg: unknown) => handleFetch(new Request(A_ID + path, { method: "POST", body: JSON.stringify(msg) }), e, t.fetcher, net);
  const texts = (chat: number) => t.sent(chat).map((c) => c.params.text as string);
  const buttons = (chat: number) => t.sent(chat).filter((c) => c.params.reply_markup).at(-1)?.params.reply_markup.inline_keyboard.flat() as { callback_data: string }[];
  return { app, e, t, outbound, post, texts, buttons };
}

/** Club B builds and signs a message the way any conforming node would. */
async function fromB(type: FedMessage["type"], exchangeId: string, body: Record<string, unknown>, over: Partial<FedMessage> = {}, key = KB.privateKey) {
  const now = Date.now();
  return sign(
    { schema: "nexus.v1", type, exchange_id: exchangeId, issuer_org: B_ID, recipient_org: A_ID, issued_at: new Date(now).toISOString(), expires_at: new Date(now + 86_400_000).toISOString(), nonce: crypto.randomUUID(), body, ...over },
    key,
  );
}

async function setup(cats = "*") {
  const n = node();
  await enableGroup(n.app);
  await feed(n.app, groupMsg(OWNER, "hi"));
  await feed(n.app, groupMsg(ALICE, "hello group"));
  await feed(n.app, dm(OWNER, `/partner add ${B_ID} ${KB.publicKey} ${cats} Club B`));
  return n;
}

async function missionToDesk(n: ReturnType<typeof node>, text = "/help I need an accountant for bookkeeping in Germany") {
  await feed(n.app, dm(ALICE, text));
  const id = (await q<{ id: string }>("SELECT id FROM missions ORDER BY rowid DESC LIMIT 1"))!.id;
  await feed(n.app, press(ALICE, `m:${id}:ok`));
  await feed(n.app, press(ALICE, `m:${id}:more`));
  return id;
}

describe("envelope crypto and shape", () => {
  it("canonical JSON is key-order independent; signatures verify and detect tampering", async () => {
    expect(canonical({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
    const m = await fromB("withdraw", "ex1", { reason: "x" });
    expect(await verifySignature(m, KB.publicKey)).toBe(true);
    expect(await verifySignature({ ...m, body: { reason: "y" } }, KB.publicKey)).toBe(false);
    expect(await verifySignature(m, KA.publicKey)).toBe(false);
    expect(await publicKeyOf(KB.privateKey)).toBe(KB.publicKey);
  });
  it("rejects expired, future, over-long TTL and forwardable inquiries", async () => {
    const now = Date.now();
    const base = await fromB("inquiry", "e", { mission_ref: "r", job: "accounting", summary: "s", criteria: {}, allowed_fields: ["job"], purpose: "evaluate_willing_provider", forwarding: "prohibited", max_hops: 1, policy_version: 1 });
    expect(checkShape(base, now)).toBeNull();
    expect(checkShape({ ...base, expires_at: new Date(now - 1).toISOString() }, now)).toBe("expired");
    expect(checkShape({ ...base, issued_at: new Date(now + 3_600_000).toISOString() }, now)).toBe("future");
    expect(checkShape({ ...base, expires_at: new Date(now + 40 * 86_400_000).toISOString() }, now)).toBe("ttl");
    expect(checkShape({ ...base, body: { ...base.body, forwarding: "allowed" } }, now)).toBe("forwarding");
    expect(checkShape({ ...base, body: { ...base.body, max_hops: 3 } }, now)).toBe("forwarding");
    expect(checkShape({ ...base, body: { ...base.body, member_tg_id: 5 } }, now)).toBe("inquiry_field:member_tg_id");
    expect(checkShape({ ...base, body: { ...base.body, allowed_fields: ["contact"] } }, now)).toBe("allowed_fields");
  });
  it("partner endpoints must be public https origins (SSRF)", () => {
    expect(safeEndpoint("https://club-b.example/path")).toBe("https://club-b.example");
    for (const bad of ["http://club-b.example", "https://127.0.0.1", "https://localhost", "https://x.internal", "https://club-b.example:8443", "https://[::1]", "https://u:p@club-b.example", "https://intranet"]) expect(safeEndpoint(bad)).toBeNull();
  });
});

describe("requester side: our member's mission reaches a partner (S4)", () => {
  it("preview → consent → signed inquiry with only allowed fields → offer → choose → committed → delivered", async () => {
    const n = await setup();
    const mid = await missionToDesk(n);
    expect(n.buttons(ALICE).map((x) => x.callback_data)).toContain(`m:${mid}:pv`);
    // Operator can't route before the member allows it.
    await feed(n.app, press(OWNER, `d:${mid}:rt`));
    expect(await q("SELECT COUNT(*) AS n FROM fed_outbox")).toEqual({ n: 0 });

    await feed(n.app, press(ALICE, `m:${mid}:pv`));
    expect(n.texts(ALICE).at(-1)).toContain("Club B");
    expect(n.texts(ALICE).at(-1)).toContain("Not your name");
    await feed(n.app, press(ALICE, `m:${mid}:allow`));
    await feed(n.app, press(OWNER, `d:${mid}:rt`));
    expect((await q<{ status: string }>("SELECT status FROM missions WHERE id=?", mid))!.status).toBe("routed");
    // Routing twice for the same version doesn't send twice.
    await feed(n.app, press(OWNER, `d:${mid}:rt`));
    expect(await dispatchFed(n.app)).toBe(1);
    expect(n.outbound).toHaveLength(1);

    const inq = n.outbound[0]!;
    expect(inq.url).toBe(`${B_ID}/v1/opportunities/inquiries`);
    expect(await verifySignature(inq.body, KA.publicKey)).toBe(true);
    expect(Object.keys(inq.body.body).sort()).toEqual(["allowed_fields", "criteria", "forwarding", "job", "max_hops", "mission_ref", "policy_version", "purpose", "summary"]);
    const wire = JSON.stringify(inq.body);
    const alice = (await q<{ id: string }>("SELECT id FROM members WHERE tg_id=?", ALICE))!.id;
    for (const secret of [alice, mid, "tg://", "-1001234"]) expect(wire).not.toContain(secret); // I05: no identifiers
    // The Telegram id as a standalone value (signatures and timestamps may contain the digits).
    expect(JSON.stringify(inq.body.body)).not.toMatch(new RegExp(`(^|[^0-9A-Za-z])${ALICE}([^0-9A-Za-z]|$)`));
    expect(inq.body.body.mission_ref).not.toBe(mid);

    // Club B offers.
    const exId = inq.body.exchange_id;
    const offer = await fromB("offer", exId, { offer_ref: "b-1", summary: "Tax adviser, 30 min call", terms: { mode: "volunteer" } });
    expect((await n.post(`/v1/opportunities/${exId}/offers`, offer)).status).toBe(202);
    expect((await n.post(`/v1/opportunities/${exId}/offers`, offer)).status).toBe(200); // replay = no-op
    expect(await q("SELECT COUNT(*) AS n FROM exchange_offers")).toEqual({ n: 1 });
    expect(n.texts(ALICE).at(-1)).toContain("Tax adviser");
    const choose = n.buttons(ALICE).find((x) => x.callback_data.endsWith(":y"))!.callback_data;

    await feed(n.app, press(ALICE, choose));
    expect((await q<{ status: string }>("SELECT status FROM missions WHERE id=?", mid))!.status).toBe("pending_final_approvals");
    await dispatchFed(n.app);
    const appr = n.outbound.at(-1)!;
    expect(appr.url).toBe(`${B_ID}/v1/opportunities/${exId}/approvals`);
    expect(appr.body.body.contact).toBe(`tg://user?id=${ALICE}`); // only now, only to B
    expect((appr.body.body.consent as { action: string }).action).toBe("reveal");

    expect((await n.post(`/v1/commitments/${exId}/events`, await fromB("commitment", exId, { status: "committed" }))).status).toBe(202);
    expect((await q<{ status: string }>("SELECT status FROM missions WHERE id=?", mid))!.status).toBe("service_committed");
    expect((await n.post(`/v1/commitments/${exId}/events`, await fromB("commitment", exId, { status: "delivered" }))).status).toBe(202);
    expect((await q<{ status: string }>("SELECT status FROM missions WHERE id=?", mid))!.status).toBe("delivered");
    await feed(n.app, press(ALICE, `r:${mid}:1`));
    expect(await q("SELECT service_code, evidence_level FROM outcome_receipts WHERE mission_id=?", mid)).toEqual({ service_code: "partner_service", evidence_level: "both_confirmed" });
  });

  it("refuses forged, misaddressed, misrouted, unknown and suspended senders", async () => {
    const n = await setup();
    const mid = await missionToDesk(n);
    await feed(n.app, press(ALICE, `m:${mid}:allow`));
    await feed(n.app, press(OWNER, `d:${mid}:rt`));
    const exId = (await q<{ id: string }>("SELECT id FROM federation_exchanges"))!.id;
    const body = { offer_ref: "b", summary: "x", terms: {} };
    const status = async (path: string, m: unknown) => (await n.post(path, m)).status;
    const path = `/v1/opportunities/${exId}/offers`;
    expect(await status(path, await fromB("offer", exId, body, {}, KA.privateKey))).toBe(401); // wrong key
    expect(await status(path, await fromB("offer", exId, body, { recipient_org: "https://club-c.example" }))).toBe(403);
    expect(await status(path, await fromB("offer", exId, body, { issuer_org: "https://evil.example" }))).toBe(401);
    expect(await status(`/v1/opportunities/other/offers`, await fromB("offer", exId, body))).toBe(400); // URL id ≠ exchange
    expect(await status(path, await fromB("approval", exId, body))).toBe(400); // type not allowed on route
    expect(await status(path, await fromB("offer", "nope", body))).toBe(400);
    expect(await status(`/v1/opportunities/nope/offers`, await fromB("offer", "nope", body))).toBe(404);
    const tampered = { ...(await fromB("offer", exId, body)), body: { ...body, summary: "changed" } };
    expect(await status(path, tampered)).toBe(401);
    await feed(n.app, dm(OWNER, `/partner suspend ${B_ID}`));
    expect(await status(path, await fromB("offer", exId, body))).toBe(403);
    expect(await q("SELECT COUNT(*) AS n FROM exchange_offers")).toEqual({ n: 0 });
  });

  it("member cancel withdraws the exchange; identifiers in the summary block sharing", async () => {
    const n = await setup();
    const mid = await missionToDesk(n);
    await feed(n.app, press(ALICE, `m:${mid}:allow`));
    await feed(n.app, press(OWNER, `d:${mid}:rt`));
    await feed(n.app, press(ALICE, `m:${mid}:x`));
    await dispatchFed(n.app);
    expect(n.outbound.map((o) => o.body.type)).toEqual(["inquiry", "withdraw"]);

    const m2 = await missionToDesk(n, "/help bookkeeping help, write me at me@example.com");
    await feed(n.app, press(ALICE, `m:${m2}:pv`));
    expect(n.texts(ALICE).at(-1)).toContain("email");
    await feed(n.app, press(ALICE, `m:${m2}:allow`));
    expect(await q("SELECT COUNT(*) AS n FROM consent_grants WHERE mission_id=? AND action='external_discovery'", m2)).toEqual({ n: 0 });
  });

  it("partner categories limit what can be routed", async () => {
    const n = await setup("legal_contracts");
    const mid = await missionToDesk(n);
    expect(n.buttons(ALICE)?.map((x) => x.callback_data) ?? []).not.toContain(`m:${mid}:pv`);
  });
});

describe("provider side: a partner's member gets our help (S3, S5)", () => {
  async function inquiry(n: ReturnType<typeof node>, ex: string, job = "accounting") {
    return n.post(
      "/v1/opportunities/inquiries",
      await fromB("inquiry", ex, { mission_ref: `ref-${ex}`, job, summary: "Bookkeeping help for a small bakery", criteria: {}, allowed_fields: ["job", "summary", "criteria"], purpose: "evaluate_willing_provider", forwarding: "prohibited", max_hops: 1, policy_version: 1 }),
    );
  }
  const approve = (ex: string) => fromB("approval", ex, { consent: { action: "reveal", purpose: "connect_helper", fields: ["contact"], grant_ref: "h" }, contact: "tg://user?id=777 @bakery_owner" });

  it("inquiry → operator offers → approval reserves capacity → full → withdraw frees slot and deletes contact", async () => {
    const n = await setup();
    await feed(n.app, dm(OWNER, "/offer add accounting 1 volunteer Bookkeeping review"));
    const offer = (await q<{ id: string }>("SELECT id FROM capability_offers"))!.id;
    expect((await inquiry(n, "bx1")).status).toBe(202);
    expect(n.texts(OWNER).at(-1)).toContain("Request from Club B");
    const inId = (await q<{ id: string }>("SELECT id FROM federation_exchanges WHERE remote_id='bx1'"))!.id;
    expect(n.buttons(OWNER).map((x) => x.callback_data)).toContain(`x:${inId}:o:${offer}`);

    await feed(n.app, press(OWNER, `x:${inId}:o:${offer}`));
    await dispatchFed(n.app);
    expect(n.outbound.at(-1)!.url).toBe(`${B_ID}/v1/opportunities/bx1/offers`);
    expect(n.outbound.at(-1)!.body.body.summary).toBe("Bookkeeping review");

    expect((await n.post("/v1/opportunities/bx1/approvals", await approve("bx1"))).status).toBe(202);
    expect(await q("SELECT state, contact FROM federation_exchanges WHERE id=?", inId)).toEqual({ state: "committed", contact: "tg://user?id=777 @bakery_owner" });
    expect((await q<{ reserved: number }>("SELECT reserved FROM capability_offers"))!.reserved).toBe(1);

    // A second request for the same full offer is declined for capacity, never overbooked.
    await inquiry(n, "bx2");
    const in2 = (await q<{ id: string }>("SELECT id FROM federation_exchanges WHERE remote_id='bx2'"))!.id;
    await env.DB.prepare("UPDATE federation_exchanges SET state='offered', capability_offer_id=? WHERE id=?").bind(offer, in2).run();
    await n.post("/v1/opportunities/bx2/approvals", await approve("bx2"));
    expect((await q<{ state: string }>("SELECT state FROM federation_exchanges WHERE id=?", in2))!.state).toBe("declined");
    expect((await q<{ reserved: number }>("SELECT reserved FROM capability_offers"))!.reserved).toBe(1);

    expect((await n.post("/v1/exchanges/bx1/withdraw", await fromB("withdraw", "bx1", { reason: "requester_withdrew" }))).status).toBe(202);
    expect(await q("SELECT state, contact, summary FROM federation_exchanges WHERE id=?", inId)).toEqual({ state: "withdrawn", contact: null, summary: "[withdrawn]" });
    expect((await q<{ reserved: number }>("SELECT reserved FROM capability_offers"))!.reserved).toBe(0);
  });

  it("approval without reveal consent or with a bad contact is refused", async () => {
    const n = await setup();
    await feed(n.app, dm(OWNER, "/offer add accounting 2 Bookkeeping review"));
    const offer = (await q<{ id: string }>("SELECT id FROM capability_offers"))!.id;
    await inquiry(n, "bx3");
    const inId = (await q<{ id: string }>("SELECT id FROM federation_exchanges"))!.id;
    await feed(n.app, press(OWNER, `x:${inId}:o:${offer}`));
    expect((await n.post("/v1/opportunities/bx3/approvals", await fromB("approval", "bx3", { contact: "tg://user?id=1" }))).status).toBe(400);
    expect((await n.post("/v1/opportunities/bx3/approvals", await fromB("approval", "bx3", { consent: { action: "reveal", fields: ["contact"] }, contact: "javascript:alert(1)" }))).status).toBe(400);
    expect((await q<{ reserved: number }>("SELECT reserved FROM capability_offers"))!.reserved).toBe(0);
  });

  it("category allowlist and per-partner rate limit apply to inquiries", async () => {
    const n = await setup("legal_contracts");
    expect((await inquiry(n, "c1", "accounting")).status).toBe(403);
    expect((await inquiry(n, "c2", "legal_contracts")).status).toBe(202);
    const now = new Date().toISOString();
    await env.DB.batch(
      Array.from({ length: 50 }, (_, i) =>
        env.DB.prepare("INSERT INTO federation_exchanges(id, direction, partner_id, remote_id, mission_ref, job_code, summary, envelope, state, idempotency_key, expires_at, created_at, updated_at) VALUES (?, 'in', ?, ?, 'r', 'legal_contracts', 's', '{}', 'received', ?, ?, ?, ?)").bind(`f${i}`, B_ID, `r${i}`, `k${i}`, now, now, now),
      ),
    );
    expect((await inquiry(n, "c3", "legal_contracts")).status).toBe(429);
  });

  it("node manifest reveals categories only, and everything is off by default", async () => {
    const n = await setup();
    await feed(n.app, dm(OWNER, "/offer add accounting 3 Bookkeeping review"));
    const res = await handleFetch(new Request(`${A_ID}/.well-known/nexus-node.json`), n.e);
    const man = (await res.json()) as Record<string, unknown>;
    expect(man.categories).toEqual(["accounting"]);
    expect(JSON.stringify(man)).not.toMatch(/Bookkeeping|"3"|reserved|capacity_total/);
    // Default env: federation disabled → 404 everywhere.
    expect((await handleFetch(new Request(`${A_ID}/.well-known/nexus-node.json`), env as unknown as Env)).status).toBe(404);
    expect((await handleFetch(new Request(`${A_ID}/v1/opportunities/inquiries`, { method: "POST", body: "{}" }), env as unknown as Env)).status).toBe(404);
  });
});

describe("manual gateway (E0)", () => {
  it("messages for a partner without an endpoint go to the desk; /fed loads the reply", async () => {
    const n = node();
    await enableGroup(n.app);
    await feed(n.app, groupMsg(OWNER, "hi"));
    await feed(n.app, groupMsg(ALICE, "hello"));
    await feed(n.app, dm(OWNER, `/partner manual ${B_ID.replace("https://", "")} ${KB.publicKey} * Club B (manual)`));
    const PID = "club-b.example";
    const mid = await missionToDesk(n);
    await feed(n.app, press(ALICE, `m:${mid}:allow`));
    await feed(n.app, press(OWNER, `d:${mid}:rt`));
    expect(await dispatchFed(n.app)).toBe(0);
    expect(n.outbound).toHaveLength(0);
    const row = (await q<{ id: string; state: string; body: string }>("SELECT id, state, body FROM fed_outbox"))!;
    expect(row.state).toBe("manual");
    expect(n.texts(OWNER).some((t) => t.includes("by hand"))).toBe(true);
    const exId = (JSON.parse(row.body) as FedMessage).exchange_id;

    const offer = await fromB("offer", exId, { offer_ref: "m1", summary: "Manual partner offer", terms: {} }, { issuer_org: PID });
    await feed(n.app, dm(OWNER, `/fed ${JSON.stringify(offer)}`));
    expect(n.texts(OWNER).at(-1)).toContain("ok");
    expect(n.texts(ALICE).at(-1)).toContain("Manual partner offer");
    await feed(n.app, press(OWNER, `x:${row.id}:s`));
    expect((await q<{ state: string }>("SELECT state FROM fed_outbox WHERE id=?", row.id))!.state).toBe("reconciled");
  });
});
