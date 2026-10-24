// nexus.v1 SDK: zero dependencies, runs on Node 20+, Deno, Bun, Cloudflare Workers and browsers.
// For community platforms that want to talk to Telepathy nodes without adopting Telepathy.
//   import { buildMessage, sign, verify, send } from "./nexus.mjs";
// Spec: ../nexus-v1.schema.json, ../openapi.yaml. Test vectors: ../test-vectors/nexus-v1.json.

export const SCHEMA = "nexus.v1";
const enc = new TextEncoder();
const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Sorted keys, no whitespace, undefined members dropped. */
export function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
}

export async function generateKeys() {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  return { privateKey: b64(await crypto.subtle.exportKey("pkcs8", kp.privateKey)), publicKey: b64(await crypto.subtle.exportKey("raw", kp.publicKey)) };
}

/** Ed25519 private key (pkcs8, base64) from a 32-byte seed — for deterministic test vectors. */
export function pkcs8FromSeed(seed) {
  const head = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];
  return b64(new Uint8Array([...head, ...seed]));
}

export async function sign(msg, privateKeyB64) {
  const { signature: _drop, ...rest } = msg;
  const key = await crypto.subtle.importKey("pkcs8", unb64(privateKeyB64), { name: "Ed25519" }, false, ["sign"]);
  return { ...rest, signature: b64(await crypto.subtle.sign({ name: "Ed25519" }, key, enc.encode(canonical(rest)))) };
}

export async function verify(msg, publicKeyB64) {
  if (!msg || typeof msg.signature !== "string") return false;
  try {
    const { signature, ...rest } = msg;
    const key = await crypto.subtle.importKey("raw", unb64(publicKeyB64), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, unb64(signature), enc.encode(canonical(rest)));
  } catch {
    return false;
  }
}

/** Unsigned message skeleton; pass the result to sign(). */
export function buildMessage({ type, exchangeId, issuer, recipient, body, ttlMs = 14 * 86_400_000, now = Date.now(), nonce = crypto.randomUUID() }) {
  return { schema: SCHEMA, type, exchange_id: exchangeId, issuer_org: issuer, recipient_org: recipient, issued_at: new Date(now).toISOString(), expires_at: new Date(now + ttlMs).toISOString(), nonce, body };
}

/** Inquiry body with the only fields the protocol allows. */
export const inquiryBody = ({ missionRef, job, summary, criteria = {}, policyVersion = 1 }) => ({
  mission_ref: missionRef, job, summary, criteria, allowed_fields: ["job", "summary", "criteria"],
  purpose: "evaluate_willing_provider", forwarding: "prohibited", max_hops: 1, policy_version: policyVersion,
});

const PATHS = { inquiry: () => "/v1/opportunities/inquiries", offer: (id) => `/v1/opportunities/${id}/offers`, decline: (id) => `/v1/opportunities/${id}/offers`, approval: (id) => `/v1/opportunities/${id}/approvals`, commitment: (id) => `/v1/commitments/${id}/events`, withdraw: (id) => `/v1/exchanges/${id}/withdraw`, notice: () => "/v1/notices" };
export const pathFor = (msg) => PATHS[msg.type](msg.exchange_id);

