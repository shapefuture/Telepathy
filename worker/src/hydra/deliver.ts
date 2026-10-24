// H1: one delivery port for every non-Telegram head. Telegram keeps the effect ledger.
// Each send updates the head's health and its failure domains (H3 learns from real traffic).

import type { App } from "../bot";
import type { Env } from "../env";
import { open, seal } from "../continuity/crypto";
import { emailSenders, sendEmail } from "../continuity/email";
import { headDomains, type HeadKind } from "./domains";
import { recordDomain, recordHead } from "./health";
import { sendPush } from "./webpush";

export interface Notice {
  title: string;
  text: string;
  url?: string;
  unsubscribe?: string;
}
export interface RegRow {
  id: string;
  person_id: string;
  channel: HeadKind;
  address_enc: string | null;
  meta_enc: string | null;
  domains: string | null;
}
export type DeliverResult = "sent" | "failed" | "disabled" | "logged" | "gone";

const ascii = (s: string, n: number) => s.slice(0, n);

/** Which head kinds a member may add on this install (and their nominal domain, for suggestions). */
export function availableHeads(env: Env): { kind: HeadKind; domain: string }[] {
  const out: { kind: HeadKind; domain: string }[] = [];
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) out.push({ kind: "webpush", domain: "push:browser" });
  for (const s of ntfyServers(env).slice(0, 1)) out.push({ kind: "ntfy", domain: `ntfy:${new URL(s).hostname}` });
  if (env.MATRIX_HOMESERVER && env.MATRIX_ACCESS_TOKEN) out.push({ kind: "matrix", domain: `matrix:${new URL(env.MATRIX_HOMESERVER).hostname}` });
  if (emailSenders(env).length) out.push({ kind: "email", domain: "mail:another-provider" });
  if (env.SMS_PROVIDER === "twilio" && env.SMS_ACCOUNT_SID && env.SMS_AUTH_TOKEN && env.SMS_FROM) out.push({ kind: "sms", domain: "sms" });
  return out;
}

