// Hydra operator tool (P16, docs/HYDRA.md). Runs on your own machine; nothing here needs Cloudflare.
//   npm run hydra -- vapid                      Web Push key pair (VAPID_PUBLIC_KEY var + VAPID_PRIVATE_KEY secret)
//   npm run hydra -- escrow-keys                X25519 pair for an escrow recipient (keep the private key offline)
//   npm run hydra -- shamir-split <base64> <n> <k>   split a secret (e.g. CONTINUITY_KEY) among n custodians
//   npm run hydra -- shamir-combine <share>...       rebuild it from any k shares
//   npm run hydra -- seal <manifest.json> <quorum> <silence-days> <partner,partner,...>
//                                               body for POST /admin/hydra/seal (the Worker encrypts and splits)
//   npm run hydra -- anchors <https://worker>    text to publish as DNS TXT, a Nostr note, a post, a repo file
//   npm run hydra -- mirror <https://worker> <out-dir>   static mirror (public material only) for any host
import fs from "node:fs";
import path from "node:path";
import { decodeShare, encodeShare, shamirCombine } from "../../contracts/sdk/hydra.mjs";

const b64 = (b) => Buffer.from(b).toString("base64");
const b64u = (b) => Buffer.from(b).toString("base64url");
const [cmd, ...a] = process.argv.slice(2);

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
const mul = (p, q) => (p && q ? EXP[LOG[p] + LOG[q]] : 0);

async function get(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r;
}

if (cmd === "vapid") {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  console.log(`VAPID_PUBLIC_KEY=${b64u(await crypto.subtle.exportKey("raw", kp.publicKey))}`);
  console.log(`VAPID_PRIVATE_KEY=${(await crypto.subtle.exportKey("jwk", kp.privateKey)).d}   # wrangler secret put VAPID_PRIVATE_KEY`);
} else if (cmd === "escrow-keys") {
  const kp = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  console.log(`public  (add to ESCROW_RECIPIENTS): ${b64(await crypto.subtle.exportKey("raw", kp.publicKey))}`);
  console.log(`private (offline; decrypts escrow): ${b64(pkcs8.slice(-32))}`);
} else if (cmd === "shamir-split" && a.length === 3) {
  const secret = Buffer.from(a[0], "base64");
  const [n, k] = [Number(a[1]), Number(a[2])];
  if (!(k >= 2 && n >= k && n <= 255)) throw new Error("need 2 <= k <= n <= 255");
  const coeffs = [...secret].map((s) => [s, ...crypto.getRandomValues(new Uint8Array(k - 1))]);
  for (let x = 1; x <= n; x++) {
    const y = new Uint8Array(secret.length);
    coeffs.forEach((c, i) => {
      let acc = 0;
      for (let d = k - 1; d >= 0; d--) acc = mul(acc, x) ^ c[d];
      y[i] = acc;
    });
    console.log(encodeShare({ k, x, y }));
  }
} else if (cmd === "shamir-combine" && a.length >= 2) {
  console.log(b64(shamirCombine(a.map(decodeShare))));
} else if (cmd === "seal" && a.length === 4) {
  const manifest = JSON.parse(fs.readFileSync(a[0], "utf8"));
  console.log(JSON.stringify({ manifest, quorum: Number(a[1]), silence_days: Number(a[2]), partners: a[3].split(",").map((s) => s.trim()) }));
} else if (cmd === "anchors" && a.length === 1) {
  const base = a[0].replace(/\/$/, "");
  const rec = (await (await get(`${base}/.well-known/nexus-anchor.txt`)).text()).trim();
  const chunks = rec.match(/.{1,250}/g).map((c) => `"${c}"`).join(" ");
  console.log(`# DNS TXT record at _nexus.<your-domain> (one record, several strings):\n_nexus IN TXT ${chunks}\n`);
  console.log(`# Nostr note / Mastodon / Bluesky post (any one surviving copy is enough):\n${rec}\n`);
  console.log(`# Public repository file anchors/${new Date().toISOString().slice(0, 10)}.txt (public manifest only, never member data):\n${rec}`);
} else if (cmd === "mirror" && a.length === 2) {
  const base = a[0].replace(/\/$/, "");
  const out = a[1];
  fs.mkdirSync(path.join(out, ".well-known"), { recursive: true });
  const files = [".well-known/nexus-community.json", ".well-known/nexus-anchor.txt", "notices.json", "feed.xml", "notices.ics"];
  for (const f of files) fs.writeFileSync(path.join(out, f), Buffer.from(await (await get(`${base}/${f}`)).arrayBuffer()));
  const community = JSON.parse(fs.readFileSync(path.join(out, ".well-known/nexus-community.json"), "utf8"));
  fs.writeFileSync(path.join(out, "index.html"), MIRROR_PAGE(community.root.signed.org, community.root.signed.root_keys.map((k) => k.keyid)));
  console.log(`Mirror written to ${out}/ (${files.length + 1} files). Upload it to any static host (Pages, Netlify, GitHub Pages, IPFS).`);
  console.log("Then add it to the signed list: /destinations add web https://<mirror-url>");
} else {
  console.log(fs.readFileSync(new URL(import.meta.url)).toString().split("\n").filter((l) => l.startsWith("//")).join("\n"));
  process.exit(cmd ? 2 : 0);
}

