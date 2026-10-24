// Hydra (P16): every lost head must leave a member reachable and regrow two. One test per gate in
// docs/HYDRA_PLAN.md §6, plus the pieces each gate rests on.

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { b64, keyId, signWith, unb64, type Signed } from "../src/continuity/crypto";
import type { DestMeta, RootMeta } from "../src/continuity/identity";
import type { Env } from "../src/env";
import { generateKeys, sign as signMsg } from "../src/federation/envelope";
import { dispatchFed } from "../src/federation/gateway";
import { handleFetch, makeApp } from "../src/index";
import { coverage, expandDomains, headDomains, hydraIndex, independentCount, suggestHeads } from "../src/hydra/domains";
import { encryptPush, vapidAuth, vapidKeys, b64u, unb64u } from "../src/hydra/webpush";
import { combine, decodeShare, encodeShare, split } from "../src/hydra/shamir";
import { decryptEscrow, encryptEscrow, x25519Keys } from "../src/hydra/escrow";
import { totp, unbase32 } from "../src/hydra/login";
import { checkAnchor, verifyNotice, type NoticeMeta } from "../src/hydra/notices";
import { verifyReceipt, type ReceiptMeta } from "../src/hydra/receipts";
import { hydraMetrics, regrowth } from "../src/hydra/graph";
import { classify, dispatchInvites, openIncident, runCanaries } from "../src/hydra/regrow";
import { recordDomain } from "../src/hydra/health";
import { watchSeals } from "../src/hydra/fed";
import { dispatchAlerts } from "../src/continuity/alerts";
import { runCron } from "../src/cron";
import { dispatchPending } from "../src/outbox";
import { dm, enableGroup, fakeTelegram, feed, groupMsg, OWNER } from "./helpers";

declare global {
  interface Array<T> {
    findLast(pred: (v: T) => unknown): T | undefined; // ES2023, available in workerd
  }
}

type Keys = { privateKey: string; publicKey: string };
let R: Keys[];
let ON: Keys;
let FED: Keys;
let VAPID: { publicKey: string; privateKey: string };
let ESC: { privateKey: string; publicKey: string };
const ORG = "club-a";
const A = "https://club-a.example";
const B = "https://club-b.example";
const C = "https://club-c.example";
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const q = <T>(sql: string, ...a: unknown[]) => env.DB.prepare(sql).bind(...a).first<T>();
const CKEY = b64(new Uint8Array(32).map((_, i) => i * 5 + 3));

beforeAll(async () => {
  R = [await generateKeys(), await generateKeys(), await generateKeys()];
  ON = await generateKeys();
  FED = await generateKeys();
  VAPID = await vapidKeys();
  ESC = await x25519Keys();
});

const pk = async (k: Keys) => ({ keyid: await keyId(k.publicKey), key: k.publicKey });
async function rootDoc(org = ORG, keys = R, online = ON): Promise<Signed<RootMeta>> {
  let d: Signed<RootMeta> = { signed: { schema: "nexus.root.v1", org, version: 1, expires: iso(Date.now() + 365 * DAY), root_keys: await Promise.all(keys.map(pk)), threshold: 2, online_keys: [await pk(online)] }, signatures: [] };
  for (const k of keys) d = await signWith(d, k.privateKey, k.publicKey);
  return d;
}
async function manifest(version: number, primary: string, signers: Keys[], extra: Partial<DestMeta> = {}, org = ORG, days = 30): Promise<Signed<DestMeta>> {
  let d: Signed<DestMeta> = { signed: { schema: "nexus.destinations.v1", org, version, root_version: 1, expires: iso(Date.now() + days * DAY), destinations: [{ kind: "web", url: primary, role: "primary" }], ...extra }, signatures: [] };
  for (const k of signers) d = await signWith(d, k.privateKey, k.publicKey);
  return d;
}

interface Hit {
  url: string;
  method: string;
  body: string;
  raw?: Uint8Array;
  headers: Record<string, string>;
}

/** A node with a programmable fake internet. */
function node(extraEnv: Partial<Env> = {}, opts: { me?: string; fed?: Keys } = {}) {
  const t = fakeTelegram();
  const hits: Hit[] = [];
  const down = new Set<string>(); // URL substrings that answer 503
  const pages = new Map<string, () => Response>();
  const ntfy = new Map<string, string[]>();
  const mails: { to: string; subject: string; text: string; via: string }[] = [];
  const net = async (url: string, init: RequestInit = {}) => {
    const body = typeof init.body === "string" ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : init.body ? "[binary]" : "";
    hits.push({ url, method: init.method ?? "GET", body, raw: init.body instanceof Uint8Array ? init.body : undefined, headers: Object.fromEntries(Object.entries((init.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v])) });
    for (const d of down) if (url.includes(d)) return new Response("down", { status: 503 });
    for (const [prefix, f] of pages) if (url.startsWith(prefix)) return f();
    const u = new URL(url);
    if (u.host === "api.resend.com") {
      const b = JSON.parse(body);
      mails.push({ to: b.to[0], subject: b.subject, text: b.text, via: "resend" });
      return Response.json({ id: "r" });
    }
    if (u.host === "api.postmarkapp.com") {
      const b = JSON.parse(body);
      mails.push({ to: b.To, subject: b.Subject, text: b.TextBody, via: "postmark" });
      return Response.json({ MessageID: "p" });
    }
    if (u.host === "ntfy.sh") {
      if ((init.method ?? "GET") === "POST") {
        const b = JSON.parse(body);
        ntfy.set(b.topic, [...(ntfy.get(b.topic) ?? []), b.message]);
        return Response.json({ id: "n" });
      }
      const topic = u.pathname.split("/")[1]!;
      return new Response((ntfy.get(topic) ?? []).map((m) => JSON.stringify({ event: "message", message: m })).join("\n"));
    }
    if (u.host === "matrix.example") {
      if (u.pathname.endsWith("/createRoom")) return Response.json({ room_id: "!dm:matrix.example" });
      if (u.pathname.endsWith("/whoami")) return Response.json({ user_id: "@bot:matrix.example" });
      return Response.json({ event_id: "$e" });
    }
    if (u.host === "bsky.social" && u.pathname.endsWith("createSession")) return Response.json({ accessJwt: "j", did: "did:plc:x" });
    if (u.host === "cloudflare-dns.com") return Response.json({ Answer: [{ data: "10 aspmx.l.google.com." }] });
    return Response.json({ ok: true }, { status: 201 });
  };
  const me = opts.me ?? A;
  const fed = opts.fed ?? FED;
  const e: Env = {
    ...(env as unknown as Env),
    PUBLIC_URL: me,
    CONTINUITY_KEY: CKEY,
    IDENTITY_ONLINE_KEY: ON.privateKey,
    IDENTITY_ONLINE_PUBLIC_KEY: ON.publicKey,
    EMAIL_PROVIDER: "resend",
    EMAIL_API_KEY: "k",
    EMAIL_FROM: "club@example.com",
    VAPID_PUBLIC_KEY: VAPID.publicKey,
    VAPID_PRIVATE_KEY: VAPID.privateKey,
    NTFY_SERVERS: "https://ntfy.sh",
    MATRIX_HOMESERVER: "https://matrix.example",
    MATRIX_ACCESS_TOKEN: "mx",
    FEDERATION_ENABLED: "true",
    FEDERATION_PRIVATE_KEY: fed.privateKey,
    FEDERATION_PUBLIC_KEY: fed.publicKey,
    ...extraEnv,
  };
  const app = makeApp(e, t.fetcher, net);
  const http = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await handleFetch(new Request(me + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), e, t.fetcher, net);
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: res.status, json, text, cookie: res.headers.get("set-cookie"), headers: res.headers };
  };
  const admin = (method: string, path: string, body?: unknown) => http(method, path, body, { authorization: "Bearer test-admin-token" });
  return { app, e, t, hits, down, pages, ntfy, mails, http, admin };
}
type Node = ReturnType<typeof node>;

