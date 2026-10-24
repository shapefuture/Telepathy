// H1: members add more heads themselves: Web Push, ntfy, Matrix, SMS (each verified by a code
// sent over that head), and buddies. Nothing is added on anyone's behalf.

import type { App } from "../bot";
import { audit, newId, nowIso } from "../util";
import { hmacHex, open, randomToken, seal } from "../continuity/crypto";
import { addressHash, ContinuityError, issueCode, suppressHash } from "../continuity/people";
import { availableHeads, ntfyServers } from "./deliver";
import { pushOperator, type HeadKind } from "./domains";
import { recordDomain, recordHead } from "./health";

export const MAX_HEADS = 10;
export type AddableKind = "webpush" | "ntfy" | "matrix" | "sms";

/** Validate and normalise an address for a head kind; throws ContinuityError with a reason code. */
export function normaliseHead(app: App, kind: AddableKind, address: string): string {
  const a = address.trim();
  if (!availableHeads(app.env).some((h) => h.kind === kind)) throw new ContinuityError("head_not_enabled");
  switch (kind) {
    case "webpush": {
      // Only real push services: the Worker never POSTs to an arbitrary URL.
      if (!/^https:\/\/[^\s]{10,800}$/.test(a) || !pushOperator(a)) throw new ContinuityError("push_endpoint");
      return a;
    }
    case "ntfy": {
      let u: URL;
      try {
        u = new URL(a);
      } catch {
        throw new ContinuityError("ntfy_url");
      }
      if (!ntfyServers(app.env).includes(u.origin) || !/^\/[A-Za-z0-9_-]{16,64}$/.test(u.pathname) || u.search) throw new ContinuityError("ntfy_url");
      return `${u.origin}${u.pathname}`;
    }
    case "matrix":
      if (!/^@[a-z0-9._=\-/]{1,100}:[a-z0-9.-]+\.[a-z]{2,}(:\d{2,5})?$/i.test(a)) throw new ContinuityError("matrix_id");
      return a.toLowerCase();
    case "sms":
      if (!/^\+[1-9]\d{7,14}$/.test(a.replace(/[\s-]/g, ""))) throw new ContinuityError("phone");
      return a.replace(/[\s-]/g, "");
  }
}

/** A random, unguessable ntfy topic for this person to subscribe to in the ntfy app. */
export function newNtfyTopic(app: App): string | null {
  const s = ntfyServers(app.env)[0];
  return s ? `${s}/tp_${randomToken().slice(0, 28)}` : null;
}

export async function addHead(app: App, personId: string, kind: AddableKind, address: string, keys?: { p256dh?: string; auth?: string }, now = new Date()): Promise<{ registrationId: string; sent: string }> {
  const addr = normaliseHead(app, kind, address);
  if (kind === "webpush" && (!keys?.p256dh || !keys.auth || !/^[A-Za-z0-9_-]{80,100}$/.test(keys.p256dh) || !/^[A-Za-z0-9_-]{16,32}$/.test(keys.auth))) throw new ContinuityError("push_keys");
  const n = await app.db.prepare("SELECT COUNT(*) AS n FROM delivery_registrations WHERE person_id=? AND status<>'revoked'").bind(personId).first<{ n: number }>();
  if ((n?.n ?? 0) >= MAX_HEADS) throw new ContinuityError("too_many_heads");
  const hash = await addressHash(app.env, kind, addr);
  const taken = await app.db.prepare("SELECT id, person_id, status FROM delivery_registrations WHERE channel=? AND address_hash=?").bind(kind, hash).first<{ id: string; person_id: string; status: string }>();
  if (taken && taken.person_id !== personId && taken.status === "verified") throw new ContinuityError("address_in_use");
  const id = taken?.id ?? newId();
  const meta = kind === "webpush" ? await seal(app.env.CONTINUITY_KEY, JSON.stringify({ p256dh: keys!.p256dh, auth: keys!.auth })) : null;
  await app.db
    .prepare(
      "INSERT INTO delivery_registrations(id, person_id, channel, address_enc, address_hash, suppress_hash, status, created_at, meta_enc) VALUES (?,?,?,?,?,?,'pending',?,?) " +
        "ON CONFLICT(channel, address_hash) DO UPDATE SET person_id=excluded.person_id, address_enc=excluded.address_enc, meta_enc=COALESCE(excluded.meta_enc, delivery_registrations.meta_enc), health='ok', fail_count=0, status=CASE WHEN delivery_registrations.status='verified' THEN 'verified' ELSE 'pending' END",
    )
    .bind(id, personId, kind, await seal(app.env.CONTINUITY_KEY, addr), hash, await suppressHash(kind, addr), nowIso(now), meta)
    .run();
  await audit(app.db, `hydra.head.${kind}`, personId, id);
  return { registrationId: id, sent: await issueCode(app, id, "verify", now) };
}