function MIRROR_PAGE(org, keyids) {
  // The page verifies the copied documents in the browser against the root key ids printed on it.
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${org}: official places (mirror)</title>
<style>body{font:16px/1.45 system-ui,sans-serif;max-width:640px;margin:0 auto;padding:16px}code{word-break:break-all}.ok{color:#1a7f37}.bad{color:#b42318}</style></head><body>
<h1>${org}: official places</h1><p>This is a static mirror. It only copies public, signed documents; your browser checks the signatures below.</p>
<p>Club key ids (compare with your recovery card): <code>${keyids.join(", ")}</code></p><div id="v">Checking…</div><h2>Notices</h2><div id="n"></div>
<p><a href="feed.xml">Atom feed</a> · <a href="notices.ics">Calendar</a> · <a href=".well-known/nexus-community.json">Signed document</a></p>
<script>
"use strict";
var KEYIDS=${JSON.stringify(keyids)};
function canon(v){if(v===null||typeof v!=="object")return JSON.stringify(v);if(Array.isArray(v))return "["+v.map(canon).join(",")+"]";return "{"+Object.keys(v).filter(function(k){return v[k]!==undefined}).sort().map(function(k){return JSON.stringify(k)+":"+canon(v[k])}).join(",")+"}"}
function unb64(s){var r=atob(s),o=new Uint8Array(r.length);for(var i=0;i<r.length;i++)o[i]=r.charCodeAt(i);return o}
function count(doc,keys){var data=new TextEncoder().encode(canon(doc.signed));return Promise.all((doc.signatures||[]).map(function(s){var k=keys.find(function(x){return x.keyid===s.keyid});if(!k)return null;return crypto.subtle.importKey("raw",unb64(k.key),{name:"Ed25519"},false,["verify"]).then(function(p){return crypto.subtle.verify({name:"Ed25519"},p,unb64(s.sig),data)}).then(function(ok){return ok?k.keyid:null}).catch(function(){return null})})).then(function(r){return new Set(r.filter(Boolean)).size})}
var v=document.getElementById("v");
fetch(".well-known/nexus-community.json").then(function(r){return r.json()}).then(function(c){var root=c.root.signed;
 var same=root.root_keys.map(function(k){return k.keyid}).sort().join()===KEYIDS.slice().sort().join();
 return count(c.root,root.root_keys).then(function(n){var rootOk=same&&n>=root.threshold;return count(c.destinations,root.online_keys).then(function(m){return count(c.destinations,root.root_keys).then(function(rk){
  var ok=rootOk&&(m>=1||rk>=root.threshold)&&c.destinations.signed.expires>new Date().toISOString();
  v.innerHTML="";var p=document.createElement("p");p.className=ok?"ok":"bad";p.textContent=ok?"Verified: signed by the club's keys (list v"+c.destinations.signed.version+", valid until "+c.destinations.signed.expires.slice(0,10)+").":"NOT verified. Don't trust these addresses.";v.append(p);
  if(ok)c.destinations.signed.destinations.forEach(function(d){var a=document.createElement("a");a.href=d.url;a.textContent=(d.role==="primary"?"★ ":"")+d.kind+": "+d.url;var div=document.createElement("div");div.append(a);v.append(div)});
  return fetch("notices.json").then(function(r){return r.json()}).then(function(j){var n=document.getElementById("n");return Promise.all(j.notices.map(function(x){return count(x,root.online_keys).then(function(k){var d=document.createElement("div");d.textContent=(k?"✓ ":"✗ ")+x.signed.issued_at.slice(0,10)+" — "+x.signed.title+": "+x.signed.body;n.append(d)})}))})})})})
}).catch(function(){v.textContent="This browser can't check Ed25519 signatures, or the files are missing."});
</script></body></html>`;
}
