// CONT-2..4, 7: people independent of Telegram, verified channels, purpose-scoped follows,
// membership attestations. Nothing here enrolls anyone automatically.
//
// Separations the plan insists on (§2): following club news ≠ being a current member ≠
// marketing consent ≠ partner offers consent ≠ contact reveal. Each is its own record.

import { readable, type Member } from "../acl";
import type { App } from "../bot";
import type { Env } from "../env";
import { audit, DAY, HOUR, newId, nowIso } from "../util";
import { hmacHex, numericCode, open, randomToken, recoveryCode, seal } from "./crypto";
import { computeDomains, deliver, type RegRow } from "../hydra/deliver";

export const TOPICS = ["critical", "events", "requests", "news", "commercial", "partner_offers"] as const;
export type Topic = (typeof TOPICS)[number];
/** Version of the consent wording shown to people; bump when the text changes. */
export const CONSENT_VERSION = 1;
export const CODE_TTL_MS = 10 * 60_000;
export const CODE_MAX_ATTEMPTS = 5;
export const CODES_PER_HOUR = 3;
export const SESSION_DAYS = 30;
export const ATTESTATION_DAYS = 90;
export const RECOVERY_CODES = 8;

export class ContinuityError extends Error {}

const normEmail = (e: string) => e.trim().toLowerCase();
export const validEmail = (e: string) => /^[^\s@<>()",;]{1,64}@[^\s@<>()",;]{1,190}\.[a-z]{2,24}$/i.test(e.trim());
export const addressHash = (env: Env, channel: string, address: string) => hmacHex(env.CONTINUITY_KEY, `addr:${channel}`, channel === "email" ? normEmail(address) : address);
/** Portable suppression key: plain SHA-256, so tombstones survive a move to a new install. */
export async function suppressHash(channel: string, address: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${channel}:${channel === "email" ? normEmail(address) : address}`));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// ---- people and links ------------------------------------------------------------------------

export async function personForMember(db: D1Database, memberId: string): Promise<string | null> {
  const r = await db.prepare("SELECT l.person_id FROM identity_links l JOIN people p ON p.id=l.person_id WHERE l.platform='telegram' AND l.account_id=? AND l.revoked_at IS NULL AND p.removed_at IS NULL").bind(memberId).first<{ person_id: string }>();
  return r?.person_id ?? null;
}

/** Explicit enrolment from a verified Telegram session (Mini App initData). Idempotent. */
export async function enrolFromTelegram(db: D1Database, m: Member): Promise<string> {
  const existing = await personForMember(db, m.id);
  if (existing) return existing;
  const id = newId();
  const now = nowIso();
  await db.batch([
    db.prepare("INSERT INTO people(id, created_at) VALUES (?,?)").bind(id, now),
    db.prepare("INSERT INTO identity_links(person_id, platform, account_id, proof_method, proof_at) VALUES (?, 'telegram', ?, 'telegram_init_data', ?) ON CONFLICT(platform, account_id) DO UPDATE SET person_id=excluded.person_id, proof_at=excluded.proof_at, revoked_at=NULL").bind(id, m.id, now),
  ]);
  await audit(db, "passport.enrol", m.id, id);
  return id;
}

// ---- follow intents (versioned ops) -----------------------------------------------------------

export type Op = "FOLLOW" | "UNFOLLOW" | "MUTE" | "UNMUTE" | "REVOKE_ENDPOINT";

/** Append an op and update state only if it is newer than what's there (restores can't win). */
export async function applyOp(db: D1Database, personId: string, op: Op, topic: Topic | null, opts: { seq?: number; registrationId?: string; at?: string } = {}): Promise<number> {
  const at = opts.at ?? nowIso();
  const seq = opts.seq ?? ((await db.prepare("SELECT COALESCE(MAX(seq),0)+1 AS s FROM subscription_ops WHERE person_id=?").bind(personId).first<{ s: number }>())?.s ?? 1);
  await db.prepare("INSERT OR IGNORE INTO subscription_ops(person_id, seq, op, topic, registration_id, consent_version, at) VALUES (?,?,?,?,?,?,?)").bind(personId, seq, op, topic, opts.registrationId ?? null, CONSENT_VERSION, at).run();
  if (topic && op !== "REVOKE_ENDPOINT") {
    const status = op === "FOLLOW" || op === "UNMUTE" ? "following" : op === "MUTE" ? "muted" : "unfollowed";
    await db
      .prepare("INSERT INTO follow_state(person_id, topic, status, seq) VALUES (?,?,?,?) ON CONFLICT(person_id, topic) DO UPDATE SET status=excluded.status, seq=excluded.seq WHERE excluded.seq > follow_state.seq")
      .bind(personId, topic, status, seq)
      .run();
  }
  return seq;
}

/** Person changes a purpose. Unfollow also suppresses their addresses for it; follow lifts that. */
export async function setTopic(app: App, personId: string, topic: Topic, on: boolean): Promise<void> {
  await applyOp(app.db, personId, on ? "FOLLOW" : "UNFOLLOW", topic);
  const hashes = (await app.db.prepare("SELECT suppress_hash FROM delivery_registrations WHERE person_id=?").bind(personId).all<{ suppress_hash: string }>()).results.map((r) => r.suppress_hash);
  for (const h of hashes) {
    if (on) await app.db.prepare("DELETE FROM suppressions WHERE address_hash=? AND scope=?").bind(h, topic).run();
    else await app.db.prepare("INSERT OR IGNORE INTO suppressions(address_hash, scope, created_at) VALUES (?,?,?)").bind(h, topic, nowIso()).run();
  }
}

export async function follows(db: D1Database, personId: string): Promise<Record<string, string>> {
  const { results } = await db.prepare("SELECT topic, status FROM follow_state WHERE person_id=?").bind(personId).all<{ topic: string; status: string }>();
  return Object.fromEntries(TOPICS.map((t) => [t, results.find((r) => r.topic === t)?.status ?? "unfollowed"]));
}

export async function suppressed(db: D1Database, hash: string, topic: string): Promise<boolean> {
  return !!(await db.prepare("SELECT 1 FROM suppressions WHERE address_hash=? AND scope IN (?, '*')").bind(hash, topic).first());
}

// ---- email channel and independent login ------------------------------------------------------

/** Start (or restart) verification of an email address for this person. */
export async function addEmail(app: App, personId: string, email: string, now = new Date()): Promise<{ registrationId: string; sent: string }> {
  if (!validEmail(email)) throw new ContinuityError("invalid_email");
  const hash = await addressHash(app.env, "email", email);
  const taken = await app.db.prepare("SELECT id, person_id, status FROM delivery_registrations WHERE channel='email' AND address_hash=?").bind(hash).first<{ id: string; person_id: string; status: string }>();
  if (taken && taken.person_id !== personId && taken.status === "verified") throw new ContinuityError("email_in_use");
  const regId = taken?.id ?? newId();
  const sealed = await seal(app.env.CONTINUITY_KEY, normEmail(email));
  await app.db
    .prepare("INSERT INTO delivery_registrations(id, person_id, channel, address_enc, address_hash, suppress_hash, status, created_at) VALUES (?,?,'email',?,?,?,'pending',?) ON CONFLICT(channel, address_hash) DO UPDATE SET person_id=excluded.person_id, address_enc=excluded.address_enc, status=CASE WHEN delivery_registrations.status='verified' THEN 'verified' ELSE 'pending' END")
    .bind(regId, personId, sealed, hash, await suppressHash("email", email), nowIso(now))
    .run();
  const sent = await issueCode(app, regId, "verify", now);
  return { registrationId: regId, sent };
}

/** Send a one-time code over the head itself (email, push, ntfy, Matrix, SMS): proof of control. */
export async function issueCode(app: App, registrationId: string, purpose: "verify" | "login", now: Date): Promise<string> {
  const recent = await app.db.prepare("SELECT COUNT(*) AS n FROM login_codes WHERE registration_id=? AND expires_at>?").bind(registrationId, nowIso(new Date(now.getTime() - HOUR + CODE_TTL_MS))).first<{ n: number }>();
  if ((recent?.n ?? 0) >= CODES_PER_HOUR) throw new ContinuityError("too_many_codes");
  const reg = await app.db.prepare("SELECT id, person_id, channel, address_enc, meta_enc, domains FROM delivery_registrations WHERE id=?").bind(registrationId).first<RegRow>();
  if (!reg) throw new ContinuityError("unknown_registration");
  const code = numericCode();
  await app.db
    .prepare("INSERT INTO login_codes(id, registration_id, code_hash, purpose, expires_at) VALUES (?,?,?,?,?)")
    .bind(newId(), registrationId, await hmacHex(app.env.CONTINUITY_KEY, "code", `${registrationId}:${code}`), purpose, nowIso(new Date(now.getTime() + CODE_TTL_MS)))
    .run();
  const label = app.env.COMMUNITY_LABEL || "your community";
  return deliver(app, reg, { title: `${label}: your code ${code}`, text: `Your ${label} code is ${code}. It expires in 10 minutes.\n\nIf you didn't ask for it, ignore this message.` });
}

