// H4: 3-2-1 escrow of continuity data. Nightly, the signed export is encrypted inside the Worker
// to several X25519 recipient keys (custodians, a standby node, partners) and written to
// S3-compatible buckets on other providers and an optional R2 bucket. Plaintext never leaves.
//
// Envelope "nexus.escrow.v1": a random 256-bit data key encrypts the payload (AES-256-GCM); for
// each recipient, an ephemeral X25519 exchange → HKDF-SHA256 (salt = epk‖rpk,
// info "nexus-escrow-v1") → AES-256-GCM wraps the data key. Python and the SDK decrypt it too.

import type { App } from "../bot";
import { newId, nowIso } from "../util";
import { b64, keyId, unb64 } from "../continuity/crypto";
import { exportBundle, PortableError } from "../continuity/portable";

const enc = new TextEncoder();
const PKCS8_X25519 = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20]);

export interface EscrowEnvelope {
  schema: "nexus.escrow.v1";
  org: string;
  created_at: string;
  sha256: string;
  iv: string;
  ct: string;
  recipients: { kid: string; epk: string; iv: string; wrapped: string }[];
}

async function kek(shared: ArrayBuffer, epk: Uint8Array, rpk: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const salt = new Uint8Array([...epk, ...rpk]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: enc.encode("nexus-escrow-v1") }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function x25519Keys(): Promise<{ privateKey: string; publicKey: string }> {
  const kp = (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", kp.privateKey)) as ArrayBuffer);
  return { privateKey: b64(pkcs8.slice(-32)), publicKey: b64((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer) };
}

export async function encryptEscrow(plain: string, recipients: string[], org: string, now = nowIso()): Promise<EscrowEnvelope> {
  if (!recipients.length) throw new Error("no_recipients");
  const data = enc.encode(plain);
  const dek = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const dk = await crypto.subtle.importKey("raw", dek, { name: "AES-GCM" }, false, ["encrypt"]);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, dk, data);
  const out: EscrowEnvelope["recipients"] = [];
  for (const r of recipients) {
    const rpk = unb64(r);
    if (rpk.length !== 32) throw new Error("bad_recipient");
    const eph = (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
    const epk = new Uint8Array((await crypto.subtle.exportKey("raw", eph.publicKey)) as ArrayBuffer);
    const pub = await crypto.subtle.importKey("raw", rpk, { name: "X25519" }, false, []);
    const shared = await crypto.subtle.deriveBits({ name: "X25519", public: pub } as unknown as SubtleCryptoDeriveKeyAlgorithm, eph.privateKey, 256);
    const wiv = crypto.getRandomValues(new Uint8Array(12));
    const wrapped = await crypto.subtle.encrypt({ name: "AES-GCM", iv: wiv }, await kek(shared, epk, rpk), dek);
    out.push({ kid: await keyId(r), epk: b64(epk), iv: b64(wiv), wrapped: b64(wrapped) });
  }
  return { schema: "nexus.escrow.v1", org, created_at: now, sha256: b64(await crypto.subtle.digest("SHA-256", data)), iv: b64(iv), ct: b64(ct), recipients: out };
}

/** Decrypt with one recipient's private key (raw 32 bytes, base64). */
export async function decryptEscrow(env: EscrowEnvelope, privateKey: string): Promise<string> {
  const raw = unb64(privateKey);
  const priv = await crypto.subtle.importKey("pkcs8", new Uint8Array([...PKCS8_X25519, ...raw]), { name: "X25519" }, true, ["deriveBits"]);
  const jwk = (await crypto.subtle.exportKey("jwk", priv)) as JsonWebKey;
  const rpk = Uint8Array.from(atob(jwk.x!.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (jwk.x!.length % 4)) % 4)), (c) => c.charCodeAt(0));
  const kid = await keyId(b64(rpk));
  const r = env.recipients.find((x) => x.kid === kid);
  if (!r) throw new Error("not_a_recipient");
  const epk = unb64(r.epk);
  const pub = await crypto.subtle.importKey("raw", epk, { name: "X25519" }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "X25519", public: pub } as unknown as SubtleCryptoDeriveKeyAlgorithm, priv, 256);
  const dek = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(r.iv) }, await kek(shared, epk, rpk), unb64(r.wrapped));
  const dk = await crypto.subtle.importKey("raw", dek, { name: "AES-GCM" }, false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(env.iv) }, dk, unb64(env.ct));
  if (b64(await crypto.subtle.digest("SHA-256", plain)) !== env.sha256) throw new Error("hash_mismatch");
  return new TextDecoder().decode(plain);
}

