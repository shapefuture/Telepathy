// Make an Ed25519 key pair for the partner gateway. Prints to your terminal only.
//   public  -> wrangler.jsonc vars.FEDERATION_PUBLIC_KEY, and give it to partners
//   private -> `npx wrangler secret put FEDERATION_PRIVATE_KEY` (never commit it)
const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const b64 = (b) => Buffer.from(b).toString("base64");
console.log("FEDERATION_PUBLIC_KEY =", b64(await crypto.subtle.exportKey("raw", kp.publicKey)));
console.log("FEDERATION_PRIVATE_KEY =", b64(await crypto.subtle.exportKey("pkcs8", kp.privateKey)));