/** Check a code; on success the registration is verified. Returns the person id. With `forPerson`, only that person's registration. */
export async function checkCode(app: App, registrationId: string, code: string, purpose: "verify" | "login", now = new Date(), forPerson?: string): Promise<string | null> {
  if (forPerson && !(await app.db.prepare("SELECT 1 FROM delivery_registrations WHERE id=? AND person_id=?").bind(registrationId, forPerson).first())) return null;
  const row = await app.db
    .prepare("SELECT id, code_hash, attempts FROM login_codes WHERE registration_id=? AND purpose=? AND used_at IS NULL AND expires_at>? ORDER BY expires_at DESC LIMIT 1")
    .bind(registrationId, purpose, nowIso(now))
    .first<{ id: string; code_hash: string; attempts: number }>();
  if (!row || row.attempts >= CODE_MAX_ATTEMPTS) return null;
  const ok = row.code_hash === (await hmacHex(app.env.CONTINUITY_KEY, "code", `${registrationId}:${code.trim()}`));
  // Atomic: parallel requests can't each pass the checks above and all use the same code.
  const won = await app.db.prepare(`UPDATE login_codes SET attempts=attempts+1${ok ? ", used_at=?" : ""} WHERE id=? AND used_at IS NULL AND attempts<? RETURNING id`).bind(...(ok ? [nowIso(now), row.id] : [row.id]), CODE_MAX_ATTEMPTS).first();
  if (!ok || !won) return null;
  const reg = await app.db
    .prepare("UPDATE delivery_registrations SET status='verified', verified_at=COALESCE(verified_at, ?) WHERE id=? AND status<>'revoked' AND person_id=COALESCE(?, person_id) RETURNING person_id, suppress_hash")
    .bind(nowIso(now), registrationId, forPerson ?? null)
    .first<{ person_id: string; suppress_hash: string }>();
  // Re-verifying an address is a new explicit action: it lifts an earlier endpoint revocation.
  if (reg) {
    await app.db.prepare("DELETE FROM suppressions WHERE address_hash=? AND scope='*'").bind(reg.suppress_hash).run();
    await computeDomains(app, registrationId);
  }
  return reg?.person_id ?? null;
}

