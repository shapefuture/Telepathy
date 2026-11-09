import { env } from "cloudflare:test";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { makeArchive, makeLeanArchive, makeZip, safeFileName, uploadTmpfiles, type ExportMessage } from "../export/archive";
import { exportLeanMessage, exportMessage } from "../export/messages";
import { normalizeLimit, selectDate, selectMessage } from "../export/selection";
import type { Message } from "@mtcute/web";
// @ts-expect-error plain JS module shared with the existing Telegram Desktop importer
import { botApiChatId, countMessages } from "../scripts/import-lib.mjs";
import { handleFetch } from "../src/index";
import type { Env } from "../src/env";
import { forwardedChat, offerForwardedExport } from "../src/export-forward";
import type { App } from "../src/bot";
import type { TgMessage } from "../src/ingest";
import { floodWaitSeconds, readHistoryPages, retryTelegramRead, TelegramReadRetryError } from "../export/resilience";

const message = (id: number): ExportMessage => ({
  id,
  type: "message",
  date: `2026-01-0${id}T00:00:00.000Z`,
  date_unixtime: String(1767225600 + id * 86400),
  edit_date: null,
  text: `message ${id}`,
  text_entities: [{ type: "plain", text: `message ${id}` }],
  sender: { id: 7, type: "user", name: "Alice" },
  outgoing: false,
  reply_to_message_id: null,
  topic_id: null,
  service: null,
  media: null,
  entities: [],
});

