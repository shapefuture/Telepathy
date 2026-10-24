// Hydra SDK (P16, H8): what a client, mirror or partner needs to check a club's heads without
// Telepathy. Same rules as worker/src/hydra/*; the shared vectors (test-vectors/hydra-v1.json)
// keep the Worker, this file and the Python port in agreement. Node 20+ or any WebCrypto runtime
// with Ed25519 and X25519.

import { canonical, countValid, verifyDestinations, verifyRoot } from "./nexus.mjs";

const enc = new TextEncoder();
const b64 = (b) => btoa(String.fromCharCode(...new Uint8Array(b)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64u = (b) => b64(b).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const unb64u = (s) => unb64(s.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (s.length % 4)) % 4));

// ---- failure domains (H0) ----------------------------------------------------------------------

const MAIL = { "gmail.com": "google", "googlemail.com": "google", "outlook.com": "microsoft", "hotmail.com": "microsoft", "live.com": "microsoft", "msn.com": "microsoft", "yahoo.com": "yahoo", "aol.com": "yahoo", "ymail.com": "yahoo", "icloud.com": "apple", "me.com": "apple", "mac.com": "apple", "proton.me": "proton", "protonmail.com": "proton", "pm.me": "proton", "yandex.ru": "yandex", "ya.ru": "yandex", "yandex.com": "yandex", "mail.ru": "vk", "bk.ru": "vk", "inbox.ru": "vk", "list.ru": "vk", "gmx.de": "united_internet", "gmx.net": "united_internet", "web.de": "united_internet", "fastmail.com": "fastmail", "tutanota.com": "tuta", "tuta.io": "tuta", "zoho.com": "zoho" };
const MX = [[/(google\.com|googlemail\.com)\.?$/, "google"], [/(outlook\.com|office365\.us)\.?$/, "microsoft"], [/(yahoodns\.net)\.?$/, "yahoo"], [/(icloud\.com)\.?$/, "apple"], [/(protonmail\.ch)\.?$/, "proton"], [/(yandex\.(ru|net))\.?$/, "yandex"], [/(mail\.ru)\.?$/, "vk"], [/(messagingengine\.com)\.?$/, "fastmail"], [/(zoho\.(com|eu))\.?$/, "zoho"]];
const PUSH = [[/(^|\.)googleapis\.com$/, "google"], [/(^|\.)mozilla\.com$/, "mozilla"], [/(^|\.)push\.apple\.com$/, "apple"], [/(^|\.)notify\.windows\.com$/, "microsoft"]];
const ORG_PARENT = { google: "org:google", microsoft: "org:microsoft", apple: "org:apple", yahoo: "org:yahoo" };
const host = (u) => {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return "unknown";
  }
};

export function headDomains(kind, address, { mx = null, senders = [], matrixServer } = {}) {
  const out = [];
  if (kind === "telegram") out.push("telegram");
  else if (kind === "email") {
    const d = address.trim().toLowerCase().split("@")[1] ?? "";
    let op = MAIL[d];
    if (!op && mx) op = MX.find(([re]) => re.test(mx.toLowerCase()))?.[1];
    out.push(`mail:${op ?? (d || "unknown")}`);
    if (senders.length === 1) out.push(`sender:${senders[0]}`);
  } else if (kind === "webpush") out.push(`push:${PUSH.find(([re]) => re.test(host(address)))?.[1] ?? "unknown"}`);
  else if (kind === "ntfy") out.push(`ntfy:${host(address)}`);
  else if (kind === "matrix") {
    out.push(`matrix:${address.split(":").slice(1).join(":").toLowerCase()}`);
    if (matrixServer) out.push(`matrix:${host(matrixServer)}`);
  } else if (kind === "sms") out.push("sms");
  return [...new Set(out)];
}

export function expandDomains(base, registry = {}) {
  const out = new Set();
  const stack = [...base];
  while (stack.length) {
    const d = stack.pop();
    if (out.has(d)) continue;
    out.add(d);
    const op = /^(mail|push):(.+)$/.exec(d)?.[2];
    if (op && ORG_PARENT[op]) stack.push(ORG_PARENT[op]);
    for (const p of registry[d] ?? []) stack.push(p);
  }
  return [...out].sort();
}

export function independentCount(heads) {
  const seen = new Set();
  const hs = heads.filter((h) => {
    const k = [...h].sort().join("|");
    return seen.has(k) ? false : (seen.add(k), true);
  }).slice(0, 12);
  let best = 0;
  const pick = (i, used, n) => {
    if (n + (hs.length - i) <= best) return;
    if (i === hs.length) return void (best = Math.max(best, n));
    if (hs[i].every((d) => !used.has(d))) pick(i + 1, new Set([...used, ...hs[i]]), n + 1);
    pick(i + 1, used, n);
  };
  pick(0, new Set(), 0);
  return best;
}

