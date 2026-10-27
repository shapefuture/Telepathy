// Bio import: a link to a site or profile, or pasted text, becomes skills on the person's profile.
// Only the skills are kept: the page and the text are read once and dropped. Text that goes to a
// model is redacted first, and the model is told to skip anything personal; its answer is filtered again.

import type { Member } from "./acl";
import { aiEnabled, generate } from "./ai/beam";
import { redact } from "./ai/redact";
import type { App } from "./bot";
import { CUSTOM_MAX, CUSTOM_PREFIX, customCode, matchSkills, resolveSkill, skillName } from "./experts";
import { langOf } from "./acl";
import { audit } from "./util";

const MAX_BYTES = 400_000;
const MAX_TEXT = 6_000;
const MAX_NEW = 12;
const MIN_TEXT = 20;

/** A message that is only a link ("https://…" or "www.…"). */
export const lonelyUrl = (text: string): string | null => (/^(https?:\/\/|www\.)\S+$/i.test(text.trim()) ? text.trim() : null);

/** An https address on a public site, or null. No IP addresses, local names, ports or logins. */
export function safeUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(/^www\./i.test(raw) ? `https://${raw}` : raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  u.protocol = "https:";
  const host = u.hostname.toLowerCase();
  if (u.username || u.password || (u.port && u.port !== "443")) return null;
  if (!host.includes(".") || /^[\d.]+$/.test(host) || host.includes(":") || host.startsWith("[")) return null;
  if (/(^|\.)(localhost|local|internal|lan|home|corp|intranet)$/.test(host)) return null;
  return u;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (s: string) =>
  s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1]!.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : " ";
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });

