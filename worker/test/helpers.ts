import { env } from "cloudflare:test";
import type { App, Update } from "../src/bot";
import { handleUpdate } from "../src/bot";
import { handleFetch, makeApp } from "../src/index";
import { dispatchPending } from "../src/outbox";
import type { Fetcher } from "../src/telegram";

export const OWNER = 1000;
export const GROUP = -1001234;

export interface Call {
  method: string;
  params: Record<string, any>;
}

/** Fake Bot API. `fail` lets a test make a method throw like the network or Telegram would. */
export function fakeTelegram(opts: { admins?: number[]; files?: Record<string, string>; fail?: Record<string, "network" | 403 | 429> } = {}) {
  const calls: Call[] = [];
  let nextId = 1;
  const admins = new Set(opts.admins ?? [OWNER]);
  const fetcher: Fetcher = async (url, init) => {
    if (url.includes("/file/bot")) {
      const path = url.split("/").pop()!;
      return new Response(opts.files?.[path] ?? "", { status: 200 });
    }
    const method = url.split("/").pop()!;
    const params = JSON.parse(String(init.body ?? "{}"));
    calls.push({ method, params });
    const f = opts.fail?.[method];
    if (f === "network") throw new TypeError("network connection lost");
    if (f === 403) return Response.json({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" });
    if (f === 429) return Response.json({ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 3 } });
    const result = (() => {
      switch (method) {
        case "sendMessage":
          return { message_id: nextId++, chat: { id: params.chat_id }, date: 0, text: params.text };
        case "getChatMember":
          return { status: admins.has(params.user_id) ? "administrator" : "member", user: { id: params.user_id } };
        case "getChat":
          return { id: params.chat_id, first_name: "Expert", username: "expert_user" };
        case "getFile":
          return { file_id: params.file_id, file_path: params.file_id, file_size: (opts.files?.[params.file_id] ?? "").length };
        default:
          return true;
      }
    })();
    return Response.json({ ok: true, result });
  };
  return { fetcher, calls, sent: (chatId?: number) => calls.filter((c) => c.method === "sendMessage" && (chatId === undefined || c.params.chat_id === chatId)) };
}

export function testApp(opts?: Parameters<typeof fakeTelegram>[0]) {
  const t = fakeTelegram(opts);
  const app: App = makeApp(env, t.fetcher);
  return { app, ...t, texts: (chatId?: number) => t.sent(chatId).map((c) => c.params.text as string) };
}

/** Run an update the way the webhook does: handle, then dispatch the effects it produced. */
export async function feed(app: App, update: Omit<Update, "update_id">): Promise<void> {
  const keys = await handleUpdate(app, { update_id: nextUpdate(), ...update } as Update);
  if (keys.length) await dispatchPending(app.db, app.tg, 40, keys);
}

let upd = 1;
let msgId = 100;
export const nextUpdate = () => upd++;
export const nextMsg = () => msgId++;

const nowUnix = () => Math.floor(Date.now() / 1000);

export function groupMsg(user: number, text: string, extra: Record<string, unknown> = {}) {
  return {
    message: {
      message_id: nextMsg(),
      date: nowUnix(),
      chat: { id: GROUP, type: "supergroup", title: "G" },
      from: { id: user, is_bot: false },
      text,
      ...extra,
    },
  };
}

export function groupCmd(user: number, text: string, extra: Record<string, unknown> = {}) {
  const u = groupMsg(user, text, extra);
  (u.message as any).entities = [{ type: "bot_command", offset: 0, length: text.split(/\s/)[0]!.length }];
  return u;
}

export function dm(user: number, text: string, languageCode?: string) {
  return {
    message: {
      message_id: nextMsg(),
      date: nowUnix(),
      chat: { id: user, type: "private" },
      from: { id: user, is_bot: false, ...(languageCode ? { language_code: languageCode } : {}) },
      text,
      entities: text.startsWith("/") ? [{ type: "bot_command", offset: 0, length: text.split(/\s/)[0]!.length }] : [],
    },
  };
}

export function press(user: number, data: string) {
  return { callback_query: { id: String(nextUpdate()), from: { id: user, is_bot: false }, data, message: { message_id: 1, chat: { id: user } } } };
}

export async function webhook(body: unknown, secret = "test-webhook-secret", fetcher?: Fetcher) {
  return handleFetch(
    new Request("https://bot.example/telegram", {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": secret, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
    fetcher,
  );
}

/** Owner enables the test group. */
export async function enableGroup(app: App, visibility = "") {
  await feed(app, groupCmd(OWNER, `/enable ${visibility}`.trim()));
}
