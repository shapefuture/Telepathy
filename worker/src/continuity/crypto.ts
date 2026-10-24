// Continuity crypto helpers. CONTINUITY_KEY (secret, 32 random bytes, base64) keys:
//   * HMACs for lookups and one-time codes (addresses and codes are never stored in clear)
//   * AES-GCM encryption of delivery addresses at rest
//   * pairwise pseudonyms for partner attestations
// Ed25519 signatures with key ids for TUF-style multi-signature metadata.

import { canonical } from "../federation/envelope";

const enc = new TextEncoder();
const dec = new TextDecoder();
export const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b)));
export const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

export class ContinuityConfigError extends Error {}

function keyBytes(secret: string | undefined): Uint8Array {
  if (!secret) throw new ContinuityConfigError("CONTINUITY_KEY is not set");
  const k = unb64(secret);
  if (k.length < 32) throw new ContinuityConfigError("CONTINUITY_KEY must be at least 32 bytes");
  return k;
}

export async function hmacHex(secret: string | undefined, label: string, value: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", keyBytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(`${label}\u0000${value}`)));
}

async function aesKey(secret: string | undefined): Promise<CryptoKey> {
  const raw = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array([...keyBytes(secret), ...enc.encode("aes")])));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function seal(secret: string | undefined, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(secret), enc.encode(plain));
  return `${b64(iv)}.${b64(ct)}`;
}

export async function open(secret: string | undefined, sealed: string): Promise<string> {
  const [iv, ct] = sealed.split(".");
  return dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv!) }, await aesKey(secret), unb64(ct!)));
}

/** 6-digit code, uniform. */
export function numericCode(): string {
  const a = crypto.getRandomValues(new Uint32Array(1))[0]!;
  return String(a % 1_000_000).padStart(6, "0");
}

/** Readable one-time recovery code, e.g. "K7QF-9MZ2-XW4P". */
export function recoveryCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const r = crypto.getRandomValues(new Uint8Array(12));
  const s = [...r].map((x) => alphabet[x % alphabet.length]).join("");
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

export const randomToken = () => b64(crypto.getRandomValues(new Uint8Array(32))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

// ---- Ed25519 multi-signature metadata --------------------------------------------------------

export interface Signed<T> {
  signed: T;
  signatures: { keyid: string; sig: string }[];
}
export interface PubKey {
  keyid: string;
  key: string; // raw Ed25519, base64
}

export async function keyId(publicKeyB64: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", unb64(publicKeyB64))).slice(0, 16);
}

export async function signWith<T>(doc: Signed<T> | { signed: T; signatures?: Signed<T>["signatures"] }, privateKeyB64: string, publicKeyB64: string): Promise<Signed<T>> {
  const key = await crypto.subtle.importKey("pkcs8", unb64(privateKeyB64), { name: "Ed25519" }, false, ["sign"]);
  const sig = b64(await crypto.subtle.sign({ name: "Ed25519" }, key, enc.encode(canonical(doc.signed))));
  const keyid = await keyId(publicKeyB64);
  return { signed: doc.signed, signatures: [...(doc.signatures ?? []).filter((s) => s.keyid !== keyid), { keyid, sig }] };
}

/** How many distinct listed keys produced a valid signature over `signed`. */
export async function countValid<T>(doc: Signed<T>, keys: PubKey[]): Promise<number> {
  const data = enc.encode(canonical(doc.signed));
  const seen = new Set<string>();
  for (const s of doc.signatures ?? []) {
    const k = keys.find((x) => x.keyid === s.keyid);
    if (!k || seen.has(k.keyid)) continue;
    try {
      const pub = await crypto.subtle.importKey("raw", unb64(k.key), { name: "Ed25519" }, false, ["verify"]);
      if (await crypto.subtle.verify({ name: "Ed25519" }, pub, unb64(s.sig), data)) seen.add(k.keyid);
    } catch {
      /* malformed signature: not counted */
    }
  }
  return seen.size;
}
