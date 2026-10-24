// Signed federation messages (plan E.2, E.3). Ed25519 over canonical JSON, via WebCrypto.
// Every message names issuer, recipient, exchange, nonce and expiry, so a receiver can reject
// forgeries, wrong audiences, stale and replayed messages before reading the body.

import { ENVELOPE_FIELDS } from "../domain/consent";

export const SCHEMA = "nexus.v1";
export const MAX_BODY_BYTES = 16 * 1024;
export const MAX_TTL_MS = 15 * 24 * 3_600_000;
export const CLOCK_SKEW_MS = 5 * 60_000;

export type MessageType = "inquiry" | "offer" | "decline" | "approval" | "commitment" | "withdraw" | "notice";

export interface FedMessage {
  schema: typeof SCHEMA;
  type: MessageType;
  exchange_id: string; // always the requester's exchange id
  issuer_org: string;
  recipient_org: string;
  issued_at: string;
  expires_at: string;
  nonce: string;
  body: Record<string, unknown>;
  signature?: string;
}

/** Inquiry body (the Opportunity Envelope proper). Only these keys may appear. */
export interface InquiryBody {
  mission_ref: string;
  job: string;
  summary: string;
  criteria: Record<string, unknown>;
  allowed_fields: string[];
  purpose: "evaluate_willing_provider";
  forwarding: "prohibited";
  max_hops: 1;
  policy_version: number;
}
const INQUIRY_KEYS = new Set(["mission_ref", "job", "summary", "criteria", "allowed_fields", "purpose", "forwarding", "max_hops", "policy_version"]);

export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(",")}}`;
}

const b64 = (bytes: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const enc = new TextEncoder();

export async function sha256(text: string): Promise<string> {
  return b64(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

export async function generateKeys(): Promise<{ privateKey: string; publicKey: string }> {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const priv = (await crypto.subtle.exportKey("pkcs8", kp.privateKey)) as ArrayBuffer;
  const pub = (await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer;
  return { privateKey: b64(priv), publicKey: b64(pub) };
}

export async function publicKeyOf(privateKeyB64: string): Promise<string> {
  // Ed25519 pkcs8 = 16-byte header + 32-byte seed; WebCrypto can't derive the public key directly,
  // so we round-trip through JWK, whose `x` member is the public key.
  const key = await crypto.subtle.importKey("pkcs8", unb64(privateKeyB64), { name: "Ed25519" }, true, ["sign"]);
  const jwk = (await crypto.subtle.exportKey("jwk", key)) as JsonWebKey;
  const x = jwk.x!; // base64url -> base64
  return x.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (x.length % 4)) % 4);
}

export async function sign(msg: Omit<FedMessage, "signature">, privateKeyB64: string): Promise<FedMessage> {
  const key = await crypto.subtle.importKey("pkcs8", unb64(privateKeyB64), { name: "Ed25519" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, key, enc.encode(canonical(msg)));
  return { ...msg, signature: b64(sig) };
}

export async function verifySignature(msg: FedMessage, publicKeyB64: string): Promise<boolean> {
  if (typeof msg.signature !== "string") return false;
  try {
    const key = await crypto.subtle.importKey("raw", unb64(publicKeyB64), { name: "Ed25519" }, false, ["verify"]);
    const { signature, ...rest } = msg;
    return await crypto.subtle.verify({ name: "Ed25519" }, key, unb64(signature), enc.encode(canonical(rest)));
  } catch {
    return false;
  }
}

/** Structural checks that need no database. Returns a reason code, or null when well-formed. */
export function checkShape(msg: unknown, now: number): string | null {
  if (!msg || typeof msg !== "object") return "not_object";
  const m = msg as FedMessage;
  if (m.schema !== SCHEMA) return "schema";
  if (!["inquiry", "offer", "decline", "approval", "commitment", "withdraw", "notice"].includes(m.type)) return "type";
  for (const k of ["exchange_id", "issuer_org", "recipient_org", "issued_at", "expires_at", "nonce"] as const) {
    if (typeof m[k] !== "string" || !m[k] || m[k].length > 200) return `field:${k}`;
  }
  if (!m.body || typeof m.body !== "object" || Array.isArray(m.body)) return "body";
  const issued = Date.parse(m.issued_at);
  const expires = Date.parse(m.expires_at);
  if (!Number.isFinite(issued) || !Number.isFinite(expires)) return "time";
  if (issued > now + CLOCK_SKEW_MS) return "future";
  if (expires <= now) return "expired";
  if (expires - issued > MAX_TTL_MS) return "ttl";
  if (m.type === "inquiry") return checkInquiry(m.body);
  return null;
}

function checkInquiry(b: Record<string, unknown>): string | null {
  for (const k of Object.keys(b)) if (!INQUIRY_KEYS.has(k)) return `inquiry_field:${k}`;
  if (b.forwarding !== "prohibited" || b.max_hops !== 1) return "forwarding";
  if (b.purpose !== "evaluate_willing_provider") return "purpose";
  if (typeof b.job !== "string" || !/^[a-z0-9_.]{2,80}$/.test(b.job)) return "job";
  if (typeof b.summary !== "string" || !b.summary || b.summary.length > 600) return "summary";
  if (typeof b.mission_ref !== "string" || !b.mission_ref) return "mission_ref";
  if (!Array.isArray(b.allowed_fields) || !b.allowed_fields.every((f) => (ENVELOPE_FIELDS as readonly string[]).includes(String(f)))) return "allowed_fields";
  if (b.criteria !== undefined && (typeof b.criteria !== "object" || Array.isArray(b.criteria))) return "criteria";
  return null;
}