/** ntfy servers members may use (fixed list: the Worker only ever posts to these hosts). */
export function ntfyServers(env: Env): string[] {
  // Off until the owner names the server(s): each one is a processor in the privacy notice.
  return (env.NTFY_SERVERS ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter((s) => /^https:\/\/[a-z0-9.-]+\.[a-z]{2,}$/i.test(s));
}

export async function deliver(app: App, reg: RegRow, n: Notice): Promise<DeliverResult> {
  const env = app.env;
  const net = app.net ?? fetch;
  const address = reg.address_enc ? await open(env.CONTINUITY_KEY, reg.address_enc) : "";
  const meta = reg.meta_enc ? (JSON.parse(await open(env.CONTINUITY_KEY, reg.meta_enc)) as Record<string, string>) : {};
  let r: DeliverResult = "disabled";
  try {
    switch (reg.channel) {
      case "email": {
        const res = await sendEmail(app, { to: address, subject: n.title.slice(0, 120), text: n.text + (n.url ? `\n\n${n.url}` : "") + (n.unsubscribe ? `\n\nStop these notices: ${n.unsubscribe}` : ""), unsubscribe: n.unsubscribe });
        r = res;
        break;
      }
      case "webpush": {
        if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) break;
        r = await sendPush(net, { endpoint: address, p256dh: meta.p256dh ?? "", auth: meta.auth ?? "" }, { title: n.title.slice(0, 120), body: n.text.slice(0, 1500), url: n.url ?? `${(env.PUBLIC_URL ?? "").replace(/\/$/, "")}/portal` }, {
          publicKey: env.VAPID_PUBLIC_KEY,
          privateKey: env.VAPID_PRIVATE_KEY,
          subject: env.VAPID_SUBJECT || env.PUBLIC_URL || "mailto:admin@example.invalid",
        });
        break;
      }
      case "ntfy": {
        const u = new URL(address);
        if (!ntfyServers(env).includes(u.origin)) break;
        const res = await net(u.origin, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ topic: u.pathname.slice(1), title: n.title.slice(0, 120), message: n.text.slice(0, 3000), click: n.url, priority: 4 }),
          signal: AbortSignal.timeout(8000),
        });
        r = res.ok ? "sent" : "failed";
        break;
      }
      case "matrix": {
        if (!env.MATRIX_HOMESERVER || !env.MATRIX_ACCESS_TOKEN) break;
        const hs = env.MATRIX_HOMESERVER.replace(/\/$/, "");
        const auth = { authorization: `Bearer ${env.MATRIX_ACCESS_TOKEN}`, "content-type": "application/json" };
        let room = meta.room;
        if (!room) {
          const c = await net(`${hs}/_matrix/client/v3/createRoom`, { method: "POST", headers: auth, body: JSON.stringify({ is_direct: true, invite: [address], preset: "trusted_private_chat" }), signal: AbortSignal.timeout(8000) });
          if (!c.ok) {
            r = "failed";
            break;
          }
          room = ((await c.json()) as { room_id: string }).room_id;
          await app.db.prepare("UPDATE delivery_registrations SET meta_enc=? WHERE id=?").bind(await seal(env.CONTINUITY_KEY, JSON.stringify({ ...meta, room })), reg.id).run();
        }
        const res = await net(`${hs}/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/m.room.message/${crypto.randomUUID()}`, {
          method: "PUT",
          headers: auth,
          body: JSON.stringify({ msgtype: "m.text", body: `${n.title}\n\n${n.text}${n.url ? `\n\n${n.url}` : ""}` }),
          signal: AbortSignal.timeout(8000),
        });
        r = res.ok ? "sent" : res.status === 403 ? "gone" : "failed";
        break;
      }
      case "sms": {
        if (env.SMS_PROVIDER !== "twilio" || !env.SMS_ACCOUNT_SID || !env.SMS_AUTH_TOKEN || !env.SMS_FROM) break;
        const res = await net(`https://api.twilio.com/2010-04-01/Accounts/${env.SMS_ACCOUNT_SID}/Messages.json`, {
          method: "POST",
          headers: { authorization: `Basic ${btoa(`${env.SMS_ACCOUNT_SID}:${env.SMS_AUTH_TOKEN}`)}`, "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ To: address, From: env.SMS_FROM, Body: ascii(`${n.title}\n${n.text}${n.url ? `\n${n.url}` : ""}`, 600) }),
          signal: AbortSignal.timeout(8000),
        });
        r = res.ok ? "sent" : "failed";
        break;
      }
      default:
        r = "disabled";
    }
  } catch {
    r = "failed";
  }
  if (r === "sent" || r === "failed" || r === "gone") {
    await recordHead(app.db, reg.id, r === "sent" ? "ok" : r === "gone" ? "gone" : "fail");
    // Email: a provider error is the sender's fault (recorded in sendEmail), not the mailbox's.
    if (reg.channel !== "email") for (const d of JSON.parse(reg.domains ?? "[]") as string[]) await recordDomain(app.db, d, r === "sent");
  }
  return r;
}

/** Work out and store a head's failure domains once it is verified (one MX lookup for email). */
export async function computeDomains(app: App, registrationId: string): Promise<string[]> {
  const reg = await app.db.prepare("SELECT channel, address_enc FROM delivery_registrations WHERE id=?").bind(registrationId).first<{ channel: HeadKind; address_enc: string | null }>();
  if (!reg) return [];
  const address = reg.address_enc ? await open(app.env.CONTINUITY_KEY, reg.address_enc) : "";
  let mx: string | null = null;
  if (reg.channel === "email") mx = await mxHost(app, address.split("@")[1] ?? "");
  const domains = headDomains(reg.channel, address, { mx, senders: emailSenders(app.env), matrixServer: app.env.MATRIX_HOMESERVER });
  await app.db.prepare("UPDATE delivery_registrations SET domains=? WHERE id=?").bind(JSON.stringify(domains), registrationId).run();
  return domains;
}

/** DNS-over-HTTPS MX lookup, best effort (custom domains on Google/Microsoft share their fate). */
async function mxHost(app: App, domain: string): Promise<string | null> {
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) return null;
  try {
    const res = await (app.net ?? fetch)(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(3000) });
    const j = (await res.json()) as { Answer?: { data: string }[] };
    const best = (j.Answer ?? []).map((a) => a.data.split(" ")).sort((a, b) => Number(a[0]) - Number(b[0]))[0];
    return best?.[1] ?? null;
  } catch {
    return null;
  }
}