async function initData(id: number) {
  const enc = new TextEncoder();
  const key = async (k: BufferSource) => crypto.subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const secret = await crypto.subtle.sign("HMAC", await key(enc.encode("WebAppData")), enc.encode("123456:TEST"));
  const fields: Record<string, string> = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id }) };
  const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
  const hash = [...new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret), enc.encode(check)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return new URLSearchParams({ ...fields, hash }).toString();
}
const miniApp = (n: Node, id: number) => async (method: string, path: string, body?: unknown) => n.http(method, `/app/api/${path}`, body, { "x-telegram-init-data": await initData(id) });
const codeIn = (text: string) => /\b(\d{6})\b/.exec(text)![1]!;
const P = { "x-portal": "1" };

async function setup(n: Node, ...ids: number[]) {
  await enableGroup(n.app);
  for (const id of [OWNER, ...ids]) await feed(n.app, groupMsg(id, "hello"));
  expect((await n.admin("POST", "/admin/identity/root", await rootDoc())).json.ok).toBe(true);
  expect((await n.admin("POST", "/admin/identity/manifest", await manifest(1, A, [ON]))).json.ok).toBe(true);
}

/** Enrol via the Mini App with a verified email, then log into the portal. Returns a portal client. */
async function member(n: Node, id: number, email: string) {
  const api = miniApp(n, id);
  expect((await api("POST", "passport/enrol", { topics: ["critical"] })).json.ok).toBe(true);
  const r = (await api("POST", "passport/email", { email })).json;
  expect((await api("POST", "passport/email/verify", { registration: r.registration, code: codeIn(n.mails.at(-1)!.text) })).json.ok).toBe(true);
  const t = (await n.http("POST", "/portal/api/login", { email }, P)).json.ticket;
  const v = await n.http("POST", "/portal/api/verify", { ticket: t, code: codeIn(n.mails.at(-1)!.text) }, P);
  return portalClient(n, /tp_s=[^;]+/.exec(v.cookie!)![0]);
}
function portalClient(n: Node, cookie: string) {
  return (method: string, path: string, body?: unknown) => n.http(method, `/portal/api/${path}`, body, { ...P, cookie });
}
const ntfyCode = (n: Node, topic: string) => codeIn(n.ntfy.get(new URL(topic).pathname.slice(1))!.at(-1)!);

async function addNtfy(n: Node, portal: ReturnType<typeof portalClient>) {
  const topic = (await portal("GET", "ntfy-topic")).json.topic as string;
  const r = (await portal("POST", "head", { kind: "ntfy", address: topic })).json;
  expect(r).toMatchObject({ ok: true, sent: "sent" });
  expect((await portal("POST", "head/verify", { registration: r.registration, code: ntfyCode(n, topic) })).json.ok).toBe(true);
  return topic;
}

// ---- H0 --------------------------------------------------------------------------------------------

describe("H0 head model: count failure domains, not channels", () => {
  it("two Gmail addresses are one head; Gmail and Chrome push share Google; the registry adds correlations", () => {
    const g1 = expandDomains(headDomains("email", "a@gmail.com", { senders: ["resend", "postmark"] }), {});
    const g2 = expandDomains(headDomains("email", "b@googlemail.com", { senders: ["resend", "postmark"] }), {});
    const custom = expandDomains(headDomains("email", "me@family.example", { mx: "aspmx.l.google.com.", senders: ["resend", "postmark"] }), {});
    const push = expandDomains(headDomains("webpush", "https://fcm.googleapis.com/fcm/send/x"), {});
    const ntfy = expandDomains(headDomains("ntfy", "https://ntfy.sh/tp_abc"), {});
    expect(g1).toEqual(["mail:google", "org:google"]);
    expect(independentCount([g1, g2, custom])).toBe(1);
    expect(independentCount([g1, push])).toBe(1); // a Google-wide outage takes both
    expect(independentCount([g1, ntfy, ["telegram"]])).toBe(3);
    // One sending provider is a single point of failure for every email head.
    expect(headDomains("email", "x@proton.me", { senders: ["resend"] })).toEqual(["mail:proton", "sender:resend"]);
    // People-maintained registry: a self-hosted ntfy on the same cloud as the Matrix server.
    const reg = { "ntfy:ntfy.club.example": ["cloud:hetzner"], "matrix:matrix.club.example": ["cloud:hetzner"] };
    expect(independentCount([expandDomains(["ntfy:ntfy.club.example"], reg), expandDomains(["matrix:matrix.club.example"], reg)])).toBe(1);
  });

  it("the hydra index is the fewest domains whose joint failure cuts off >10%, buddies included", () => {
    const g = (heads: string[][], buddies: string[] = []) => ({ heads, buddies });
    const people = [
      { id: "a", ...g([["telegram"], ["mail:google", "org:google"], ["ntfy:ntfy.sh"]]) },
      { id: "b", ...g([["telegram"], ["mail:proton"]]) },
      { id: "c", ...g([["telegram"]], ["a"]) },
      { id: "d", ...g([["telegram"], ["ntfy:ntfy.sh"]]) },
    ];
    // Telegram alone cuts nobody (c has buddy a); telegram + proton cuts b (25%).
    expect(hydraIndex(people)).toMatchObject({ index: 2, worst: expect.arrayContaining(["telegram"]), cutOff: 1 });
    expect(hydraIndex([{ id: "x", heads: [["telegram"]] }])).toMatchObject({ index: 1, worst: ["telegram"] });
    expect(hydraIndex([{ id: "x", heads: [] }])).toMatchObject({ index: 0 });
    expect(coverage(people)).toEqual({ people: 4, atLeast1: 4, atLeast2: 4, atLeast3: 1 }); // a buddy counts as one more path
    expect(suggestHeads([["telegram"], ["mail:google"]], [{ kind: "webpush", domain: "push:browser" }, { kind: "ntfy", domain: "ntfy:ntfy.sh" }, { kind: "email", domain: "mail:google" }], ["push:browser"])).toEqual(["ntfy", "webpush"]);
  });

  it("metrics come from verified records only and show in /hydra", async () => {
    const n = node();
    await setup(n, 71);
    await member(n, 71, "m71@gmail.com");
    const m = await hydraMetrics(n.app);
    // Telegram link + Gmail: two independent heads; the index is 1 because each person's
    // two heads are telegram and google, and one person: telegram+google (2) cuts 100%.
    expect(m).toMatchObject({ people: 1, coverage: { atLeast2: 1, atLeast3: 0 }, index: { index: 2 } });
    await feed(n.app, dm(OWNER, "/hydra"));
    const text = n.t.sent(OWNER).at(-1)!.params.text as string;
    expect(text).toContain("Hydra index: <b>2</b>");
    expect(text).not.toMatch(/m71@gmail/);
  });
});

// ---- H1 --------------------------------------------------------------------------------------------

