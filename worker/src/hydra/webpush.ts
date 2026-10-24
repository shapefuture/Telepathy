// H1 Web Push head: VAPID (RFC 8292) + aes128gcm message encryption (RFC 8291), WebCrypto only.
// The push service (Google, Mozilla, Apple, Microsoft) sees only ciphertext and the endpoint.
// Keys: VAPID_PUBLIC_KEY (base64url, 65-byte uncompressed P-256 point, a var) and
// VAPID_PRIVATE_KEY (base64url 32-byte scalar, a secret). `npm run hydra -- vapid` makes a pair.

import type { Fetcher } from "../telegram";

const enc = new TextEncoder();
export const b64u = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
export const unb64u = (s: string) => Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

export interface PushSubscriptionKeys {
  endpoint: string;
  p256dh: string; // base64url, 65 bytes
  auth: string; // base64url, 16 bytes
}

/** Encrypt one message for a subscription (RFC 8291). `asKeys`/`salt` are injectable for tests. */
export async function encryptPush(sub: PushSubscriptionKeys, plaintext: string, fixed?: { asKeys: CryptoKeyPair; salt: Uint8Array }): Promise<Uint8Array> {
  const uaPublic = unb64u(sub.p256dh);
  const authSecret = unb64u(sub.auth);
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error("bad_subscription_keys");
  const asKeys = fixed?.asKeys ?? ((await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair);
  const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", asKeys.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, asKeys.privateKey, 256));
  const prkKey = await hmac(authSecret, shared);
  const ikm = await hmac(prkKey, cat(enc.encode("WebPush: info\0"), uaPublic, asPublic, new Uint8Array([1])));
  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, cat(enc.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, cat(enc.encode("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);
  const key = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const body = cat(enc.encode(plaintext), new Uint8Array([2])); // last-record delimiter
  if (body.length > 3993) throw new Error("push_too_large");
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, body));
  const header = new Uint8Array(21 + 65);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = 65;
  header.set(asPublic, 21);
  return cat(header, ct);
}

/** VAPID authorization header value for an endpoint's origin. */
export async function vapidAuth(endpoint: string, publicKey: string, privateKey: string, subject: string, now = Date.now()): Promise<string> {
  const pub = unb64u(publicKey);
  if (pub.length !== 65) throw new Error("bad_vapid_public_key");
  const jwk: JsonWebKey = { kty: "EC", crv: "P-256", d: privateKey, x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)), ext: false };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${head}.${claims}`));
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${publicKey}`;
}

export type PushResult = "sent" | "gone" | "failed";

export async function sendPush(net: Fetcher, sub: PushSubscriptionKeys, payload: unknown, vapid: { publicKey: string; privateKey: string; subject: string }): Promise<PushResult> {
  try {
    const body = await encryptPush(sub, JSON.stringify(payload));
    const res = await net(sub.endpoint, {
      method: "POST",
      headers: { authorization: await vapidAuth(sub.endpoint, vapid.publicKey, vapid.privateKey, vapid.subject), "content-encoding": "aes128gcm", "content-type": "application/octet-stream", ttl: "86400", urgency: "high" },
      body,
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 404 || res.status === 410) return "gone"; // subscription expired or removed
    return res.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}

/** Fresh VAPID key pair (base64url), for the setup script and tests. */
export async function vapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])) as CryptoKeyPair;
  const raw = (await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer;
  const jwk = (await crypto.subtle.exportKey("jwk", kp.privateKey)) as JsonWebKey;
  return { publicKey: b64u(raw), privateKey: jwk.d! };
}
