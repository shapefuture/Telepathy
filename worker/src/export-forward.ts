// Forwarded-message entry into the standalone exporter. Telegram's MessageOrigin tells the bot
// where a forward came from even when the bot is not a member of that chat. Only the forward routing
// metadata (chat id/title) is used; message content is neither ingested nor sent to any AI service.

import type { App } from "./bot";
import type { TgMessage } from "./ingest";
import { escapeHtml } from "./text";

export interface ForwardedChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
}

/** Current Bot API MessageOrigin first, legacy forward_from_chat as a compatibility fallback. */
export function forwardedChat(msg: TgMessage): ForwardedChat | null {
  const origin = msg.forward_origin;
  const chat = origin?.type === "channel" ? origin.chat : origin?.type === "chat" ? origin.sender_chat : msg.forward_from_chat;
  if (!chat || !Number.isSafeInteger(chat.id) || !["group", "supergroup", "channel"].includes(chat.type)) return null;
  return chat;
}

/** Handles a group/channel forward in the bot DM. Returns false for other messages. */
export async function offerForwardedExport(app: App, msg: TgMessage): Promise<boolean> {
  const chat = forwardedChat(msg);
  if (!chat) return false;
  const origin = (app.env.PUBLIC_URL ?? "").replace(/\/$/, "");
  const title = chat.title ?? chat.username ?? String(chat.id);
  const text = `Export history from <b>${escapeHtml(title)}</b>?\n\nChat ID <code>${chat.id}</code> was read from the forwarded message. The bot did not join or read this chat.`;
  const buttons = origin ? [[{ text: "Open chat exporter", web_app: { url: `${origin}/export?start=chat_${chat.id}` } }]] : undefined;
  await app.tg.sendMessage(msg.chat.id, text, { buttons, replyTo: msg.message_id });
  return true;
}
