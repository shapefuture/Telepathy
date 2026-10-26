// Bundles history/client.ts (the owner's in-browser Telegram reader) into public/history/.
// Runs automatically before `wrangler deploy` / `wrangler dev` (build.command in wrangler.jsonc).
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { build } from "esbuild";

const root = path.join(import.meta.dirname, "..");
const out = path.join(root, "public", "history");
mkdirSync(out, { recursive: true });
await build({
  entryPoints: [path.join(root, "history", "client.ts")],
  outfile: path.join(out, "history.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  legalComments: "linked",
  logLevel: "warning",
});
// mtcute loads its crypto WebAssembly next to the script (new URL("./x.wasm", import.meta.url)).
const wasm = path.dirname(createRequire(import.meta.url).resolve("@mtcute/wasm"));
for (const f of ["mtcute.wasm", "mtcute-simd.wasm"]) copyFileSync(path.join(wasm, f), path.join(out, f));
console.log("history import bundle → public/history/");
