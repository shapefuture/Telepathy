// Worker entry: Telegram webhook, operator endpoints, and the cron trigger.

import { handleUpdate, status, type App, type Update } from "./bot";
import { handleApp } from "./app";
import { agentCard, handleA2A } from "./federation/a2a";
import { fedEnabled, handleFederation, relayRelocation } from "./federation/gateway";
import { handlePortal } from "./continuity/portal";
import { installManifest, installRoot, publicIdentity } from "./continuity/identity";
import { attestationStatus } from "./continuity/passport";
import { exportBundle, importBundle, PortableError } from "./continuity/portable";
import { metrics as continuityMetrics } from "./continuity/alerts";
import { runCron } from "./cron";
import { setDefaultLang } from "./i18n";
import { anchorRecord, handleFeeds, publishNotice } from "./hydra/notices";
import { handleMailEvent } from "./hydra/heads";
import { hydraMetrics } from "./hydra/graph";
import { buildEscrow } from "./hydra/escrow";
import { sealRelocation } from "./hydra/fed";
import type { Env } from "./env";
import { MAX_CHUNKS, storeChunks } from "./ingest";
import { dispatchPending } from "./outbox";
import { createTelegram, DefiniteFailure, type Fetcher } from "./telegram";
import { nowIso, safeEqual } from "./util";

export const ALLOWED_UPDATES = ["message", "edited_message", "callback_query", "my_chat_member", "chat_member", "chat_join_request"];

// Command menu (the list under "/"), in DEFAULT_LANG for everyone.
/** The menu: the five things people do most. Everything else is a command away (/help lists them). */
export const COMMANDS_RU = [
  { command: "ask", description: "Спросить: напишите вопрос" },
  { command: "catchup", description: "Что нового и встречи" },
  { command: "requests", description: "Мои запросы" },
  { command: "profile", description: "Мой профиль и настройки" },
  { command: "help", description: "Как пользоваться" },
];
export const COMMANDS = [
  { command: "ask", description: "Ask: type your question" },
  { command: "catchup", description: "What's new and upcoming events" },
  { command: "requests", description: "My requests" },
  { command: "profile", description: "My profile and settings" },
  { command: "help", description: "How to use me" },
];
/** What the bot is, in the profile Telegram shows before anyone taps Start. */
export const DESCRIPTION_RU = "Ответы из памяти клуба и люди, которые помогут. Напишите вопрос — найду, что уже обсуждали, и спрошу тех, кто готов помочь. Контакты открываются, только когда согласны оба.";
export const DESCRIPTION_EN = "Answers from the club's memory, and the people who can help. Ask a question: I find what was already discussed and ask those ready to help. Contacts open only when you both agree.";
export const SHORT_DESCRIPTION_RU = "Ответы из памяти клуба и помощь людей";
export const SHORT_DESCRIPTION_EN = "Answers from the club's memory and people who can help";
export const BOT_NAME_RU = "Миндальная связь";
/** In groups, only what works there. */
export const GROUP_COMMANDS_RU = [{ command: "ask", description: "Спросить: отвечу из этой группы" }];
export const GROUP_COMMANDS = [{ command: "ask", description: "Ask: I answer from this group" }];

