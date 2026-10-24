#!/usr/bin/env node
// Usage: npm run import -- result.json [--chat-id -100123] [--per-file 15000] [--out import]
// Then, one file per day on the free plan (100k D1 writes/day):
//   npx wrangler d1 execute telepathy --remote --file import/part-001.sql
import fs from "node:fs";
import path from "node:path";
import { botApiChatId, countMessages, toSql } from "./import-lib.mjs";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const file = args.find((a) => !a.startsWith("--") && !args[args.indexOf(a) - 1]?.startsWith("--"));
if (!file) {
  console.error("usage: npm run import -- result.json [--chat-id ID] [--per-file 15000] [--out import]");
  process.exit(2);
}
const exp = JSON.parse(fs.readFileSync(file, "utf8"));
const chatId = Number(opt("chat-id", botApiChatId(exp)));
const perFile = Number(opt("per-file", "15000"));
const out = opt("out", "import");
fs.mkdirSync(out, { recursive: true });

let part = 0;
let inFile = 0;
let lines = [];
const flush = () => {
  if (!lines.length) return;
  part += 1;
  fs.writeFileSync(path.join(out, `part-${String(part).padStart(3, "0")}.sql`), `${lines.join("\n")}\n`);
  lines = [];
  inFile = 0;
};
for (const stmt of toSql(exp, chatId)) {
  lines.push(stmt);
  if (stmt.startsWith("INSERT OR IGNORE INTO passages")) {
    inFile += 1;
    if (inFile >= perFile) flush();
  }
}
flush();
const total = countMessages(exp);
console.log(`chat ${chatId}: ${total} text messages -> ${part} file(s) in ${out}/ (${perFile} messages each)`);
console.log("Estimated D1 writes: ~5 per new message (row + search index + indexes).");
console.log(`Free plan: run at most one file per day:  npx wrangler d1 execute telepathy --remote --file ${out}/part-001.sql`);
