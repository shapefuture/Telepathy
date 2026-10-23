// Worker entry: Telegram webhook, operator endpoints, and the cron trigger.

import { handleUpdate, status, type App, type Update } from "./bot";
import { runCron } from "./cron";
import type { Env } from "./env";
import { MAX_CHUNKS, storeChunks } from "./ingest";
import { dispatchPending } from "./outbox";
import { createTelegram, DefiniteFailure, type Fetcher } from "./telegram";
import { nowIso, safeEqual } from "./util";

export const ALLOWED_UPDATES = ["message", "edited_message", "callback_query", "my_chat_member", "chat_member"];

export const COMMANDS = [
  { command: "ask", description: "Search your groups with cited answers" },
  { command: "intro", description: "Request a consent-based introduction" },
  { command: "expert", description: "How many experts match a topic" },
  { command: "requests", description: "Your open introduction requests" },
  { command: "profile", description: "Your profile and settings" },
  { command: "digest", description: "Turn the daily digest on or off" },
  { command: "skills", description: "Manage your skills" },
  { command: "privacy", description: "What is stored and why" },
  { command: "forget_me", description: "Delete your data" },
  { command: "help", description: "All commands" },
];

export function makeApp(env: Env, fetcher?: Fetcher): App {
  return { env, db: env.DB, tg: createTelegram(env.BOT_TOKEN, fetcher) };
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json" } });

function bearerOk(req: Request, env: Env): boolean {
  const h = req.headers.get("authorization") ?? "";
  return !!env.ADMIN_TOKEN && env.ADMIN_TOKEN.length >= 16 && safeEqual(h, `Bearer ${env.ADMIN_TOKEN}`);
}

export async function handleFetch(req: Request, env: Env, fetcher?: Fetcher): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/health") return new Response("ok");

  if (req.method === "POST" && url.pathname === "/telegram") {
    // Telegram echoes the secret we registered with setWebhook (P11-02).
    const secret = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
    if (!env.WEBHOOK_SECRET || !safeEqual(secret, env.WEBHOOK_SECRET)) return new Response("forbidden", { status: 403 });
    let update: Update;
    try {
      update = await req.json();
    } catch {
      return new Response("bad request", { status: 400 });
    }
    const app = makeApp(env, fetcher);
    try {
      const keys = await handleUpdate(app, update);
      if (keys.length) await dispatchPending(app.db, app.tg, 40, keys);
    } catch (e) {
      // Telegram permanently refused a reply (e.g. user blocked the bot): retrying won't help.
      if (e instanceof DefiniteFailure) {
        console.warn("reply refused", update.update_id, String(e));
        return new Response("ok");
      }
      // Storage or network trouble: ask Telegram to retry. Ingest is idempotent, so that's safe.
      console.error("update failed", update.update_id, String(e));
      return new Response("error", { status: 500 });
    }
    return new Response("ok");
  }

  if (url.pathname.startsWith("/admin/")) {
    if (!bearerOk(req, env)) return new Response("unauthorized", { status: 401 });
    const app = makeApp(env, fetcher);
    if (req.method === "POST" && url.pathname === "/admin/setup") {
      const hook = await app.tg.call("setWebhook", {
        url: `${url.origin}/telegram`,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ALLOWED_UPDATES,
        max_connections: 10,
      });
      const cmds = await app.tg.call("setMyCommands", { commands: COMMANDS, scope: { type: "all_private_chats" } });
      return json({ webhook: hook, commands: cmds, url: `${url.origin}/telegram` });
    }
    if (req.method === "GET" && url.pathname === "/admin/status") return json(await status(app.db));
    if (req.method === "POST" && url.pathname === "/admin/cron") return json(await runCron(app));
    if (req.method === "GET" && url.pathname === "/admin/docs/pending") return json(await pendingDocs(env.DB, Number(url.searchParams.get("limit") ?? "10")));
    if (req.method === "POST" && url.pathname === "/admin/docs/result") return json(await docResult(env.DB, await req.json()));
  }
  return new Response("not found", { status: 404 });
}

// ---- document offload (GitHub Actions parses PDF/DOCX/PPTX; see docs/GITHUB_ACTIONS.md) ----

const MAX_DOC_ATTEMPTS = 3;

async function pendingDocs(db: D1Database, limit: number) {
  const n = Math.min(Math.max(1, Number.isFinite(limit) ? limit : 10), 50);
  // Only documents whose message is still live and whose group is still enabled.
  const { results } = await db
    .prepare(
      "SELECT q.source_id, q.msg_id, q.file_id, q.file_name, q.file_size FROM doc_queue q " +
        "JOIN passages p ON p.source_id = q.source_id AND p.msg_id = q.msg_id AND p.part = 0 AND p.removed_at IS NULL " +
        "JOIN sources s ON s.id = q.source_id AND s.enabled = 1 " +
        "WHERE q.status = 'pending' AND q.attempts < ? ORDER BY q.created_at LIMIT ?",
    )
    .bind(MAX_DOC_ATTEMPTS, n)
    .all();
  return { documents: results };
}

interface DocResult {
  source_id: string;
  msg_id: number;
  status: "done" | "failed" | "skipped";
  error?: string;
  chunks?: { locator: string | null; text: string }[];
}

async function docResult(db: D1Database, body: DocResult) {
  const row = await db
    .prepare("SELECT file_name, status FROM doc_queue WHERE source_id=? AND msg_id=?")
    .bind(body.source_id, body.msg_id)
    .first<{ file_name: string; status: string }>();
  if (!row) return { ok: false, reason: "unknown document" };
  if (row.status !== "pending") return { ok: true, stored: 0, note: "already handled" };
  let stored = 0;
  let status = body.status;
  if (status === "done") {
    const chunks = (body.chunks ?? []).slice(0, MAX_CHUNKS).map((c) => ({ locator: c.locator ?? null, text: String(c.text ?? "").slice(0, 20_000) }));
    stored = await storeChunks(db, body.source_id, body.msg_id, row.file_name, chunks);
    if (!stored) status = "skipped"; // message removed meanwhile, or empty document
  }
  await db
    .prepare(
      "UPDATE doc_queue SET status=CASE WHEN ?='failed' AND attempts+1 < ? THEN 'pending' ELSE ? END, attempts=attempts+1, error=?, updated_at=? WHERE source_id=? AND msg_id=?",
    )
    .bind(status, MAX_DOC_ATTEMPTS, status, body.error?.slice(0, 300) ?? null, nowIso(), body.source_id, body.msg_id)
    .run();
  return { ok: true, stored, status };
}

export default {
  fetch: (req: Request, env: Env) => handleFetch(req, env),
  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runCron(makeApp(env)).then((r) => console.log("cron", JSON.stringify(r))));
  },
} satisfies ExportedHandler<Env>;
