// H2 login heads and H5 social recovery: ways to prove "it's me" with Telegram AND email gone.
//   passport id   short public handle ("TP-7K2Q-9MXD") a person can type on any login page
//   TOTP          authenticator app (RFC 6238, HMAC-SHA1, 30 s, ±1 step, replay-guarded)
//   device key    non-extractable ECDSA P-256 key kept in the member's browser; signs a challenge
//   code over any head   a one-time code sent to every healthy head (push, ntfy, Matrix, SMS…)
//   guardians     k of n people the member chose approve; the member's own heads get 24 h to cancel
// Same answers whether or not a handle exists; every factor is rate-limited.

import type { App } from "../bot";
import { effectStatement } from "../outbox";
import { escapeHtml } from "../text";
import { audit, DAY, HOUR, newId, nowIso } from "../util";
import { hmacHex, numericCode, open, randomToken, seal } from "../continuity/crypto";
import { CODE_MAX_ATTEMPTS, CODE_TTL_MS, CODES_PER_HOUR } from "../continuity/people";
import { deliver, type RegRow } from "./deliver";
import { unb64u } from "./webpush";

const ALPHA = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
export const RECOVERY_DELAY_MS = DAY;
export const RECOVERY_TTL_MS = 7 * DAY;

// ---- passport id ---------------------------------------------------------------------------------

export async function ensureHandle(db: D1Database, personId: string): Promise<string> {
  const have = await db.prepare("SELECT handle FROM people WHERE id=?").bind(personId).first<{ handle: string | null }>();
  if (have?.handle) return have.handle;
  for (let i = 0; i < 5; i++) {
    const r = crypto.getRandomValues(new Uint8Array(8));
    const s = [...r].map((x) => ALPHA[x % ALPHA.length]).join("");
    const h = `TP-${s.slice(0, 4)}-${s.slice(4)}`;
    const ok = await db.prepare("UPDATE people SET handle=? WHERE id=? AND handle IS NULL AND NOT EXISTS (SELECT 1 FROM people WHERE handle=?) RETURNING handle").bind(h, personId, h).first<{ handle: string }>();
    if (ok) return ok.handle;
  }
  throw new Error("handle_collision");
}

export const normHandle = (h: string) => h.trim().toUpperCase().replace(/\s+/g, "");

export async function personByHandle(db: D1Database, handle: string): Promise<string | null> {
  const r = await db.prepare("SELECT id FROM people WHERE handle=? AND removed_at IS NULL").bind(normHandle(handle)).first<{ id: string }>();
  return r?.id ?? null;
}

