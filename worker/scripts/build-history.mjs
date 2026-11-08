// Bundles the two in-browser Telegram tools into public/. Runs automatically before
// `wrangler deploy` / `wrangler dev` (build.command in wrangler.jsonc).
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { build } from "esbuild";

const root = path.join(import.meta.dirname, "..");
const bundles = [
  { source: path.join(root, "history", "client.ts"), directory: "history", script: "history.js" },
  { source: path.join(root, "export", "client.ts"), directory: "export", script: "export.js" },
];
// mtcute loads its crypto WebAssembly next to each script (new URL("./x.wasm", import.meta.url)).
const wasm = path.dirname(createRequire(import.meta.url).resolve("@mtcute/wasm"));
for (const bundle of bundles) {
  const out = path.join(root, "public", bundle.directory);
  mkdirSync(out, { recursive: true });
  await build({
    entryPoints: [bundle.source],
    outfile: path.join(out, bundle.script),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    legalComments: "linked",
    logLevel: "warning",
  });
  for (const f of ["mtcute.wasm", "mtcute-simd.wasm"]) copyFileSync(path.join(wasm, f), path.join(out, f));
  console.log(`${bundle.directory} bundle → public/${bundle.directory}/`);
}
