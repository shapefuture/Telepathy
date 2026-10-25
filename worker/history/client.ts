// Browser side of the history import (Mini App → Desk → History). Built by scripts/build-history.mjs
// into public/history/history.js and loaded only when an owner opens that screen.
//
// The owner signs in to their own Telegram account here, over Telegram's own WebSocket endpoints
// (*.web.telegram.org). The login lives only in this tab's memory: it is never stored, never sent
// to the Worker, and is ended with auth.logOut when the import stops. The Worker only receives the
// group's messages, page by page, through the same signed Mini App API as everything else.
// Reading takes seconds: supergroup pages are fetched 6 at a time, and the Worker stores them later.

import { Long, MemoryStorage, TelegramClient, tl } from "@mtcute/web";
import { PAGE, readAll, type Outcome, type Source, type Stage, type StageResult } from "./read";

export type { Outcome, Stage, StageResult } from "./read";

export class SignInError extends Error {}

export function createImporter(apiId: number, apiHash: string) {
  const tg = new TelegramClient({ apiId, apiHash, storage: new MemoryStorage(), disableUpdates: true });
  let phone = "";
  let codeHash = "";
  let signedIn = false;

  const why = (e: unknown) => (tl.RpcError.is(e) ? e.text : String((e as Error)?.message ?? e));

  async function sendCode(number: string): Promise<void> {
    phone = number.replace(/[^\d+]/g, "");
    try {
      const sent = await tg.sendCode({ phone });
      if ("phoneCodeHash" in sent) codeHash = sent.phoneCodeHash;
      else signedIn = true;
    } catch (e) {
      throw new SignInError(why(e));
    }
  }

  /** "ok" when signed in, "password" when two-step verification is on. */
  async function signIn(code: string): Promise<"ok" | "password"> {
    try {
      await tg.signIn({ phone, phoneCodeHash: codeHash, phoneCode: code.replace(/\D/g, "") });
      signedIn = true;
      return "ok";
    } catch (e) {
      if (tl.RpcError.is(e, "SESSION_PASSWORD_NEEDED")) return "password";
      throw new SignInError(why(e));
    }
  }

  async function password(pw: string): Promise<void> {
    try {
      await tg.checkPassword(pw);
      signedIn = true;
    } catch (e) {
      throw new SignInError(why(e));
    }
  }

  /** Bot API chat ids (-100…) are mtcute's "marked" ids; an unseen chat needs one dialogs pass. */
  async function peerOf(chatId: number): Promise<tl.TypeInputPeer> {
    try {
      return await tg.resolvePeer(chatId);
    } catch {
      for await (const d of tg.iterDialogs({ archived: "keep" })) if (d.peer.id === chatId) break;
      return tg.resolvePeer(chatId);
    }
  }

  /** Read the whole chat and park it on the Worker (see read.ts); `read` = pages parked before. */
  async function run(
    chatId: number,
    read: number[],
    keepFrom: number,
    stage: (p: Stage) => Promise<StageResult>,
    progress: (done: number, total: number) => void,
    signal: AbortSignal,
  ): Promise<Outcome> {
    if (!signedIn) throw new SignInError("not signed in");
    const peer = await peerOf(chatId);
    // Telegram's FLOOD_WAIT (up to 5 minutes) is waited out rather than failing the import.
    const opts = { floodSleepThreshold: 300_000, abortSignal: signal };
    const history = (offsetId: number) =>
      tg.call({ _: "messages.getHistory", peer, offsetId, offsetDate: 0, addOffset: 0, limit: PAGE, maxId: 0, minId: 0, hash: Long.ZERO }, opts);
    const src: Source =
      peer._ === "inputPeerChannel"
        ? {
            kind: "ids",
            newest: async () => {
              const r = await history(0);
              return r._ === "messages.messagesNotModified" ? 0 : Math.max(0, ...r.messages.map((m) => m.id));
            },
            byIds: (ids) =>
              tg.call({ _: "channels.getMessages", channel: { _: "inputChannel", channelId: peer.channelId, accessHash: peer.accessHash }, id: ids.map((id) => ({ _: "inputMessageID", id })) }, opts),
            history,
          }
        : { kind: "seq", newest: async () => 0, byIds: () => Promise.reject(new Error("unused")), history };
    return readAll({ chatId, keepFrom, read, src, stage, progress, signal });
  }

  /** Ends the Telegram session we created (it disappears from Settings → Devices) and disconnects. */
  async function close(): Promise<void> {
    try {
      if (signedIn) await tg.logOut();
    } catch {
      // already gone, or offline: the owner can end it in Settings → Devices
    }
    signedIn = false;
    await tg.destroy().catch(() => {});
  }

  return { sendCode, signIn, password, run, close, get signedIn() { return signedIn; } };
}
