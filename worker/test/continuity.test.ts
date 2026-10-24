// Continuity (CONT-1..9): identity chain, passport enrolment, independent login, follows that
// survive restores, alerts and drills, passes for partners, rescue relay, metrics.

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { b64, keyId, signWith, type Signed } from "../src/continuity/crypto";
import { verifyDestinations, verifyRoot, type DestMeta, type RootMeta } from "../src/continuity/identity";
import { applyOp, enrolFromTelegram, follows } from "../src/continuity/people";
import { dispatchAlertEmails, metrics } from "../src/continuity/alerts";
import { exportBundle, importBundle, type ExportDoc } from "../src/continuity/portable";
import { verifyPass, type PassClaim } from "../src/continuity/passport";
import { ensureMember } from "../src/acl";
import type { Env } from "../src/env";
import { generateKeys, sign as signMsg } from "../src/federation/envelope";
import { dispatchFed } from "../src/federation/gateway";
import { handleFetch, makeApp } from "../src/index";
import { dm, enableGroup, fakeTelegram, feed, groupMsg, OWNER } from "./helpers";

type Keys = { privateKey: string; publicKey: string };
let R: Keys[]; // custodians
let ON: Keys; // online key
let FED: Keys;
let PB: Keys; // partner federation key
let PR: Keys[]; // partner custodians
let PON: Keys; // partner online key
const ORG = "club-a";
const A = "https://club-a.example";
const B = "https://club-b.example";
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const q = <T>(sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).first<T>();
const CKEY = b64(new Uint8Array(32).map((_, i) => i * 7 + 1));

beforeAll(async () => {
  R = [await generateKeys(), await generateKeys(), await generateKeys()];
  ON = await generateKeys();
  FED = await generateKeys();
  PB = await generateKeys();
  PR = [await generateKeys(), await generateKeys()];
  PON = await generateKeys();
});

const pk = async (k: Keys) => ({ keyid: await keyId(k.publicKey), key: k.publicKey });
async function rootDoc(org = ORG, version = 1, signers = R, keys = R, online = ON, threshold = 2): Promise<Signed<RootMeta>> {
  let d: Signed<RootMeta> = { signed: { schema: "nexus.root.v1", org, version, expires: iso(Date.now() + 365 * DAY), root_keys: await Promise.all(keys.map(pk)), threshold, online_keys: [await pk(online)] }, signatures: [] };
  for (const k of signers) d = await signWith(d, k.privateKey, k.publicKey);
  return d;
}
async function manifest(version: number, primary: string, signers: Keys[], extra: Partial<DestMeta> = {}, org = ORG): Promise<Signed<DestMeta>> {
  let d: Signed<DestMeta> = { signed: { schema: "nexus.destinations.v1", org, version, root_version: 1, expires: iso(Date.now() + 30 * DAY), destinations: [{ kind: "web", url: primary, role: "primary" }], ...extra }, signatures: [] };
  for (const k of signers) d = await signWith(d, k.privateKey, k.publicKey);
  return d;
}

function node(extraEnv: Partial<Env> = {}) {
  const t = fakeTelegram();
  const mails: { to: string; subject: string; text: string; headers?: Record<string, string> }[] = [];
  const out: { url: string; body: any }[] = [];
  const net = async (url: string, init: RequestInit) => {
    if (url.startsWith("https://api.resend.com")) {
      const b = JSON.parse(String(init.body));
      mails.push({ to: b.to[0], subject: b.subject, text: b.text, headers: b.headers });
      return Response.json({ id: "x" });
    }
    out.push({ url, body: JSON.parse(String(init.body ?? "{}")) });
    return Response.json({ ok: true }, { status: 202 });
  };
  const e: Env = {
    ...(env as unknown as Env),
    PUBLIC_URL: A,
    CONTINUITY_KEY: CKEY,
    IDENTITY_ONLINE_KEY: ON.privateKey,
    IDENTITY_ONLINE_PUBLIC_KEY: ON.publicKey,
    EMAIL_PROVIDER: "resend",
    EMAIL_API_KEY: "k",
    EMAIL_FROM: "club@example.com",
    FEDERATION_ENABLED: "true",
    FEDERATION_PRIVATE_KEY: FED.privateKey,
    FEDERATION_PUBLIC_KEY: FED.publicKey,
    ...extraEnv,
  };
  const app = makeApp(e, t.fetcher, net);
  const http = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await handleFetch(new Request(A + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) }), e, t.fetcher, net);
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* html */
    }
    return { status: res.status, json, text, cookie: res.headers.get("set-cookie") };
  };
  const admin = (method: string, path: string, body?: unknown) => http(method, path, body, { authorization: "Bearer test-admin-token" });
  return { app, e, t, mails, out, http, admin, net };
}

