// Email delivery port (CONT-3/4/6, Hydra H1). Off unless EMAIL_PROVIDER is set.
//   Provider A: EMAIL_PROVIDER, EMAIL_API_KEY (secret), EMAIL_FROM, EMAIL_API_URL
//   Provider B: EMAIL_B_PROVIDER, EMAIL_B_API_KEY (secret), EMAIL_B_FROM, EMAIL_B_API_URL
//   Kinds: "resend" | "postmark" (different companies, so B really is a second head);
//          "log" = development: nothing is sent, no address or content is logged.
// Failover: try the preferred provider, then the other. After 3 failures in a row a provider is
// skipped for 10 minutes (circuit breaker), and every result feeds the "sender:<kind>" domain.
// Cloudflare's own send_email binding only reaches pre-verified addresses, so it can't do this.

import type { App } from "../bot";
import type { Env } from "../env";
import { recordDomain } from "../hydra/health";

export interface Mail {
  to: string;
  subject: string;
  text: string;
  /** One-click unsubscribe URL (RFC 8058) for non-transactional mail. */
  unsubscribe?: string;
}
export type MailResult = "sent" | "failed" | "disabled" | "logged";

interface Provider {
  slot: "A" | "B";
  kind: "resend" | "postmark" | "log";
  key?: string;
  from?: string;
  url?: string;
}

export function emailProviders(env: Env): Provider[] {
  const out: Provider[] = [];
  const add = (slot: "A" | "B", kind?: string, key?: string, from?: string, url?: string) => {
    if (kind === "log") out.push({ slot, kind });
    else if ((kind === "resend" || kind === "postmark") && key && from) out.push({ slot, kind, key, from, url: url || undefined });
  };
  add("A", env.EMAIL_PROVIDER, env.EMAIL_API_KEY, env.EMAIL_FROM, env.EMAIL_API_URL);
  add("B", env.EMAIL_B_PROVIDER, env.EMAIL_B_API_KEY, env.EMAIL_B_FROM, env.EMAIL_B_API_URL);
  return out;
}

/** Distinct sending companies: one = a single point of failure for every email head. */
export const emailSenders = (env: Env) => [...new Set(emailProviders(env).filter((p) => p.kind !== "log").map((p) => p.kind))];

const BREAK_MS = 10 * 60_000;

async function breaker(db: D1Database, slot: string): Promise<{ fails: number; at: number }> {
  const r = await db.prepare("SELECT value FROM settings WHERE key=?").bind(`email.${slot}.fails`).first<{ value: string }>();
  const [f, at] = (r?.value ?? "0:0").split(":");
  return { fails: Number(f) || 0, at: Number(at) || 0 };
}
const setBreaker = (db: D1Database, slot: string, fails: number) =>
  db.prepare("INSERT INTO settings(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(`email.${slot}.fails`, `${fails}:${Date.now()}`).run();

export async function sendEmail(app: App, mail: Mail): Promise<MailResult> {
  const providers = emailProviders(app.env);
  if (!providers.length) return "disabled";
  if (providers[0]!.kind === "log") {
    console.log("email (log provider): message not sent", mail.subject.length, "chars subject");
    return "logged";
  }
  // Healthy providers first, in configured order; a tripped one is still tried last.
  const states = await Promise.all(providers.map(async (p) => ({ p, b: await breaker(app.db, p.slot) })));
  const tripped = (b: { fails: number; at: number }) => b.fails >= 3 && Date.now() - b.at < BREAK_MS;
  const order = [...states.filter((s) => !tripped(s.b)), ...states.filter((s) => tripped(s.b))];
  for (const { p, b } of order) {
    if (p.kind === "log") continue;
    const ok = await sendVia(app, p, mail);
    await recordDomain(app.db, `sender:${p.kind}`, ok).catch(() => undefined);
    if (ok) {
      if (b.fails) await setBreaker(app.db, p.slot, 0);
      return "sent";
    }
    await setBreaker(app.db, p.slot, b.fails + 1);
  }
  return "failed";
}

async function sendVia(app: App, p: Provider, mail: Mail): Promise<boolean> {
  const headers: Record<string, string> = {};
  if (mail.unsubscribe) {
    headers["List-Unsubscribe"] = `<${mail.unsubscribe}>`;
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }
  const net = app.net ?? fetch;
  try {
    const res =
      p.kind === "postmark"
        ? await net(p.url || "https://api.postmarkapp.com/email", {
            method: "POST",
            headers: { "x-postmark-server-token": p.key!, "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({ From: p.from, To: mail.to, Subject: mail.subject, TextBody: mail.text, MessageStream: "outbound", Headers: Object.entries(headers).map(([Name, Value]) => ({ Name, Value })) }),
            signal: AbortSignal.timeout(8000),
          })
        : await net(p.url || "https://api.resend.com/emails", {
            method: "POST",
            headers: { authorization: `Bearer ${p.key}`, "content-type": "application/json" },
            body: JSON.stringify({ from: p.from, to: [mail.to], subject: mail.subject, text: mail.text, headers }),
            signal: AbortSignal.timeout(8000),
          });
    return res.ok;
  } catch {
    return false;
  }
}
