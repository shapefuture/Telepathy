// Email delivery port (CONT-3/4/6). Off unless EMAIL_PROVIDER is set.
//   "resend" — Resend-compatible HTTP API (EMAIL_API_KEY secret, EMAIL_FROM var). The address and
//              message go to that processor; the owner chooses it and names it in the privacy notice.
//   "log"    — development: nothing is sent, the Worker logs that a message would have gone out
//              (no address, no content).
// Cloudflare's own send_email binding only reaches pre-verified addresses, so it can't do this.

import type { App } from "../bot";

export interface Mail {
  to: string;
  subject: string;
  text: string;
  /** One-click unsubscribe URL (RFC 8058) for non-transactional mail. */
  unsubscribe?: string;
}
export type MailResult = "sent" | "failed" | "disabled" | "logged";

export async function sendEmail(app: App, mail: Mail): Promise<MailResult> {
  const provider = app.env.EMAIL_PROVIDER ?? "";
  if (provider === "log") {
    console.log("email (log provider): message not sent", mail.subject.length, "chars subject");
    return "logged";
  }
  if (provider !== "resend" || !app.env.EMAIL_API_KEY || !app.env.EMAIL_FROM) return "disabled";
  const headers: Record<string, string> = {};
  if (mail.unsubscribe) {
    headers["List-Unsubscribe"] = `<${mail.unsubscribe}>`;
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }
  try {
    const res = await (app.net ?? fetch)(app.env.EMAIL_API_URL || "https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${app.env.EMAIL_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: app.env.EMAIL_FROM, to: [mail.to], subject: mail.subject, text: mail.text, headers }),
      signal: AbortSignal.timeout(8000),
    });
    return res.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}