/** Login by email without Telegram. Same answer whether or not the address is known. */
export async function requestLogin(app: App, email: string, now = new Date()): Promise<{ registrationId: string | null }> {
  if (!validEmail(email)) return { registrationId: null };
  const hash = await addressHash(app.env, "email", email);
  const reg = await app.db
    .prepare("SELECT r.id FROM delivery_registrations r JOIN people p ON p.id=r.person_id WHERE r.channel='email' AND r.address_hash=? AND r.status='verified' AND p.removed_at IS NULL")
    .bind(hash)
    .first<{ id: string }>();
  if (!reg) return { registrationId: null };
  try {
    await issueCode(app, reg.id, "login", now);
  } catch (e) {
    if (!(e instanceof ContinuityError)) throw e;
  }
  return { registrationId: reg.id };
}

export async function newRecoveryCodes(env: Env, db: D1Database, personId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODES }, recoveryCode);
  await db.batch([
    db.prepare("DELETE FROM recovery_codes WHERE person_id=?").bind(personId),
    ...(await Promise.all(codes.map(async (c) => db.prepare("INSERT INTO recovery_codes(person_id, code_hash) VALUES (?,?)").bind(personId, await hmacHex(env.CONTINUITY_KEY, "recovery", c))))),
  ]);
  await audit(db, "passport.recovery_codes", personId, personId);
  return codes;
}