/** Fewest failure domains whose joint failure cuts off more than `threshold` of people. */
export function hydraIndex(graph, { threshold = 0.1, maxK = 4 } = {}) {
  const total = graph.length;
  if (!total) return { index: 0, atLeast: false, worst: [], cutOff: 0, people: 0 };
  const freq = new Map();
  for (const p of graph) for (const h of p.heads) for (const d of h) freq.set(d, (freq.get(d) ?? 0) + 1);
  const domains = [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 24).map(([d]) => d);
  const bit = new Map(domains.map((d, i) => [d, 1 << i]));
  const OTHER = 1 << 30;
  const mask = (h) => h.reduce((m, d) => m | (bit.get(d) ?? OTHER), 0) & ~OTHER;
  const idx = new Map(graph.map((p, i) => [p.id, i]));
  const people = graph.map((p) => ({ heads: p.heads.map(mask), buddies: (p.buddies ?? []).map((b) => idx.get(b)).filter((x) => x !== undefined) }));
  const cut = (failed) => {
    const direct = people.map((p) => p.heads.some((h) => (h & failed) === 0));
    let n = 0;
    for (let i = 0; i < people.length; i++) if (!direct[i] && !people[i].buddies.some((b) => direct[b])) n++;
    return n;
  };
  const limit = total * threshold;
  const zero = cut(0);
  if (zero > limit) return { index: 0, atLeast: false, worst: [], cutOff: zero, people: total };
  for (let k = 1; k <= Math.min(maxK, domains.length); k++) {
    let found = null;
    const walk = (start, depth, m) => {
      if (found) return;
      if (depth === k) {
        const n = cut(m);
        if (n > limit) found = { m, n };
        return;
      }
      for (let i = start; i < domains.length; i++) walk(i + 1, depth + 1, m | (1 << i));
    };
    walk(0, 0, 0);
    if (found) return { index: k, atLeast: false, worst: domains.filter((_, i) => found.m & (1 << i)), cutOff: found.n, people: total };
  }
  return { index: Math.min(maxK, domains.length) + 1, atLeast: true, worst: [], cutOff: 0, people: total };
}

// ---- signed public material (H1, H5, H6, H7) ---------------------------------------------------

const onlineOrRoot = async (doc, root) => (await countValid(doc, root.signed.online_keys)) >= 1 || (await countValid(doc, root.signed.root_keys)) >= root.signed.threshold;

export async function verifyNotice(doc, root) {
  const n = doc?.signed;
  if (!n || n.schema !== "nexus.notice.v1" || !Number.isInteger(n.seq) || typeof n.title !== "string" || typeof n.body !== "string") return { ok: false, reason: "notice_shape" };
  if (n.org !== root.signed.org) return { ok: false, reason: "notice_org" };
  return (await onlineOrRoot(doc, root)) ? { ok: true } : { ok: false, reason: "notice_signature" };
}

const OPS = ["FOLLOW", "UNFOLLOW", "MUTE", "UNMUTE", "REVOKE_ENDPOINT"];
const TOPICS = ["critical", "events", "requests", "news", "commercial", "partner_offers"];
export async function verifyReceipt(doc, root) {
  const r = doc?.signed;
  if (!r || r.schema !== "nexus.follow-receipt.v1" || r.org !== root.signed.org || !Number.isInteger(r.seq) || r.seq < 1 || !OPS.includes(r.op) || (r.topic !== null && !TOPICS.includes(r.topic)) || typeof r.person_ref !== "string") return false;
  return onlineOrRoot(doc, root);
}

/** Follow state from receipts a member kept: the highest sequence per topic wins. */
export function followStateFromReceipts(receipts) {
  const best = new Map();
  for (const r of receipts) {
    const { topic, op, seq } = r.signed;
    if (!topic || op === "REVOKE_ENDPOINT") continue;
    const status = op === "FOLLOW" || op === "UNMUTE" ? "following" : op === "MUTE" ? "muted" : "unfollowed";
    if (!best.has(topic) || best.get(topic).seq < seq) best.set(topic, { seq, status });
  }
  return Object.fromEntries([...best].map(([k, v]) => [k, v.status]));
}

export async function verifyHeartbeat(doc, root) {
  const h = doc?.signed;
  if (!h || h.schema !== "nexus.heartbeat.v1" || h.org !== root.signed.org || typeof h.owners_seen !== "string") return false;
  return (await countValid(doc, root.signed.online_keys)) >= 1;
}