async function initData(id: number) {
  const enc = new TextEncoder();
  const key = async (k: BufferSource) => crypto.subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const secret = await crypto.subtle.sign("HMAC", await key(enc.encode("WebAppData")), enc.encode("123456:TEST"));
  const fields: Record<string, string> = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id }) };
  const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
  const hash = [...new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret), enc.encode(check)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return new URLSearchParams({ ...fields, hash }).toString();
}
const miniApp = (n: ReturnType<typeof node>, id: number) => async (method: string, path: string, body?: unknown) => n.http(method, `/app/api/${path}`, body, { "x-telegram-init-data": await initData(id) });
const codeIn = (text: string) => /\b(\d{6})\b/.exec(text)![1]!;

async function withIdentity(n: ReturnType<typeof node>) {
  expect((await n.admin("POST", "/admin/identity/root", await rootDoc())).json.ok).toBe(true);
  expect((await n.admin("POST", "/admin/identity/manifest", await manifest(1, A, [ON]))).json.ok).toBe(true);
}
async function members(n: ReturnType<typeof node>, ...ids: number[]) {
  await enableGroup(n.app);
  for (const id of [OWNER, ...ids]) await feed(n.app, groupMsg(id, "hello"));
}
/** Full member enrolment through the Mini App, with a verified email and critical notices. */
async function enrolWithEmail(n: ReturnType<typeof node>, id: number, email: string, topics = ["critical"]) {
  const api = miniApp(n, id);
  expect((await api("POST", "passport/enrol", { topics })).json.ok).toBe(true);
  const r = (await api("POST", "passport/email", { email })).json;
  expect(r).toMatchObject({ ok: true, sent: "sent" });
  expect((await api("POST", "passport/email/verify", { registration: r.registration, code: codeIn(n.mails.at(-1)!.text) })).json.ok).toBe(true);
  return api;
}

