// Reading past messages through the owner's own Telegram MCP server (shapefuture/telegram_mcp),
// so nobody has to open the app: once TG_MCP_KEY is set, every enabled group is read in the
// background, 500 messages a minute, and parked for history.ts to store like browser pages.
// The key should be a read-only one (POST /keys/history): it can only call export_history for
// the listed chats. Nothing here sees the owner's Telegram login; it stays in the MCP Worker.

import { langOf, memberByTg } from "./acl";
import type { App } from "./bot";
import { ownerIds, type Env } from "./env";
import { cleanMessages, HISTORY_PAGE_MAX, type HistoryMessage } from "./history";
import { T } from "./i18n";
import { DefiniteFailure, type InlineButton } from "./telegram";
import { escapeHtml } from "./text";
import { DAY, nowIso } from "./util";

export const MCP_PAGE = 500;
const MAX_ERRORS = 10; // ten failed minutes in a row: stop and offer the app instead

export const mcpOn = (env: Env): boolean => !!env.TG_MCP_KEY && (!!env.TG_MCP || !!env.TG_MCP_URL);

/** Queue every enabled group (or one) that has no import yet for reading through MCP. */
export async function startAuto(db: D1Database, env: Env, sourceId?: string, now = new Date()): Promise<number> {
  if (!mcpOn(env)) return 0;
  const fallbackOwner = [...ownerIds(env)][0] ?? 0;
  const r = await db
    .prepare(
      "INSERT OR IGNORE INTO history_jobs(source_id, owner_tg, mcp_offset, updated_at) " +
        "SELECT s.id, COALESCE(m.tg_id, ?1), 0, ?2 FROM sources s LEFT JOIN members m ON m.id=s.enabled_by " +
        "WHERE s.enabled=1 AND (?3 IS NULL OR s.id=?3) AND NOT EXISTS (SELECT 1 FROM history_jobs j WHERE j.source_id=s.id)",
    )
    .bind(fallbackOwner, nowIso(now), sourceId ?? null)
    .run();
  return r.meta.changes;
}

interface McpPage {
  messages: unknown[];
  next_offset: number | null;
}

/** One export_history call. Throws with the server's reason on any failure. */
export async function exportHistory(app: App, chatId: number, offset: number): Promise<McpPage> {
  const env = app.env;
  const url = `${(env.TG_MCP_URL || "https://telegram-mcp").replace(/\/$/, "")}/webhook`;
  const init: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json", "X-API-Key": env.TG_MCP_KEY ?? "" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "export_history", arguments: { chat_id: String(chatId), offset_id: offset, limit: MCP_PAGE } } }),
  };
  const res = env.TG_MCP ? await env.TG_MCP.fetch(url, init) : await (app.net ?? ((u: string, i: RequestInit) => fetch(u, i)))(url, init);
  const body = (await res.json().catch(() => null)) as { error?: { message?: string }; result?: { isError?: boolean; content?: { text?: string }[] } } | null;
  if (!body) throw new Error(`MCP HTTP ${res.status}`);
  if (body.error) throw new Error(`MCP: ${body.error.message ?? "error"}`);
  const text = body.result?.content?.[0]?.text;
  if (body.result?.isError || typeof text !== "string") throw new Error(`MCP: ${String(text ?? "no result").slice(0, 200)}`);
  let page: Partial<McpPage>;
  try {
    page = JSON.parse(text) as Partial<McpPage>;
  } catch {
    throw new Error(`MCP: ${text.slice(0, 200)}`); // e.g. an old server without export_history
  }
  if (!Array.isArray(page.messages)) throw new Error("MCP: no messages in reply");
  const next = page.next_offset;
  return { messages: page.messages, next_offset: typeof next === "number" && Number.isSafeInteger(next) && next > 0 ? next : null };
}

