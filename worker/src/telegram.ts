// Minimal Bot API client. No SDK: smaller bundle and less CPU per request.

export class DefiniteFailure extends Error {} // provider definitely did not deliver (400/403)
export class RetryLater extends Error {} // definitely not delivered yet (429)

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export interface InlineButton {
  text: string;
  callback_data: string;
}

export interface Telegram {
  call<T = unknown>(method: string, params: Record<string, unknown>): Promise<T>;
  sendMessage(
    chatId: number,
    text: string,
    opts?: { buttons?: InlineButton[][]; replyTo?: number },
  ): Promise<{ message_id: number }>;
  /** Send a small generated file (e.g. an .ics calendar) as a document. */
  sendFile(chatId: number, fileName: string, content: string, mime: string, caption?: string): Promise<{ message_id: number }>;
  /** Download a file as UTF-8 text, refusing anything larger than maxBytes. */
  fileText(fileId: string, maxBytes: number): Promise<string>;
  /** Number of outbound calls made by this instance (Workers cap subrequests). */
  readonly calls: number;
}

export function createTelegram(token: string, fetcher: Fetcher = fetch): Telegram {
  let calls = 0;
  async function call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    calls += 1;
    const res = await fetcher(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    let data: {
      ok?: boolean;
      result?: T;
      error_code?: number;
      description?: string;
      parameters?: { retry_after?: number };
    };
    try {
      data = await res.json();
    } catch {
      throw new Error(`telegram ${method}: HTTP ${res.status} with non-JSON body`);
    }
    if (data.ok) return data.result as T;
    const code = data.error_code ?? res.status;
    const msg = `telegram ${method}: ${code} ${data.description ?? ""}`.trim();
    if (code === 429) throw new RetryLater(`${msg} retry_after=${data.parameters?.retry_after ?? "?"}`);
    if (code === 400 || code === 403) throw new DefiniteFailure(msg);
    throw new Error(msg); // 5xx etc: outcome unknown
  }
  return {
    call,
    sendMessage(chatId, text, opts = {}) {
      const params: Record<string, unknown> = {
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      };
      if (opts.buttons) params.reply_markup = { inline_keyboard: opts.buttons };
      if (opts.replyTo) params.reply_parameters = { message_id: opts.replyTo, allow_sending_without_reply: true };
      return call("sendMessage", params);
    },
    async sendFile(chatId, fileName, content, mime, caption) {
      calls += 1;
      const form = new FormData();
      form.set("chat_id", String(chatId));
      if (caption) {
        form.set("caption", caption);
        form.set("parse_mode", "HTML");
      }
      form.set("document", new Blob([content], { type: mime }), fileName);
      const res = await fetcher(`https://api.telegram.org/bot${token}/sendDocument`, { method: "POST", body: form });
      const data = (await res.json()) as { ok?: boolean; result?: { message_id: number }; error_code?: number; description?: string };
      if (data.ok && data.result) return data.result;
      const code = data.error_code ?? res.status;
      if (code === 400 || code === 403) throw new DefiniteFailure(`telegram sendDocument: ${code} ${data.description ?? ""}`);
      throw new Error(`telegram sendDocument: ${code}`);
    },
    async fileText(fileId, maxBytes) {
      const f = await call<{ file_path?: string; file_size?: number }>("getFile", { file_id: fileId });
      if (!f.file_path || (f.file_size ?? 0) > maxBytes) throw new DefiniteFailure("file too large or unavailable");
      calls += 1;
      const res = await fetcher(`https://api.telegram.org/file/bot${token}/${f.file_path}`, { method: "GET" });
      if (!res.ok) throw new Error(`file download: HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      if (buf.byteLength > maxBytes) throw new DefiniteFailure("file too large");
      return new TextDecoder("utf-8").decode(buf);
    },
    get calls() {
      return calls;
    },
  };
}
