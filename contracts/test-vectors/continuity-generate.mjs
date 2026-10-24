// Regenerate: node contracts/test-vectors/continuity-generate.mjs > contracts/test-vectors/continuity-v1.json
// Deterministic (fixed seeds, Ed25519 is deterministic). Test keys only — never use them for real.
import { canonical, followStateFrom, keyId, pkcs8FromSeed, verifyDestinations, verifyPass, verifyRoot } from "../sdk/nexus.mjs";

const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64 = (b) => Buffer.from(b).toString("base64");
async function keys(n) {
  const priv = pkcs8FromSeed(Uint8Array.from({ length: 32 }, (_, i) => (i * 13 + n * 31) & 255));
  const k = await crypto.subtle.importKey("pkcs8", unb64(priv), { name: "Ed25519" }, true, ["sign"]);
  const x = (await crypto.subtle.exportKey("jwk", k)).x;
  const pub = x.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (x.length % 4)) % 4);
  return { priv, pub, keyid: await keyId(pub) };
}
async function sign(doc, k) {
  const key = await crypto.subtle.importKey("pkcs8", unb64(k.priv), { name: "Ed25519" }, false, ["sign"]);
  const sig = b64(await crypto.subtle.sign({ name: "Ed25519" }, key, new TextEncoder().encode(canonical(doc.signed))));
  return { signed: doc.signed, signatures: [...(doc.signatures ?? []), { keyid: k.keyid, sig }] };
}
const C = [await keys(1), await keys(2), await keys(3)];
const ON = await keys(4);
const now = "2030-01-02T00:00:00Z";
const exp = "2031-01-01T00:00:00Z";
const rootSigned = { schema: "nexus.root.v1", org: "club-a", version: 1, expires: exp, root_keys: C.map((k) => ({ keyid: k.keyid, key: k.pub })), threshold: 2, online_keys: [{ keyid: ON.keyid, key: ON.pub }] };
let root = { signed: rootSigned };
for (const k of C) root = await sign(root, k);
const m1 = await sign({ signed: { schema: "nexus.destinations.v1", org: "club-a", version: 1, root_version: 1, expires: exp, destinations: [{ kind: "telegram", url: "https://t.me/club_a", role: "primary" }, { kind: "web", url: "https://club-a.example", role: "backup" }] } }, ON);
const relocSigned = { ...m1.signed, version: 2, destinations: [{ kind: "web", url: "https://club-a.example", role: "primary" }, { kind: "telegram", url: "https://t.me/club_a", role: "backup" }], relocation: { from: "https://t.me/club_a", to: "https://club-a.example", reason: "group deleted" } };
const m2 = await sign(await sign({ signed: relocSigned }, C[0]), C[2]);
const forged = await sign({ signed: { ...relocSigned } }, ON);
const fork = await sign(await sign({ signed: { ...relocSigned, relocation: { ...relocSigned.relocation, reason: "other" } } }, C[0]), C[1]);
const weakRoot = await sign({ signed: rootSigned }, C[0]);
const pass = await sign({ signed: { schema: "nexus.attestation.v1", id: "0123456789abcdef0123456789abcdef", org: "club-a", audience: "https://club-b.example", subject: "aa".repeat(16), tier: "member", scope: "community", issued_at: "2030-01-01T00:00:00Z", expires_at: "2030-01-08T00:00:00Z" } }, ON);
const ops = (seqs) => seqs.map(([seq, op, topic]) => ({ seq, op, topic, at: "2030-01-01T00:00:00Z" }));
const exportOf = async (o) => sign({ signed: { schema: "nexus.continuity-export.v1", org: "club-a", generated_at: "2030-01-01T00:00:00Z", root_version: 1, manifest_version: 1, people: [{ ref: "p1", emails: ["ann@example.com"], ops: ops(o), memberships: [] }], suppressions: [] } }, ON);
const older = await exportOf([[1, "FOLLOW", "critical"], [2, "FOLLOW", "news"]]);
const newer = await exportOf([[1, "FOLLOW", "critical"], [2, "FOLLOW", "news"], [3, "UNFOLLOW", "news"]]);

const cases = {
  root: [
    { note: "valid, 3 of 3", doc: root, trusted: null, expect: (await verifyRoot(root, null, now)) },
    { note: "below threshold", doc: weakRoot, trusted: null, expect: (await verifyRoot(weakRoot, null, now)) },
  ],
  destinations: [
    { note: "online key, first list", doc: m1, last: null, expect: await verifyDestinations(m1, root, null, now) },
    { note: "root-signed relocation", doc: m2, last: m1, expect: await verifyDestinations(m2, root, m1, now) },
    { note: "relocation signed by online key only", doc: forged, last: m1, expect: await verifyDestinations(forged, root, m1, now) },
    { note: "replay of older list", doc: m1, last: m2, expect: await verifyDestinations(m1, root, m2, now) },
    { note: "same version, different content", doc: fork, last: m2, expect: await verifyDestinations(fork, root, m2, now) },
  ],
  pass: [
    { note: "valid for club-b", doc: pass, me: "https://club-b.example", expect: (await verifyPass(pass, root, "https://club-b.example", now)).ok },
    { note: "wrong audience", doc: pass, me: "https://club-c.example", expect: (await verifyPass(pass, root, "https://club-c.example", now)).ok },
    { note: "tier changed", doc: { ...pass, signed: { ...pass.signed, tier: "vip" } }, me: "https://club-b.example", expect: (await verifyPass({ ...pass, signed: { ...pass.signed, tier: "vip" } }, root, "https://club-b.example", now)).ok },
  ],
  restore: { exports: [older, newer], expect_any_order: followStateFrom([newer, older]) },
};
if (JSON.stringify(followStateFrom([older, newer])) !== JSON.stringify(cases.restore.expect_any_order)) throw new Error("order dependence");
console.log(JSON.stringify({ description: "nexus continuity conformance vectors (CONT-10). Test keys only.", now, canonical_root: canonical(rootSigned), root, cases }, null, 2));