describe("CONT-1 club identity (TUF-style)", () => {
  it("root needs its threshold; updates need the previous keys; no rollback, skip or fork", async () => {
    const r1 = await rootDoc();
    expect(await verifyRoot(r1, null)).toEqual({ ok: true });
    expect(await verifyRoot(await rootDoc(ORG, 1, [R[0]!]), null)).toEqual({ ok: false, reason: "root_threshold" });
    const evil = [await generateKeys(), await generateKeys(), await generateKeys()];
    expect(await verifyRoot(await rootDoc(ORG, 2, evil, evil), r1)).toEqual({ ok: false, reason: "root_not_authorized_by_previous" });
    const r2 = await rootDoc(ORG, 2, R, R, await generateKeys());
    expect(await verifyRoot(r2, r1)).toEqual({ ok: true });
    expect(await verifyRoot(r1, r2)).toEqual({ ok: false, reason: "root_rollback" });
    expect(await verifyRoot(await rootDoc(ORG, 3), r1)).toEqual({ ok: false, reason: "root_skip" });
    expect(await verifyRoot(await rootDoc(ORG, 1, R, R, await generateKeys()), r1)).toEqual({ ok: false, reason: "root_fork" });
  });
  it("online key signs address lists, but moving the primary needs root signatures and a record", async () => {
    const root = await rootDoc();
    const m1 = await manifest(1, A, [ON]);
    expect((await verifyDestinations(m1, root, null)).ok).toBe(true);
    // A stolen online key can't move the audience.
    const hijack = await manifest(2, "https://evil.example", [ON], { relocation: { from: A, to: "https://evil.example", reason: "x" } });
    expect(await verifyDestinations(hijack, root, m1)).toEqual({ ok: false, reason: "relocation_needs_root" });
    const silent = await manifest(2, "https://evil.example", [ON]);
    expect(await verifyDestinations(silent, root, m1)).toEqual({ ok: false, reason: "relocation_record" });
    const moved = await manifest(2, "https://club-a-new.example", [R[0]!, R[2]!], { relocation: { from: A, to: "https://club-a-new.example", reason: "domain lost" } });
    expect(await verifyDestinations(moved, root, m1)).toEqual({ ok: true, relocation: true });
    expect(await verifyDestinations(m1, root, moved)).toEqual({ ok: false, reason: "dest_rollback" }); // replay of an old list
    expect(await verifyDestinations(await manifest(2, "https://club-a-new.example", [R[0]!, R[1]!], { relocation: { from: A, to: "https://club-a-new.example", reason: "other" } }), root, moved)).toEqual({ ok: false, reason: "dest_fork" });
    const expired = await manifest(3, "https://club-a-new.example", [ON], { expires: iso(Date.now() - 1) });
    expect((await verifyDestinations(expired, root, moved)).ok).toBe(false);
  });
  it("admin install, public document, backups via the online key only", async () => {
    const n = node();
    await members(n);
    expect((await n.http("GET", "/.well-known/nexus-community.json")).status).toBe(404);
    await withIdentity(n);
    const pub = (await n.http("GET", "/.well-known/nexus-community.json")).json;
    expect(pub.root.signed.org).toBe(ORG);
    expect(pub.destinations.signed.version).toBe(1);
    await feed(n.app, dm(OWNER, "/destinations add rss https://club-a.example/feed.xml"));
    expect(n.t.sent(OWNER).at(-1)!.params.text).toContain("v2");
    await feed(n.app, dm(OWNER, `/destinations remove ${A}`));
    expect(n.t.sent(OWNER).at(-1)!.params.text).toContain("primary_needs_relocation");
    expect((await n.admin("POST", "/admin/identity/manifest", await manifest(2, "https://evil.example", [ON], { relocation: { from: A, to: "https://evil.example", reason: "x" } }))).json).toMatchObject({ ok: false });
  });
});

