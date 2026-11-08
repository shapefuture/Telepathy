// Portable JSON/ZIP creation and tmpfiles upload for the standalone exporter. No Telegram SDK
// types cross this boundary, which also makes the archive format straightforward to test.

import { strToU8, zipSync } from "fflate";

export interface ExportChat {
  id: number;
  title: string;
  type: "group" | "supergroup" | "channel";
  username?: string;
  protected?: boolean;
}

export interface ExportTextEntity {
  type: string;
  text: string;
  url?: string;
  language?: string;
}

export interface ExportMessage {
  id: number;
  type: "message" | "service";
  date: string;
  date_unixtime: string;
  edit_date: string | null;
  edited?: string;
  edited_unixtime?: string;
  text: string;
  text_entities: ExportTextEntity[];
  from?: string;
  from_id?: string;
  sender: { id: number; type: string; name: string; username?: string } | null;
  outgoing: boolean;
  reply_to_message_id: number | null;
  forwarded_from?: string;
  topic_id: number | null;
  grouped_id?: string;
  via_bot?: string;
  service: string | null;
  action?: string;
  media: Record<string, unknown> | null;
  entities: { type: string; offset: number; length: number; url?: string }[];
  reactions?: { type: "emoji" | "custom_emoji"; emoji?: string; document_id?: string; count: number }[];
  // Telegram Desktop-compatible media fields (files themselves are deliberately absent).
  photo?: string;
  file?: string;
  media_type?: string;
  mime_type?: string;
  file_name?: string;
  file_size?: number;
  duration_seconds?: number;
  width?: number;
  height?: number;
  sticker_emoji?: string;
  title?: string;
  performer?: string;
  contact_information?: Record<string, unknown>;
  location_information?: Record<string, unknown>;
  poll?: Record<string, unknown>;
}

export interface LeanExportMessage {
  id: number;
  date: string;
  text: string;
  from?: string;
  from_id?: string;
  from_username?: string;
  reply_to_message_id?: number;
  forwarded_from?: string;
  topic_id?: number;
}

export interface LeanChatArchive {
  name: string;
  type: ChatArchive["type"];
  id: number;
  messages: LeanExportMessage[];
}

export interface ChatArchive {
  // Telegram Desktop single-chat export root (https://core.telegram.org/import-export).
  name: string;
  type: "private_group" | "private_supergroup" | "public_supergroup" | "private_channel" | "public_channel";
  id: number;
  // Telepathy additions; unknown root keys are ignored by Telegram Desktop JSON consumers.
  format: "telepathy-chat-export";
  version: 2;
  exported_at: string;
  chat: ExportChat;
  message_count: number;
  skipped_protected_messages: number;
  date_range: { from: string | null; to: string | null };
  includes: string;
  messages: ExportMessage[];
}

function desktopChat(chat: ExportChat): Pick<ChatArchive, "name" | "type" | "id"> {
  const visibility = chat.username ? "public" : "private";
  const officialType = chat.type === "group" ? "private_group" : (`${visibility}_${chat.type}` as ChatArchive["type"]);
  // Telegram Desktop uses bare ids; mtcute uses Bot-API marked ids (-100… for channels).
  const desktopId = chat.type === "group" ? Math.abs(chat.id) : Number(String(Math.abs(chat.id)).replace(/^100/, ""));
  return { name: chat.title, type: officialType, id: desktopId };
}

export function makeLeanArchive(chat: ExportChat, messages: LeanExportMessage[]): LeanChatArchive {
  return { ...desktopChat(chat), messages: [...messages].sort((a, b) => a.id - b.id) };
}

export function makeArchive(chat: ExportChat, messages: ExportMessage[], now = new Date(), skippedProtected = 0): ChatArchive {
  const sorted = [...messages].sort((a, b) => a.id - b.id);
  return {
    ...desktopChat(chat),
    format: "telepathy-chat-export",
    version: 2,
    exported_at: now.toISOString(),
    chat,
    message_count: sorted.length,
    skipped_protected_messages: skippedProtected,
    date_range: { from: sorted[0]?.date ?? null, to: sorted.at(-1)?.date ?? null },
    includes: "Messages, service events and media metadata. Media files are not downloaded.",
    messages: sorted,
  };
}

export function safeFileName(title: string): string {
  const stem = title
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `telegram-${stem || "chat"}-${new Date().toISOString().slice(0, 10)}.zip`;
}

export function makeZip(archive: ChatArchive | LeanChatArchive, fileName = safeFileName(archive.name)): { blob: Blob; fileName: string; bytes: number } {
  const bytes = zipSync(
    {
      "result.json": strToU8(JSON.stringify(archive, null, 2)),
      ...("format" in archive
        ? {
            "metadata.json": strToU8(
              JSON.stringify(
                {
                  format: archive.format,
                  version: archive.version,
                  exported_at: archive.exported_at,
                  message_count: archive.message_count,
                  skipped_protected_messages: archive.skipped_protected_messages,
                  date_range: archive.date_range,
                },
                null,
                2,
              ),
            ),
            "README.txt": strToU8(
              "Telepathy Telegram chat export\n\n" +
                "result.json follows Telegram Desktop's single-chat JSON schema, with additional Telepathy " +
                "fields for forum topics, media metadata and export statistics. Messages are in ascending " +
                "message-id order. Attached photos, videos and documents are not included; their file and " +
                "photo fields contain Telegram's standard not-included placeholder. metadata.json summarizes " +
                "the archive.\n\nAnyone with a tmpfiles link may be able to download this archive. " +
                "Share it carefully and delete it from tmpfiles when it is no longer needed.\n",
            ),
          }
        : {}),
    },
    { level: 6 },
  );
  return { blob: new Blob([bytes.slice().buffer as ArrayBuffer], { type: "application/zip" }), fileName, bytes: bytes.byteLength };
}

export interface TmpfilesResult {
  pageUrl: string;
  downloadUrl: string;
}

/** Upload directly from the browser; chat data never passes through the Telepathy Worker. */
export async function uploadTmpfiles(blob: Blob, fileName: string, fetcher: typeof fetch = fetch): Promise<TmpfilesResult> {
  if (blob.size > 100 * 1024 * 1024) throw new Error("ZIP_TOO_LARGE");
  const form = new FormData();
  form.set("file", blob, fileName);
  let res: Response;
  try {
    res = await fetcher("https://tmpfiles.org/api/v1/upload", { method: "POST", body: form, cache: "no-store" });
  } catch {
    throw new Error("UPLOAD_UNREACHABLE");
  }
  if (!res.ok) throw new Error(`UPLOAD_HTTP_${res.status}`);
  let body: { status?: string; data?: { url?: unknown } };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new Error("UPLOAD_BAD_RESPONSE");
  }
  const raw = typeof body.data?.url === "string" ? body.data.url : "";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("UPLOAD_BAD_RESPONSE");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("UPLOAD_BAD_RESPONSE");
  if (url.hostname !== "tmpfiles.org" && url.hostname !== "www.tmpfiles.org") throw new Error("UPLOAD_BAD_RESPONSE");
  url.protocol = "https:";
  const pageUrl = url.toString();
  url.pathname = `/dl${url.pathname.startsWith("/") ? url.pathname : `/${url.pathname}`}`;
  return { pageUrl, downloadUrl: url.toString() };
}
