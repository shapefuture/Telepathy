// Standalone Telegram chat exporter. Built into public/export/export.js and loaded by /export.
// Authentication and history stay in this tab's memory. Nothing is sent to Telepathy's database;
// only the explicit tmpfiles action sends the finished ZIP anywhere other than Telegram.

import { MemoryStorage, TelegramClient, tl } from "@mtcute/web";
import { makeArchive, makeLeanArchive, makeZip, safeFileName, uploadTmpfiles, type ChatArchive, type ExportChat, type ExportMessage, type LeanChatArchive, type LeanExportMessage, type TmpfilesResult } from "./archive";
import { exportLeanMessage, exportMessage } from "./messages";
import { normalizeLimit, selectMessage } from "./selection";

export { uploadTmpfiles } from "./archive";
export type { ChatArchive, ExportChat, TmpfilesResult } from "./archive";

export class ExportError extends Error {}
const why = (e: unknown) => (tl.RpcError.is(e) ? e.text : String((e as Error)?.message ?? e));

export interface ExportResult {
  archive: ChatArchive | LeanChatArchive;
  blob: Blob;
  fileName: string;
  bytes: number;
  stopped: boolean;
  skippedProtected: number;
}

export interface ExportOptions {
  /** Inclusive lower date bound; reading stops when older messages are reached. */
  from?: Date;
  /** Exclusive upper date bound. */
  until?: Date;
  /** Maximum exported messages, after filtering. Zero/undefined means all. */
  limit?: number;
  /** Exclude service events and emit only text, datetime, author and reply/forward references. */
  lean?: boolean;
}

export function createExporter(apiId: number, apiHash: string) {
  const tg = new TelegramClient({ apiId, apiHash, storage: new MemoryStorage(), disableUpdates: true });
  let phone = "";
  let codeHash = "";
  let signedIn = false;

  async function sendCode(number: string): Promise<void> {
    phone = number.replace(/[^\d+]/g, "");
    try {
      const sent = await tg.sendCode({ phone });
      if ("phoneCodeHash" in sent) codeHash = sent.phoneCodeHash;
      else signedIn = true;
    } catch (e) {
      throw new ExportError(why(e));
    }
  }

  async function signIn(code: string): Promise<"ok" | "password"> {
    try {
      await tg.signIn({ phone, phoneCodeHash: codeHash, phoneCode: code.replace(/\D/g, "") });
      signedIn = true;
      return "ok";
    } catch (e) {
      if (tl.RpcError.is(e, "SESSION_PASSWORD_NEEDED")) return "password";
      throw new ExportError(why(e));
    }
  }

  async function password(pw: string): Promise<void> {
    try {
      await tg.checkPassword(pw);
      signedIn = true;
    } catch (e) {
      throw new ExportError(why(e));
    }
  }

  async function groups(): Promise<ExportChat[]> {
    if (!signedIn) throw new ExportError("NOT_SIGNED_IN");
    const found = new Map<number, ExportChat>();
    try {
      for await (const dialog of tg.iterDialogs({ archived: "keep" })) {
        const p = dialog.peer;
        if (p.type !== "chat" || (p.chatType !== "group" && p.chatType !== "supergroup" && p.chatType !== "gigagroup" && p.chatType !== "channel")) continue;
        found.set(p.id, {
          id: p.id,
          title: p.displayName,
          type: p.chatType === "gigagroup" ? "supergroup" : p.chatType,
          ...("username" in p && p.username ? { username: p.username } : {}),
          ...("noForwards" in p.raw && p.raw.noForwards ? { protected: true } : {}),
        });
      }
    } catch (e) {
      throw new ExportError(why(e));
    }
    return [...found.values()].sort((a, b) => a.title.localeCompare(b.title));
  }

  /** Accept a listed chat, or a public @username / Bot-API-style numeric chat id. */
  async function exportChat(
    chat: ExportChat,
    progress: (count: number, latest: string | null, total?: number) => void,
    signal: AbortSignal,
    options: ExportOptions = {},
  ): Promise<ExportResult> {
    if (!signedIn) throw new ExportError("NOT_SIGNED_IN");
    if (chat.protected) throw new ExportError("PROTECTED_CHAT");
    const limit = normalizeLimit(options.limit);
    const peer = chat.username ? `@${chat.username.replace(/^@/, "")}` : chat.id;
    const messages: (ExportMessage | LeanExportMessage)[] = [];
    let skippedProtected = 0;
    let total: number | undefined;
    try {
      // Best-effort count for determinate progress, matching Toolset's behavior. Date-filtered and
      // lean selections leave it unknown: service events would make their percentage misleading.
      if (!options.from && !options.until && !options.lean) total = Math.min((await tg.getHistory(peer, { limit: 1 })).total, limit ?? Infinity);
      // iterHistory follows Telegram's pagination for basic groups, supergroups and channels.
      // It is intentionally sequential: large exports should not trigger flood limits.
      for await (const m of tg.iterHistory(peer, { chunkSize: 100 })) {
        if (signal.aborted || (limit !== undefined && messages.length >= limit)) break;
        const selected = selectMessage(m.date, m.isService, options);
        if (selected === "stop") break;
        if (selected === "skip") continue;
        // Telegram Desktop excludes copy-protected material. Listed protected chats are rejected
        // above; this per-message check also covers custom chat input and protected replies/media.
        if (m.isContentProtected) {
          skippedProtected++;
          continue;
        }
        messages.push(options.lean ? exportLeanMessage(m) : exportMessage(m));
        if (messages.length % 25 === 0) progress(messages.length, m.date.toISOString(), total);
      }
    } catch (e) {
      if (!signal.aborted) throw new ExportError(why(e));
    }
    const archive = options.lean ? makeLeanArchive(chat, messages as LeanExportMessage[]) : makeArchive(chat, messages as ExportMessage[], new Date(), skippedProtected);
    progress(messages.length, messages[0]?.date ?? null, total);
    return { archive, ...makeZip(archive, safeFileName(chat.title)), stopped: signal.aborted, skippedProtected };
  }

  async function close(): Promise<void> {
    try {
      if (signedIn) await tg.logOut();
    } catch {
      // Offline logout can be completed in Telegram Settings → Devices.
    }
    signedIn = false;
    await tg.destroy().catch(() => {});
  }

  return { sendCode, signIn, password, groups, exportChat, uploadTmpfiles, close, get signedIn() { return signedIn; } };
}
