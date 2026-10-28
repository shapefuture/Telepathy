// Messages to the people who manage a group (its Telegram admins and the operators), through the
// effect ledger: at most once per key, in each person's own language.

import type { App } from "../bot";
import { chatAdminIds } from "../admins";
import { ownerIds } from "../env";
import { defaultLang, type Lang } from "../i18n";
import { effectStatement, type Payload } from "../outbox";

export async function managersOf(app: App, chatId: number): Promise<number[]> {
  return [...new Set([...ownerIds(app.env), ...(await chatAdminIds(app, chatId))])];
}

export async function notifyStaff(app: App, ids: number[], key: string, build: (lang: Lang) => Payload): Promise<string[]> {
  if (!ids.length) return [];
  const { results } = await app.db
    .prepare("SELECT tg_id, lang FROM members WHERE tg_id IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(ids))
    .all<{ tg_id: number; lang: string | null }>();
  const langs = new Map(results.map((r) => [r.tg_id, r.lang === "en" || r.lang === "ru" ? r.lang : defaultLang()] as const));
  await app.db.batch(ids.map((tg) => effectStatement(app.db, `${key}:${tg}`, tg, build(langs.get(tg) ?? defaultLang()))));
  return ids.map((tg) => `${key}:${tg}`);
}
