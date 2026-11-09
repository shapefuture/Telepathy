// Standalone /export Mini App. Unlike /app, this only shares optional Telegram app credentials;
// chat content never passes through the Worker. The browser talks to Telegram and tmpfiles directly.

import { EXPORT_PAGE } from "./export-page";
import { RECOVERY_PAGE } from "./recovery-page";
import type { Env } from "./env";
import { verifyInitUser } from "./app";

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

// WebAssembly is needed for MTProto. tmpfiles is reachable only from the exporter page, and the
// page itself requires a separate checkbox plus confirmation before sending an archive there.
const CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://telegram.org; " +
  "style-src 'unsafe-inline'; connect-src 'self' blob: wss://*.web.telegram.org https://tmpfiles.org; " +
  "img-src 'self' data:; base-uri 'none'; form-action 'none'; object-src 'none'";

export async function handleExport(req: Request, env: Env): Promise<Response> {
  const path = new URL(req.url).pathname;
  if (req.method === "GET" && (path === "/export" || path === "/export/recover")) {
    return new Response(path === "/export/recover" ? RECOVERY_PAGE : EXPORT_PAGE, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": CSP,
        "referrer-policy": "no-referrer",
        "cache-control": "no-store",
      },
    });
  }
  if (req.method === "GET" && path === "/export/api/config") {
    // App credentials are optional. Do not disclose them to an arbitrary web visitor: require the
    // same signed, fresh Telegram Mini App identity used by the primary app, but no club membership.
    const user = await verifyInitUser(req.headers.get("x-telegram-init-data") ?? "", env.BOT_TOKEN);
    if (!user) return json({ error: "unauthorized" }, 401);
    return json({ api: env.TG_API_ID && env.TG_API_HASH ? { id: Number(env.TG_API_ID), hash: env.TG_API_HASH } : null });
  }
  return json({ error: "not found" }, 404);
}
