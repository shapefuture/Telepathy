// Regenerate nexus-v1.json: node contracts/test-vectors/generate.mjs > contracts/test-vectors/nexus-v1.json
// Ed25519 is deterministic, so the same seed and message always give the same signature.
import { canonical, pkcs8FromSeed, sign } from "../sdk/nexus.mjs";

const seed = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const privateKey = pkcs8FromSeed(seed);
const key = await crypto.subtle.importKey("pkcs8", Uint8Array.from(atob(privateKey), (c) => c.charCodeAt(0)), { name: "Ed25519" }, true, ["sign"]);
const jwk = await crypto.subtle.exportKey("jwk", key);
const publicKey = jwk.x.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (jwk.x.length % 4)) % 4);

const message = {
  schema: "nexus.v1", type: "inquiry", exchange_id: "ex_vector_1", issuer_org: "https://club-a.example", recipient_org: "https://club-b.example",
  issued_at: "2030-01-01T00:00:00Z", expires_at: "2030-01-08T00:00:00Z", nonce: "nonce-1",
  body: { mission_ref: "ref_1", job: "accounting", summary: "Bookkeeping help for a small bakery; Привет, ünïcödé ✓", criteria: { language: ["en", "ru"] }, allowed_fields: ["job", "summary", "criteria"], purpose: "evaluate_willing_provider", forwarding: "prohibited", max_hops: 1, policy_version: 1 },
};
const signed = await sign(message, privateKey);
const now = "2030-01-02T00:00:00Z";
const shape = (patch, expect, note) => ({ note, patch, expect });
console.log(JSON.stringify({
  description: "nexus.v1 conformance vectors. Every implementation must reproduce `canonical` and `signature` exactly and give the listed result for each case, evaluated at `now`.",
  seed_hex: Buffer.from(seed).toString("hex"),
  private_key_pkcs8: privateKey,
  public_key: publicKey,
  now,
  message,
  canonical: canonical(message),
  signature: signed.signature,
  verify_cases: [
    { note: "valid", patch: {}, expect: true },
    { note: "body changed after signing", patch: { body: { ...message.body, summary: "changed" } }, expect: false },
    { note: "nonce changed", patch: { nonce: "nonce-2" }, expect: false },
  ],
  shape_cases: [
    shape({}, null, "well-formed"),
    shape({ expires_at: "2030-01-01T12:00:00Z" }, "expired", "expired at now"),
    shape({ issued_at: "2030-01-03T00:00:00Z" }, "future", "issued more than 5 min in the future"),
    shape({ expires_at: "2030-02-01T00:00:00Z" }, "ttl", "TTL over 15 days"),
    shape({ schema: "nexus.v0" }, "schema", "wrong schema"),
    shape({ body: { ...message.body, forwarding: "allowed" } }, "forwarding", "forwarding must be prohibited"),
    shape({ body: { ...message.body, max_hops: 2 } }, "forwarding", "one hop only"),
    shape({ body: { ...message.body, member_tg_id: 42 } }, "inquiry_field:member_tg_id", "no extra inquiry fields"),
    shape({ body: { ...message.body, allowed_fields: ["job", "contact"] } }, "allowed_fields", "contact can't be an envelope field"),
    shape({ body: { ...message.body, job: "Bad Job!" } }, "job", "job code format"),
  ],
}, null, 2));