/** Recovery code login (works without Telegram and without email). One use per code. */
export async function useRecoveryCode(env: Env, db: D1Database, code: string, now = nowIso()): Promise<string | null> {
  const h = await hmacHex(env.CONTINUITY_KEY, "recovery", code.trim().toUpperCase());
  const r = await db.prepare("UPDATE recovery_codes SET used_at=? WHERE code_hash=? AND used_at IS NULL RETURNING person_id").bind(now, h).first<{ person_id: string }>();
  return r?.person_id ?? null;
}

/** Login methods that can arrive in the same inbox count as one factor. */
export const factorOf = (method: string) => (method === "email_code" || method === "head_code" ? "code" : method);
const STRONG_WINDOW_MS = 15 * 60_000;

/** `priorToken`: the session this browser already had, if any; a login made on top of it is linked. */
export async function newSession(env: Env, db: D1Database, personId: string, method: string, now = new Date(), priorToken?: string | null): Promise<string> {
  const token = randomToken();
  let parent: string | null = null;
  if (priorToken) {
    const h = await hmacHex(env.CONTINUITY_KEY, "session", priorToken);
    const prior = await db.prepare("SELECT token_hash FROM sessions WHERE token_hash=? AND person_id=? AND revoked_at IS NULL AND expires_at>?").bind(h, personId, nowIso(now)).first<{ token_hash: string }>();
    parent = prior?.token_hash ?? null;
  }
  await db
    .prepare("INSERT INTO sessions(token_hash, person_id, method, created_at, expires_at, parent_hash) VALUES (?,?,?,?,?,?)")
    .bind(await hmacHex(env.CONTINUITY_KEY, "session", token), personId, method, nowIso(now), nowIso(new Date(now.getTime() + SESSION_DAYS * DAY)), parent)
    .run();
  return token;
}

/** `methods`: the factors used in THIS browser's chain of logins within the last 15 minutes. */
export async function sessionPerson(env: Env, db: D1Database, token: string | null, now = nowIso()): Promise<{ personId: string; methods: string[] } | null> {
  if (!token) return null;
  const h = await hmacHex(env.CONTINUITY_KEY, "session", token);
  const s = await db.prepare("SELECT s.person_id FROM sessions s JOIN people p ON p.id=s.person_id WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>? AND p.removed_at IS NULL").bind(h, now).first<{ person_id: string }>();
  if (!s) return null;
  const since = nowIso(new Date(Date.parse(now) - STRONG_WINDOW_MS));
  const { results } = await db
    .prepare(
      "WITH RECURSIVE chain(token_hash, parent_hash, method, created_at, depth) AS (" +
        "SELECT token_hash, parent_hash, method, created_at, 0 FROM sessions WHERE token_hash=? " +
        "UNION ALL SELECT x.token_hash, x.parent_hash, x.method, x.created_at, c.depth+1 FROM sessions x JOIN chain c ON x.token_hash=c.parent_hash " +
        "WHERE x.person_id=? AND x.revoked_at IS NULL AND c.depth<5) " +
        "SELECT DISTINCT method FROM chain WHERE created_at>?",
    )
    .bind(h, s.person_id, since)
    .all<{ method: string }>();
  return { personId: s.person_id, methods: [...new Set(results.map((r) => factorOf(r.method)))] };
}

export async function endSession(env: Env, db: D1Database, token: string): Promise<void> {
  await db.prepare("UPDATE sessions SET revoked_at=? WHERE token_hash=?").bind(nowIso(), await hmacHex(env.CONTINUITY_KEY, "session", token)).run();
}