// ---- TOTP ------------------------------------------------------------------------------------------

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function unbase32(s: string): Uint8Array {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, "");
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const c of clean) {
    value = (value << 5) | B32.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export async function totp(secret: Uint8Array, step: number): Promise<string> {
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setUint32(4, step >>> 0);
  new DataView(msg.buffer).setUint32(0, Math.floor(step / 2 ** 32));
  const k = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const h = new Uint8Array(await crypto.subtle.sign("HMAC", k, msg));
  const o = h[19]! & 15;
  const n = (((h[o]! & 127) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!) % 1_000_000;
  return String(n).padStart(6, "0");
}

export async function enrolTotp(app: App, personId: string, label = "Authenticator"): Promise<{ id: string; secret: string; uri: string }> {
  const n = await app.db.prepare("SELECT COUNT(*) AS n FROM login_factors WHERE person_id=? AND kind='totp' AND status<>'revoked'").bind(personId).first<{ n: number }>();
  if ((n?.n ?? 0) >= 3) throw new LoginError("too_many_factors");
  const secret = base32(crypto.getRandomValues(new Uint8Array(20)));
  const id = newId();
  await app.db.prepare("INSERT INTO login_factors(id, person_id, kind, secret_enc, label, status, created_at) VALUES (?,?, 'totp', ?, ?, 'pending', ?)").bind(id, personId, await seal(app.env.CONTINUITY_KEY, secret), label.slice(0, 40), nowIso()).run();
  const handle = await ensureHandle(app.db, personId);
  const issuer = encodeURIComponent(app.env.COMMUNITY_LABEL || "Community");
  return { id, secret, uri: `otpauth://totp/${issuer}:${handle}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30` };
}

export class LoginError extends Error {}

/** Check a TOTP code against one factor; advances the replay guard on success. */
async function checkTotp(app: App, f: { id: string; secret_enc: string; last_step: number }, code: string, now: number): Promise<boolean> {
  const secret = unbase32(await open(app.env.CONTINUITY_KEY, f.secret_enc));
  const step = Math.floor(now / 30_000);
  for (const s of [step, step - 1, step + 1]) {
    if (s <= f.last_step) continue;
    if ((await totp(secret, s)) === code.trim()) {
      const r = await app.db.prepare("UPDATE login_factors SET last_step=?, failures=0, last_used_at=? WHERE id=? AND last_step<? RETURNING id").bind(s, nowIso(new Date(now)), f.id, s).first();
      return !!r;
    }
  }
  return false;
}

export async function confirmTotp(app: App, personId: string, factorId: string, code: string, now = Date.now()): Promise<boolean> {
  const f = await app.db.prepare("SELECT id, secret_enc, last_step FROM login_factors WHERE id=? AND person_id=? AND kind='totp' AND status='pending'").bind(factorId, personId).first<{ id: string; secret_enc: string; last_step: number }>();
  if (!f || !(await checkTotp(app, f, code, now))) return false;
  await app.db.prepare("UPDATE login_factors SET status='active' WHERE id=?").bind(factorId).run();
  await audit(app.db, "hydra.factor.totp", personId, factorId);
  return true;
}

/** Passport id + authenticator code → person, or null. Five failures lock the factor for 15 min. */
export async function loginTotp(app: App, handle: string, code: string, now = Date.now()): Promise<string | null> {
  const person = await personByHandle(app.db, handle);
  if (!person || !/^\d{6}$/.test(code.trim())) return null;
  const factors = (await app.db.prepare("SELECT id, secret_enc, last_step, failures, locked_until FROM login_factors WHERE person_id=? AND kind='totp' AND status='active'").bind(person).all<{ id: string; secret_enc: string; last_step: number; failures: number; locked_until: string | null }>()).results;
  for (const f of factors) {
    if (f.locked_until && f.locked_until > nowIso(new Date(now))) continue;
    if (await checkTotp(app, f, code, now)) return person;
    await app.db.prepare("UPDATE login_factors SET failures=failures+1, locked_until=CASE WHEN failures+1>=5 THEN ? ELSE locked_until END WHERE id=?").bind(nowIso(new Date(now + 15 * 60_000)), f.id).run();
  }
  return null;
}

// ---- device key ----------------------------------------------------------------------------------

export async function challenge(db: D1Database, now = Date.now()): Promise<{ id: string; nonce: string }> {
  const c = { id: newId(), nonce: randomToken() };
  await db.batch([
    db.prepare("DELETE FROM login_challenges WHERE expires_at<?").bind(nowIso(new Date(now))),
    db.prepare("INSERT INTO login_challenges(id, nonce, expires_at) VALUES (?,?,?)").bind(c.id, c.nonce, nowIso(new Date(now + 5 * 60_000))),
  ]);
  return c;
}

export async function registerDevice(app: App, personId: string, jwk: unknown, label: string): Promise<string> {
  const j = jwk as JsonWebKey;
  if (!j || j.kty !== "EC" || j.crv !== "P-256" || typeof j.x !== "string" || typeof j.y !== "string" || "d" in j) throw new LoginError("jwk");
  await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: j.x, y: j.y }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]).catch(() => {
    throw new LoginError("jwk");
  });
  const n = await app.db.prepare("SELECT COUNT(*) AS n FROM login_factors WHERE person_id=? AND kind='device_key' AND status='active'").bind(personId).first<{ n: number }>();
  if ((n?.n ?? 0) >= 5) throw new LoginError("too_many_factors");
  const id = newId();
  await app.db.prepare("INSERT INTO login_factors(id, person_id, kind, public_jwk, label, status, created_at) VALUES (?,?, 'device_key', ?, ?, 'active', ?)").bind(id, personId, JSON.stringify({ kty: "EC", crv: "P-256", x: j.x, y: j.y }), label.slice(0, 40) || "This device", nowIso()).run();
  await audit(app.db, "hydra.factor.device", personId, id);
  return id;
}