export async function manifestHash(m) {
  return b64u(await crypto.subtle.digest("SHA-256", enc.encode(canonical(m.signed))));
}
export async function anchorRecord(root, m) {
  const r = root.signed;
  return `nexus1 org=${r.org} root=${r.version}:${r.root_keys.map((k) => k.keyid).sort().join(",")}/${r.threshold} man=${m.signed.version}:${await manifestHash(m)} primary=${m.signed.destinations.find((d) => d.role === "primary").url}`;
}
export function parseAnchor(rec) {
  const parts = rec.trim().split(/\s+/);
  if (parts[0] !== "nexus1") return null;
  return Object.fromEntries(parts.slice(1).map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)]));
}
export async function checkAnchor(rec, root, m) {
  const a = parseAnchor(rec);
  if (!a) return { ok: false, reason: "anchor_shape" };
  const r = root.signed;
  if (a.org !== r.org) return { ok: false, reason: "anchor_org" };
  if (a.root !== `${r.version}:${r.root_keys.map((k) => k.keyid).sort().join(",")}/${r.threshold}`) return { ok: false, reason: "anchor_root" };
  if (a.man !== `${m.signed.version}:${await manifestHash(m)}`) return { ok: false, reason: "anchor_manifest" };
  if (a.primary !== m.signed.destinations.find((d) => d.role === "primary")?.url) return { ok: false, reason: "anchor_primary" };
  return { ok: true };
}

/**
 * A client that reaches only some heads (one mirror, one partner relay, one anchor) asks each for
 * the club's community document and keeps the newest one that verifies against its pinned root and
 * last accepted list. Relays can't forge or roll back; they can only fail to answer.
 */
export async function bestManifest(candidates, pinnedRoot, last = null, now) {
  let best = null;
  for (const c of candidates) {
    if (!c?.root || !c?.destinations) continue;
    let root = pinnedRoot;
    if (c.root.signed?.version !== pinnedRoot.signed.version) {
      if (!(await verifyRoot(c.root, pinnedRoot, now)).ok) continue;
      root = c.root;
    }
    const v = await verifyDestinations(c.destinations, root, last, now);
    if (v.ok && (!best || c.destinations.signed.version > best.destinations.signed.version)) best = { root, destinations: c.destinations, relocation: !!v.relocation };
  }
  return best;
}

// ---- escrow (H4) --------------------------------------------------------------------------------

const PKCS8_X25519 = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20];
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

export async function decryptEscrow(env, privateKeyB64) {
  const priv = await crypto.subtle.importKey("pkcs8", new Uint8Array([...PKCS8_X25519, ...unb64(privateKeyB64)]), { name: "X25519" }, true, ["deriveBits"]);
  const rpk = unb64u((await crypto.subtle.exportKey("jwk", priv)).x);
  const kid = hex(await crypto.subtle.digest("SHA-256", rpk)).slice(0, 16);
  const r = env.recipients.find((x) => x.kid === kid);
  if (!r) throw new Error("not_a_recipient");
  const epk = unb64(r.epk);
  const shared = await crypto.subtle.deriveBits({ name: "X25519", public: await crypto.subtle.importKey("raw", epk, { name: "X25519" }, false, []) }, priv, 256);
  const base = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const kek = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array([...epk, ...rpk]), info: enc.encode("nexus-escrow-v1") }, base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const dek = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(r.iv) }, kek, unb64(r.wrapped));
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(env.iv) }, await crypto.subtle.importKey("raw", dek, "AES-GCM", false, ["decrypt"]), unb64(env.ct));
  if (b64(await crypto.subtle.digest("SHA-256", plain)) !== env.sha256) throw new Error("hash_mismatch");
  return new TextDecoder().decode(plain);
}

// ---- Shamir over GF(256), polynomial 0x11b (H4, H7) ----------------------------------------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x = (x ^ (x << 1) ^ (x & 0x80 ? 0x11b : 0)) & 0xff;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
const div = (a, b) => (a ? EXP[(LOG[a] + 255 - LOG[b]) % 255] : 0);

export function decodeShare(t) {
  const m = /^s1-(\d{1,3})-(\d{1,3})-([A-Za-z0-9_-]+)$/.exec(t.trim());
  if (!m) throw new Error("share_shape");
  return { k: Number(m[1]), x: Number(m[2]), y: unb64u(m[3]) };
}
export const encodeShare = (s) => `s1-${s.k}-${s.x}-${b64u(s.y)}`;
export function shamirCombine(shares) {
  const parsed = shares.map((s) => (typeof s === "string" ? decodeShare(s) : s));
  const list = [...new Map(parsed.map((s) => [s.x, s])).values()];
  if (!list.length || list.length < list[0].k) throw new Error("shamir_too_few");
  const pick = list.slice(0, list[0].k);
  const out = new Uint8Array(pick[0].y.length);
  for (let i = 0; i < out.length; i++) {
    let acc = 0;
    for (const a of pick) {
      let num = 1;
      let den = 1;
      for (const b of pick) if (a.x !== b.x) (num = mul(num, b.x)), (den = mul(den, a.x ^ b.x));
      acc ^= mul(a.y[i], div(num, den));
    }
    out[i] = acc;
  }
  return out;
}

// ---- TOTP (RFC 6238), for clients that offer an authenticator --------------------------------------

export async function totp(secret, step, digits = 6) {
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setUint32(4, step >>> 0);
  new DataView(msg.buffer).setUint32(0, Math.floor(step / 2 ** 32));
  const h = new Uint8Array(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]), msg));
  const o = h[19] & 15;
  return String((((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 10 ** digits).padStart(digits, "0");
}
