// /concierge for the operator (OWNER_IDS): the replay report, starting a replay, and reviewing its
// cases one at a time on a single card edited in place. Only groups the operator can read count.

import type { App } from "../bot";
import { ensureMember, langOf, readable, type Member } from "../acl";
import type { InlineButton } from "../telegram";
import { escapeHtml, snippet } from "../text";
import { conciergeModel } from "./agent";
import { nextForReview, queued, queueRun, report, reportView, review, reviewView, C } from "./replay";

export const RUN_SIZE = 20;

const sourcesOf = async (app: App, owner: Member) => [...(await readable(app.db, owner))].sort();
const snip = (s: string) => snippet(s, [], 280);

async function reportCard(app: App, owner: Member) {
  const sources = await sourcesOf(app, owner);
  const q = await queued(app.db);
  return reportView(await report(app.db, sources), langOf(owner), app.env.CONCIERGE_AUTONOMY, q?.left ?? null, !!conciergeModel(app));
}

async function start(app: App, owner: Member, tgId: number, n: number): Promise<string> {
  const m = C(langOf(owner));
  const sources = await sourcesOf(app, owner);
  if (!sources.length) return m.noGroups;
  const q = await queued(app.db);
  if (q) return m.running(q.left);
  return m.queued(await queueRun(app.db, sources, n, tgId, langOf(owner)));
}

/** `/concierge` shows the report; `/concierge run [N]` queues a replay of up to N past requests. */
export async function conciergeCommand(app: App, chat: number, tgId: number, args: string, langCode?: string): Promise<string[]> {
  const owner = await ensureMember(app.db, tgId, "owner", langCode);
  const [sub, n] = args.trim().split(/\s+/);
  if (sub === "run") {
    await app.tg.sendMessage(chat, await start(app, owner, tgId, Number(n) || RUN_SIZE));
    return [];
  }
  const card = await reportCard(app, owner);
  await app.tg.sendMessage(chat, card.text, { buttons: card.buttons });
  return [];
}

interface Cb {
  id: string;
  from: { id: number; language_code?: string };
  message?: { message_id: number; chat: { id: number } };
}

/** Buttons `cg:*`. The caller has already checked the presser is an operator. */
export async function conciergeCallback(app: App, cb: Cb, data: string): Promise<string[]> {
  const [, what = "", id = ""] = data.split(":");
  const owner = await ensureMember(app.db, cb.from.id, "owner", cb.from.language_code);
  const lang = langOf(owner);
  const answer = (text = "") => app.tg.call("answerCallbackQuery", { callback_query_id: cb.id, text: text.slice(0, 190) });
  const show = async (v: { text: string; buttons: InlineButton[][] }) => {
    if (!cb.message) return;
    await app.tg
      .call("editMessageText", { chat_id: cb.message.chat.id, message_id: cb.message.message_id, text: v.text, parse_mode: "HTML", reply_markup: { inline_keyboard: v.buttons } })
      .catch(() => app.tg.sendMessage(cb.message!.chat.id, v.text, { buttons: v.buttons }));
  };
  const sources = await sourcesOf(app, owner);
  if (what === "run") {
    await answer(await start(app, owner, cb.from.id, RUN_SIZE));
    await show(await reportCard(app, owner));
    return [];
  }
  if (what === "ok" || what === "bad" || what === "skip") {
    await review(app.db, Number(id), what === "ok" ? "good" : what, sources);
    await answer();
    await show(reviewView(await nextForReview(app.db, sources), lang, escapeHtml, snip));
    return [];
  }
  await answer();
  if (what === "rev") await show(reviewView(await nextForReview(app.db, sources), lang, escapeHtml, snip));
  else await show(await reportCard(app, owner));
  return [];
}