/** POST a signed message to a node. Safe to retry: receivers deduplicate by nonce. */
export async function send(endpoint, signed, fetchImpl = fetch) {
  const res = await fetchImpl(endpoint.replace(/\/$/, "") + pathFor(signed), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(signed) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// ---- Continuity (CONT-10): verify a club's identity, address lists, passes and exports ----------
// Same rules as the Telepathy Worker (worker/src/continuity/identity.ts). Pin the club's root once
// (confirm its key ids out of band); after that everything else is checked against it.

const hexOf = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
export async function keyId(publicKeyB64) {
  return hexOf(await crypto.subtle.digest("SHA-256", unb64(publicKeyB64))).slice(0, 16);
}
/** Number of distinct listed keys with a valid signature over doc.signed. */
export async function countValid(doc, keys) {
  const data = enc.encode(canonical(doc.signed));
  const ok = new Set();
  for (const s of doc.signatures ?? []) {
    const k = keys.find((x) => x.keyid === s.keyid);
    if (!k || ok.has(k.keyid)) continue;
    try {
      const pub = await crypto.subtle.importKey("raw", unb64(k.key), { name: "Ed25519" }, false, ["verify"]);
      if (await crypto.subtle.verify({ name: "Ed25519" }, pub, unb64(s.sig), data)) ok.add(k.keyid);
    } catch {}
  }
  return ok.size;
}
const nowZ = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

export async function verifyRoot(doc, trusted, now = nowZ()) {
  const r = doc?.signed;
  if (!r || r.schema !== "nexus.root.v1" || !Number.isInteger(r.version) || r.version < 1 || !Array.isArray(r.root_keys) || !Array.isArray(r.online_keys) || !Number.isInteger(r.threshold) || r.threshold < 1 || r.threshold > r.root_keys.length) return { ok: false, reason: "root_shape" };
  for (const k of [...r.root_keys, ...r.online_keys]) if (k.keyid !== (await keyId(k.key))) return { ok: false, reason: "root_keyid" };
  if (r.expires <= now) return { ok: false, reason: "root_expired" };
  if ((await countValid(doc, r.root_keys)) < r.threshold) return { ok: false, reason: "root_threshold" };
  if (trusted) {
    const t = trusted.signed;
    if (r.org !== t.org) return { ok: false, reason: "root_org" };
    if (r.version < t.version) return { ok: false, reason: "root_rollback" };
    if (r.version === t.version) return JSON.stringify(r) === JSON.stringify(t) ? { ok: true } : { ok: false, reason: "root_fork" };
    if (r.version !== t.version + 1) return { ok: false, reason: "root_skip" };
    if ((await countValid(doc, t.root_keys)) < t.threshold) return { ok: false, reason: "root_not_authorized_by_previous" };
  }
  return { ok: true };
}

const primaryOf = (d) => d?.destinations?.find((x) => x.role === "primary")?.url ?? null;
const KINDS = ["web", "telegram", "rss", "matrix", "email_list", "portal"];
export async function verifyDestinations(doc, root, last, now = nowZ()) {
  const d = doc?.signed;
  const okShape = d && d.schema === "nexus.destinations.v1" && Number.isInteger(d.version) && d.version >= 1 && Array.isArray(d.destinations) && d.destinations.length <= 20 &&
    d.destinations.filter((x) => x.role === "primary").length === 1 && d.destinations.every((x) => KINDS.includes(x.kind) && (x.role === "primary" || x.role === "backup") && /^(https:\/\/|tg:\/\/)[^\s]{3,300}$/.test(x.url));
  if (!okShape) return { ok: false, reason: "dest_shape" };
  const r = root.signed;
  if (d.org !== r.org) return { ok: false, reason: "dest_org" };
  if (d.root_version !== r.version) return { ok: false, reason: "dest_root_version" };
  if (d.expires <= now) return { ok: false, reason: "dest_expired" };
  if (last) {
    if (d.version < last.signed.version) return { ok: false, reason: "dest_rollback" };
    if (d.version === last.signed.version) return JSON.stringify(d) === JSON.stringify(last.signed) ? { ok: true } : { ok: false, reason: "dest_fork" };
  }
  const moved = !!last && primaryOf(d) !== primaryOf(last.signed);
  if (moved || d.relocation) {
    if (!d.relocation || d.relocation.to !== primaryOf(d) || (last && d.relocation.from !== primaryOf(last.signed))) return { ok: false, reason: "relocation_record" };
    if ((await countValid(doc, r.root_keys)) < r.threshold) return { ok: false, reason: "relocation_needs_root" };
    return { ok: true, relocation: true };
  }
  if ((await countValid(doc, r.online_keys)) < 1 && (await countValid(doc, r.root_keys)) < r.threshold) return { ok: false, reason: "dest_signature" };
  return { ok: true, relocation: false };
}

export async function verifyPass(pass, issuerRoot, me, now = nowZ()) {
  const c = pass?.signed;
  if (!c || c.schema !== "nexus.attestation.v1") return { ok: false, reason: "shape" };
  if (c.org !== issuerRoot.signed.org) return { ok: false, reason: "org" };
  if (c.audience !== me) return { ok: false, reason: "audience" };
  if (c.expires_at <= now) return { ok: false, reason: "expired" };
  if ((await countValid(pass, issuerRoot.signed.online_keys)) < 1) return { ok: false, reason: "signature" };
  return { ok: true, claim: c };
}

/** Rebuild follow state from one or more exports (any order): the highest seq per topic wins. */
export function followStateFrom(bundles) {
  const best = new Map(); // email|topic -> {seq, status}
  for (const b of bundles) for (const p of b.signed.people) for (const o of p.ops) {
    if (!o.topic || o.op === "REVOKE_ENDPOINT") continue;
    const status = o.op === "FOLLOW" || o.op === "UNMUTE" ? "following" : o.op === "MUTE" ? "muted" : "unfollowed";
    for (const e of p.emails) {
      const k = `${e.toLowerCase()}|${o.topic}`;
      if (!best.has(k) || best.get(k).seq < o.seq) best.set(k, { seq: o.seq, status });
    }
  }
  return Object.fromEntries([...best].map(([k, v]) => [k, v.status]));
}