/** The readable text of a page: title, description, then the body without scripts and styles. */
export function htmlToText(html: string): string {
  const meta = (re: RegExp) => decode(re.exec(html)?.[1] ?? "").trim();
  const head = [
    meta(/<title[^>]*>([\s\S]*?)<\/title>/i),
    meta(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]*content=["']([^"']*)["']/i),
    meta(/<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["'](?:description|og:description)["']/i),
  ];
  const body = decode(
    html
      .replace(/<(script|style|noscript|svg|template|head)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " "),
  );
  return [...new Set(head.filter(Boolean)), body].join("\n").replace(/[ \t\r\f\v]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}

export type Page = { ok: true; text: string } | { ok: false; reason: "bad_url" | "blocked" | "failed" | "empty" };

/** Read one public page: https only, 8 seconds, 400 KB. LinkedIn does not let anyone read a profile, so it asks for text. */
export async function fetchPage(app: App, raw: string): Promise<Page> {
  const url = safeUrl(raw);
  if (!url) return { ok: false, reason: "bad_url" };
  if (/(^|\.)linkedin\.com$/.test(url.hostname)) return { ok: false, reason: "blocked" };
  try {
    const send = app.net ?? ((u: string, i: RequestInit) => fetch(u, i));
    const res = await send(url.href, {
      headers: { "user-agent": "TelepathyBot/1.0 (profile import)", accept: "text/html,text/plain;q=0.9", "accept-language": "en,ru;q=0.8" },
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
    });
    const final = res.url ? safeUrl(res.url) : url;
    if (!final) return { ok: false, reason: "bad_url" };
    if (/(^|\.)linkedin\.com$/.test(final.hostname) || [401, 403, 429, 999].includes(res.status)) return { ok: false, reason: "blocked" };
    if (!res.ok) return { ok: false, reason: "failed" };
    if (!/^(text\/html|text\/plain|application\/xhtml)/i.test(res.headers.get("content-type") ?? "text/html")) return { ok: false, reason: "failed" };
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (reader && size < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
    await reader?.cancel().catch(() => {});
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.length;
    }
    const text = htmlToText(new TextDecoder().decode(bytes)).slice(0, MAX_TEXT);
    return text.length >= MIN_TEXT ? { ok: true, text } : { ok: false, reason: "empty" };
  } catch (e) {
    console.warn("bio fetch failed", String(e));
    return { ok: false, reason: "failed" };
  }
}

// Traits a skill list must never carry, even if the page or the model offers them.
const PRIVATE_TRAITS = ["diagnos", "disease", "illness", "cancer", "pregnan", "disabilit", "religio", "muslim", "christian", "jewish", "atheis", "orientation", "lesbian", "ethnic", "болезн", "диагноз", "религ", "беремен", "инвалид", "ориентац", "атеист", "мусульман", "христиан", "иудей"];
export const isPrivateTrait = (s: string) => PRIVATE_TRAITS.some((t) => s.toLowerCase().includes(t));

const PROMPT = {
  en: "List the professional skills, tools and subject areas this person could help others with, as a JSON array of at most 10 short strings (1-3 words each, in the language of the text). Use only what the text says. Never include names, employers, places, age, health, religion, politics, sexuality, ethnicity or family. Reply with the JSON array only.",
  ru: "Перечисли профессиональные навыки, инструменты и темы, в которых этот человек может помочь другим, JSON-массивом из не более 10 коротких строк (1–3 слова, на языке текста). Только то, что есть в тексте. Не включай имена, работодателей, места, возраст, здоровье, религию, политику, сексуальность, национальность и семью. Ответь только JSON-массивом.",
};

/** Skill codes found in a text: the taxonomy by phrase, then the model's own phrases (kept as the person's own skills). */
export async function extractSkills(app: App, text: string, lang: "en" | "ru"): Promise<string[]> {
  const clean = redact(text).slice(0, MAX_TEXT);
  const found: string[] = matchSkills(clean, 15).filter((c) => !isPrivateTrait(c));
  if (aiEnabled(app)) {
    try {
      const out = await generate(app, [{ role: "system", content: PROMPT[lang] }, { role: "user", content: clean }], `bio\n${clean}`, lang);
      const arr = out ? (JSON.parse(/\[[\s\S]*\]/.exec(out)?.[0] ?? "[]") as unknown) : [];
      for (const s of Array.isArray(arr) ? arr.slice(0, 10) : []) {
        if (typeof s !== "string" || s.length < 2 || s.length > 40 || isPrivateTrait(s)) continue;
        const code = resolveSkill(s) ?? customCode(s);
        if (code && !found.includes(code)) found.push(code);
      }
    } catch (e) {
      console.warn("bio ai failed", String(e));
    }
  }
  return found;
}

export type BioResult = { status: "ok"; added: string[]; known: number } | { status: "none" | "short" | "bad_url" | "blocked" | "failed" | "empty" };

/** Read a link or text, add what it shows to the person's skills, and keep nothing else. */
export async function applyBio(app: App, mem: Member, input: string, via: "bot" | "app"): Promise<BioResult> {
  const lang = langOf(mem);
  const link = lonelyUrl(input);
  let text = input.trim();
  if (link) {
    const page = await fetchPage(app, link);
    if (!page.ok) return { status: page.reason };
    text = page.text;
  } else if (text.length < MIN_TEXT) return { status: "short" };
  const codes = await extractSkills(app, text, lang);
  if (!codes.length) return { status: "none" };
  const db = app.db;
  const have = new Set((await db.prepare("SELECT code FROM skills WHERE member_id=? AND state='confirmed'").bind(mem.id).all<{ code: string }>()).results.map((r) => r.code));
  const dismissed = new Set((await db.prepare("SELECT code FROM skill_dismissed WHERE member_id=?").bind(mem.id).all<{ code: string }>()).results.map((r) => r.code));
  let customs = [...have].filter((c) => c.startsWith(CUSTOM_PREFIX)).length;
  const added: string[] = [];
  let known = 0;
  for (const code of codes) {
    if (have.has(code)) {
      known++;
      continue;
    }
    if (dismissed.has(code) || added.length >= MAX_NEW) continue;
    if (code.startsWith(CUSTOM_PREFIX) && customs >= CUSTOM_MAX) continue;
    await db.prepare("INSERT INTO skills(member_id, code, state, kind) VALUES (?,?,'confirmed','self_claim') ON CONFLICT(member_id, code) DO UPDATE SET state='confirmed'").bind(mem.id, code).run();
    if (code.startsWith(CUSTOM_PREFIX)) customs++;
    added.push(skillName(code, lang));
  }
  await audit(db, "skills.bio", mem.id, null, { via, source: link ? "link" : "text", added: added.length });
  return added.length || known ? { status: "ok", added, known } : { status: "none" };
}
