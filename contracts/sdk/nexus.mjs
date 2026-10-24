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

const PATHS = { inquiry: () => "/v1/opportunities/inquiries", offer: (id) => `/v1/opportunities/${id}/offers`, decline: (id) => `/v1/opportunities/${id}/offers`, approval: (id) => `/v1/opportunities/${id}/approvals`, commitment: (id) => `/v1/commitments/${id}/events`, withdraw: (id) => `/v1/exchanges/${id}/withdraw` };
export const pathFor = (msg) => PATHS[msg.type](msg.exchange_id);

/** POST a signed message to a node. Safe to retry: receivers deduplicate by nonce. */
export async function send(endpoint, signed, fetchImpl = fetch) {
  const res = await fetchImpl(endpoint.replace(/\/$/, "") + pathFor(signed), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(signed) });
  return { status: res.status, body: await res.json().catch(() => null) };
}
