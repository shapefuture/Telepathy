// Messages to operators and members go through the effect ledger (at-most-once, reconcilable).

import type { App } from "../bot";
import { ownerIds } from "../env";
import { effectStatement } from "../outbox";
import type { InlineButton } from "../telegram";
import { A, type AssistMessages } from "./i18n";
import { defaultLang } from "../i18n";

export const b = (text: string, data: string): InlineButton => ({ text, callback_data: data });

type Build = (a: AssistMessages) => { text: string; buttons?: InlineButton[][] };

/** One message per Telegram id, in each one's language. Returns effect keys. */
export async function notifyIds(app: App, ids: number[], key: string, build: Build): Promise<string[]> {
  if (!ids.length) return [];
  const { results } = await app.db.prepare("SELECT tg_id, lang FROM members WHERE tg_id IN (SELECT value FROM json_each(?))").bind(JSON.stringify(ids)).all<{ tg_id: number; lang: string | null }>();
  const langs = new Map(results.map((r) => [r.tg_id, r.lang === "en" || r.lang === "ru" ? r.lang : defaultLang()] as const));
  await app.db.batch(ids.map((tg) => effectStatement(app.db, `${key}:${tg}`, tg, build(A(langs.get(tg) ?? defaultLang())))));
  return ids.map((tg) => `${key}:${tg}`);
}

/** One message per configured owner, in their language. Returns effect keys. */
export const notifyOwners = (app: App, key: string, build: Build) => notifyIds(app, [...ownerIds(app.env)], key, build);

export async function notifyMember(app: App, memberId: string, key: string, build: Build): Promise<string[]> {
  const mem = await app.db.prepare("SELECT tg_id, lang FROM members WHERE id=? AND removed_at IS NULL").bind(memberId).first<{ tg_id: number; lang: string | null }>();
  if (!mem) return [];
  await effectStatement(app.db, key, mem.tg_id, build(A(mem.lang === "ru" ? "ru" : "en"))).run();
  return [key];
}