export async function revokeEndpoint(db: D1Database, personId: string, registrationId: string): Promise<boolean> {
  const r = await db.prepare("UPDATE delivery_registrations SET status='revoked' WHERE id=? AND person_id=? AND status<>'revoked' RETURNING suppress_hash").bind(registrationId, personId).first<{ suppress_hash: string }>();
  if (!r) return false;
  await db.prepare("INSERT OR IGNORE INTO suppressions(address_hash, scope, created_at) VALUES (?, '*', ?)").bind(r.suppress_hash, nowIso()).run();
  await applyOp(db, personId, "REVOKE_ENDPOINT", null, { registrationId });
  return true;
}

// ---- membership attestations (club-issued, separate from follows) -----------------------------

/** Issue/refresh the automatic 'member' attestation from current group access; expire it if gone. */
export async function refreshMembership(db: D1Database, personId: string, m: Member | null, now = new Date()): Promise<void> {
  const hasAccess = !!m && !m.removed_at && (await readable(db, m)).size > 0;
  const live = await db.prepare("SELECT id FROM membership_attestations WHERE person_id=? AND basis='group_access' AND status='active' AND expires_at>?").bind(personId, nowIso(now)).first<{ id: string }>();
  if (hasAccess && !live) {
    await db.prepare("INSERT INTO membership_attestations(id, person_id, tier, status, basis, issued_at, expires_at) VALUES (?,?, 'member', 'active', 'group_access', ?, ?)").bind(newId(), personId, nowIso(now), nowIso(new Date(now.getTime() + ATTESTATION_DAYS * DAY))).run();
  } else if (!hasAccess && live) {
    await db.prepare("UPDATE membership_attestations SET status='revoked', revoked_at=? WHERE id=?").bind(nowIso(now), live.id).run();
  }
}

export async function activeAttestations(db: D1Database, personId: string, now = nowIso()) {
  return (await db.prepare("SELECT id, tier, scope, basis, issued_at, expires_at FROM membership_attestations WHERE person_id=? AND status='active' AND expires_at>? ORDER BY issued_at DESC").bind(personId, now).all<{ id: string; tier: string; scope: string; basis: string; issued_at: string; expires_at: string }>()).results;
}

// ---- truthful protection status (CONT-3 gate: "protected" only after real verification) -------

export interface Protection {
  enrolled: boolean;
  independentLogin: boolean; // any verified head, unused recovery codes, TOTP or a device key
  alternateDelivery: boolean; // a verified head AND following 'critical' AND not suppressed
  recoveryCodes: number;
  emails: { id: string; address: string; status: string }[];
  heads: { id: string; channel: string; address: string; status: string; health: string; domains: string[] }[];
  factors: { id: string; kind: string; label: string | null }[];
  topics: Record<string, string>;
  level: "not_enrolled" | "not_yet_protected" | "login_only" | "protected";
}

export async function protection(env: Env, db: D1Database, personId: string | null): Promise<Protection> {
  if (!personId) return { enrolled: false, independentLogin: false, alternateDelivery: false, recoveryCodes: 0, emails: [], heads: [], factors: [], topics: {}, level: "not_enrolled" };
  const regs = (await db.prepare("SELECT id, channel, address_enc, suppress_hash, status, health, domains FROM delivery_registrations WHERE person_id=? AND channel<>'telegram' AND status<>'revoked' ORDER BY created_at").bind(personId).all<{ id: string; channel: string; address_enc: string; suppress_hash: string; status: string; health: string; domains: string | null }>()).results;
  const factors = (await db.prepare("SELECT id, kind, label FROM login_factors WHERE person_id=? AND status='active'").bind(personId).all<{ id: string; kind: string; label: string | null }>()).results;
  const codes = (await db.prepare("SELECT COUNT(*) AS n FROM recovery_codes WHERE person_id=? AND used_at IS NULL").bind(personId).first<{ n: number }>())?.n ?? 0;
  const topics = await follows(db, personId);
  const verified = regs.filter((r) => r.status === "verified");
  let alt = false;
  if (topics.critical === "following") for (const r of verified) if (!(await suppressed(db, r.suppress_hash, "critical"))) alt = true;
  const login = verified.length > 0 || codes > 0 || factors.length > 0;
  const heads = await Promise.all(regs.map(async (r) => ({ id: r.id, channel: r.channel, address: displayAddress(r.channel, await open(env.CONTINUITY_KEY, r.address_enc)), status: r.status, health: r.health, domains: JSON.parse(r.domains ?? "[]") as string[] })));
  const emails = heads.filter((h) => h.channel === "email").map(({ id, address, status }) => ({ id, address, status }));
  return { enrolled: true, independentLogin: login, alternateDelivery: alt, recoveryCodes: codes, emails, heads, factors, topics, level: login && alt ? "protected" : login ? "login_only" : "not_yet_protected" };
}