describe("CONT-2..4 passport, independent login, follows", () => {
  it("nothing is followed without the member's own choice; 'protected' only after verification", async () => {
    const n = node();
    await members(n, 61);
    const api = miniApp(n, 61);
    expect((await api("GET", "passport")).json.protection.level).toBe("not_enrolled");
    await api("POST", "passport/enrol", {});
    let p = (await api("GET", "passport")).json.protection;
    expect(p.level).toBe("not_yet_protected");
    expect(Object.values(p.topics).every((s) => s === "unfollowed")).toBe(true);
    const r = (await api("POST", "passport/email", { email: "Ann@Example.com" })).json;
    p = (await api("GET", "passport")).json.protection;
    expect(p.level).toBe("not_yet_protected"); // pending email isn't protection
    expect((await api("POST", "passport/email/verify", { registration: r.registration, code: "000000" })).json.ok).toBe(false);
    await api("POST", "passport/email/verify", { registration: r.registration, code: codeIn(n.mails.at(-1)!.text) });
    expect((await api("GET", "passport")).json.protection.level).toBe("login_only"); // no critical follow yet
    await api("POST", "passport/topic", { topic: "critical", on: true });
    expect((await api("GET", "passport")).json.protection.level).toBe("protected");
    // Unsubscribing from commercial doesn't touch service notices.
    await api("POST", "passport/topic", { topic: "commercial", on: false });
    expect((await api("GET", "passport")).json.protection.topics.critical).toBe("following");
    // Addresses are stored encrypted.
    const raw = await q<{ address_enc: string }>("SELECT address_enc FROM delivery_registrations");
    expect(raw!.address_enc).not.toContain("example");
    // Membership comes from group access, separately from follows.
    expect((await api("GET", "passport")).json.memberships[0]).toMatchObject({ tier: "member", basis: "group_access" });
  });

  it("portal login works without Telegram: email code or one-time recovery code; no address enumeration", async () => {
    const n = node();
    await members(n, 62);
    const api = await enrolWithEmail(n, 62, "bob@example.com");
    const codes = (await api("POST", "passport/recovery")).json.codes as string[];
    expect(codes).toHaveLength(8);
    const P = { "x-portal": "1" };
    const unknown = await n.http("POST", "/portal/api/login", { email: "nobody@example.com" }, P);
    const known = await n.http("POST", "/portal/api/login", { email: "bob@example.com" }, P);
    expect(Object.keys(unknown.json)).toEqual(Object.keys(known.json)); // same shape either way
    expect((await n.http("POST", "/portal/api/login", { email: "bob@example.com" })).status).toBe(403); // CSRF header required
    const v = await n.http("POST", "/portal/api/verify", { ticket: known.json.ticket, code: codeIn(n.mails.at(-1)!.text) }, P);
    expect(v.json.ok).toBe(true);
    const cookie = /tp_s=[^;]+/.exec(v.cookie!)![0];
    expect(v.cookie).toMatch(/HttpOnly; Secure; SameSite=Strict/);
    const me = await n.http("GET", "/portal/api/me", undefined, { cookie });
    expect(me.json.protection.level).toBe("protected");
    expect(me.json.destinations).toEqual([]);
    const rc = await n.http("POST", "/portal/api/recover", { code: codes[0] }, P);
    expect(rc.json.ok).toBe(true);
    expect((await n.http("POST", "/portal/api/recover", { code: codes[0] }, P)).status).toBe(401); // one use
    expect((await n.http("GET", "/portal/api/me")).status).toBe(401);
  });

  it("restores can't re-enable an unfollow (flow D); forget keeps a tombstone", async () => {
    const n = node();
    await members(n, 63);
    await withIdentity(n);
    const api = await enrolWithEmail(n, 63, "cat@example.com", ["critical", "news"]);
    const older = (await n.admin("GET", "/admin/continuity/export")).json as Signed<ExportDoc>;
    expect(JSON.stringify(older)).not.toMatch(/hello|tg_id|"63"/); // no chat text, no Telegram ids
    await api("POST", "passport/topic", { topic: "news", on: false });
    const newer = (await n.admin("GET", "/admin/continuity/export")).json as Signed<ExportDoc>;
    // Simulate restoring an old database: wipe continuity tables, import the OLDER export, then the newer one.
    for (const t of ["follow_state", "subscription_ops", "suppressions", "membership_attestations", "delivery_registrations", "recovery_codes", "sessions", "login_codes", "identity_links", "people"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
    await n.admin("POST", "/admin/continuity/import", older);
    const pid = (await q<{ id: string }>("SELECT id FROM people"))!.id;
    expect((await follows(env.DB, pid)).news).toBe("following");
    await n.admin("POST", "/admin/continuity/import", newer);
    expect((await follows(env.DB, pid)).news).toBe("unfollowed");
    await n.admin("POST", "/admin/continuity/import", older); // replaying the old one again changes nothing
    expect((await follows(env.DB, pid)).news).toBe("unfollowed");
    // A forged bundle is refused.
    const forged = await signWith({ signed: newer.signed }, (await generateKeys()).privateKey, (await generateKeys()).publicKey);
    expect((await n.admin("POST", "/admin/continuity/import", { signed: newer.signed, signatures: forged.signatures })).json.error).toBe("bundle_signature");
    // Ops applied with lower seq never override.
    await applyOp(env.DB, pid, "FOLLOW", "news", { seq: 1 });
    expect((await follows(env.DB, pid)).news).toBe("unfollowed");
  });
});

describe("CONT-6 alerts, CONT-9 drills and metrics", () => {
  it("alerts reach only consented, verified channels; once; unsubscribe wins; drill confirmations count once", async () => {
    const n = node();
    await members(n, 64, 65, 66);
    await withIdentity(n);
    await enrolWithEmail(n, 64, "d@example.com"); // critical
    await enrolWithEmail(n, 65, "e@example.com", ["news"]); // not critical
    await miniApp(n, 66)("POST", "passport/enrol", { topics: ["critical"] }); // no verified email
    const before = n.mails.length;
    await feed(n.app, dm(OWNER, "/alert incident Telegram group is down"));
    expect(n.t.sent(OWNER).at(-1)!.params.text).toContain("Queued");
    expect(await dispatchAlertEmails(n.app)).toBe(1);
    expect(await dispatchAlertEmails(n.app)).toBe(0); // at most once
    const mail = n.mails.slice(before);
    expect(mail.map((m) => m.to)).toEqual(["d@example.com"]);
    expect(mail[0]!.text).toContain(A);
    expect(mail[0]!.headers!["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    // Telegram copies went to everyone following critical who is linked (64, 66), through the effect ledger.
    expect((await q<{ n: number }>("SELECT COUNT(*) AS n FROM effects WHERE key LIKE 'cont:%'"))!.n).toBe(2);
    await feed(n.app, dm(OWNER, "/alert incident again"));
    expect(n.t.sent(OWNER).at(-1)!.params.text).toContain("too_soon");
    // One-click unsubscribe from the email link.
    const unsub = /\/portal\/unsub\?t=(\S+)/.exec(mail[0]!.text)![1]!;
    expect((await n.http("GET", `/portal/unsub?t=${unsub}`)).text).toContain("<form");
    expect((await n.http("POST", `/portal/unsub?t=${unsub}`)).status).toBe(200);
    expect((await n.http("POST", `/portal/unsub?t=${unsub.replace(/.$/, "0")}x`)).status).toBe(400);
    // Drill: the unsubscribed address gets nothing; Telegram link confirms once.
    await feed(n.app, dm(OWNER, "/drill start telegram_down"));
    expect(await dispatchAlertEmails(n.app)).toBe(0);
    const eff = await q<{ payload: string }>("SELECT payload FROM effects WHERE key LIKE 'cont:%' ORDER BY created_at DESC, rowid DESC LIMIT 1");
    const confirm = /\/portal\/confirm\?t=(\S+)/.exec(JSON.parse(eff!.payload).text)![1]!;
    expect((await n.http("GET", `/portal/confirm?t=${confirm}`)).text).toContain("Thank you");
    expect((await n.http("GET", `/portal/confirm?t=${confirm}`)).text).toContain("Already");
    await feed(n.app, dm(OWNER, "/drill end"));
    expect(n.t.sent(OWNER).at(-1)!.params.text).toMatch(/1\/\d confirmed/);
    const m = await metrics(env.DB);
    expect(m).toMatchObject({ enrolled: 3, independentLogin: 2, followingCritical: 1, verifiedAlternate: 0, PI: 0 });
    expect(m.lastDrill).toMatchObject({ confirmed: 1, ended: true });
  });

  it("relocation alerts need a recent root-signed relocation; owner portal alerts need two factors", async () => {
    const n = node();
    await members(n, 67);
    await withIdentity(n);
    await feed(n.app, dm(OWNER, "/alert relocation moving"));
    expect(n.t.sent(OWNER).at(-1)!.params.text).toContain("no_recent_relocation");
    const moved = await manifest(2, "https://club-a-new.example", [R[0]!, R[1]!], { relocation: { from: A, to: "https://club-a-new.example", reason: "domain" } });
    expect((await n.admin("POST", "/admin/identity/manifest", moved)).json).toMatchObject({ ok: true, relocation: true });
    const api = await enrolWithEmail(n, OWNER, "owner@example.com");
    const codes = (await api("POST", "passport/recovery")).json.codes as string[];
    const P = { "x-portal": "1" };
    const t = (await n.http("POST", "/portal/api/login", { email: "owner@example.com" }, P)).json.ticket;
    const v = await n.http("POST", "/portal/api/verify", { ticket: t, code: codeIn(n.mails.at(-1)!.text) }, P);
    let cookie = /tp_s=[^;]+/.exec(v.cookie!)![0];
    expect((await n.http("POST", "/portal/api/alert", { kind: "relocation" }, { ...P, cookie })).json.reason).toBe("strong_auth_required");
    // A second method in another browser (no cookie) doesn't strengthen anyone's session.
    const elsewhere = await n.http("POST", "/portal/api/recover", { code: codes[0] }, P);
    expect((await n.http("POST", "/portal/api/alert", { kind: "relocation" }, { ...P, cookie })).json.reason).toBe("strong_auth_required");
    const other = /tp_s=[^;]+/.exec(elsewhere.cookie!)![0];
    expect((await n.http("POST", "/portal/api/alert", { kind: "relocation" }, { ...P, cookie: other })).json.reason).toBe("strong_auth_required");
    // The same method twice is still one factor.
    const t2 = (await n.http("POST", "/portal/api/login", { email: "owner@example.com" }, P)).json.ticket;
    const v2 = await n.http("POST", "/portal/api/verify", { ticket: t2, code: codeIn(n.mails.at(-1)!.text) }, { ...P, cookie });
    cookie = /tp_s=[^;]+/.exec(v2.cookie!)![0];
    expect((await n.http("POST", "/portal/api/alert", { kind: "relocation" }, { ...P, cookie })).json.reason).toBe("strong_auth_required");
    // A different method in the same browser, on top of that session: strong.
    const rc = await n.http("POST", "/portal/api/recover", { code: codes[1] }, { ...P, cookie });
    cookie = /tp_s=[^;]+/.exec(rc.cookie!)![0];
    const a = await n.http("POST", "/portal/api/alert", { kind: "relocation", note: "new home" }, { ...P, cookie });
    expect(a.json).toMatchObject({ ok: true });
    await dispatchAlertEmails(n.app);
    expect(n.mails.at(-1)!.text).toContain("https://club-a-new.example");
  });
});

describe("CONT-7 passport for partners, CONT-8 rescue relay", () => {
  it("a pass proves membership to one partner under a pseudonym; revocation is checkable", async () => {
    const n = node();
    await members(n, 68);
    await withIdentity(n);
    await feed(n.app, dm(OWNER, `/partner add ${B} ${PB.publicKey} * Club B`));
    const api = await enrolWithEmail(n, 68, "f@example.com");
    const pass = (await api("POST", "passport/pass", { audience: B })).json.pass as Signed<PassClaim>;
    const again = (await api("POST", "passport/pass", { audience: B })).json.pass as Signed<PassClaim>;
    expect(pass.signed.subject).toBe(again.signed.subject); // stable per partner
    expect(JSON.stringify(pass)).not.toMatch(/f@example|"68"/);
    const root = await rootDoc();
    expect(await verifyPass(pass, root, B)).toMatchObject({ ok: true, claim: { tier: "member" } });
    expect(await verifyPass(pass, root, "https://club-c.example")).toMatchObject({ ok: false, reason: "audience" });
    expect(await verifyPass({ ...pass, signed: { ...pass.signed, tier: "vip" } }, root, B)).toMatchObject({ ok: false, reason: "signature" });
    expect((await n.http("GET", `/v1/attestations/${pass.signed.id}/status`)).json.status).toBe("active");
    await env.DB.prepare("UPDATE membership_attestations SET status='revoked' WHERE id=?").bind(pass.signed.id).run();
    expect((await n.http("GET", `/v1/attestations/${pass.signed.id}/status`)).json.status).toBe("revoked");
    expect((await api("POST", "passport/pass", { audience: "https://unknown.example" })).status).toBe(400);
  });

  it("partners relay our verified relocation; forged or unpinned notices are refused", async () => {
    const n = node();
    await members(n);
    // We are the relay for partner B: pin B's root first.
    await feed(n.app, dm(OWNER, `/partner add ${B} ${PB.publicKey} * Club B`));
    const bRoot = await rootDoc("club-b", 1, PR, PR, PON);
    const bM1 = await manifest(1, B, [PON], {}, "club-b");
    const bMoved = await manifest(2, "https://club-b-new.example", PR, { relocation: { from: B, to: "https://club-b-new.example", reason: "banned" } }, "club-b");
    const notice = async (community: unknown) =>
      signMsg({ schema: "nexus.v1", type: "notice", exchange_id: "relay-2", issuer_org: B, recipient_org: A, issued_at: iso(Date.now()), expires_at: iso(Date.now() + DAY), nonce: crypto.randomUUID(), body: { community } }, PB.privateKey);
    expect((await n.http("POST", "/v1/notices", await notice({ root: bRoot, destinations: bMoved }))).json.reason).toBe("no_pinned_root");
    await feed(n.app, dm(OWNER, `/partner root ${B} ${JSON.stringify(bRoot)}`));
    expect(n.t.sent(OWNER).at(-1)!.params.text).toContain("pinned");
    const forged = await manifest(2, "https://evil.example", [PON], { relocation: { from: B, to: "https://evil.example", reason: "x" } }, "club-b");
    expect((await n.http("POST", "/v1/notices", await notice({ root: bRoot, destinations: forged }))).json.reason).toBe("relocation_needs_root");
    expect((await n.http("POST", "/v1/notices", await notice({ root: bRoot, destinations: bM1 }))).json.reason).toBe("not_a_relocation");
    expect((await n.http("POST", "/v1/notices", await notice({ root: bRoot, destinations: bMoved }))).status).toBe(202);
    const relay = (await n.http("GET", "/v1/relay")).json.notices;
    expect(relay[0]).toMatchObject({ partner: B, primary: "https://club-b-new.example", version: 2 });
    expect(n.t.sent(OWNER).at(-1)!.params.text).toContain("club-b-new.example");
  });

  it("our own relocation is queued as a signed notice to partners", async () => {
    const n = node();
    await members(n);
    await feed(n.app, dm(OWNER, `/partner add ${B} ${PB.publicKey} * Club B`));
    await withIdentity(n);
    const moved = await manifest(2, "https://club-a-new.example", [R[0]!, R[1]!], { relocation: { from: A, to: "https://club-a-new.example", reason: "domain" } });
    expect((await n.admin("POST", "/admin/identity/manifest", moved)).json).toMatchObject({ ok: true, relocation: true, relayed: 1 });
    await dispatchFed(n.app);
    expect(n.out.at(-1)!.url).toBe(`${B}/v1/notices`);
    expect(n.out.at(-1)!.body.body.community.destinations.signed.relocation.to).toBe("https://club-a-new.example");
  });
});

describe("continuity is opt-in and separate", () => {
  it("off without CONTINUITY_KEY; /passport explains; existing members aren't enrolled", async () => {
    const n = node({ CONTINUITY_KEY: undefined });
    await members(n, 69);
    expect((await miniApp(n, 69)("GET", "passport")).status).toBe(404);
    expect((await n.http("GET", "/portal")).status).toBe(404);
    const n2 = node();
    await feed(n2.app, dm(69, "/passport"));
    expect(n2.t.sent(69).at(-1)!.params.text).toContain("Not set up yet");
    expect(await q("SELECT COUNT(*) AS n FROM people")).toEqual({ n: 0 });
    // Enrolment is idempotent and needs a real member.
    const m = await ensureMember(env.DB, 70);
    expect(await enrolFromTelegram(env.DB, m)).toBe(await enrolFromTelegram(env.DB, m));
    void exportBundle;
    void importBundle;
  });
});

import CV from "../../contracts/test-vectors/continuity-v1.json";
import * as sdk from "../../contracts/sdk/nexus.mjs";

describe("CONT-10 conformance vectors", () => {
  it("the Worker and the SDK agree with the shared vectors", async () => {
    const root = CV.root as unknown as Signed<RootMeta>;
    for (const c of CV.cases.root) expect(await verifyRoot(c.doc as unknown as Signed<RootMeta>, c.trusted as unknown as Signed<RootMeta> | null, CV.now)).toEqual(c.expect);
    for (const c of CV.cases.destinations) {
      expect(await verifyDestinations(c.doc as unknown as Signed<DestMeta>, root, c.last as unknown as Signed<DestMeta> | null, CV.now)).toEqual(c.expect);
      expect(await sdk.verifyDestinations(c.doc as any, root, c.last as any, CV.now)).toEqual(c.expect);
    }
    for (const c of CV.cases.pass) expect((await verifyPass(c.doc as unknown as Signed<PassClaim>, root, c.me, CV.now)).ok).toBe(c.expect);
    expect(sdk.followStateFrom(CV.cases.restore.exports as any)).toEqual(CV.cases.restore.expect_any_order);
  });
});
