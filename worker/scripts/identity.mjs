// Club identity tool (CONT-1). Run on an offline machine for root operations.
//   node scripts/identity.mjs init <org> <primary-url> [custodians=3] [threshold=2]
//       -> identity-out/: root.json (signed by all custodians), manifest.json (signed by online key),
//          custodian-N.key (root private keys: give one to each custodian, keep OFFLINE),
//          online.key (goes to `wrangler secret put IDENTITY_ONLINE_KEY`)
//   SIGN_KEY=<private key> node scripts/identity.mjs sign <file.json>      # add one signature
//   node scripts/identity.mjs relocate <current-manifest.json> <new-primary-url> "<reason>" > next.json
//   node scripts/identity.mjs root-next <root.json> <new-online-public-key> > root-next.json
// Upload: curl -X POST $WORKER/admin/identity/root|manifest -H "Authorization: Bearer $ADMIN_TOKEN" --data @file.json
import fs from "node:fs";
import { canonical, generateKeys } from "../../contracts/sdk/nexus.mjs";

const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64 = (b) => Buffer.from(b).toString("base64");
const keyid = async (pub) => Buffer.from(await crypto.subtle.digest("SHA-256", unb64(pub))).toString("hex").slice(0, 16);
async function pubOf(priv) {
  const k = await crypto.subtle.importKey("pkcs8", unb64(priv), { name: "Ed25519" }, true, ["sign"]);
  const x = (await crypto.subtle.exportKey("jwk", k)).x;
  return x.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (x.length % 4)) % 4);
}
async function sign(doc, priv) {
  const pub = await pubOf(priv);
  const id = await keyid(pub);
  const k = await crypto.subtle.importKey("pkcs8", unb64(priv), { name: "Ed25519" }, false, ["sign"]);
  const sig = b64(await crypto.subtle.sign({ name: "Ed25519" }, k, new TextEncoder().encode(canonical(doc.signed))));
  return { signed: doc.signed, signatures: [...(doc.signatures ?? []).filter((s) => s.keyid !== id), { keyid: id, sig }] };
}
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const DAY = 86_400_000;
const [cmd, ...a] = process.argv.slice(2);

if (cmd === "init") {
  const [org, primary, n = "3", t = "2"] = a;
  if (!org || !primary) throw new Error("usage: init <org> <primary-url> [custodians] [threshold]");
  fs.mkdirSync("identity-out", { recursive: true, mode: 0o700 });
  const roots = [];
  for (let i = 1; i <= Number(n); i++) {
    const k = await generateKeys();
    roots.push(k);
    fs.writeFileSync(`identity-out/custodian-${i}.key`, k.privateKey + "\n", { mode: 0o600 });
  }
  const online = await generateKeys();
  fs.writeFileSync("identity-out/online.key", online.privateKey + "\n", { mode: 0o600 });
  let root = { signed: { schema: "nexus.root.v1", org, version: 1, expires: iso(Date.now() + 365 * DAY), root_keys: await Promise.all(roots.map(async (k) => ({ keyid: await keyid(k.publicKey), key: k.publicKey }))), threshold: Number(t), online_keys: [{ keyid: await keyid(online.publicKey), key: online.publicKey }] } };
  for (const k of roots) root = await sign(root, k.privateKey);
  const kind = primary.startsWith("tg://") || primary.includes("t.me/") ? "telegram" : "web";
  const manifest = await sign({ signed: { schema: "nexus.destinations.v1", org, version: 1, root_version: 1, expires: iso(Date.now() + 30 * DAY), destinations: [{ kind, url: primary, role: "primary" }] } }, online.privateKey);
  fs.writeFileSync("identity-out/root.json", JSON.stringify(root, null, 2));
  fs.writeFileSync("identity-out/manifest.json", JSON.stringify(manifest, null, 2));
  console.log(`Wrote identity-out/. Threshold ${t} of ${n}. Move custodian-*.key offline NOW.`);
  console.log("IDENTITY_ONLINE_PUBLIC_KEY =", online.publicKey);
} else if (cmd === "sign") {
  const doc = JSON.parse(fs.readFileSync(a[0], "utf8"));
  if (!process.env.SIGN_KEY) throw new Error("set SIGN_KEY");
  fs.writeFileSync(a[0], JSON.stringify(await sign(doc, process.env.SIGN_KEY), null, 2));
  console.log("signed", a[0]);
} else if (cmd === "relocate") {
  const cur = JSON.parse(fs.readFileSync(a[0], "utf8")).signed;
  const from = cur.destinations.find((d) => d.role === "primary").url;
  const to = a[1];
  const kind = to.startsWith("tg://") || to.includes("t.me/") ? "telegram" : "web";
  const dests = [{ kind, url: to, role: "primary" }, ...cur.destinations.filter((d) => d.url !== to && d.url !== from).map((d) => ({ ...d, role: "backup" })), { kind: cur.destinations.find((d) => d.url === from).kind, url: from, role: "backup" }];
  const next = { signed: { ...cur, version: cur.version + 1, expires: iso(Date.now() + 30 * DAY), destinations: dests, relocation: { from, to, reason: a[2] ?? "relocation" } }, signatures: [] };
  console.log(JSON.stringify(next, null, 2));
} else if (cmd === "root-next") {
  const cur = JSON.parse(fs.readFileSync(a[0], "utf8")).signed;
  const pub = a[1];
  console.log(JSON.stringify({ signed: { ...cur, version: cur.version + 1, expires: iso(Date.now() + 365 * DAY), online_keys: [{ keyid: await keyid(pub), key: pub }] }, signatures: [] }, null, 2));
} else {
  console.log("commands: init | sign | relocate | root-next (see header)");
}