/** Signature (IEEE P1363 r||s, base64url) over "nexus-login:<nonce>" by a registered device key. */
export async function loginDevice(app: App, factorId: string, challengeId: string, sig: string, now = Date.now()): Promise<string | null> {
  const c = await app.db.prepare("UPDATE login_challenges SET used_at=? WHERE id=? AND used_at IS NULL AND expires_at>? RETURNING nonce").bind(nowIso(new Date(now)), challengeId, nowIso(new Date(now))).first<{ nonce: string }>();
  if (!c) return null;
  const f = await app.db.prepare("SELECT person_id, public_jwk FROM login_factors WHERE id=? AND kind='device_key' AND status='active'").bind(factorId).first<{ person_id: string; public_jwk: string }>();
  if (!f) return null;
  try {
    const key = await crypto.subtle.importKey("jwk", JSON.parse(f.public_jwk), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    if (!(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, unb64u(sig), new TextEncoder().encode(`nexus-login:${c.nonce}`)))) return null;
  } catch {
    return null;
  }
  await app.db.prepare("UPDATE login_factors SET last_used_at=? WHERE id=?").bind(nowIso(new Date(now)), factorId).run();
  return f.person_id;
}

export async function revokeFactor(db: D1Database, personId: string, id: string): Promise<boolean> {
  return !!(await db.prepare("UPDATE login_factors SET status='revoked', secret_enc=NULL WHERE id=? AND person_id=? AND status<>'revoked' RETURNING id").bind(id, personId).first());
}

// ---- reaching a person over whatever still works ------------------------------------------------

/** Send to up to `max` healthy non-Telegram heads, plus Telegram via the effect ledger. */
export async function notifyPerson(app: App, personId: string, title: string, text: string, key: string, max = 2): Promise<{ sent: number; keys: string[] }> {
  const regs = (await app.db.prepare("SELECT id, person_id, channel, address_enc, meta_enc, domains FROM delivery_registrations WHERE person_id=? AND status='verified' AND health<>'dead' AND channel<>'telegram' ORDER BY (health='ok') DESC, verified_at").bind(personId).all<RegRow>()).results;
  let sent = 0;
  for (const r of regs.slice(0, max)) {
    const res = await deliver(app, r, { title, text });
    if (res === "sent" || res === "logged") sent++;
  }
  const keys: string[] = [];
  const tg = await app.db.prepare("SELECT m.tg_id FROM identity_links l JOIN members m ON m.id=l.account_id WHERE l.person_id=? AND l.platform='telegram' AND l.revoked_at IS NULL AND m.removed_at IS NULL").bind(personId).first<{ tg_id: number }>();
  if (tg) {
    await effectStatement(app.db, key, tg.tg_id, { text: escapeHtml(`${title}\n\n${text}`) }).run();
    keys.push(key);
    sent++;
  }
  return { sent, keys };
}

// ---- one-time code over any head ----------------------------------------------------------------