async function initData(id: number) {
  const enc = new TextEncoder();
  const key = async (k: BufferSource) => crypto.subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const fields = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id }) };
  const secret = await crypto.subtle.sign("HMAC", await key(enc.encode("WebAppData")), enc.encode("123456:TEST"));
  const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k as keyof typeof fields]}`).join("\n");
  const hash = [...new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret), enc.encode(check)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return new URLSearchParams({ ...fields, hash }).toString();
}

describe("resumable Telegram history reads", () => {
  it("honors a flood countdown and retries the same cursor without losing or duplicating messages", async () => {
    const offsets: unknown[] = [];
    const waits: number[] = [];
    const consumed: number[] = [];
    let calls = 0;
    const total = await readHistoryPages(async (offset) => {
      offsets.push(offset);
      if (++calls === 1) throw Object.assign(new Error("420 FLOOD_WAIT_3"), { code: 420 });
      return offset
        ? { items: [1] }
        : { items: [3, 2], next: { id: 2, date: 20 }, total: 3 };
    }, (items) => { consumed.push(...items); }, {
      signal: new AbortController().signal,
      sleep: async () => {},
      onWait: (wait) => { if (wait) waits.push(wait.remaining); },
    });
    expect(total).toBe(3);
    expect(offsets).toEqual([undefined, undefined, { id: 2, date: 20 }]);
    expect(consumed).toEqual([3, 2, 1]);
    expect(waits).toEqual([3, 2, 1]);
  });

  it("uses bounded exponential backoff only for transient failures", async () => {
    const delays: number[] = [];
    const backoffs: number[] = [];
    let previousAttempt = 0;
    let calls = 0;
    await expect(retryTelegramRead(async () => {
      calls++;
      throw new TypeError("network connection lost");
    }, {
      signal: new AbortController().signal,
      sleep: async (ms) => { delays.push(ms); },
      onWait: (wait) => {
        if (wait && wait.attempt !== previousAttempt) {
          previousAttempt = wait.attempt;
          backoffs.push(wait.remaining);
        }
      },
    })).rejects.toBeInstanceOf(TelegramReadRetryError);
    expect(calls).toBe(5);
    expect(backoffs).toEqual([1, 2, 4, 8]);
    expect(delays).toEqual(Array(15).fill(1000));
  });

  it("does not retry permanent Telegram errors", async () => {
    let calls = 0;
    await expect(retryTelegramRead(async () => {
      calls++;
      throw Object.assign(new Error("CHANNEL_PRIVATE"), { code: 400 });
    }, { signal: new AbortController().signal, sleep: async () => {} })).rejects.toThrow("CHANNEL_PRIVATE");
    expect(calls).toBe(1);
  });

  it("parses mtcute flood errors and normalizes zero-second waits", () => {
    expect(floodWaitSeconds(Object.assign(new Error("FLOOD_WAIT_22"), { code: 420 }))).toBe(22);
    expect(floodWaitSeconds(Object.assign(new Error("FLOOD_WAIT_0"), { code: 420 }))).toBe(1);
    expect(floodWaitSeconds(new Error("CHANNEL_PRIVATE"))).toBeNull();
  });
});

describe("forwarded chat export shortcut", () => {
  const base = { message_id: 1, chat: { id: 7, type: "private" }, from: { id: 7 }, date: 1 } satisfies TgMessage;
  it("reads current channel/group origins and the legacy fallback", () => {
    expect(forwardedChat({ ...base, forward_origin: { type: "channel", chat: { id: -100123, type: "channel", title: "News" }, message_id: 9 } })).toMatchObject({ id: -100123, title: "News" });
    expect(forwardedChat({ ...base, forward_origin: { type: "chat", sender_chat: { id: -42, type: "group", title: "Club" } } })).toMatchObject({ id: -42, title: "Club" });
    expect(forwardedChat({ ...base, forward_from_chat: { id: -99, type: "supergroup", title: "Legacy" } })).toMatchObject({ id: -99, title: "Legacy" });
    expect(forwardedChat({ ...base, forward_origin: { type: "user" } })).toBeNull();
    expect(forwardedChat(base)).toBeNull();
  });
  it("offers a signed-in-user Mini App button with the chat deep link", async () => {
    const sendMessage = vi.fn().mockResolvedValue({});
    const app = { env: { PUBLIC_URL: "https://telepathy.example" }, tg: { sendMessage } } as unknown as App;
    const msg: TgMessage = { ...base, forward_origin: { type: "channel", chat: { id: -100123, type: "channel", title: "News" }, message_id: 9 } };
    await expect(offerForwardedExport(app, msg)).resolves.toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(7, expect.stringContaining("Chat ID"), {
      buttons: [[{ text: "Open chat exporter", web_app: { url: "https://telepathy.example/export?start=chat_-100123" } }]],
      replyTo: 1,
    });
    await expect(offerForwardedExport(app, base)).resolves.toBe(false);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe("standalone chat archive", () => {
  it("creates a valid ZIP with sorted, documented JSON", async () => {
    const archive = makeArchive({ id: -100123, title: "Club / QA", type: "supergroup" }, [message(2), message(1)], new Date("2026-02-03T04:05:06Z"));
    const zip = makeZip(archive, "club.zip");
    expect(zip.fileName).toBe("club.zip");
    const files = unzipSync(new Uint8Array(await zip.blob.arrayBuffer()));
    const parsed = JSON.parse(strFromU8(files["result.json"]!));
    expect(parsed).toMatchObject({ name: "Club / QA", type: "private_supergroup", id: 123, version: 2 });
    expect(parsed.messages.map((m: ExportMessage) => m.id)).toEqual([1, 2]);
    expect(parsed.message_count).toBe(2);
    expect(botApiChatId(parsed)).toBe(-100123); // directly consumable by the existing Desktop importer
    expect(countMessages(parsed)).toBe(2);
    expect(parsed.includes).toContain("Media files are not downloaded");
    expect(JSON.parse(strFromU8(files["metadata.json"]!)).date_range).toEqual(parsed.date_range);
    expect(strFromU8(files["README.txt"]!)).toContain("Anyone with a tmpfiles link");
    expect(safeFileName("Club / QA")).toMatch(/^telegram-Club-QA-\d{4}-\d{2}-\d{2}\.zip$/);
  });

  it("applies inclusive-from, exclusive-until and positive limit selection rules", () => {
    const options = { from: new Date("2026-01-02T00:00:00Z"), until: new Date("2026-01-05T00:00:00Z") };
    expect(selectDate(new Date("2026-01-05T00:00:00Z"), options)).toBe("skip");
    expect(selectDate(new Date("2026-01-02T00:00:00Z"), options)).toBe("include");
    expect(selectDate(new Date("2026-01-01T23:59:59Z"), options)).toBe("stop");
    expect(normalizeLimit(100)).toBe(100);
    expect(normalizeLimit(0)).toBeUndefined();
    expect(normalizeLimit(1.5)).toBeUndefined();
    expect(selectMessage(new Date("2026-01-03T00:00:00Z"), true, { lean: true })).toBe("skip");
    expect(selectMessage(new Date("2026-01-03T00:00:00Z"), false, { lean: true })).toBe("include");
    expect(selectMessage(new Date("2026-01-03T00:00:00Z"), true, { lean: false })).toBe("include");
  });

  it("serializes useful message metadata without Telegram access hashes", () => {
    const raw = {
      _: "message",
      replyTo: { _: "messageReplyHeader", forumTopic: true, replyToMsgId: 8, replyToTopId: 3 },
      media: {
        _: "messageMediaDocument",
        document: {
          _: "document",
          id: 99,
          accessHash: "must-not-leak",
          mimeType: "text/plain",
          size: { toString: () => "42" },
          attributes: [{ _: "documentAttributeFilename", fileName: "notes.txt" }],
        },
      },
    };
    const fake = {
      id: 9,
      date: new Date("2026-01-02T03:04:05Z"),
      editDate: null,
      text: "hello",
      sender: { id: 7, type: "user", displayName: "Alice", username: "alice" },
      isOutgoing: true,
      raw,
      entities: [{ raw: { _: "messageEntityTextUrl", offset: 0, length: 5, url: "https://example.com" }, text: "hello" }],
    } as unknown as Message;
    const out = exportMessage(fake);
    expect(out).toMatchObject({
      id: 9,
      type: "message",
      date_unixtime: "1767323045",
      from: "Alice",
      from_id: "user7",
      reply_to_message_id: 8,
      topic_id: 3,
      media: { type: "document", file_name: "notes.txt", size: "42" },
      file: "(File not included. Change data exporting settings to download.)",
      mime_type: "text/plain",
      file_size: 42,
    });
    expect(JSON.stringify(out)).not.toContain("must-not-leak");
    expect(out.entities[0]?.url).toBe("https://example.com");
    expect(out.text_entities[0]).toEqual({ type: "text_link", text: "hello", url: "https://example.com" });
  });

  it("lean mode emits only text, datetime, authors and structural references", async () => {
    const fake = {
      id: 12,
      date: new Date("2026-01-02T03:04:05Z"),
      text: "lean hello",
      sender: { id: 7, type: "user", displayName: "Alice", username: "alice" },
      raw: { _: "message", replyTo: { _: "messageReplyHeader", forumTopic: true, replyToMsgId: 8, replyToTopId: 3 } },
      forward: { sender: { displayName: "Original channel" } },
    } as unknown as Message;
    const lean = exportLeanMessage(fake);
    expect(lean).toEqual({
      id: 12,
      date: "2026-01-02T03:04:05.000Z",
      text: "lean hello",
      from: "Alice",
      from_id: "user7",
      from_username: "alice",
      reply_to_message_id: 8,
      forwarded_from: "Original channel",
      topic_id: 3,
    });
    const archive = makeLeanArchive({ id: -100123, title: "Lean club", type: "supergroup" }, [lean]);
    expect(Object.keys(archive)).toEqual(["name", "type", "id", "messages"]);
    const files = unzipSync(new Uint8Array(await makeZip(archive, "lean.zip").blob.arrayBuffer()));
    expect(Object.keys(files)).toEqual(["result.json"]);
    expect(JSON.parse(strFromU8(files["result.json"]!))).toEqual(archive);
  });

  it("uploads the ZIP directly and returns tmpfiles' direct-download URL", async () => {
    let request: RequestInit | undefined;
    const result = await uploadTmpfiles(new Blob(["zip"]), "chat.zip", async (url, init) => {
      expect(url).toBe("https://tmpfiles.org/api/v1/upload");
      request = init;
      return new Response(JSON.stringify({ status: "success", data: { url: "https://tmpfiles.org/12345/chat.zip" } }));
    });
    expect(request?.method).toBe("POST");
    expect(request?.body).toBeInstanceOf(FormData);
    expect(result).toEqual({ pageUrl: "https://tmpfiles.org/12345/chat.zip", downloadUrl: "https://tmpfiles.org/dl/12345/chat.zip" });
  });

  it("rejects misleading or failed upload responses", async () => {
    await expect(uploadTmpfiles(new Blob(["zip"]), "chat.zip", async () => new Response(JSON.stringify({ data: { url: "https://evil.example/chat.zip" } })))).rejects.toThrow("UPLOAD_BAD_RESPONSE");
    await expect(uploadTmpfiles(new Blob(["zip"]), "chat.zip", async () => new Response("no", { status: 503 }))).rejects.toThrow("UPLOAD_HTTP_503");
  });
});

describe("standalone export Mini App", () => {
  it("serves a separate, strict page with explicit public-upload consent", async () => {
    const res = await handleFetch(new Request("https://bot.example/export"), env as unknown as Env);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("https://tmpfiles.org");
    expect(html).toContain('import("/export/export.js")');
    expect(html).toContain("Anyone with the link");
    expect(html).toContain("tg.downloadFile");
    expect(html).toContain("saveRecovery");
    expect(html).toContain("loadRecovery");
    expect(html).toContain("Upload again for a fresh link");
    expect(html).not.toContain("innerHTML");
    const script = html.split("<script>")[1]!.split("</script>")[0]!;
    expect(() => new Function(script)).not.toThrow();
  });

  it("serves the same-origin WebKit blob rescue page without authentication", async () => {
    const res = await handleFetch(new Request("https://telepathy.wmobilas.workers.dev/export/recover"), env as unknown as Env);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("connect-src 'self' blob:");
    expect(html).toContain("blob:https://telepathy.wmobilas.workers.dev/d0723d91-dedc-4989-9e3a-22dddb9448a9");
    expect(html).toContain("23901116");
    expect(html).toContain("saveRecovery");
    expect(html).toContain("uploadTmpfiles");
    expect(html).toContain("statusEl");
    expect(html).not.toContain("var status=");
    const script = html.split("<script>")[1]!.split("</script>")[0]!;
    expect(() => new Function(script)).not.toThrow();
  });

  it("shares configured app keys only with signed Telegram initData, without requiring club membership", async () => {
    const e = { ...env, TG_API_ID: "1234", TG_API_HASH: "test-hash" } as unknown as Env;
    const denied = await handleFetch(new Request("https://bot.example/export/api/config"), e);
    expect(denied.status).toBe(401);
    const allowed = await handleFetch(new Request("https://bot.example/export/api/config", { headers: { "x-telegram-init-data": await initData(998877) } }), e);
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ api: { id: 1234, hash: "test-hash" } });
  });
});
