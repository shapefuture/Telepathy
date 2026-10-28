// ⚙️ Settings for a group (plan: step 1, one card of toggles in plain language). Admins of the
// group open it with /settings and tap to change; the card is edited in place. It replaces
// remembering /hints on, /routing on, /welcome on.

import type { App } from "./bot";
import { T, type Lang } from "./i18n";
import { audit } from "./util";
import { btn } from "./thread-card";
import { T2 } from "./concierge/texts";
import type { InlineButton } from "./telegram";

/** The toggles a group admin can change from the card. Column names are fixed, never from input. */
export const SETTING_COLUMNS = ["hints", "routing", "welcome", "screen", "spam_guard", "doors"] as const;
export type SettingColumn = (typeof SETTING_COLUMNS)[number];

export async function settingsView(db: D1Database, chatId: number, lang: Lang): Promise<{ text: string; buttons: InlineButton[][] } | null> {
  const src = await db
    .prepare("SELECT hints, routing, welcome, screen, spam_guard, doors, retention_days FROM sources WHERE chat_id=? AND enabled=1")
    .bind(chatId)
    .first<{ hints: number; routing: number; welcome: number; screen: number; spam_guard: number; doors: number; retention_days: number }>();
  if (!src) return null;
  const m = T(lang);
  const mark = (v: number) => (v ? "✅" : "⬜");
  const rows: [SettingColumn, string][] = [
    ["hints", m.setHints],
    ["routing", m.setRouting],
    ["welcome", m.setWelcome],
    ["screen", T2(lang).settingScreen],
    ["spam_guard", T2(lang).settingSpam],
    ["doors", T2(lang).settingDoors],
  ];
  const text = [`<b>${m.settingsTitle}</b>`, "", m.setRetention(src.retention_days)].join("\n");
  const buttons: InlineButton[][] = rows.map(([col, label]) => [btn(`${mark(src[col])} ${label}`, `st:${col}:${src[col] ? 0 : 1}`)]);
  return { text, buttons };
}

/** Button press: flip one setting and redraw the card. Returns the redrawn card, if the group is still connected. */
export async function toggleSetting(app: App, chatId: number, col: SettingColumn, on: boolean, byTg: number, lang: Lang) {
  await app.db.prepare(`UPDATE sources SET ${col}=? WHERE chat_id=? AND enabled=1`).bind(on ? 1 : 0, chatId).run();
  await audit(app.db, `source.${col}`, String(byTg), String(chatId), { on });
  return settingsView(app.db, chatId, lang);
}