/** Start a login by passport id. Always returns a ticket; only a real handle gets codes sent. */
export async function requestHandleLogin(app: App, handle: string, now = new Date()): Promise<{ ticket: string; keys: string[] }> {
  const person = await personByHandle(app.db, handle);
  const fake = { ticket: newId(), keys: [] };
  if (!person) return fake;
  const reg = `h:${person}`;
  const recent = await app.db.prepare("SELECT COUNT(*) AS n FROM login_codes WHERE registration_id=? AND expires_at>?").bind(reg, nowIso(new Date(now.getTime() - HOUR + CODE_TTL_MS))).first<{ n: number }>();
  if ((recent?.n ?? 0) >= CODES_PER_HOUR) return fake;
  const code = numericCode();
  const id = newId();
  await app.db.prepare("INSERT INTO login_codes(id, registration_id, code_hash, purpose, expires_at) VALUES (?,?,?, 'login', ?)").bind(id, reg, await hmacHex(app.env.CONTINUITY_KEY, "code", `${reg}:${code}`), nowIso(new Date(now.getTime() + CODE_TTL_MS))).run();
  const label = app.env.COMMUNITY_LABEL || "your community";
  const r = await notifyPerson(app, person, `${label}: your login code ${code}`, `Your ${label} login code is ${code}. It expires in 10 minutes. If you didn't ask for it, ignore this message.`, `login:${id}`);
  return { ticket: id, keys: r.keys };
}

export async function checkHandleCode(app: App, ticket: string, code: string, now = new Date()): Promise<string | null> {
  const row = await app.db.prepare("SELECT id, registration_id, code_hash, attempts FROM login_codes WHERE id=? AND purpose='login' AND used_at IS NULL AND expires_at>? AND registration_id LIKE 'h:%'").bind(ticket, nowIso(now)).first<{ id: string; registration_id: string; code_hash: string; attempts: number }>();
  if (!row || row.attempts >= CODE_MAX_ATTEMPTS) return null;
  const ok = row.code_hash === (await hmacHex(app.env.CONTINUITY_KEY, "code", `${row.registration_id}:${code.trim()}`));
  // Atomic: parallel requests can't each pass the checks above and all use the same code.
  const won = await app.db.prepare(`UPDATE login_codes SET attempts=attempts+1${ok ? ", used_at=?" : ""} WHERE id=? AND used_at IS NULL AND attempts<? RETURNING id`).bind(...(ok ? [nowIso(now), row.id] : [row.id]), CODE_MAX_ATTEMPTS).first();
  return ok && won ? row.registration_id.slice(2) : null;
}

// ---- guardians (H5 social recovery) -------------------------------------------------------------

export async function addGuardian(app: App, personId: string, guardianHandle: string): Promise<boolean> {
  const g = await personByHandle(app.db, guardianHandle);
  if (!g || g === personId) return false;
  const n = await app.db.prepare("SELECT COUNT(*) AS n FROM guardians WHERE person_id=? AND status<>'removed'").bind(personId).first<{ n: number }>();
  if ((n?.n ?? 0) >= 7) return false;
  await app.db.prepare("INSERT INTO guardians(person_id, guardian_id, status, created_at) VALUES (?,?, 'invited', ?) ON CONFLICT(person_id, guardian_id) DO UPDATE SET status=CASE WHEN guardians.status='active' THEN 'active' ELSE 'invited' END").bind(personId, g, nowIso()).run();
  return true;
}

export async function answerGuardian(db: D1Database, guardianId: string, personHandle: string, accept: boolean): Promise<boolean> {
  const p = await personByHandle(db, personHandle);
  if (!p) return false;
  return !!(await db.prepare("UPDATE guardians SET status=? WHERE person_id=? AND guardian_id=? AND status='invited' RETURNING person_id").bind(accept ? "active" : "removed", p, guardianId).first());
}

export async function removeGuardian(db: D1Database, personId: string, guardianHandle: string): Promise<boolean> {
  const g = await personByHandle(db, guardianHandle);
  return !!g && !!(await db.prepare("UPDATE guardians SET status='removed' WHERE person_id=? AND guardian_id=? AND status<>'removed' RETURNING person_id").bind(personId, g).first());
}

