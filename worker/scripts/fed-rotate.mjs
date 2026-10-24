// Rotate this node's federation key. The old private key signs a proof for the new public key,
// so partners accept the change automatically (the old key stays valid 7 days on their side).
//   OLD_PRIVATE_KEY=... npm run fed:rotate -- https://club-a.example
// Then: wrangler secret put FEDERATION_PRIVATE_KEY (new), vars FEDERATION_PUBLIC_KEY (new),
//       var FEDERATION_ROTATION (the proof JSON, public), deploy. Manual partners: send them the proof
//       for `/partner rotate <your id> <proof>`.
import { canonical, generateKeys } from "../../contracts/sdk/nexus.mjs";

const nodeId = process.argv[2];
const old = process.env.OLD_PRIVATE_KEY;
if (!nodeId || !old) {
  console.error("usage: OLD_PRIVATE_KEY=... node scripts/fed-rotate.mjs <node id>");
  process.exit(1);
}
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64 = (b) => Buffer.from(b).toString("base64");
const oldKey = await crypto.subtle.importKey("pkcs8", unb64(old), { name: "Ed25519" }, true, ["sign"]);
const jwk = await crypto.subtle.exportKey("jwk", oldKey);
const oldPub = jwk.x.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (jwk.x.length % 4)) % 4);
const next = await generateKeys();
const proof = { schema: "nexus.rotation.v1", node_id: nodeId, old_key: oldPub, new_key: next.publicKey, issued_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") };
const signature = b64(await crypto.subtle.sign({ name: "Ed25519" }, oldKey, new TextEncoder().encode(canonical(proof))));
console.log("FEDERATION_PUBLIC_KEY =", next.publicKey);
console.log("FEDERATION_PRIVATE_KEY =", next.privateKey);
console.log("FEDERATION_ROTATION =", JSON.stringify({ ...proof, signature }));
