// Standalone Telegram chat exporter. Built into public/export/export.js and loaded by /export.
// Authentication and history stay in this tab's memory. Nothing is sent to Telepathy's database;
// only the explicit tmpfiles action sends the finished ZIP anywhere other than Telegram.

import { Long, MemoryStorage, Message as TelegramMessage, PeersIndex, TelegramClient, tl } from "@mtcute/web";
import { makeArchive, makeLeanArchive, makeZip, safeFileName, uploadTmpfiles, type ChatArchive, type ExportChat, type ExportMessage, type LeanChatArchive, type LeanExportMessage, type TmpfilesResult } from "./archive";
import { exportLeanMessage, exportMessage } from "./messages";
import { normalizeLimit, selectMessage } from "./selection";
import { readHistoryPages, retryTelegramRead, TelegramReadRetryError, type ReadWait } from "./resilience";

export { uploadTmpfiles } from "./archive";
export { deleteRecovery, loadRecovery, saveRecovery } from "./recovery";
export type { ChatArchive, ExportChat, TmpfilesResult } from "./archive";

export class ExportError extends Error {}
const why = (e: unknown) => (tl.RpcError.is(e) ? e.text : String((e as Error)?.message ?? e));

export interface ExportResult {
  archive: ChatArchive | LeanChatArchive;
  blob: Blob;
  fileName: string;
  bytes: number;
  stopped: boolean;
  /** True when retries were exhausted and the archive contains only messages read so far. */
  interrupted: boolean;
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
    progress: (count: number, latest: string | null, total?: number, wait?: ReadWait | null) => void,
    signal: AbortSignal,
    options: ExportOptions = {},
  ): Promise<ExportResult> {
    if (!signedIn) throw new ExportError("NOT_SIGNED_IN");
    if (chat.protected) throw new ExportError("PROTECTED_CHAT");
    const limit = normalizeLimit(options.limit);
    const peer = chat.username ? `@${chat.username.replace(/^@/, "")}` : chat.id;
    const messages: (ExportMessage | LeanExportMessage)[] = [];
    const seen = new Set<number>();
    let skippedProtected = 0;
    let total: number | undefined;
    let latest: string | null = null;
    let interrupted = false;
    const retryOptions = {
      signal,
      onWait: (wait: ReadWait | null) => progress(messages.length, latest, total, wait),
    };
    try {
      const inputPeer = await retryTelegramRead(() => tg.resolvePeer(peer), retryOptions);
      total = await readHistoryPages(async (offset) => {
        const res = await tg.call({
          _: "messages.getHistory",
          peer: inputPeer,
          offsetId: offset?.id ?? 0,
          offsetDate: offset?.date ?? 0,
          addOffset: 0,
          limit: 100,
          maxId: 0,
          minId: 0,
          hash: Long.ZERO,
        }, { abortSignal: signal, floodSleepThreshold: 0, maxRetryCount: 0 });
        if (res._ === "messages.messagesNotModified") return { items: [], total: 0 };
        if (!options.from && !options.until && !options.lean) total = "count" in res ? res.count : res.messages.length;
        const peers = PeersIndex.from(res);
        const items = res.messages.filter((raw) => raw._ !== "messageEmpty").map((raw) => new TelegramMessage(raw, peers));
        const last = items[items.length - 1];
        return {
          items,
          total: "count" in res ? res.count : items.length,
          next: last ? { id: last.id, date: last.raw.date } : undefined,
        };
      }, (items) => {
        for (const m of items) {
          if (signal.aborted || (limit !== undefined && messages.length >= limit)) return false;
          // Defensive de-duplication also makes a cursor retry safe if Telegram repeats a boundary.
          if (seen.has(m.id)) continue;
          seen.add(m.id);
          latest = m.date.toISOString();
          const selected = selectMessage(m.date, m.isService, options);
          if (selected === "stop") return false;
          if (selected === "skip") continue;
          // Telegram Desktop excludes copy-protected material. Listed protected chats are rejected
          // above; this per-message check also covers custom input and protected replies/media.
          if (m.isContentProtected) {
            skippedProtected++;
            continue;
          }
          messages.push(options.lean ? exportLeanMessage(m) : exportMessage(m));
          if (messages.length % 25 === 0) progress(messages.length, latest, total);
        }
        return true;
      }, retryOptions);
    } catch (e) {
      if (signal.aborted) {
        // Stop-and-save also cancels an in-progress flood countdown or network backoff.
      } else if (e instanceof TelegramReadRetryError && messages.length) {
        // A dead connection must not discard a large partial export. Clearly label it as partial.
        interrupted = true;
      } else {
        throw new ExportError(why(e));
      }
    }
    if (!options.from && !options.until && !options.lean && total !== undefined) total = Math.min(total, limit ?? Infinity);
    else total = undefined; // Filtered totals would include skipped messages and mislead progress.
    const archive = options.lean ? makeLeanArchive(chat, messages as LeanExportMessage[]) : makeArchive(chat, messages as ExportMessage[], new Date(), skippedProtected);
    progress(messages.length, latest, total, null);
    return { archive, ...makeZip(archive, safeFileName(chat.title)), stopped: signal.aborted || interrupted, interrupted, skippedProtected };
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