export async function setGuardianK(db: D1Database, personId: string, k: number): Promise<boolean> {
  const n = (await db.prepare("SELECT COUNT(*) AS n FROM guardians WHERE person_id=? AND status='active'").bind(personId).first<{ n: number }>())?.n ?? 0;
  if (!Number.isInteger(k) || k < 2 || k > n) return false;
  await db.prepare("UPDATE people SET guardian_k=? WHERE id=?").bind(k, personId).run();
  return true;
}

export async function guardianView(db: D1Database, personId: string): Promise<{ k: number; mine: { handle: string; status: string }[]; guarding: { handle: string; status: string; requests: { id: string; approved: boolean; not_before: string }[] }[] }> {
  const k = (await db.prepare("SELECT guardian_k FROM people WHERE id=?").bind(personId).first<{ guardian_k: number }>())?.guardian_k ?? 0;
  const mine = (await db.prepare("SELECT p.handle, g.status FROM guardians g JOIN people p ON p.id=g.guardian_id WHERE g.person_id=? AND g.status<>'removed'").bind(personId).all<{ handle: string; status: string }>()).results;
  const g = (await db.prepare("SELECT g.person_id, p.handle, g.status FROM guardians g JOIN people p ON p.id=g.person_id WHERE g.guardian_id=? AND g.status<>'removed' AND p.removed_at IS NULL").bind(personId).all<{ person_id: string; handle: string; status: string }>()).results;
  const guarding = await Promise.all(
    g.map(async (x) => ({
      handle: x.handle,
      status: x.status,
      requests:
        x.status === "active"
          ? (
              await db
                .prepare("SELECT r.id, r.not_before, EXISTS (SELECT 1 FROM recovery_approvals a WHERE a.request_id=r.id AND a.guardian_id=?) AS approved FROM recovery_requests r WHERE r.person_id=? AND r.state='open' AND r.expires_at>?")
                .bind(personId, x.person_id, nowIso())
                .all<{ id: string; not_before: string; approved: number }>()
            ).results.map((r) => ({ id: r.id, not_before: r.not_before, approved: !!r.approved }))
          : [],
    })),
  );
  return { k, mine, guarding };
}

/** Anyone can start a recovery for a handle; it only ever works with k guardian approvals + 24 h. */
export async function startRecovery(app: App, handle: string, now = new Date()): Promise<{ ticket: string; keys: string[] }> {
  const ticket = randomToken();
  const person = await personByHandle(app.db, handle);
  if (!person) return { ticket, keys: [] };
  const k = (await app.db.prepare("SELECT guardian_k FROM people WHERE id=?").bind(person).first<{ guardian_k: number }>())?.guardian_k ?? 0;
  const guardians = (await app.db.prepare("SELECT guardian_id FROM guardians WHERE person_id=? AND status='active'").bind(person).all<{ guardian_id: string }>()).results;
  const open_ = await app.db.prepare("SELECT 1 FROM recovery_requests WHERE person_id=? AND state='open' AND expires_at>?").bind(person, nowIso(now)).first();
  if (k < 2 || guardians.length < k || open_) return { ticket, keys: [] };
  const id = newId();
  const cancel = randomToken();
  await app.db
    .prepare("INSERT INTO recovery_requests(id, person_id, ticket_hash, cancel_hash, state, created_at, not_before, expires_at) VALUES (?,?,?,?, 'open', ?,?,?)")
    .bind(id, person, await hmacHex(app.env.CONTINUITY_KEY, "recovery-ticket", ticket), await hmacHex(app.env.CONTINUITY_KEY, "recovery-cancel", cancel), nowIso(now), nowIso(new Date(now.getTime() + RECOVERY_DELAY_MS)), nowIso(new Date(now.getTime() + RECOVERY_TTL_MS)))
    .run();
  const o = (app.env.PUBLIC_URL ?? "").replace(/\/$/, "");
  const label = app.env.COMMUNITY_LABEL || "Your community";
  const keys: string[] = [];
  // The person first: if this wasn't them, one tap stops it.
  keys.push(...(await notifyPerson(app, person, `${label}: someone asked to recover your access`, `A recovery of your passport ${normHandle(handle)} through your guardians was started. If this was you, nothing to do. If not, stop it now: ${o}/portal/recovery/cancel?t=${id}.${cancel}`, `rec:${id}:self`, 3)).keys);
  for (const g of guardians) {
    keys.push(...(await notifyPerson(app, g.guardian_id, `${label}: a recovery needs your approval`, `${normHandle(handle)} asked to recover their access. Approve it only if they contacted you directly and you're sure it's them. Open your portal: ${o}/portal`, `rec:${id}:${g.guardian_id}`, 1)).keys);
  }
  await audit(app.db, "hydra.recovery.start", "anonymous", id, { guardians: guardians.length, k });
  return { ticket, keys };
}