async function decryptPush(body: Uint8Array, ua: CryptoKeyPair, auth: Uint8Array): Promise<string> {
  const salt = body.slice(0, 16);
  const idlen = body[20]!;
  const asPublic = body.slice(21, 21 + idlen);
  const ct = body.slice(21 + idlen);
  const uaPublic = new Uint8Array((await crypto.subtle.exportKey("raw", ua.publicKey)) as ArrayBuffer);
  const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey } as any, ua.privateKey, 256));
  const hmac = async (k: Uint8Array, d: Uint8Array) => new Uint8Array(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), d));
  const enc = new TextEncoder();
  const cat = (...p: Uint8Array[]) => new Uint8Array(p.flatMap((x) => [...x]));
  const ikm = await hmac(await hmac(auth, shared), cat(enc.encode("WebPush: info\0"), uaPublic, asPublic, new Uint8Array([1])));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, cat(enc.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, cat(enc.encode("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]), ct));
  return new TextDecoder().decode(plain.slice(0, plain.lastIndexOf(2)));
}

describe("H1 more delivery heads", () => {
  it("Web Push: RFC 8291 encryption a browser can open, and a valid VAPID signature", async () => {
    const ua = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    const auth = crypto.getRandomValues(new Uint8Array(16));
    const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", p256dh: b64u((await crypto.subtle.exportKey("raw", ua.publicKey)) as ArrayBuffer), auth: b64u(auth) };
    const body = await encryptPush(sub, '{"title":"Привет"}');
    expect(await decryptPush(body, ua, auth)).toBe('{"title":"Привет"}');
    const h = await vapidAuth(sub.endpoint, VAPID.publicKey, VAPID.privateKey, "mailto:ops@club.example");
    const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(h)!;
    expect(k).toBe(VAPID.publicKey);
    const [hd, cl, sig] = jwt!.split(".");
    expect(JSON.parse(new TextDecoder().decode(unb64u(cl!)))).toMatchObject({ aud: "https://fcm.googleapis.com", sub: "mailto:ops@club.example" });
    const pub = await crypto.subtle.importKey("raw", unb64u(VAPID.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, unb64u(sig!), new TextEncoder().encode(`${hd}.${cl}`))).toBe(true);
  });

  it("members add push, ntfy, Matrix and SMS heads, each verified over itself; arbitrary URLs are refused", async () => {
    const n = node({ SMS_PROVIDER: "twilio", SMS_ACCOUNT_SID: "AC1", SMS_AUTH_TOKEN: "t", SMS_FROM: "+15550000000" });
    await setup(n, 72);
    const portal = await member(n, 72, "m72@proton.me");
    await addNtfy(n, portal);
    // Web Push: the code travels encrypted to the push service.
    const ua = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    const auth = crypto.getRandomValues(new Uint8Array(16));
    const keys = { p256dh: b64u((await crypto.subtle.exportKey("raw", ua.publicKey)) as ArrayBuffer), auth: b64u(auth) };
    const wp = (await portal("POST", "head", { kind: "webpush", address: "https://fcm.googleapis.com/fcm/send/dev1", keys })).json;
    expect(wp.ok).toBe(true);
    const pushHit = n.hits.findLast((h) => h.url.startsWith("https://fcm.googleapis.com"))!;
    expect(pushHit.headers["content-encoding"]).toBe("aes128gcm");
    expect((await portal("POST", "head", { kind: "webpush", address: "https://evil.example/collect", keys })).json.reason).toBe("push_endpoint");
    expect((await portal("POST", "head", { kind: "ntfy", address: "https://evil.example/tp_aaaaaaaaaaaaaaaaaaaa" })).json.reason).toBe("ntfy_url");
    // Matrix: a DM room is created once, then reused.
    const mx = (await portal("POST", "head", { kind: "matrix", address: "@m72:matrix.org" })).json;
    const sent = n.hits.findLast((h) => h.url.includes("/send/m.room.message/"))!;
    expect((await portal("POST", "head/verify", { registration: mx.registration, code: codeIn(JSON.parse(sent.body).body) })).json.ok).toBe(true);
    // SMS through Twilio.
    const sms = (await portal("POST", "head", { kind: "sms", address: "+44 7700 900123" })).json;
    const tw = n.hits.findLast((h) => h.url.includes("api.twilio.com"))!;
    expect((await portal("POST", "head/verify", { registration: sms.registration, code: codeIn(decodeURIComponent(tw.body.replaceAll("+", " "))) })).json.ok).toBe(true);
    const y = (await portal("GET", "hydra")).json;
    expect(y.heads.filter((h: any) => h.status === "verified").map((h: any) => h.channel).sort()).toEqual(["email", "matrix", "ntfy", "sms"]);
    expect(y.independent).toBe(5); // telegram + proton + ntfy + matrix + sms
    expect(JSON.stringify(y.heads)).not.toContain("dev1"); // push endpoints are capability URLs: never shown back
  });

  it("gate: a member on ≥3 domains is still reached with email down, and a second provider takes over", async () => {
    const n = node({ EMAIL_B_PROVIDER: "postmark", EMAIL_B_API_KEY: "pm", EMAIL_B_FROM: "club@example.org" });
    await setup(n, 73);
    const portal = await member(n, 73, "m73@gmail.com");
    const topic = await addNtfy(n, portal);
    expect((await hydraMetrics(n.app)).coverage.atLeast3).toBe(1);
    // Email provider A dies: B carries the mail; ntfy and Telegram carry the notice anyway.
    n.down.add("api.resend.com");
    await feed(n.app, dm(OWNER, "/alert incident maintenance tonight"));
    await dispatchAlerts(n.app);
    expect(n.mails.at(-1)).toMatchObject({ via: "postmark", to: "m73@gmail.com" });
    expect(n.ntfy.get(new URL(topic).pathname.slice(1))!.at(-1)).toContain("maintenance tonight");
    await dispatchPending(env.DB, n.app.tg, 40); // Telegram copies go through the effect ledger
    expect(n.t.sent(73).at(-1)!.params.text).toContain("maintenance tonight");
    // Even with both email providers down, the other two heads reach the member.
    n.down.add("api.postmarkapp.com");
    await env.DB.batch([env.DB.prepare("DELETE FROM alert_deliveries"), env.DB.prepare("DELETE FROM continuity_alerts")]);
    await feed(n.app, dm(OWNER, "/alert incident second notice"));
    await dispatchAlerts(n.app);
    expect(n.ntfy.get(new URL(topic).pathname.slice(1))!.at(-1)).toContain("second notice");
    expect(await q("SELECT state FROM alert_deliveries WHERE channel='email' ORDER BY updated_at DESC LIMIT 1")).toEqual({ state: "failed" });
  });

  it("signed public notices: JSON, Atom and iCal feeds, verifiable against the root; anchors pin the manifest", async () => {
    const n = node({ MASTODON_URL: "https://mastodon.example", MASTODON_TOKEN: "m", BLUESKY_HANDLE: "club.bsky.social", BLUESKY_APP_PASSWORD: "p", ARCHIVE_ANCHOR: "true" });
    await setup(n);
    await feed(n.app, dm(OWNER, "/hydra notice Meeting moved | Thursday at the library, 7pm"));
    const j = (await n.http("GET", "/notices.json")).json;
    const root = await rootDoc();
    const latest = j.notices[0] as Signed<NoticeMeta>;
    expect(latest.signed).toMatchObject({ title: "Meeting moved", body: "Thursday at the library, 7pm", primary: A });
    expect(await verifyNotice(latest, root)).toEqual({ ok: true });
    expect(await verifyNotice({ ...latest, signed: { ...latest.signed, body: "send money" } }, root)).toEqual({ ok: false, reason: "notice_signature" });
    expect((await n.http("GET", "/feed.xml")).text).toContain("<title>Meeting moved</title>");
    expect((await n.http("GET", "/notices.ics")).text).toContain("SUMMARY:Meeting moved");
    // The manifest install published an anchor notice; announcers post them.
    const anchor = (await n.http("GET", "/.well-known/nexus-anchor.txt")).text.trim();
    const m1 = (await n.http("GET", "/.well-known/nexus-community.json")).json.destinations as Signed<DestMeta>;
    expect(await checkAnchor(anchor, root, m1)).toEqual({ ok: true });
    expect(await checkAnchor(anchor.replace(/man=1:\S+/, "man=1:AAAA"), root, m1)).toEqual({ ok: false, reason: "anchor_manifest" });
    for (let i = 0; i < 5; i++) await runCron(n.app);
    expect(n.hits.some((h) => h.url === "https://mastodon.example/api/v1/statuses" && JSON.parse(h.body).status.includes("Meeting moved"))).toBe(true);
    expect(n.hits.some((h) => h.url.endsWith("com.atproto.repo.createRecord"))).toBe(true);
    expect(n.hits.some((h) => h.url.startsWith("https://web.archive.org/save/"))).toBe(true);
    expect(await q("SELECT COUNT(*) AS n FROM announce_outbox WHERE state='pending'")).toEqual({ n: 0 });
  });
});

describe("free-plan budget", () => {
  it("one cron run never exceeds the subrequest limit, however much is queued", async () => {
    const n = node({ EMAIL_B_PROVIDER: "postmark", EMAIL_B_API_KEY: "pm", EMAIL_B_FROM: "club@example.org" });
    await setup(n, 87);
    const portal = await member(n, 87, "m87@proton.me");
    await addNtfy(n, portal);
    const person = (await q<{ id: string }>("SELECT person_id AS id FROM follow_state LIMIT 1"))!.id;
    n.down.add("api.resend.com"); // every email costs two calls (failover)
    for (let i = 0; i < 40; i++) {
      await env.DB.prepare("INSERT INTO continuity_alerts(id, kind, manifest_version, message, created_by, created_at) VALUES (?, 'incident', 1, 'm', 'test', ?)").bind(`a${i}`, iso(Date.now() + i)).run();
      for (const ch of ["email", "ntfy"]) await env.DB.prepare("INSERT INTO alert_deliveries(alert_id, person_id, channel, state, updated_at) VALUES (?,?,?, 'pending', ?)").bind(`a${i}`, person, ch, iso(Date.now())).run();
    }
    for (let i = 0; i < 40; i++) await env.DB.prepare("INSERT INTO effects(id, key, chat_id, payload, state, created_at, updated_at) VALUES (?,?,?,?, 'pending', ?, ?)").bind(`e${i}`, `k${i}`, 87, JSON.stringify({ text: "x" }), iso(Date.now()), iso(Date.now())).run();
    const before = n.hits.length;
    n.t.calls.length = 0;
    await runCron(n.app);
    const used = n.hits.length - before + n.t.calls.length;
    expect(used).toBeLessThanOrEqual(46);
    expect(used).toBeGreaterThan(20); // it did real work, it just stopped in time
  });
});

// ---- H3 --------------------------------------------------------------------------------------------

describe("H3 regrowth engine and canaries", () => {
  it("gate: a dead domain opens an incident, affected members get two independent suggestions, and regrowth ≥2 is measured", async () => {
    const n = node();
    await setup(n, 74, 75);
    const p74 = await member(n, 74, "m74@gmail.com");
    await member(n, 75, "m75@proton.me");
    await addNtfy(n, p74);
    await env.DB.prepare("UPDATE delivery_registrations SET verified_at=?").bind(iso(Date.now() - 3_600_000)).run(); // heads from before the incident
    // Mailbox feedback says Google is bouncing everything.
    for (let i = 0; i < 5; i++) await recordDomain(env.DB, "mail:google", false);
    expect(await classify(n.app)).toBe(1);
    const inc = await q<{ id: string; heads_lost: number; people_affected: number }>("SELECT id, heads_lost, people_affected FROM head_incidents WHERE domain='mail:google'");
    expect(inc).toMatchObject({ heads_lost: 1, people_affected: 1 });
    const inv = await q<{ state: string; suggested: string }>("SELECT state, suggested FROM regrowth_invites WHERE incident_id=?", inc!.id);
    const sugg = JSON.parse(inv!.suggested) as string[];
    expect(sugg).toHaveLength(2);
    expect(sugg).not.toContain("ntfy"); // already has it
    // The invitation travels over a head that still works (ntfy), not the dead one.
    const before = n.mails.length;
    expect(await dispatchInvites(n.app)).toBe(1);
    expect(n.mails.length).toBe(before);
    expect([...n.ntfy.values()].flat().at(-1)).toContain("add two more");
    // The member answers by adding two heads in new domains: ratio 2.
    const mx = (await p74("POST", "head", { kind: "matrix", address: "@m74:matrix.org" })).json;
    await p74("POST", "head/verify", { registration: mx.registration, code: codeIn(JSON.parse(n.hits.findLast((h) => h.url.includes("/send/m.room.message/"))!.body).body) });
    const ua = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    const auth = crypto.getRandomValues(new Uint8Array(16));
    const wp = (await p74("POST", "head", { kind: "webpush", address: "https://updates.push.services.mozilla.com/wpush/v2/x", keys: { p256dh: b64u((await crypto.subtle.exportKey("raw", ua.publicKey)) as ArrayBuffer), auth: b64u(auth) } })).json;
    const pushBody = await decryptPush(n.hits.findLast((h) => h.url.startsWith("https://updates.push.services.mozilla.com"))!.raw!, ua, auth);
    expect((await p74("POST", "head/verify", { registration: wp.registration, code: codeIn(JSON.parse(pushBody).title) })).json.ok).toBe(true);
    expect(await regrowth(env.DB, inc!.id)).toMatchObject({ lost: 1, added: 2, ratio: 2 });
    // Owners heard about it; the domain recovering closes the incident.
    await dispatchPending(env.DB, n.app.tg, 40);
    expect(n.t.sent(OWNER).some((c) => String(c.params.text).includes("Path down"))).toBe(true);
    await recordDomain(env.DB, "mail:google", true);
    await recordDomain(env.DB, "mail:google", true);
    await env.DB.prepare("UPDATE domain_health SET state='up' WHERE domain='mail:google'").run();
    await classify(n.app);
    expect(await q("SELECT state FROM head_incidents WHERE id=?", inc!.id)).toEqual({ state: "recovered" });
  });

  it("Telegram down: the pre-approved playbook publishes a public notice and proposes the rest", async () => {
    const n = node();
    await setup(n, 76);
    await member(n, 76, "m76@proton.me");
    await openIncident(n.app, "telegram");
    expect((await n.http("GET", "/notices.json")).json.notices[0].signed).toMatchObject({ kind: "incident", title: "Telegram is unavailable for us" });
    expect(await q("SELECT state, automatic FROM club_regrowth WHERE action='public_notice'")).toEqual({ state: "done", automatic: 1 });
    expect(await q("SELECT state FROM club_regrowth WHERE action='open_matrix_room'")).toEqual({ state: "proposed" });
    await feed(n.app, dm(OWNER, "/hydra done open_matrix_room matrix:matrix.example"));
    expect(await q("SELECT state, domain FROM club_regrowth WHERE action='open_matrix_room'")).toEqual({ state: "done", domain: "matrix:matrix.example" });
    // With the playbook emptied, nothing runs on its own.
    await feed(n.app, dm(OWNER, "/hydra playbook none"));
    await env.DB.prepare("DELETE FROM head_incidents").run();
    await openIncident(n.app, "telegram");
    expect(await q("SELECT COUNT(*) AS n FROM public_notices WHERE kind='incident'")).toEqual({ n: 1 });
  });

  it("canaries catch silent failure: two failed ntfy probes mark the domain down", async () => {
    const n = node();
    await setup(n);
    await feed(n.app, dm(OWNER, "/hydra canary add ntfy https://ntfy.sh/tp_canary_0123456789abcd"));
    await feed(n.app, dm(OWNER, `/hydra canary add mirror ${B}`));
    n.pages.set(B, () => Response.json({ x: 1 }));
    expect(await runCanaries(n.app, 5)).toBe(2);
    expect(await q("SELECT last_result FROM canaries WHERE kind='ntfy'")).toEqual({ last_result: "ok" });
    expect(await q("SELECT last_result FROM canaries WHERE kind='mirror'")).toEqual({ last_result: "shape" });
    n.down.add("ntfy.sh");
    const later = new Date(Date.now() + DAY);
    await runCanaries(n.app, 5, later);
    await runCanaries(n.app, 5, new Date(later.getTime() + DAY));
    expect(await q("SELECT state FROM domain_health WHERE domain='ntfy:ntfy.sh'")).toEqual({ state: "down" });
  });
});

// ---- H2 --------------------------------------------------------------------------------------------

describe("H2 login heads", () => {
  it("gate: login works with email AND Telegram gone (authenticator, device key, code over ntfy)", async () => {
    const n = node();
    await setup(n, 77);
    const portal = await member(n, 77, "m77@proton.me");
    await addNtfy(n, portal);
    const handle = (await portal("GET", "hydra")).json.handle as string;
    expect(handle).toMatch(/^TP-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    // Authenticator (TOTP), replay-guarded.
    const t = (await portal("POST", "totp", { label: "phone" })).json;
    expect(t.uri).toContain(`:${handle}?secret=`);
    expect(t.qr).toMatch(/^data:image\/svg\+xml;base64,/);
    const secret = unbase32(t.secret);
    const step = Math.floor(Date.now() / 30_000);
    expect((await portal("POST", "totp/confirm", { id: t.id, code: await totp(secret, step) })).json.ok).toBe(true);
    // Now email and Telegram are gone.
    n.down.add("api.resend.com");
    n.t.calls.length = 0;
    expect((await n.http("POST", "/portal/api/login/totp", { handle, code: await totp(secret, step) }, P)).status).toBe(401); // replay
    const ok = await n.http("POST", "/portal/api/login/totp", { handle: handle.toLowerCase(), code: await totp(secret, step + 1) }, P);
    expect(ok.json.ok).toBe(true);
    // Device key: non-extractable in the browser; the server keeps only the public half.
    const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as JsonWebKey;
    const dev = (await portal("POST", "device", { jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, label: "laptop" })).json;
    expect((await portal("POST", "device", { jwk: { ...jwk, d: "secret" } })).json.reason).toBe("jwk");
    const c = (await n.http("POST", "/portal/api/login/challenge", {}, P)).json;
    const sig = b64u(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, new TextEncoder().encode(`nexus-login:${c.nonce}`)));
    expect((await n.http("POST", "/portal/api/login/device", { factor: dev.id, challenge: c.id, sig }, P)).json.ok).toBe(true);
    expect((await n.http("POST", "/portal/api/login/device", { factor: dev.id, challenge: c.id, sig }, P)).status).toBe(401); // one use
    // A code sent over every healthy head (here: ntfy); same answer for an unknown passport id.
    const tk = (await n.http("POST", "/portal/api/login/handle", { handle }, P)).json.ticket;
    const fake = await n.http("POST", "/portal/api/login/handle", { handle: "TP-AAAA-AAAA" }, P);
    expect(fake.json).toMatchObject({ ok: true });
    const code = codeIn([...n.ntfy.values()].flat().at(-1)!);
    const s = await n.http("POST", "/portal/api/login/handle/verify", { ticket: tk, code }, P);
    expect(s.json.ok).toBe(true);
    const me = await n.http("GET", "/portal/api/me", undefined, { cookie: /tp_s=[^;]+/.exec(s.cookie!)![0] });
    expect(me.json.protection.level).toBe("protected");
    expect(me.json.protection.factors.map((f: any) => f.kind).sort()).toEqual(["device_key", "totp"]);
  });

  it("five wrong authenticator codes lock the factor for 15 minutes", async () => {
    const n = node();
    await setup(n, 78);
    const portal = await member(n, 78, "m78@proton.me");
    const handle = (await portal("GET", "hydra")).json.handle;
    const t = (await portal("POST", "totp", {})).json;
    const step = Math.floor(Date.now() / 30_000);
    await portal("POST", "totp/confirm", { id: t.id, code: await totp(unbase32(t.secret), step) });
    for (let i = 0; i < 5; i++) await n.http("POST", "/portal/api/login/totp", { handle, code: "000000" }, P);
    expect((await n.http("POST", "/portal/api/login/totp", { handle, code: await totp(unbase32(t.secret), step + 1) }, P)).status).toBe(401);
  });
});

describe("Mini App", () => {
  it("reaches the same Hydra routes through signed initData: summary, ntfy head, buddy code", async () => {
    const n = node();
    await setup(n, 88);
    await member(n, 88, "m88@proton.me");
    const api = miniApp(n, 88);
    const y = (await api("GET", "passport/h/hydra")).json;
    expect(y).toMatchObject({ telegram: true, independent: 2 });
    expect(y.handle).toMatch(/^TP-/);
    const topic = (await api("GET", "passport/h/ntfy-topic")).json.topic;
    const r = (await api("POST", "passport/h/head", { kind: "ntfy", address: topic })).json;
    expect((await api("POST", "passport/h/head/verify", { registration: r.registration, code: ntfyCode(n, topic) })).json.ok).toBe(true);
    expect((await api("GET", "passport/h/hydra")).json.independent).toBe(3);
    expect((await api("POST", "passport/h/buddy/invite", { label: "Ann" })).json.code).toBeTruthy();
    expect((await api("GET", "passport/h/nope")).status).toBe(404);
  });
});

describe("portal page", () => {
  it("the page script parses, the service worker is scoped, and CSP allows only what it needs", async () => {
    const n = node();
    const page = await n.http("GET", "/portal");
    const script = /<script>([\s\S]*)<\/script>/.exec(page.text)![1]!;
    expect(() => new Function(script)).not.toThrow();
    expect(page.headers.get("content-security-policy")).toContain("worker-src 'self'");
    const sw = await n.http("GET", "/portal/sw.js");
    expect(sw.headers.get("service-worker-allowed")).toBe("/portal/");
    expect(() => new Function(sw.text)).not.toThrow();
  });
});

// ---- H4 --------------------------------------------------------------------------------------------

describe("H4 data and key multi-homing", () => {
  it("Shamir: any k shares recover the key; k-1 don't", () => {
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const shares = split(secret, 5, 3);
    expect([...combine([shares[4]!, shares[0]!, shares[2]!])]).toEqual([...secret]);
    expect([...combine(shares.slice(1, 4).map((s) => decodeShare(encodeShare(s))))]).toEqual([...secret]);
    expect(() => combine(shares.slice(0, 2))).toThrow("shamir_too_few");
    const forged = { ...shares[0]!, k: 2 };
    expect([...combine([forged, shares[1]!])]).not.toEqual([...secret]);
  });

  it("gate: nightly escrow is encrypted to recipients, written to S3-compatible storage, and restores on a fresh node", async () => {
    const other = await x25519Keys();
    const n = node({ ESCROW_RECIPIENTS: `${ESC.publicKey},${other.publicKey}`, ESCROW_TARGETS: JSON.stringify([{ name: "b2", url: "https://s3.eu-central-003.backblazeb2.example/club-escrow", region: "eu-central-003", keyIdSecret: "B2_KEY_ID", secretSecret: "B2_SECRET" }]), B2_KEY_ID: "k1", B2_SECRET: "s1" } as Partial<Env>);
    await setup(n, 79);
    const portal = await member(n, 79, "m79@proton.me");
    const topic = await addNtfy(n, portal);
    await runCron(n.app);
    const put = n.hits.find((h) => h.method === "PUT")!;
    expect(put.url).toMatch(/^https:\/\/s3\.eu-central-003\.backblazeb2\.example\/club-escrow\/club-a\/escrow-\d{4}-\d{2}-\d{2}\.json$/);
    expect(put.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=k1\/\d{8}\/eu-central-003\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    expect(put.body).not.toContain("m79@proton.me"); // ciphertext only
    expect(await q("SELECT targets_ok, targets_failed FROM escrow_runs")).toEqual({ targets_ok: 1, targets_failed: 0 });
    const envelope = JSON.parse(put.body);
    const bundle = JSON.parse(await decryptEscrow(envelope, ESC.privateKey));
    expect(JSON.parse(await decryptEscrow(envelope, other.privateKey))).toEqual(bundle);
    await expect(decryptEscrow(envelope, (await x25519Keys()).privateKey)).rejects.toThrow("not_a_recipient");
    // Total loss of continuity tables, then restore from the escrow copy alone.
    for (const t of ["subscription_ops", "follow_state", "delivery_registrations", "login_codes", "sessions", "identity_links", "membership_attestations", "recovery_codes", "login_factors", "alert_deliveries", "people"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
    expect((await n.admin("POST", "/admin/continuity/import", bundle)).json).toMatchObject({ people: 1 });
    const restored = await q<{ channel: string; domains: string }>("SELECT channel, domains FROM delivery_registrations WHERE channel='ntfy'");
    expect(restored).toEqual({ channel: "ntfy", domains: '["ntfy:ntfy.sh"]' });
    expect(await q("SELECT status FROM follow_state WHERE topic='critical'")).toEqual({ status: "following" });
    // The restored ntfy head still delivers.
    await feed(n.app, dm(OWNER, "/alert incident restored"));
    await dispatchAlerts(n.app);
    expect(n.ntfy.get(new URL(topic).pathname.slice(1))!.at(-1)).toContain("restored");
  });

  it("escrow envelopes round-trip and detect tampering", async () => {
    const e = await encryptEscrow('{"x":1}', [ESC.publicKey], "club-a");
    expect(await decryptEscrow(e, ESC.privateKey)).toBe('{"x":1}');
    const bad = { ...e, ct: b64(unb64(e.ct).map((x, i) => (i === 0 ? x ^ 1 : x))) };
    await expect(decryptEscrow(bad, ESC.privateKey)).rejects.toThrow();
  });
});

// ---- H5 --------------------------------------------------------------------------------------------

describe("H5 member-held proof", () => {
  it("gate: consent restores from receipts alone; an old receipt never overrides a newer unfollow", async () => {
    const n = node();
    await setup(n, 80);
    const portal = await member(n, 80, "m80@proton.me");
    await portal("POST", "topic", { topic: "events", on: true });
    const first = (await portal("GET", "receipts")).json.receipts as Signed<ReceiptMeta>[];
    await portal("POST", "topic", { topic: "events", on: false });
    const all = (await portal("GET", "receipts")).json.receipts as Signed<ReceiptMeta>[];
    const root = await rootDoc();
    for (const r of all) expect(await verifyReceipt(r, root)).toBe(true);
    expect(await verifyReceipt({ ...all[0]!, signed: { ...all[0]!.signed, op: "FOLLOW", topic: "commercial" } }, root)).toBe(false);
    // Replaying the old FOLLOW receipt changes nothing.
    expect((await portal("POST", "receipts", { receipts: first })).json).toMatchObject({ rejected: 0 });
    expect(await q("SELECT status FROM follow_state WHERE topic='events'")).toEqual({ status: "unfollowed" });
    // Every club database lost. On the new node the member re-verifies their address (a new
    // person with no choices yet) and presents the receipts their device kept.
    for (const t of ["subscription_ops", "follow_state", "suppressions", "sessions", "delivery_registrations", "login_codes", "identity_links", "membership_attestations", "recovery_codes", "login_factors", "people"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
    const again = await member(n, 80, "m80@proton.me");
    await env.DB.prepare("DELETE FROM subscription_ops").run(); // member() chose 'critical'; start from no choices
    await env.DB.prepare("DELETE FROM follow_state").run();
    const r = (await again("POST", "receipts", { receipts: [...first, ...all] })).json;
    expect(r.applied).toBeGreaterThan(0);
    expect(await q("SELECT status FROM follow_state WHERE topic='events'")).toEqual({ status: "unfollowed" });
    expect(await q("SELECT status FROM follow_state WHERE topic='critical'")).toEqual({ status: "following" });
    expect(await q("SELECT COUNT(*) AS n FROM suppressions WHERE scope='events'")).toEqual({ n: 1 });
  });

  it("guardians: k approvals plus 24 hours, the person can stop it, unknown ids look the same", async () => {
    const n = node();
    await setup(n, 81, 82, 83);
    const p81 = await member(n, 81, "m81@proton.me");
    const p82 = await member(n, 82, "m82@proton.me");
    const p83 = await member(n, 83, "m83@proton.me");
    const h = async (p: typeof p81) => (await p("GET", "hydra")).json.handle as string;
    const [h81, h82, h83] = [await h(p81), await h(p82), await h(p83)];
    expect((await p81("POST", "guardian/add", { handle: h82 })).json.ok).toBe(true);
    expect((await p81("POST", "guardian/add", { handle: h83 })).json.ok).toBe(true);
    expect((await p81("POST", "guardian/k", { k: 2 })).json.ok).toBe(false); // not accepted yet
    await p82("POST", "guardian/answer", { handle: h81, accept: true });
    await p83("POST", "guardian/answer", { handle: h81, accept: true });
    expect((await p81("POST", "guardian/k", { k: 2 })).json.ok).toBe(true);
    const start = await n.http("POST", "/portal/api/recover/guardians", { handle: h81 }, P);
    const unknown = await n.http("POST", "/portal/api/recover/guardians", { handle: "TP-ZZZZ-ZZZZ" }, P);
    expect(Object.keys(unknown.json).sort()).toEqual(Object.keys(start.json).sort());
    const ticket = start.json.ticket as string;
    // The person was warned with a stop link over their own heads.
    expect(n.mails.find((m) => m.to === "m81@proton.me" && m.text.includes("/portal/recovery/cancel?t="))).toBeTruthy();
    const req = (await p82("GET", "hydra")).json.guardians.guarding[0].requests[0].id;
    await p82("POST", "guardian/approve", { request: req });
    expect((await n.http("POST", "/portal/api/recover/guardians/claim", { ticket }, P)).json).toMatchObject({ status: "waiting", approvals: 1, needed: 2 });
    await p83("POST", "guardian/approve", { request: req });
    expect((await n.http("POST", "/portal/api/recover/guardians/claim", { ticket }, P)).json.status).toBe("waiting"); // 24 h not over
    await env.DB.prepare("UPDATE recovery_requests SET not_before=?").bind(iso(Date.now() - 1000)).run();
    const ok = await n.http("POST", "/portal/api/recover/guardians/claim", { ticket }, P);
    expect(ok.json.ok).toBe(true);
    expect((await n.http("GET", "/portal/api/me", undefined, { cookie: /tp_s=[^;]+/.exec(ok.cookie!)![0] })).json.protection.emails[0].address).toBe("m81@proton.me");
    // A second request is stopped by the person's one-tap link.
    const t2 = (await n.http("POST", "/portal/api/recover/guardians", { handle: h81 }, P)).json.ticket;
    const stop = /\/portal\/recovery\/cancel\?t=(\S+)/.exec(n.mails.findLast((m) => m.to === "m81@proton.me")!.text)![1]!;
    expect((await n.http("POST", `/portal/recovery/cancel?t=${stop}`)).text).toContain("Stopped");
    await env.DB.prepare("UPDATE recovery_requests SET not_before=?").bind(iso(Date.now() - 1000)).run();
    expect((await n.http("POST", "/portal/api/recover/guardians/claim", { ticket: t2 }, P)).json.status).toBe("invalid");
  });
});

// ---- H6 --------------------------------------------------------------------------------------------

describe("H6 anchors, gossip and the printed card", () => {
  it("gate: a relocation reaches a club that only talks to one partner (gossip), verified end to end", async () => {
    // We are node A. B moved and tells us; we forward to C. Then C's copy (from us) is checked.
    const PB = await generateKeys();
    const PC = await generateKeys();
    const BR = [await generateKeys(), await generateKeys()];
    const BON = await generateKeys();
    const n = node();
    await setup(n);
    await feed(n.app, dm(OWNER, `/partner add ${B} ${PB.publicKey} * Club B`));
    await feed(n.app, dm(OWNER, `/partner add ${C} ${PC.publicKey} * Club C`));
    const bRoot = await rootDoc("club-b", BR, BON);
    await feed(n.app, dm(OWNER, `/partner root ${B} ${JSON.stringify(bRoot)}`));
    const bMoved = await manifest(2, "https://club-b-new.example", BR, { relocation: { from: B, to: "https://club-b-new.example", reason: "banned" } }, "club-b");
    const notice = async (from: string, key: Keys, body: Record<string, unknown>) => signMsg({ schema: "nexus.v1", type: "notice", exchange_id: "n", issuer_org: from, recipient_org: A, issued_at: iso(Date.now()), expires_at: iso(Date.now() + DAY), nonce: crypto.randomUUID(), body }, key.privateKey);
    expect((await n.http("POST", "/v1/notices", await notice(B, PB, { community: { root: bRoot, destinations: bMoved } }))).status).toBe(202);
    await dispatchFed(n.app);
    const toC = n.hits.find((h) => h.url === `${C}/v1/notices`)!;
    const fwd = JSON.parse(toC.body);
    expect(fwd.body).toMatchObject({ kind: "gossip", hops: 1 });
    expect(fwd.body.community.destinations.signed.relocation.to).toBe("https://club-b-new.example");
    // Receiving side: C gossips about club-d, which we have never pinned. Stored, flagged unpinned.
    const DR = [await generateKeys(), await generateKeys()];
    const DON = await generateKeys();
    const dRoot = await rootDoc("club-d", DR, DON);
    const dMoved = await manifest(3, "https://club-d-new.example", DR, { relocation: { from: "https://club-d.example", to: "https://club-d-new.example", reason: "x" } }, "club-d");
    expect((await n.http("POST", "/v1/notices", await notice(C, PC, { kind: "gossip", hops: 2, community: { root: dRoot, destinations: dMoved } }))).status).toBe(202);
    const forged = await manifest(4, "https://evil.example", [DON], { relocation: { from: "https://club-d-new.example", to: "https://evil.example", reason: "x" } }, "club-d");
    expect((await n.http("POST", "/v1/notices", await notice(C, PC, { kind: "gossip", hops: 1, community: { root: dRoot, destinations: forged } }))).json.reason).toBe("relocation_needs_root");
    expect((await n.http("POST", "/v1/notices", await notice(C, PC, { kind: "gossip", hops: 4, community: { root: dRoot, destinations: dMoved } }))).json.reason).toBe("gossip_shape");
    const relay = (await n.http("GET", "/v1/relay")).json;
    expect(relay.gossip[0]).toMatchObject({ org: "club-d", pinned: false, hops: 2, primary: "https://club-d-new.example" });
    expect(relay.notices[0]).toMatchObject({ primary: "https://club-b-new.example" });
  });

  it("the printed recovery card carries the passport id, a fresh one-time code and a QR", async () => {
    const n = node();
    await setup(n, 84);
    const portal = await member(n, 84, "m84@proton.me");
    const handle = (await portal("GET", "hydra")).json.handle;
    const before = await q<{ n: number }>("SELECT COUNT(*) AS n FROM recovery_codes");
    const res = await n.http("GET", "/portal/card", undefined, { cookie: await portalCookie(n, "m84@proton.me") });
    expect(res.text).toContain(handle);
    expect(res.text).toContain("<svg");
    const code = /class="big mono">([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})</.exec(res.text)![1]!;
    expect((await q<{ n: number }>("SELECT COUNT(*) AS n FROM recovery_codes"))!.n).toBe(before!.n + 1);
    expect((await n.http("POST", "/portal/api/recover", { code }, P)).json.ok).toBe(true);
    expect((await n.http("GET", "/portal/card")).status).toBe(401);
  });
});

async function portalCookie(n: Node, email: string): Promise<string> {
  const t = (await n.http("POST", "/portal/api/login", { email }, P)).json.ticket;
  const v = await n.http("POST", "/portal/api/verify", { ticket: t, code: codeIn(n.mails.at(-1)!.text) }, P);
  return /tp_s=[^;]+/.exec(v.cookie!)![0];
}

// ---- H7 --------------------------------------------------------------------------------------------

describe("H7 sealed relocation and chaos practice", () => {
  it("gate: owners gone + primary down for 3 days opens the sealed relocation only with k partners", async () => {
    // Origin O (club-a at A) seals a relocation with partners B (us, later) and C, quorum 2.
    const PB = await generateKeys();
    const PC = await generateKeys();
    const o = node();
    await setup(o);
    await feed(o.app, dm(OWNER, `/partner add ${B} ${PB.publicKey} * Club B`));
    await feed(o.app, dm(OWNER, `/partner add ${C} ${PC.publicKey} * Club C`));
    const sealed = await manifest(1000, "https://club-a-rescue.example", [R[0]!, R[1]!], { relocation: { from: A, to: "https://club-a-rescue.example", reason: "sealed" } }, ORG, 365);
    expect((await o.admin("POST", "/admin/hydra/seal", { manifest: sealed, quorum: 3, silence_days: 30, partners: [B, C] })).json.reason).toBe("quorum");
    expect((await o.admin("POST", "/admin/hydra/seal", { manifest: sealed, quorum: 2, silence_days: 30, partners: [B, C] })).json).toMatchObject({ ok: true, sent: 2 });
    await dispatchFed(o.app);
    const toB = JSON.parse(o.hits.find((h) => h.url === `${B}/v1/notices`)!.body);
    const toC = JSON.parse(o.hits.find((h) => h.url === `${C}/v1/notices`)!.body);
    expect(toB.body.sealed.share).not.toBe(toC.body.sealed.share);
    expect(JSON.stringify(toB)).not.toContain("club-a-rescue"); // encrypted
    // Fresh database: now play partner B.
    for (const t of ["destination_manifests", "community_identity", "fed_outbox", "fed_nonces", "effects"]) await env.DB.prepare(`DELETE FROM ${t}`).run();
    await env.DB.prepare("DELETE FROM organizations WHERE kind='partner'").run();
    const b = node({}, { me: B, fed: PB });
    await feed(b.app, dm(OWNER, `/partner add ${A} ${FED.publicKey} * Club A`));
    await feed(b.app, dm(OWNER, `/partner add ${C} ${PC.publicKey} * Club C`));
    const fromA = { ...toB, recipient_org: B };
    expect((await b.http("POST", "/v1/notices", await signMsg({ ...fromA, signature: undefined, nonce: crypto.randomUUID() }, FED.privateKey))).json.reason).toBe("no_pinned_root");
    await feed(b.app, dm(OWNER, `/partner root ${A} ${JSON.stringify(await rootDoc())}`));
    expect((await b.http("POST", "/v1/notices", await signMsg({ ...fromA, signature: undefined, nonce: crypto.randomUUID() }, FED.privateKey))).status).toBe(202);
    expect(await q("SELECT state FROM sealed_held")).toEqual({ state: "held" });
    // Owners active (fresh heartbeat) and primary up: nothing happens.
    const hbFresh = await signWith({ signed: { schema: "nexus.heartbeat.v1", org: ORG, owners_seen: iso(Date.now()).slice(0, 10), issued_at: iso(Date.now()) } }, ON.privateKey, ON.publicKey);
    b.pages.set(`${A}/.well-known/nexus-heartbeat.json`, () => Response.json(hbFresh));
    await watchSeals(b.app);
    expect(await q("SELECT state, down_checks FROM sealed_held")).toEqual({ state: "held", down_checks: 0 });
    // Owners silent and the primary down on 3 separate days, 40 days later.
    b.pages.delete(`${A}/.well-known/nexus-heartbeat.json`);
    b.down.add(A);
    for (let d = 40; d <= 42; d++) await watchSeals(b.app, new Date(Date.now() + d * DAY));
    expect(await q("SELECT state FROM sealed_held")).toEqual({ state: "confirmed" });
    await dispatchFed(b.app);
    const shareToC = b.hits.find((h) => h.url === `${C}/v1/notices`);
    expect(JSON.parse(shareToC!.body).body).toMatchObject({ kind: "seal_share", org: A });
    // One partner alone can't open it.
    expect((await b.http("GET", "/v1/relay")).json.notices).toHaveLength(0);
    // C confirms independently and sends its share: now it opens, verifies and is relayed.
    const share = { schema: "nexus.v1", type: "notice", exchange_id: "seal-1000", issuer_org: C, recipient_org: B, issued_at: iso(Date.now()), expires_at: iso(Date.now() + DAY), nonce: crypto.randomUUID(), body: { kind: "seal_share", org: A, version: 1000, share: toC.body.sealed.share } } as const;
    expect((await b.http("POST", "/v1/notices", await signMsg(share as any, PC.privateKey))).status).toBe(202);
    expect(await q("SELECT state FROM sealed_held")).toEqual({ state: "released" });
    expect((await b.http("GET", "/v1/relay")).json.notices[0]).toMatchObject({ partner: A, primary: "https://club-a-rescue.example" });
  });

  it("head-off drill: a cohort loses one channel, is still reached elsewhere, and is invited to regrow", async () => {
    const n = node();
    await setup(n, 85, 86);
    const p85 = await member(n, 85, "m85@proton.me");
    await addNtfy(n, p85);
    await member(n, 86, "m86@proton.me");
    await feed(n.app, dm(OWNER, "/drill start head_off email 100"));
    expect(n.t.sent(OWNER).at(-1)!.params.text).toContain("switched off for 2 people");
    await dispatchAlerts(n.app);
    expect(n.mails.filter((m) => m.subject.includes("[DRILL]"))).toHaveLength(0); // email is off
    const confirm = /\/portal\/confirm\?t=(\S+)/.exec([...n.ntfy.values()].flat().findLast((m) => m.includes("DRILL"))!)![1]!;
    expect((await n.http("GET", `/portal/confirm?t=${confirm}`)).text).toContain("Thank you");
    await dispatchInvites(n.app, 5);
    expect([...n.ntfy.values()].flat().some((m) => m.includes("add two more"))).toBe(true);
    await feed(n.app, dm(OWNER, "/drill end"));
    expect(n.t.sent(OWNER).at(-1)!.params.text).toMatch(/Drill ended: [12]\/2 confirmed/);
  });

  it("the drill calendar reminds owners; the heartbeat is signed", async () => {
    const n = node();
    await setup(n);
    await runCron(n.app);
    expect(n.t.sent(OWNER).some((c) => String(c.params.text).includes("Drills due"))).toBe(true);
    await feed(n.app, dm(OWNER, "/hydra drilled custodians"));
    const hb = (await n.http("GET", "/.well-known/nexus-heartbeat.json")).json;
    expect(hb.signed).toMatchObject({ schema: "nexus.heartbeat.v1", org: ORG, owners_seen: iso(Date.now()).slice(0, 10) });
  });
});


// ---- H8 --------------------------------------------------------------------------------------------

import HV from "../../contracts/test-vectors/hydra-v1.json";
import * as hsdk from "../../contracts/sdk/hydra.mjs";

describe("H8 conformance: the Worker and the SDK agree with the shared Hydra vectors", () => {
  it("domains, independence, index, notices, receipts, anchors, escrow, Shamir, TOTP", async () => {
    const V = HV as any;
    for (const c of V.domains) {
      expect(expandDomains(headDomains(c.kind, c.address, c.opts), {})).toEqual(c.expect);
      expect(hsdk.expandDomains(hsdk.headDomains(c.kind, c.address, c.opts), {})).toEqual(c.expect);
    }
    for (const c of V.independent) expect(independentCount(c.heads.map((h: string[]) => expandDomains(h, c.registry)))).toBe(c.expect);
    for (const c of V.index) {
      expect(hydraIndex(c.graph)).toEqual(c.expect);
      expect(hsdk.hydraIndex(c.graph)).toEqual(c.expect);
    }
    for (const c of V.notices) {
      expect(await verifyNotice(c.doc, V.root)).toEqual(c.expect);
      expect(await hsdk.verifyNotice(c.doc, V.root)).toEqual(c.expect);
    }
    for (const r of V.receipts.valid) expect(await verifyReceipt(r, V.root)).toBe(true);
    expect(await verifyReceipt(V.receipts.forged, V.root)).toBe(V.receipts.forged_valid);
    expect(hsdk.followStateFromReceipts(V.receipts.valid)).toEqual(V.receipts.state_from_all);
    expect(await hsdk.verifyHeartbeat(V.heartbeat, V.root)).toBe(true);
    expect(await checkAnchor(V.anchor.record, V.root, V.manifest)).toEqual(V.anchor.check);
    const best = await hsdk.bestManifest(V.best_manifest.candidates, V.root, V.best_manifest.last, V.now);
    expect(best?.destinations.signed.version).toBe(V.best_manifest.expect_version);
    for (const r of V.escrow.recipients) {
      expect(await decryptEscrow(V.escrow.envelope, r.privateKey)).toBe(V.escrow.plaintext);
      expect(await hsdk.decryptEscrow(V.escrow.envelope, r.privateKey)).toBe(V.escrow.plaintext);
    }
    for (const combo of V.shamir.combos) {
      const picked = combo.map((i: number) => V.shamir.shares[i]);
      expect(b64(combine(picked.map(decodeShare)))).toBe(V.shamir.secret);
      expect(b64(hsdk.shamirCombine(picked))).toBe(V.shamir.secret);
    }
    const secret = new TextEncoder().encode(V.totp.secret_ascii);
    for (const c of V.totp.cases) expect(await totp(secret, c.step)).toBe(c.expect);
  });
});

describe("audit: login enumeration", () => {
  it("an email login ticket has the same shape whether or not the address is registered", async () => {
    const n = node();
    await setup(n, 90);
    await member(n, 90, "m90@proton.me");
    const uuidish = /^[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$/;
    expect((await n.http("POST", "/portal/api/login", { email: "m90@proton.me" }, P)).json.ticket).toMatch(uuidish);
    for (let i = 0; i < 8; i++) expect((await n.http("POST", "/portal/api/login", { email: `nobody${i}@proton.me` }, P)).json.ticket).toMatch(uuidish);
  });
});

describe("audit: one-time login codes", () => {
  it("an email login code logs in once, even when sent in parallel", async () => {
    const n = node();
    await setup(n, 91);
    await member(n, 91, "m91@proton.me");
    const ticket = (await n.http("POST", "/portal/api/login", { email: "m91@proton.me" }, P)).json.ticket;
    const code = codeIn(n.mails.at(-1)!.text);
    const tries = await Promise.all(Array.from({ length: 4 }, () => n.http("POST", "/portal/api/verify", { ticket, code }, P)));
    expect(tries.filter((r) => r.json?.ok).length).toBe(1);
  });

  it("a passport-id login code logs in once, even when sent in parallel", async () => {
    const n = node();
    await setup(n, 92);
    const portal = await member(n, 92, "m92@proton.me");
    const handle = (await portal("GET", "hydra")).json.handle as string;
    const ticket = (await n.http("POST", "/portal/api/login/handle", { handle }, P)).json.ticket;
    const code = codeIn(n.mails.at(-1)!.text);
    const tries = await Promise.all(Array.from({ length: 4 }, () => n.http("POST", "/portal/api/login/handle/verify", { ticket, code }, P)));
    expect(tries.filter((r) => r.json?.ok).length).toBe(1);
  });
});

describe("audit: imports", () => {
  it("an import never attaches someone's verified heads to another person's unverified address", async () => {
    const n = node();
    await setup(n, 93);
    const api = miniApp(n, 93);
    expect((await api("POST", "passport/enrol", { topics: [] })).json.ok).toBe(true);
    await api("POST", "passport/email", { email: "victim@proton.me" }); // typed, never verified
    const stranger = (await q<{ person_id: string }>("SELECT person_id FROM delivery_registrations WHERE channel='email'"))!.person_id;
    const doc = { schema: "nexus.continuity-export.v1", org: ORG, generated_at: iso(Date.now()), root_version: 1, manifest_version: 1, suppressions: [], people: [{ ref: "victim", emails: ["victim@proton.me"], heads: [{ channel: "sms", address: "+15557654321" }], ops: [{ seq: 1, op: "FOLLOW", topic: "critical", at: iso(Date.now()) }], memberships: [] }] };
    expect((await n.admin("POST", "/admin/continuity/import", await signWith({ signed: doc }, ON.privateKey, ON.publicKey))).status).toBe(200);
    const sms = await q<{ person_id: string }>("SELECT person_id FROM delivery_registrations WHERE channel='sms'");
    expect(sms!.person_id).not.toBe(stranger);
  });
});