/** Push endpoints are long capability URLs: show only the service. */
function displayAddress(channel: string, a: string): string {
  if (channel !== "webpush") return a;
  try {
    return `browser push (${new URL(a).hostname})`;
  } catch {
    return "browser push";
  }
}

/** Personal export (free, always available): everything we hold about this person's relationship. */
export async function personalExport(env: Env, db: D1Database, personId: string): Promise<Record<string, unknown>> {
  const p = await protection(env, db, personId);
  const ops = (await db.prepare("SELECT seq, op, topic, consent_version, at FROM subscription_ops WHERE person_id=? ORDER BY seq").bind(personId).all()).results;
  return {
    schema: "nexus.person-export.v1",
    exported_at: nowIso(),
    person_ref: personId,
    channels: p.heads.map((e) => ({ channel: e.channel, address: e.address, status: e.status, domains: e.domains })),
    follows: p.topics,
    ops,
    memberships: await activeAttestations(db, personId),
  };
}

/**
 * Forget a person (/forget_me, portal, Mini App). Addresses, codes, sessions, follows and links
 * go; what stays is a suppression tombstone per address (so nothing can switch delivery back on)
 * and the bare `people` row marked removed. Restoring an older database copy can bring rows back;
 * the runbook's restore step re-imports the latest export, whose tombstones win (plan §7 flow D).
 */
export async function forgetPerson(db: D1Database, personId: string): Promise<void> {
  const now = nowIso();
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO suppressions(address_hash, scope, created_at) SELECT suppress_hash, '*', ? FROM delivery_registrations WHERE person_id=?").bind(now, personId),
    // This person's codes only: their heads' codes and their passport-id login codes ('h:<person>').
    db.prepare("DELETE FROM login_codes WHERE registration_id IN (SELECT id FROM delivery_registrations WHERE person_id=?) OR registration_id=?").bind(personId, `h:${personId}`),
    db.prepare("DELETE FROM delivery_registrations WHERE person_id=?").bind(personId),
    db.prepare("DELETE FROM recovery_codes WHERE person_id=?").bind(personId),
    db.prepare("UPDATE login_factors SET status='revoked', secret_enc=NULL WHERE person_id=?").bind(personId),
    db.prepare("UPDATE guardians SET status='removed' WHERE person_id=? OR guardian_id=?").bind(personId, personId),
    db.prepare("UPDATE buddies SET status='ended' WHERE inviter=? OR invitee=?").bind(personId, personId),
    db.prepare("UPDATE recovery_requests SET state='cancelled' WHERE person_id=? AND state='open'").bind(personId),
    db.prepare("UPDATE sessions SET revoked_at=? WHERE person_id=? AND revoked_at IS NULL").bind(now, personId),
    db.prepare("DELETE FROM follow_state WHERE person_id=?").bind(personId),
    db.prepare("DELETE FROM subscription_ops WHERE person_id=?").bind(personId),
    db.prepare("UPDATE membership_attestations SET status='revoked', revoked_at=? WHERE person_id=? AND status='active'").bind(now, personId),
    db.prepare("UPDATE identity_links SET revoked_at=? WHERE person_id=? AND revoked_at IS NULL").bind(now, personId),
    db.prepare("UPDATE people SET removed_at=? WHERE id=?").bind(now, personId),
  ]);
  await audit(db, "passport.forget", personId, personId);
}