// ---- S3-compatible upload (AWS SigV4), for Backblaze B2, Wasabi, R2 on another account, MinIO… --

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
async function hmacRaw(key: Uint8Array | ArrayBuffer, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(data));
}

export async function s3Put(net: (u: string, i: RequestInit) => Promise<Response>, t: { url: string; region: string; keyId: string; secret: string }, key: string, body: string, now = new Date()): Promise<boolean> {
  const base = new URL(t.url.replace(/\/$/, ""));
  const path = `${base.pathname}/${key}`.replace(/\/+/g, "/").split("/").map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const payloadHash = hex(await crypto.subtle.digest("SHA-256", enc.encode(body)));
  const canonical = ["PUT", path, "", `host:${base.host}`, `x-amz-content-sha256:${payloadHash}`, `x-amz-date:${amzDate}`, "", "host;x-amz-content-sha256;x-amz-date", payloadHash].join("\n");
  const scope = `${day}/${t.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, hex(await crypto.subtle.digest("SHA-256", enc.encode(canonical)))].join("\n");
  let k: ArrayBuffer = await hmacRaw(enc.encode(`AWS4${t.secret}`), day);
  k = await hmacRaw(k, t.region);
  k = await hmacRaw(k, "s3");
  k = await hmacRaw(k, "aws4_request");
  const sig = hex(await hmacRaw(k, toSign));
  try {
    const res = await net(`${base.origin}${path}`, {
      method: "PUT",
      headers: { authorization: `AWS4-HMAC-SHA256 Credential=${t.keyId}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${sig}`, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate, "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(15000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

interface TargetConf {
  name: string;
  url: string;
  region?: string;
  keyIdSecret: string;
  secretSecret: string;
}

export function escrowTargets(env: App["env"]): TargetConf[] {
  try {
    const t = JSON.parse(env.ESCROW_TARGETS || "[]") as TargetConf[];
    return Array.isArray(t) ? t.filter((x) => x && /^https:\/\//.test(x.url) && x.keyIdSecret && x.secretSecret).slice(0, 3) : [];
  } catch {
    return [];
  }
}

export function escrowRecipients(env: App["env"]): string[] {
  return (env.ESCROW_RECIPIENTS ?? "").split(",").map((s) => s.trim()).filter((s) => /^[A-Za-z0-9+/]{43}=$/.test(s));
}

export async function buildEscrow(app: App, now = new Date()): Promise<EscrowEnvelope | null> {
  const recipients = escrowRecipients(app.env);
  if (!recipients.length) return null;
  let bundle;
  try {
    bundle = await exportBundle(app);
  } catch (e) {
    if (e instanceof PortableError) return null;
    throw e;
  }
  return encryptEscrow(JSON.stringify(bundle), recipients, bundle.signed.org, nowIso(now));
}

/** Cron (daily): encrypt and write one copy per target. Records sizes and hashes only. */
export async function runEscrow(app: App, now = new Date()): Promise<number> {
  const targets = escrowTargets(app.env);
  if (!targets.length && !app.env.ESCROW_R2) return 0;
  if (app.budget && app.budget.left() < targets.length + 2) return 0; // no room this run; tomorrow's run writes a fresh copy
  const env = await buildEscrow(app, now);
  if (!env) return 0;
  const body = JSON.stringify(env);
  const key = `${env.org.replace(/[^a-z0-9-]/gi, "-").toLowerCase()}/escrow-${nowIso(now).slice(0, 10)}.json`;
  let ok = 0;
  let failed = 0;
  const vars = app.env as unknown as Record<string, string | undefined>;
  for (const t of targets) {
    const keyId = vars[t.keyIdSecret];
    const secret = vars[t.secretSecret];
    const good = !!keyId && !!secret && (await s3Put(app.net ?? fetch, { url: t.url, region: t.region || "auto", keyId, secret }, key, body, now));
    good ? ok++ : failed++;
  }
  if (app.env.ESCROW_R2) {
    try {
      await app.env.ESCROW_R2.put(key, body, { httpMetadata: { contentType: "application/json" } });
      ok++;
    } catch {
      failed++;
    }
  }
  await app.db.prepare("INSERT INTO escrow_runs(id, at, bytes, sha256, targets_ok, targets_failed) VALUES (?,?,?,?,?,?)").bind(newId(), nowIso(now), body.length, env.sha256, ok, failed).run();
  return ok;
}
