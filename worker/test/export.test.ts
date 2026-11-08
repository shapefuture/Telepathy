import { env } from "cloudflare:test";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { makeArchive, makeLeanArchive, makeZip, safeFileName, uploadTmpfiles, type ExportMessage } from "../export/archive";
import { exportLeanMessage, exportMessage } from "../export/messages";
import { normalizeLimit, selectDate, selectMessage } from "../export/selection";
import type { Message } from "@mtcute/web";
// @ts-expect-error plain JS module shared with the existing Telegram Desktop importer
import { botApiChatId, countMessages } from "../scripts/import-lib.mjs";
import { handleFetch } from "../src/index";
import type { Env } from "../src/env";

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
    expect(html).not.toContain("innerHTML");
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