// ---- buddies: two people who agree to pass critical notices on, by any means they have ----------

export async function inviteBuddy(app: App, personId: string, label: string): Promise<string> {
  const l = label.trim().slice(0, 60);
  if (!l) throw new ContinuityError("label");
  const live = await app.db.prepare("SELECT COUNT(*) AS n FROM buddies WHERE (inviter=? OR invitee=?) AND status IN ('pending','active')").bind(personId, personId).first<{ n: number }>();
  if ((live?.n ?? 0) >= 3) throw new ContinuityError("too_many_buddies");
  const code = randomToken().slice(0, 12);
  await app.db.prepare("INSERT INTO buddies(id, inviter, code_hash, inviter_label_enc, status, created_at) VALUES (?,?,?,?,'pending',?)").bind(newId(), personId, await hmacHex(app.env.CONTINUITY_KEY, "buddy", code), await seal(app.env.CONTINUITY_KEY, l), nowIso()).run();
  return code;
}

export async function acceptBuddy(app: App, personId: string, code: string, label: string): Promise<boolean> {
  const l = label.trim().slice(0, 60);
  if (!l) return false;
  const h = await hmacHex(app.env.CONTINUITY_KEY, "buddy", code.trim());
  const r = await app.db.prepare("UPDATE buddies SET invitee=?, invitee_label_enc=?, status='active' WHERE code_hash=? AND status='pending' AND inviter<>? RETURNING id").bind(personId, await seal(app.env.CONTINUITY_KEY, l), h, personId).first();
  return !!r;
}

export async function endBuddy(db: D1Database, personId: string, id: string): Promise<boolean> {
  return !!(await db.prepare("UPDATE buddies SET status='ended' WHERE id=? AND (inviter=? OR invitee=?) AND status<>'ended' RETURNING id").bind(id, personId, personId).first());
}

export async function buddiesOf(app: App, personId: string): Promise<{ id: string; name: string; status: string }[]> {
  const { results } = await app.db.prepare("SELECT id, inviter, inviter_label_enc, invitee_label_enc, status FROM buddies WHERE (inviter=? OR invitee=?) AND status IN ('pending','active')").bind(personId, personId).all<{ id: string; inviter: string; inviter_label_enc: string; invitee_label_enc: string | null; status: string }>();
  return Promise.all(results.map(async (r) => ({ id: r.id, status: r.status, name: r.inviter === personId ? (r.invitee_label_enc ? await open(app.env.CONTINUITY_KEY, r.invitee_label_enc) : "(waiting)") : await open(app.env.CONTINUITY_KEY, r.inviter_label_enc) })));
}

/** One line added to a critical notice: "please check that <buddy> got this too". */
export async function buddyNote(app: App, personId: string): Promise<string> {
  const names = (await buddiesOf(app, personId)).filter((b) => b.status === "active").map((b) => b.name);
  return names.length ? `\n\nBuddy check: please make sure ${names.join(", ")} got this too.` : "";
}

// ---- mailbox feedback: the receiving side of email health ---------------------------------------

/**
 * Provider delivery webhook (Resend or Postmark JSON). Deliveries and bounces both count, so a
 * few bounces among many deliveries never mark a whole mailbox operator as down.
 */
export async function handleMailEvent(app: App, body: unknown): Promise<number> {
  const b = body as { type?: string; data?: { to?: string[] }; RecordType?: string; Email?: string; Recipient?: string };
  let ok: boolean | null = null;
  let emails: string[] = [];
  if (b?.type === "email.bounced" || b?.type === "email.delivered") {
    ok = b.type === "email.delivered";
    emails = b.data?.to ?? [];
  } else if (b?.RecordType === "Bounce" || b?.RecordType === "Delivery") {
    ok = b.RecordType === "Delivery";
    emails = [b.Email ?? b.Recipient ?? ""].filter(Boolean);
  }
  if (ok === null) return 0;
  let n = 0;
  for (const e of emails.slice(0, 10)) {
    const reg = await app.db.prepare("SELECT id, domains FROM delivery_registrations WHERE channel='email' AND address_hash=?").bind(await addressHash(app.env, "email", e)).first<{ id: string; domains: string | null }>();
    if (!reg) continue;
    await recordHead(app.db, reg.id, ok ? "ok" : "fail");
    for (const d of (JSON.parse(reg.domains ?? "[]") as string[]).filter((x) => x.startsWith("mail:"))) await recordDomain(app.db, d, ok);
    n++;
  }
  return n;
}

export type { HeadKind };