export function makeApp(env: Env, fetcher?: Fetcher, net?: Fetcher): App {
  setDefaultLang(env.DEFAULT_LANG);
  return { env, db: env.DB, tg: createTelegram(env.BOT_TOKEN, fetcher), net };
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json" } });

function bearerOk(req: Request, env: Env): boolean {
  const h = req.headers.get("authorization") ?? "";
  return !!env.ADMIN_TOKEN && env.ADMIN_TOKEN.length >= 16 && safeEqual(h, `Bearer ${env.ADMIN_TOKEN}`);
}

export async function handleFetch(req: Request, env: Env, fetcher?: Fetcher, net?: Fetcher): Promise<Response> {
  setDefaultLang(env.DEFAULT_LANG);
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/health") return new Response("ok");
  // ---- Continuity: public identity, attestation status, independent portal ----
  if (req.method === "GET" && url.pathname === "/.well-known/nexus-community.json") {
    const doc = await publicIdentity(env.DB);
    return doc ? new Response(JSON.stringify(doc), { headers: { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "max-age=300" } }) : new Response("not found", { status: 404 });
  }
  // Hydra public heads: signed notice feeds, anchor record, owner heartbeat (public material only).
  if (req.method === "GET" && (url.pathname === "/notices.json" || url.pathname === "/feed.xml" || url.pathname === "/notices.ics" || url.pathname === "/.well-known/nexus-anchor.txt" || url.pathname === "/.well-known/nexus-heartbeat.json")) {
    return (await handleFeeds(req, makeApp(env, fetcher, net))) ?? new Response("not found", { status: 404 });
  }
  if (req.method === "POST" && url.pathname === "/hydra/mail-events") {
    // Email provider delivery/bounce webhook; the secret is in the URL the operator registers.
    if (!env.EMAIL_WEBHOOK_SECRET || !env.CONTINUITY_KEY || !safeEqual(url.searchParams.get("t") ?? "", env.EMAIL_WEBHOOK_SECRET)) return new Response("forbidden", { status: 403 });
    return json({ ok: true, recorded: await handleMailEvent(makeApp(env, fetcher, net), await req.json().catch(() => null)) });
  }
  const att = /^\/v1\/attestations\/([0-9a-f]{32})\/status$/.exec(url.pathname);
  if (req.method === "GET" && att) return json({ status: await attestationStatus(env.DB, att[1]!) });
  if (url.pathname === "/portal" || url.pathname.startsWith("/portal/")) return handlePortal(req, makeApp(env, fetcher, net));
  if (url.pathname === "/a2a" || url.pathname === "/.well-known/agent-card.json" || url.pathname === "/.well-known/agent.json") {
    // A2A transport for the same signed messages (off unless federation is on).
    if (!fedEnabled(env)) return new Response("not found", { status: 404 });
    const app = makeApp(env, fetcher, net);
    if (req.method === "GET" && url.pathname !== "/a2a") return json(agentCard(app));
    if (req.method !== "POST" || url.pathname !== "/a2a") return new Response("not found", { status: 404 });
    let body: unknown;
    try {
      const text = await req.text();
      if (text.length > 16 * 1024) return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "too large" } });
      body = JSON.parse(text);
    } catch {
      return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    }
    const r = await handleA2A(app, body);
    if (r.keys.length) await dispatchPending(app.db, app.tg, 10, r.keys).catch((e) => console.warn("a2a notify", String(e)));
    return json(r.body);
  }
  if (url.pathname.startsWith("/v1/") || url.pathname === "/.well-known/nexus-node.json") {
    // Partner gateway (off unless FEDERATION_ENABLED=true). Signed messages only.
    const app = makeApp(env, fetcher, net);
    const r = await handleFederation(req, app);
    if (r) {
      if (r.keys.length) await dispatchPending(app.db, app.tg, 10, r.keys).catch((e) => console.warn("fed notify", String(e)));
      return r.response;
    }
  }
  if (url.pathname === "/app" || url.pathname.startsWith("/app/api/")) return handleApp(req, env, fetcher, net);

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
    const app = makeApp(env, fetcher, net);
    if (req.method === "POST" && url.pathname === "/admin/setup") {
      const hook = await app.tg.call("setWebhook", {
        url: `${url.origin}/telegram`,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ALLOWED_UPDATES,
        max_connections: 10,
      });
      // One menu for everyone, in DEFAULT_LANG (people switch the bot's language with /language).
      const ru = (env.DEFAULT_LANG ?? "ru") !== "en";
      const cmds = await app.tg.call("setMyCommands", { commands: ru ? COMMANDS_RU : COMMANDS, scope: { type: "all_private_chats" } });
      await app.tg.call("setMyCommands", { commands: ru ? GROUP_COMMANDS_RU : GROUP_COMMANDS, scope: { type: "all_group_chats" } });
      // P13-11: Mini App in the chat menu button.
      const menu = await app.tg.call("setChatMenuButton", { menu_button: { type: "web_app", text: (env.DEFAULT_LANG ?? "ru") === "en" ? "App" : "Приложение", web_app: { url: `${url.origin}/app` } } });
      // The bot's own profile in Telegram, in both languages; the Russian name spelled as the club writes it.
      const profile: Record<string, string> = {};
      const steps: [string, Record<string, unknown>][] = [
        ["description_ru", { method: "setMyDescription", params: { description: DESCRIPTION_RU, language_code: "ru" } }],
        ["description_en", { method: "setMyDescription", params: { description: DESCRIPTION_EN, language_code: "en" } }],
        ["short_ru", { method: "setMyShortDescription", params: { short_description: SHORT_DESCRIPTION_RU, language_code: "ru" } }],
        ["short_en", { method: "setMyShortDescription", params: { short_description: SHORT_DESCRIPTION_EN, language_code: "en" } }],
        ["name_ru", { method: "setMyName", params: { name: BOT_NAME_RU, language_code: "ru" } }],
      ];
      for (const [label, step] of steps) {
        try {
          profile[label] = JSON.stringify(await app.tg.call(step.method as string, step.params as Record<string, unknown>));
        } catch (e) {
          profile[label] = `failed: ${String(e)}`;
        }
      }
      return json({ webhook: hook, commands: cmds, menu, profile, url: `${url.origin}/telegram`, app: `${url.origin}/app` });
    }
    if (req.method === "GET" && url.pathname === "/admin/status") return json(await status(app.db));
    if (req.method === "POST" && url.pathname === "/admin/cron") return json(await runCron(app));
    if (req.method === "GET" && url.pathname === "/admin/docs/pending") return json(await pendingDocs(env.DB, Number(url.searchParams.get("limit") ?? "10")));
    if (req.method === "POST" && url.pathname === "/admin/docs/result") return json(await docResult(env.DB, await req.json()));
    // Continuity administration (CONT-1, 5, 9). Root and relocation documents are signed offline.
    if (req.method === "POST" && url.pathname === "/admin/identity/root") return json(await installRoot(env.DB, await req.json(), "admin"));
    if (req.method === "POST" && url.pathname === "/admin/identity/manifest") {
      const v = await installManifest(env.DB, await req.json(), "admin");
      const relayed = v.ok && v.relocation ? await relayRelocation(app) : 0;
      // Every new address list is anchored in the public feeds (and social/archive when set up).
      if (v.ok) await publishNotice(app, v.relocation ? "relocation" : "anchor", v.relocation ? "We have moved" : "Address list updated", (await anchorRecord(env.DB)) ?? "", "admin");
      return json({ ...v, relayed });
    }
    if (req.method === "GET" && url.pathname === "/admin/continuity/export") {
      try {
        return json(await exportBundle(app));
      } catch (e) {
        if (e instanceof PortableError) return json({ error: e.message }, 409);
        throw e;
      }
    }
    if (req.method === "POST" && url.pathname === "/admin/continuity/import") {
      try {
        return json(await importBundle(app, await req.json(), "admin"));
      } catch (e) {
        if (e instanceof PortableError) return json({ error: e.message }, 409);
        throw e;
      }
    }
    if (req.method === "GET" && url.pathname === "/admin/continuity/metrics") return json(await continuityMetrics(env.DB));
    // Hydra (P16): head graph numbers, an escrow copy for offline storage, sealed relocations.
    if (req.method === "GET" && url.pathname === "/admin/hydra/metrics") return json(await hydraMetrics(app));
    if (req.method === "GET" && url.pathname === "/admin/hydra/escrow") {
      const e = await buildEscrow(app);
      return e ? json(e) : json({ error: "escrow_not_configured" }, 409);
    }
    if (req.method === "POST" && url.pathname === "/admin/hydra/seal") {
      const b = (await req.json()) as { manifest: never; quorum: number; silence_days: number; partners: string[] };
      return json(await sealRelocation(app, b.manifest, { quorum: Number(b.quorum), silenceDays: Number(b.silence_days), partners: Array.isArray(b.partners) ? b.partners.map(String) : [] }));
    }
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
