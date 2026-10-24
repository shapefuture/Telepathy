// Regenerate: node contracts/test-vectors/hydra-generate.mjs > contracts/test-vectors/hydra-v1.json
// Fixed seeds; test keys only — never use them for anything real. The escrow envelope uses random
// ephemeral keys, so it changes on each run, but any run is a valid vector.
import { canonical, keyId, pkcs8FromSeed } from "../sdk/nexus.mjs";
import { anchorRecord, checkAnchor, encodeShare, expandDomains, followStateFromReceipts, headDomains, hydraIndex, independentCount, totp, verifyNotice, verifyReceipt } from "../sdk/hydra.mjs";

const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64 = (b) => Buffer.from(b).toString("base64");
const seed = (n) => Uint8Array.from({ length: 32 }, (_, i) => (i * 17 + n * 29) & 255);
async function keys(n) {
  const priv = pkcs8FromSeed(seed(n));
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
const EVIL = await keys(9);
const now = "2030-01-02T00:00:00Z";
const exp = "2031-01-01T00:00:00Z";
let root = { signed: { schema: "nexus.root.v1", org: "club-a", version: 1, expires: exp, root_keys: C.map((k) => ({ keyid: k.keyid, key: k.pub })), threshold: 2, online_keys: [{ keyid: ON.keyid, key: ON.pub }] } };
for (const k of C) root = await sign(root, k);
const m1 = await sign({ signed: { schema: "nexus.destinations.v1", org: "club-a", version: 1, root_version: 1, expires: exp, destinations: [{ kind: "web", url: "https://club-a.example", role: "primary" }] } }, ON);
const moved = await sign(await sign({ signed: { ...m1.signed, version: 2, destinations: [{ kind: "web", url: "https://club-a-new.example", role: "primary" }], relocation: { from: "https://club-a.example", to: "https://club-a-new.example", reason: "domain lost" } } }, C[0]), C[1]);
const forgedMove = await sign({ signed: { ...moved.signed, destinations: [{ kind: "web", url: "https://evil.example", role: "primary" }], relocation: { from: "https://club-a.example", to: "https://evil.example", reason: "x" } } }, ON);

// ---- domains, independence, index ----
const domainCases = [
  { kind: "email", address: "Ann@Gmail.com", opts: { senders: ["resend", "postmark"] } },
  { kind: "email", address: "me@family.example", opts: { mx: "aspmx.l.google.com.", senders: ["resend"] } },
  { kind: "email", address: "x@proton.me", opts: { senders: ["resend"] } },
  { kind: "webpush", address: "https://fcm.googleapis.com/fcm/send/abc", opts: {} },
  { kind: "webpush", address: "https://web.push.apple.com/QQ", opts: {} },
  { kind: "ntfy", address: "https://ntfy.sh/tp_abc", opts: {} },
  { kind: "matrix", address: "@ann:matrix.org", opts: { matrixServer: "https://matrix.club.example" } },
  { kind: "sms", address: "+447700900123", opts: {} },
  { kind: "telegram", address: "", opts: {} },
].map((c) => ({ ...c, expect: expandDomains(headDomains(c.kind, c.address, c.opts), {}) }));
const registry = { "ntfy:ntfy.club.example": ["cloud:hetzner"], "matrix:matrix.club.example": ["cloud:hetzner"] };
const independent = [
  { heads: [["mail:google", "org:google"], ["mail:google", "org:google"]], registry: {} },
  { heads: [["mail:google", "org:google"], ["org:google", "push:google"]], registry: {} },
  { heads: [["telegram"], ["mail:proton"], ["ntfy:ntfy.sh"]], registry: {} },
  { heads: [["ntfy:ntfy.club.example"], ["matrix:matrix.club.example"]], registry },
].map((c) => ({ ...c, expect: independentCount(c.heads.map((h) => expandDomains(h, c.registry))) }));
const graph = [
  { id: "a", heads: [["telegram"], ["mail:google", "org:google"], ["ntfy:ntfy.sh"]] },
  { id: "b", heads: [["telegram"], ["mail:proton"]] },
  { id: "c", heads: [["telegram"]], buddies: ["a"] },
  { id: "d", heads: [["telegram"], ["ntfy:ntfy.sh"]] },
];
const index = [
  { graph, expect: hydraIndex(graph) },
  { graph: [{ id: "x", heads: [["telegram"]] }], expect: hydraIndex([{ id: "x", heads: [["telegram"]] }]) },
  { graph: [{ id: "x", heads: [] }, { id: "y", heads: [["telegram"]] }], expect: hydraIndex([{ id: "x", heads: [] }, { id: "y", heads: [["telegram"]] }]) },
];

// ---- notices, receipts, heartbeat, anchors ----
const notice = await sign({ signed: { schema: "nexus.notice.v1", org: "club-a", seq: 7, kind: "incident", title: "Telegram is unavailable for us", body: "Portal: https://club-a.example/portal", issued_at: now, manifest_version: 1, primary: "https://club-a.example" } }, ON);
const noticeTampered = { ...notice, signed: { ...notice.signed, body: "Send money to ..." } };
const noticeEvil = await sign({ signed: notice.signed }, EVIL);
const rec = (seq, op, topic) => sign({ signed: { schema: "nexus.follow-receipt.v1", org: "club-a", person_ref: "p1", seq, op, topic, at: now, consent_version: 1 } }, ON);
const receipts = [await rec(1, "FOLLOW", "critical"), await rec(2, "FOLLOW", "events"), await rec(3, "UNFOLLOW", "events")];
const receiptForged = { ...receipts[2], signed: { ...receipts[2].signed, op: "FOLLOW" } };
const heartbeat = await sign({ signed: { schema: "nexus.heartbeat.v1", org: "club-a", owners_seen: "2030-01-01", issued_at: now } }, ON);
const anchor = await anchorRecord(root, m1);

// ---- escrow: X25519 recipients from fixed seeds, HKDF + AES-GCM ----
const PK = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20];
async function xkeys(n) {
  const raw = seed(n + 40);
  const k = await crypto.subtle.importKey("pkcs8", new Uint8Array([...PK, ...raw]), { name: "X25519" }, true, ["deriveBits"]);
  const x = (await crypto.subtle.exportKey("jwk", k)).x;
  return { privateKey: b64(raw), publicKey: b64(Uint8Array.from(atob(x.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (x.length % 4)) % 4)), (c) => c.charCodeAt(0))) };
}
const X1 = await xkeys(1);
const X2 = await xkeys(2);
const plaintext = JSON.stringify({ schema: "example", people: [{ ref: "p1", emails: ["ann@example.com"] }] });
async function encryptEscrow(plain, recipients) {
  const enc = new TextEncoder();
  const data = enc.encode(plain);
  const dek = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await crypto.subtle.importKey("raw", dek, "AES-GCM", false, ["encrypt"]), data);
  const out = [];
  for (const r of recipients) {
    const rpk = unb64(r);
    const eph = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
    const epk = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
    const shared = await crypto.subtle.deriveBits({ name: "X25519", public: await crypto.subtle.importKey("raw", rpk, { name: "X25519" }, false, []) }, eph.privateKey, 256);
    const kek = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array([...epk, ...rpk]), info: enc.encode("nexus-escrow-v1") }, await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]), { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
    const wiv = crypto.getRandomValues(new Uint8Array(12));
    out.push({ kid: await keyId(r), epk: b64(epk), iv: b64(wiv), wrapped: b64(await crypto.subtle.encrypt({ name: "AES-GCM", iv: wiv }, kek, dek)) });
  }
  return { schema: "nexus.escrow.v1", org: "club-a", created_at: now, sha256: b64(await crypto.subtle.digest("SHA-256", data)), iv: b64(iv), ct: b64(ct), recipients: out };
}
const envelope = await encryptEscrow(plaintext, [X1.publicKey, X2.publicKey]);
// A standby restore: a signed export (as the Worker makes it), encrypted to X1.
const supp = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("email:carl@example.com"))).toString("hex");
const exportDoc = await sign({ signed: { schema: "nexus.continuity-export.v1", org: "club-a", generated_at: now, root_version: 1, manifest_version: 1, suppressions: [{ hash: supp, scope: "critical" }], people: [
  { ref: "p1", emails: ["ann@example.com"], heads: [{ channel: "ntfy", address: "https://ntfy.sh/tp_ann_0123456789abcdef" }], handle: "TP-AAAA-BBBB", device_keys: [], ops: [{ seq: 1, op: "FOLLOW", topic: "critical", at: now }], memberships: [] },
  { ref: "p2", emails: ["bob@example.com"], heads: [], ops: [{ seq: 1, op: "FOLLOW", topic: "critical", at: now }, { seq: 2, op: "UNFOLLOW", topic: "critical", at: now }], memberships: [] },
  { ref: "p3", emails: ["carl@example.com"], heads: [{ channel: "sms", address: "+447700900123" }], ops: [{ seq: 1, op: "FOLLOW", topic: "critical", at: now }], memberships: [] },
] } }, ON);
const standbyEnvelope = await encryptEscrow(JSON.stringify(exportDoc), [X1.publicKey]);