/** Pages of ≤100, keyed by their oldest id (like browser pages of a basic group). */
export function chunk(msgs: HistoryMessage[]): { page: number; msgs: HistoryMessage[] }[] {
  const sorted = [...msgs].sort((a, b) => b.id - a.id);
  const out: { page: number; msgs: HistoryMessage[] }[] = [];
  for (let i = 0; i < sorted.length; i += HISTORY_PAGE_MAX) {
    const part = sorted.slice(i, i + HISTORY_PAGE_MAX);
    out.push({ page: part.at(-1)!.id, msgs: part });
  }
  return out;
}

/**
 * Cron, every minute: read one page of the oldest waiting chat through MCP and park it.
 * Returns the number of messages parked.
 */
export async function readViaMcp(app: App, now = new Date()): Promise<number> {
  if (!mcpOn(app.env)) return 0;
  const db = app.db;
  if (now.getUTCMinutes() % 10 === 0) await startAuto(db, app.env, undefined, now); // groups enabled before the key was set
  const job = await db
    .prepare(
      "SELECT j.source_id, j.owner_tg, j.mcp_offset, j.mcp_errors, s.chat_id, s.title, s.retention_days FROM history_jobs j " +
        "JOIN sources s ON s.id=j.source_id AND s.enabled=1 WHERE j.read_at IS NULL AND j.mcp_offset IS NOT NULL ORDER BY j.updated_at LIMIT 1",
    )
    .first<{ source_id: string; owner_tg: number; mcp_offset: number; mcp_errors: number; chat_id: number; title: string | null; retention_days: number }>();
  if (!job) return 0;
  const at = nowIso(now);
  let page: McpPage;
  try {
    page = await exportHistory(app, job.chat_id, job.mcp_offset);
  } catch (e) {
    console.warn("history mcp", String(e));
    const stop = job.mcp_errors + 1 >= MAX_ERRORS;
    await db
      .prepare("UPDATE history_jobs SET mcp_errors=mcp_errors+1, mcp_offset=CASE WHEN ? THEN NULL ELSE mcp_offset END, updated_at=? WHERE source_id=?")
      .bind(stop ? 1 : 0, at, job.source_id)
      .run();
    if (stop) await tellFailed(app, job.owner_tg, job.title);
    return 0;
  }
  const keepFrom = job.retention_days > 0 ? Math.floor((now.getTime() - job.retention_days * DAY) / 1000) : 0;
  const all = cleanMessages(page.messages, Number.MAX_SAFE_INTEGER);
  const msgs = all.filter((m) => m.date >= keepFrom);
  const past = keepFrom > 0 && all.length > 0 && msgs.length === 0; // everything older would be purged
  const finished = page.next_offset === null || past;
  const stmts = chunk(msgs).map((c) => db.prepare("INSERT OR IGNORE INTO history_pages(source_id, page, body, n) VALUES (?,?,?,?)").bind(job.source_id, c.page, JSON.stringify(c.msgs), c.msgs.length));
  stmts.push(
    db
      .prepare(
        "UPDATE history_jobs SET staged=staged+?, mcp_offset=?, mcp_errors=0, read_at=CASE WHEN ? THEN ? ELSE read_at END, updated_at=? WHERE source_id=?",
      )
      .bind(msgs.length, page.next_offset ?? job.mcp_offset, finished ? 1 : 0, at, at, job.source_id),
  );
  await db.batch(stmts);
  return msgs.length;
}

async function tellFailed(app: App, ownerTg: number, title: string | null): Promise<void> {
  const t = T(langOf(await memberByTg(app.db, ownerTg)));
  const origin = (app.env.PUBLIC_URL ?? "").replace(/\/$/, "");
  const buttons = origin ? [[{ text: t.historyButton, web_app: { url: `${origin}/app?start=history` } } as unknown as InlineButton]] : undefined;
  try {
    await app.tg.sendMessage(ownerTg, t.historyMcpFailed(escapeHtml(title ?? ""), !!origin), { buttons });
  } catch (e) {
    if (!(e instanceof DefiniteFailure)) throw e;
  }
}