export async function approveRecovery(db: D1Database, guardianId: string, requestId: string, now = new Date()): Promise<boolean> {
  const r = await db.prepare("SELECT r.person_id FROM recovery_requests r JOIN guardians g ON g.person_id=r.person_id AND g.guardian_id=? AND g.status='active' WHERE r.id=? AND r.state='open' AND r.expires_at>?").bind(guardianId, requestId, nowIso(now)).first<{ person_id: string }>();
  if (!r) return false;
  await db.prepare("INSERT OR IGNORE INTO recovery_approvals(request_id, guardian_id, at) VALUES (?,?,?)").bind(requestId, guardianId, nowIso(now)).run();
  await audit(db, "hydra.recovery.approve", guardianId, requestId);
  return true;
}

export async function cancelRecovery(app: App, token: string): Promise<boolean> {
  const [id, cancel] = token.split(".");
  if (!id || !cancel) return false;
  return !!(await app.db.prepare("UPDATE recovery_requests SET state='cancelled' WHERE id=? AND cancel_hash=? AND state='open' RETURNING id").bind(id, await hmacHex(app.env.CONTINUITY_KEY, "recovery-cancel", cancel)).first());
}

export async function cancelOwnRecoveries(db: D1Database, personId: string): Promise<number> {
  return (await db.prepare("UPDATE recovery_requests SET state='cancelled' WHERE person_id=? AND state='open'").bind(personId).run()).meta.changes;
}

/** The requester polls with their ticket; after k approvals and the waiting period it becomes a login. */
export async function claimRecovery(app: App, ticket: string, now = new Date()): Promise<{ status: "waiting" | "ready" | "invalid"; approvals?: number; needed?: number; notBefore?: string; personId?: string }> {
  const r = await app.db.prepare("SELECT r.id, r.person_id, r.not_before, r.expires_at, p.guardian_k FROM recovery_requests r JOIN people p ON p.id=r.person_id WHERE r.ticket_hash=? AND r.state='open'").bind(await hmacHex(app.env.CONTINUITY_KEY, "recovery-ticket", ticket)).first<{ id: string; person_id: string; not_before: string; expires_at: string; guardian_k: number }>();
  if (!r || r.expires_at <= nowIso(now)) return { status: "invalid" };
  // Only approvals from guardians who are still active count.
  const a = (await app.db.prepare("SELECT COUNT(*) AS n FROM recovery_approvals a JOIN guardians g ON g.person_id=? AND g.guardian_id=a.guardian_id AND g.status='active' WHERE a.request_id=?").bind(r.person_id, r.id).first<{ n: number }>())?.n ?? 0;
  if (a < r.guardian_k || nowIso(now) < r.not_before) return { status: "waiting", approvals: a, needed: r.guardian_k, notBefore: r.not_before };
  const claimed = await app.db.prepare("UPDATE recovery_requests SET state='claimed' WHERE id=? AND state='open' RETURNING id").bind(r.id).first();
  if (!claimed) return { status: "invalid" };
  await audit(app.db, "hydra.recovery.claim", r.person_id, r.id, { approvals: a });
  return { status: "ready", personId: r.person_id };
}