// ---- Shamir: fixed coefficients ----
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
const secret = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 11) & 255);
const k = 3;
const shares = [1, 2, 3, 4, 5].map((x) => {
  const y = new Uint8Array(secret.length);
  for (let i = 0; i < secret.length; i++) {
    const coeffs = [secret[i], (i * 31 + 5) & 255, (i * 47 + 9) & 255];
    let acc = 0;
    for (let d = k - 1; d >= 0; d--) acc = mul(acc, x) ^ coeffs[d];
    y[i] = acc;
  }
  return encodeShare({ k, x, y });
});

// ---- TOTP: RFC 6238 Appendix B (SHA-1), last 6 digits ----
const totpSecret = new TextEncoder().encode("12345678901234567890");
const totpCases = [];
for (const t of [59, 1111111109, 1111111111, 1234567890, 2000000000]) totpCases.push({ time: t, step: Math.floor(t / 30), expect: await totp(totpSecret, Math.floor(t / 30)) });

console.log(JSON.stringify({
  note: "Hydra (P16) conformance vectors. Test keys only.",
  now,
  root,
  manifest: m1,
  domains: domainCases,
  registry,
  independent,
  index,
  notices: [
    { note: "valid", doc: notice, expect: await verifyNotice(notice, root) },
    { note: "tampered body", doc: noticeTampered, expect: await verifyNotice(noticeTampered, root) },
    { note: "unknown key", doc: noticeEvil, expect: await verifyNotice(noticeEvil, root) },
  ],
  receipts: {
    valid: receipts,
    forged: receiptForged,
    forged_valid: await verifyReceipt(receiptForged, root),
    state_from_all: followStateFromReceipts(receipts),
    state_from_old_only: followStateFromReceipts(receipts.slice(0, 2)),
  },
  heartbeat,
  anchor: { record: anchor, check: await checkAnchor(anchor, root, m1), wrong_manifest: await checkAnchor(anchor, root, moved) },
  best_manifest: { candidates: [{ root, destinations: m1 }, { root, destinations: forgedMove }, { root, destinations: moved }], last: m1, expect_version: 2, expect_primary: "https://club-a-new.example" },
  escrow: { envelope, recipients: [X1, X2], plaintext },
  standby: { envelope: standbyEnvelope, key: X1.privateKey, expect_targets: [["email", "ann@example.com"], ["ntfy", "https://ntfy.sh/tp_ann_0123456789abcdef"], ["sms", "+447700900123"]] },
  shamir: { k, secret: b64(secret), shares, combos: [[0, 2, 4], [1, 2, 3], [4, 3, 0]] },
  totp: { secret_ascii: "12345678901234567890", cases: totpCases },
}, null, 1));
