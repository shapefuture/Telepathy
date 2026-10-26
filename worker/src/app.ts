// Telegram Mini App (P13-11, redesigned): everything a member or operator does in the bot, in
// one place. Identity comes only from Telegram's signed initData (HMAC-SHA256 with the bot
// token, core.telegram.org/bots/webapps). Every route reuses the bot's ACL and the same
// assistance actions as the inline buttons, so the app can't do anything the bot can't.

import { brief } from "./ai/beam";
import { ensureMember, langOf, memberByTg, readable, type Member } from "./acl";
import { deskAction, deskActions, exchangeAction, forgetMissions, gapAction, jobLabel, memberAction, offerChoice, rateMission, short } from "./assist/actions";
import { addOffer, listOffers, MODES, withdrawOffer, type CommitmentMode } from "./assist/capacity";
import { bucket, openGaps } from "./assist/gaps";
import { A } from "./assist/i18n";
import { balances, formatAmount, parsePrice } from "./assist/ledger";
import { createDraft, getMission, isTerminal, MissionError, report, type Mission } from "./assist/missions";
import { rateOk, status, type App } from "./bot";
import { build as buildDigest } from "./digest";
import { ownerIds, timezone, type Env } from "./env";
import { label, labelIn, resolveSkill, TAXONOMY } from "./experts";
import { upcomingEvents, toIcs } from "./features";
import { eligiblePartners, fedEnabled, partnerList } from "./federation/gateway";
import { recordAnswer, vote } from "./feedback";
import { T, type Lang } from "./i18n";
import { act as introAct, cancelNeed } from "./intros";
import { citation } from "./ingest";
import { dispatchPending } from "./outbox";
import { forgetMember } from "./rights";
import { HISTORY_PAGE_MAX, historyGroups, perDay, resetHistory, stagePage } from "./history";
import { mcpOn, startAuto } from "./history-mcp";
import { answer, parseFilters } from "./search";
import { createTelegram, type Fetcher } from "./telegram";
import { audit, DAY, HOUR, localParts, nowIso, safeEqual } from "./util";
import { PAGE } from "./app-page";
import { hydraAuthed } from "./hydra/portal";
import { activeAttestations, addEmail, checkCode, ContinuityError, enrolFromTelegram, follows, forgetPerson, newRecoveryCodes, personalExport, personForMember, protection, refreshMembership, revokeEndpoint, setTopic, TOPICS, type Topic } from "./continuity/people";
import { currentManifest } from "./continuity/identity";
import { issuePass } from "./continuity/passport";

export const INIT_DATA_MAX_AGE_S = 24 * 3600;

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(data));
}

export interface InitUser {
  id: number;
  username?: string;
  startParam?: string;
}

/** The Telegram user if initData is authentic and fresh, else null. */
export async function verifyInitUser(initData: string, botToken: string, nowS = Math.floor(Date.now() / 1000)): Promise<InitUser | null> {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = await hmac(enc.encode("WebAppData"), botToken);
  if (!safeEqual(hex(await hmac(secret, check)), hash)) return null;
  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate) || nowS - authDate > INIT_DATA_MAX_AGE_S) return null;
  try {
    const u = JSON.parse(params.get("user") ?? "{}") as { id?: unknown; username?: unknown };
    const id = Number(u.id);
    if (!Number.isInteger(id) || id <= 0) return null;
    const username = typeof u.username === "string" && /^[A-Za-z0-9_]{4,32}$/.test(u.username) ? u.username : undefined;
    return { id, username, startParam: params.get("start_param") ?? undefined };
  } catch {
    return null;
  }
}

/** Kept for callers that only need the id. */
export async function verifyInitData(initData: string, botToken: string, nowS?: number): Promise<number | null> {
  return (await verifyInitUser(initData, botToken, nowS))?.id ?? null;
}

const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const FLAGS = ["digest", "discoverable", "available", "reminders", "routing"] as const;
const CASE_TYPES = ["knowledge_answer", "qualified_expert_review", "warm_intro", "reserved_office_hour", "small_panel", "commercial_project"];
const LIVE = "status NOT IN ('closed','cancelled','expired','failed_with_explanation')";

/** Which member buttons apply to a mission in this status (mirrors the bot's flow). */
function memberActs(m: Mission, hasPartners: boolean): string[] {
  if (m.status === "draft") return ["ok", "x"];
  if (m.status === "local_investigation") return ["solved", "more", "x"];
  if (m.status === "external_permission_needed" || m.status === "no_eligible_provider") return hasPartners ? ["pv", "x"] : ["x"];
  if (m.status === "delivered") return ["rate"];
  return isTerminal(m) ? [] : ["x"];
}

const quotesOut = (qs: { text: string; label: string | null; event_at: string; url: string | null; tag?: string }[]) => qs.map(({ text, label, event_at, url, tag }) => ({ text, label, event_at, url, tag }));

export async function handleApp(req: Request, env: Env, fetcher?: Fetcher, net?: Fetcher): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/app") {
    return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": CSP, "referrer-policy": "no-referrer" } });
  }
  const user = await verifyInitUser(req.headers.get("x-telegram-init-data") ?? "", env.BOT_TOKEN);
  if (!user) return json({ error: "unauthorized" }, 401);
  const owner = ownerIds(env).has(user.id);
  // Owners get in on first open; everyone else becomes a member by writing in an enabled group.
  let m = await memberByTg(env.DB, user.id);
  if (!m && owner) m = await ensureMember(env.DB, user.id, "owner");
  if (!m || m.removed_at) return json({ error: "unknown member" }, 403);
  const app: App = { env, db: env.DB, tg: createTelegram(env.BOT_TOKEN, fetcher), net };
  const path = url.pathname.slice("/app/api/".length).split("/").filter(Boolean);
  let body: Record<string, unknown> = {};
  if (req.method === "POST") {
    try {
      const text = await req.text();
      // History pages carry up to 100 messages; everything else is a small form.
      if (text.length > (url.pathname === "/app/api/history/stage" ? 1_200_000 : 8192)) return json({ error: "too large" }, 413);
      body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      return json({ error: "bad json" }, 400);
    }
  }
  try {
    const r = await route(app, m, user, owner, req.method, path, body, url);
    if (r.keys?.length) await dispatchPending(app.db, app.tg, 10, r.keys).catch((e) => console.warn("app dispatch", String(e)));
    return json(r.data, r.status ?? 200);
  } catch (e) {
    console.error("app api", path.join("/"), String(e));
    return json({ error: "server error" }, 500);
  }
}

type R = { data: unknown; status?: number; keys?: string[] };
const out = (data: unknown, keys?: string[], status?: number): R => ({ data, keys, status });
const notFound = (): R => out({ error: "not found" }, undefined, 404);

async function route(app: App, m: Member, user: InitUser, owner: boolean, method: string, p: string[], body: Record<string, unknown>, url: URL): Promise<R> {
  const db = app.db;
  const lang: Lang = langOf(m);
  const a = A(lang);
  const key = `${method} ${p[0] ?? ""}`;

  // ---- profile ------------------------------------------------------------------------------
  if (key === "GET me" || key === "GET profile") {
    const skills = (await db.prepare("SELECT code FROM skills WHERE member_id=? AND state='confirmed' ORDER BY code").bind(m.id).all<{ code: string }>()).results.map((r) => r.code);
    const [req, offers, invites] = await db.batch([
      db.prepare(`SELECT COUNT(*) AS n FROM missions WHERE member_id=? AND status<>'draft' AND ${LIVE}`).bind(m.id),
      db.prepare("SELECT COUNT(*) AS n FROM exchange_offers o JOIN federation_exchanges e ON e.id=o.exchange_id JOIN missions x ON x.id=e.mission_id WHERE x.member_id=? AND o.status='received'").bind(m.id),
      db.prepare("SELECT COUNT(*) AS n FROM intros WHERE (candidate_id=? AND status='invited') OR (requester_id=? AND status IN ('accepted','mutually_confirmed'))").bind(m.id, m.id),
    ]);
    const n = (r: D1Result) => (r.results[0] as { n: number }).n;
    return out({
      lang,
      owner,
      label: app.env.COMMUNITY_LABEL || "Community",
      flags: Object.fromEntries(FLAGS.map((f) => [f, !!m[f as keyof Member]])),
      skills,
      skillLabels: skills.map((c) => ({ code: c, label: jobLabel(c, lang) })),
      counts: { requests: n(req!), offers: n(offers!), invites: n(invites!) },
      startParam: user.startParam ?? null,
      brand: app.env.BRAND_NAME || "Миндальная связь",
    });
  }
  if (key === "POST settings") {
    for (const f of FLAGS) if (typeof body[f] === "boolean") await db.prepare(`UPDATE members SET ${f}=? WHERE id=?`).bind(body[f] ? 1 : 0, m.id).run();
    if (typeof body.discoverable === "boolean") await audit(db, "consent.discovery", m.id, m.id, { granted: body.discoverable, via: "app" });
    if (body.lang === "en" || body.lang === "ru") await db.prepare("UPDATE members SET lang=?, lang_explicit=1 WHERE id=?").bind(body.lang, m.id).run();
    return out({ ok: true });
  }
  if (key === "GET skills") return out([...TAXONOMY.values()].map((s) => ({ code: s.code, label: labelIn(s, lang), full: label(s) })));
  if (key === "POST skills") {
    const code = typeof body.code === "string" ? (TAXONOMY.has(body.code) ? body.code : resolveSkill(body.code)) : null;
    if (!code) return out({ ok: false }, undefined, 400);
    if (body.on) await db.prepare("INSERT INTO skills(member_id, code, state, kind) VALUES (?,?,'confirmed','self_claim') ON CONFLICT(member_id, code) DO UPDATE SET state='confirmed'").bind(m.id, code).run();
    else await db.prepare("DELETE FROM skills WHERE member_id=? AND code=?").bind(m.id, code).run();
    return out({ ok: true, code });
  }
  if (key === "GET privacy") return out({ html: T(lang).privacy });
  if (key === "POST forget") {
    if (body.confirm !== "forget") return out({ ok: false }, undefined, 400);
    const keys = await forgetMissions(app, m.id);
    const personId = await personForMember(db, m.id);
    if (personId) await forgetPerson(db, personId);
    const r = await forgetMember(db, m.id, m.tg_id);
    return out({ ok: true, ...r }, keys);
  }

  // ---- passport (CONT-2..4, 7): independent link to the club, only by the member's own action ----
  if (p[0] === "passport") {
    if (!app.env.CONTINUITY_KEY) return out({ error: "continuity off" }, undefined, 404);
    let personId = await personForMember(db, m.id);
    if (key === "GET passport" && !p[1]) {
      if (personId) await refreshMembership(db, personId, m);
      const man = await currentManifest(db);
      const partners = (await partnerList(db)).filter((x) => x.status === "active").map((x) => ({ id: x.id, label: x.brand_label }));
      return out({
        topics: TOPICS,
        protection: await protection(app.env, db, personId),
        memberships: personId ? await activeAttestations(db, personId) : [],
        destinations: man?.signed.destinations ?? [],
        manifestVersion: man?.signed.version ?? null,
        portal: app.env.PUBLIC_URL ? `${app.env.PUBLIC_URL.replace(/\/$/, "")}/portal` : null,
        partners,
      });
    }
    if (key === "POST passport" && p[1] === "enrol") {
      personId = await enrolFromTelegram(db, m);
      await refreshMembership(db, personId, m);
      // Topics chosen on the enrolment screen; nothing is pre-selected server-side.
      const chosen = Array.isArray(body.topics) ? (body.topics as unknown[]).filter((t): t is Topic => TOPICS.includes(t as Topic)) : [];
      for (const t of chosen) await setTopic(app, personId, t, true);
      return out({ ok: true });
    }
    if (!personId) return out({ error: "not enrolled" }, undefined, 409);
    // Hydra heads (more paths, authenticator, buddies, guardians, receipts): same handlers as the portal.
    if (p[1] === "h" && p[2]) {
      const res = await hydraAuthed(app, personId, method, p.slice(2).join("/"), body, (d, status = 200) => new Response(JSON.stringify(d), { status }));
      if (res) return out(await res.json(), undefined, res.status === 200 ? undefined : res.status);
      return notFound();
    }
    if (key === "POST passport" && p[1] === "email" && !p[2]) {
      try {
        const r = await addEmail(app, personId, String(body.email ?? ""));
        return out({ ok: true, registration: r.registrationId, sent: r.sent });
      } catch (e) {
        if (e instanceof ContinuityError) return out({ ok: false, reason: e.message }, undefined, 400);
        throw e;
      }
    }
    if (key === "POST passport" && p[1] === "email" && p[2] === "verify") return out({ ok: (await checkCode(app, String(body.registration ?? ""), String(body.code ?? ""), "verify", new Date(), personId)) === personId });
    if (key === "POST passport" && p[1] === "recovery") return out({ codes: await newRecoveryCodes(app.env, db, personId) });
    if (key === "POST passport" && p[1] === "topic") {
      if (!TOPICS.includes(body.topic as Topic)) return out({ ok: false }, undefined, 400);
      await setTopic(app, personId, body.topic as Topic, body.on === true);
      return out({ ok: true, topics: await follows(db, personId) });
    }
    if (key === "POST passport" && p[1] === "revoke") return out({ ok: await revokeEndpoint(db, personId, String(body.registration ?? "")) });
    if (key === "GET passport" && p[1] === "export") return out(await personalExport(app.env, db, personId));
    if (key === "POST passport" && p[1] === "pass") {
      const partner = (await partnerList(db)).find((x) => x.id === body.audience && x.status === "active");
      if (!partner) return out({ ok: false, reason: "unknown_partner" }, undefined, 400);
      const pass = await issuePass(app, personId, partner.id);
      return out(pass ? { ok: true, pass } : { ok: false, reason: "no_membership" });
    }
    if (key === "POST passport" && p[1] === "forget") {
      if (body.confirm !== "forget") return out({ ok: false }, undefined, 400);
      await forgetPerson(db, personId);
      return out({ ok: true });
    }
    return notFound();
  }

  // ---- search ------------------------------------------------------------------------------
  if (key === "GET groups") {
    const ids = [...(await readable(db, m))];
    const { results } = await db.prepare("SELECT id, title, username FROM sources WHERE enabled=1 AND id IN (SELECT value FROM json_each(?)) ORDER BY title").bind(JSON.stringify(ids)).all<{ id: string; title: string | null; username: string | null }>();
    return out(results.map((r) => ({ id: r.id, title: r.title ?? r.username ?? "group" })));
  }
  if (key === "POST ask") {
    if (!rateOk(user.id, Number(app.env.ASK_RATE_PER_MINUTE ?? "10") || 10)) return out({ error: T(lang).tooMany }, undefined, 429);
    // Filters can only narrow what the member may already read.
    let q = String(body.q ?? "").slice(0, 300);
    const allowed = await readable(db, m);
    let scope = allowed;
    if (typeof body.group === "string" && body.group) scope = allowed.has(body.group) ? new Set([body.group]) : new Set();
    if (typeof body.since === "string" && /^\d{1,3}d$/.test(body.since)) q += ` since:${body.since}`;
    if (body.file === true) q += " has:file";
    const f = await parseFilters(db, scope, q);
    const ans = await answer(db, f.readable, f.query, f.filters);
    const answerId = ans.status === "answered" ? await recordAnswer(db, m.id, ans.quotes.map((x) => x.id)) : null;
    const ai = ans.status === "answered" ? await brief(app, f.readable, f.query, ans.quotes, lang) : null;
    return out({ status: ans.status, answerId, brief: ai, quotes: quotesOut(ans.quotes), fixes: [...ans.fixes.entries()], noAnswer: T(lang).insufficient.replace(/<[^>]+>/g, "") });
  }
  if (key === "POST vote") {
    const r = await vote(db, String(body.answerId ?? ""), m.id, String(body.action ?? ""));
    return out({ result: r });
  }
  if (key === "GET catchup") {
    const w = url.searchParams.get("window") ?? "";
    const rel = /^(\d{1,2})([hd])$/.exec(w);
    const now = new Date();
    const startMs = rel ? now.getTime() - Number(rel[1]) * (rel[2] === "h" ? HOUR : DAY) : m.catchup_at ? Date.parse(m.catchup_at) : now.getTime() - DAY;
    const start = nowIso(new Date(Math.max(startMs, now.getTime() - 30 * DAY)));
    const end = nowIso(new Date(now.getTime() + 1000));
    const html = await buildDigest(db, await readable(db, m), start, end, localParts(now, timezone(app.env)).date, lang);
    await db.prepare("UPDATE members SET catchup_at=? WHERE id=?").bind(end, m.id).run();
    return out({ html });
  }

  // ---- events ------------------------------------------------------------------------------
  if (key === "GET events") {
    const evs = await upcomingEvents(db, await readable(db, m));
    return out(evs.map((e) => ({ title: e.title, starts_at: e.starts_at, url: citation(e.chat_id, e.msg_id, e.username) })));
  }
  if (key === "POST events" && p[1] === "ics") {
    const evs = await upcomingEvents(db, await readable(db, m));
    if (!evs.length) return out({ ok: false });
    await app.tg.sendFile(m.tg_id, "telepathy-events.ics", toIcs(evs), "text/calendar", T(lang).eventsIcs);
    return out({ ok: true });
  }

  // ---- requests (missions, intros) ---------------------------------------------------------
  if (key === "GET requests") {
    const { results: ms } = await db.prepare(`SELECT * FROM missions WHERE member_id=? AND (${LIVE} OR updated_at>?) ORDER BY created_at DESC LIMIT 20`).bind(m.id, nowIso(new Date(Date.now() - 30 * DAY))).all<Mission>();
    const missions = [];
    for (const x of ms) {
      const hist = (await db.prepare("SELECT to_status, at FROM mission_events WHERE mission_id=? ORDER BY id").bind(x.id).all<{ to_status: string; at: string }>()).results;
      const offers = (
        await db
          .prepare("SELECT o.id, o.summary, o.terms, g.brand_label FROM exchange_offers o JOIN federation_exchanges e ON e.id=o.exchange_id JOIN organizations g ON g.id=e.partner_id WHERE e.mission_id=? AND o.status='received'")
          .bind(x.id)
          .all<{ id: string; summary: string; terms: string; brand_label: string }>()
      ).results.map((o) => ({ id: o.id, brand: o.brand_label, summary: o.summary, terms: JSON.parse(o.terms) }));
      const hasPartners = (await eligiblePartners(app, x)).length > 0;
      missions.push({
        id: x.id,
        summary: x.summary,
        job: jobLabel(x.job_code, lang),
        status: x.status,
        statusLabel: a.status(x.status),
        created_at: x.created_at,
        history: hist.map((h) => ({ status: h.to_status, label: a.status(h.to_status), at: h.at })),
        actions: memberActs(x, hasPartners),
        offers,
      });
    }
    const needs = (await db.prepare("SELECT id, text, status FROM needs WHERE member_id=? AND status IN ('open','matching') ORDER BY created_at DESC").bind(m.id).all<{ id: string; text: string; status: string }>()).results;
    const intros = (
      await db
        .prepare(
          "SELECT i.id, i.status, i.candidate_id, n.text FROM intros i JOIN needs n ON n.id=i.need_id " +
            "WHERE (i.candidate_id=? AND i.status IN ('invited','accepted','mutually_confirmed')) OR (i.requester_id=? AND i.status IN ('accepted','mutually_confirmed')) ORDER BY i.updated_at DESC LIMIT 20",
        )
        .bind(m.id, m.id)
        .all<{ id: string; status: string; candidate_id: string; text: string }>()
    ).results.map((i) => {
      const role = i.candidate_id === m.id ? "candidate" : "requester";
      const acts = role === "candidate" ? (i.status === "invited" ? ["accept", "decline"] : i.status === "mutually_confirmed" ? ["helpful", "noresp"] : ["cancel"]) : i.status === "accepted" ? ["confirm", "cancel"] : ["helpful", "noresp"];
      // A candidate sees the request text (as in the bot's invitation); a requester sees status only.
      return { id: i.id, role, status: i.status, text: role === "candidate" ? i.text : null, actions: acts };
    });
    return out({ missions, needs, intros });
  }
  if (key === "POST requests" && !p[1]) {
    try {
      const x = await createDraft(db, m.id, String(body.text ?? ""));
      return out({ ok: true, id: x.id, job: jobLabel(x.job_code, lang), summary: x.summary });
    } catch (e) {
      if (!(e instanceof MissionError)) throw e;
      return out({ ok: false, msg: e.message === "too many" ? a.tooManyOpen : a.helpUsage.replace(/<[^>]+>/g, "") });
    }
  }
  if (key === "POST requests" && p[1] && p[2]) {
    if (p[2] === "rate") {
      const r = await rateMission(app, m, p[1], body.useful === true);
      return out({ ok: r.ok, msg: r.msg }, r.keys);
    }
    const r = await memberAction(app, m, p[1], p[2]);
    const x = await getMission(db, p[1]);
    const res: Record<string, unknown> = { ok: r.ok, msg: r.msg };
    if (p[2] === "ok" && r.answer) Object.assign(res, { answered: r.answer.status === "answered", answerId: r.answerId, quotes: quotesOut(r.answer.quotes) });
    if (p[2] === "pv") {
      if (r.blocked) res.blocked = r.blocked;
      else if (r.ok && x) res.preview = { job: jobLabel(x.job_code, lang), summary: x.summary, partners: (r.partners ?? []).map((pp) => pp.brand_label) };
    }
    if (p[2] === "more") res.partners = (r.partners ?? []).length;
    return out(res, r.keys);
  }
  if (key === "POST offers" && p[1]) {
    const contact = `tg://user?id=${user.id}${user.username ? ` @${user.username}` : ""}`;
    const r = await offerChoice(app, m, p[1], body.yes === true, contact);
    return out({ ok: r.ok, msg: r.msg }, r.keys);
  }
  if (key === "POST intros" && p[1]) {
    const r = await introAct(db, p[1], m.id, String(body.action ?? ""));
    return out({ ok: true, msg: r.reply.replace(/<[^>]+>/g, "") }, r.keys);
  }
  if (key === "POST needs" && p[1]) {
    const r = await cancelNeed(db, m.id, p[1]);
    return out({ ok: r.ok }, r.keys);
  }

  // ---- history import (owners): the browser reads Telegram, we only store the pages ------------
  if (p[0] === "history") {
    if (!owner) return out({ error: "owners only" }, undefined, 403);
    if (key === "GET history") return out({ groups: await historyGroups(app.env, db), perDay: perDay(app.env), pageMax: HISTORY_PAGE_MAX, mcp: mcpOn(app.env) });
    const chatId = Number(body.chat_id);
    if (!Number.isSafeInteger(chatId)) return out({ error: "bad chat" }, undefined, 400);
    if (key === "POST history" && p[1] === "stage") {
      const r = await stagePage(db, user.id, chatId, body.page, body.messages, body.done === true);
      return out(r, undefined, r.ok ? 200 : r.error === "not_enabled" ? 404 : 400);
    }
    if (key === "POST history" && (p[1] === "reset" || p[1] === "auto")) {
      // With the MCP server configured, a (re)start is read in the background right away.
      const ok = p[1] === "reset" ? await resetHistory(db, chatId) : true;
      const src = await db.prepare("SELECT id FROM sources WHERE chat_id=? AND enabled=1").bind(chatId).first<{ id: string }>();
      const auto = !!src && (await startAuto(db, app.env, src.id)) > 0;
      return out({ ok, auto });
    }
    return notFound();
  }

  // ---- operator desk -----------------------------------------------------------------------
  if (p[0] !== "desk") return notFound();
  if (!owner) return out({ error: "owners only" }, undefined, 403);
  if (method === "GET") {
    const { results: ms } = await db
      .prepare(
        "SELECT * FROM missions WHERE status IN ('local_investigation','external_permission_needed','no_eligible_provider','routed','offers_available','pending_final_approvals','service_committed','in_delivery') ORDER BY handler='operator' DESC, updated_at LIMIT 30",
      )
      .all<Mission>();
    const missions = [];
    for (const x of ms) {
      const d = await deskActions(app, x, a);
      missions.push({ id: x.id, short: short(x.id), status: x.status, statusLabel: a.status(x.status), job: jobLabel(x.job_code, lang), summary: x.summary, hits: x.local_hits, external: d.external, case_type: x.case_type ?? null, handler: x.handler, actions: d.actions });
    }
    const inbound = (
      await db
        .prepare("SELECT e.id, e.job_code, e.summary, e.state, e.contact, g.brand_label FROM federation_exchanges e JOIN organizations g ON g.id=e.partner_id WHERE e.direction='in' AND e.state IN ('received','offered','committed') ORDER BY e.created_at LIMIT 20")
        .all<{ id: string; job_code: string; summary: string; state: string; contact: string | null; brand_label: string }>()
    ).results;
    const offersAll = await listOffers(db);
    const inboundOut = [];
    for (const e of inbound) {
      const actions =
        e.state === "received"
          ? [...offersAll.filter((o) => o.status === "published" && o.reserved < o.capacity_total && (o.job_code === e.job_code || o.job_code === "general")).map((o) => ({ act: "o", extra: o.id, label: a.bOfferWith(o.description.slice(0, 40)) })), { act: "d", label: a.bDecline }]
          : e.state === "committed"
            ? [{ act: "v", label: a.bDelivered }, { act: "r", label: a.bRelease }]
            : [];
      inboundOut.push({ id: e.id, partner: e.brand_label, job: jobLabel(e.job_code, lang), summary: e.summary, state: e.state, contact: e.contact, actions });
    }
    const manual = (await db.prepare("SELECT f.id, g.brand_label, f.body FROM fed_outbox f JOIN organizations g ON g.id=f.partner_id WHERE f.state='manual' ORDER BY f.created_at LIMIT 10").all<{ id: string; brand_label: string; body: string }>()).results;
    const rep = await report(db);
    const partners = await partnerList(db);
    return out({
      missions,
      inbound: inboundOut,
      manual: manual.map((x) => ({ id: x.id, partner: x.brand_label, body: x.body })),
      offers: offersAll.map((o) => ({ id: o.id, job: jobLabel(o.job_code, lang), description: o.description, reserved: o.reserved, total: o.capacity_total, mode: o.commitment_mode, price: o.price_minor && o.currency ? formatAmount(o.price_minor, o.currency) : null, status: o.status })),
      gaps: (await openGaps(db)).map((g) => ({ job: g.job_code, label: jobLabel(g.job_code, lang), bucket: bucket(g.members) })),
      report: { stages: rep.stages.map(([k, n]) => ({ label: a.status(k), n })), receipts: rep.receipts, useful: rep.useful, notUseful: rep.notUseful },
      ledger: (await balances(db)).map((x) => {
        const id = x.account.replace(/^partner:/, "");
        return { partner: partners.find((pp) => pp.id === id)?.brand_label ?? id, amount: formatAmount(x.amount, x.unit) };
      }),
      partners: partners.map((x) => ({ id: x.id, label: x.brand_label, status: x.status, manual: !x.endpoint })),
      federation: fedEnabled(app.env),
      health: await status(db),
      caseTypes: CASE_TYPES,
      skills: [...TAXONOMY.values()].map((s) => ({ code: s.code, label: labelIn(s, lang) })),
      modes: MODES,
    });
  }
  const [, what, id = "", act = "", extra = ""] = p;
  if (what === "mission") {
    const r = await deskAction(app, id, act, extra, lang);
    return out({ ok: r.ok, msg: r.msg }, r.keys);
  }
  if (what === "exchange") {
    const r = await exchangeAction(app, id, act, extra, lang);
    return out({ ok: r.ok, msg: r.msg }, r.keys);
  }
  if (what === "gap") {
    const r = await gapAction(app, id, act, lang);
    return out({ ok: r.ok, msg: r.msg });
  }
  if (what === "tag") {
    const ct = String(body.case_type ?? "");
    if (!CASE_TYPES.includes(ct)) return out({ ok: false }, undefined, 400);
    const r = await db.prepare("UPDATE missions SET case_type=? WHERE id=? RETURNING id").bind(ct, id).all();
    return out({ ok: r.results.length === 1 });
  }
  if (what === "offer" && !id) {
    const job = body.job === "general" ? "general" : typeof body.job === "string" && TAXONOMY.has(body.job) ? body.job : null;
    const slots = Number(body.slots);
    const mode = String(body.mode ?? "volunteer") as CommitmentMode;
    const price = mode === "paid" ? parsePrice(`paid:${String(body.price ?? "")}`) : null;
    const desc = String(body.description ?? "").trim();
    if (!job || !Number.isInteger(slots) || slots < 1 || slots > 1000 || !MODES.includes(mode) || desc.length < 3 || (mode === "paid" && !price)) return out({ ok: false, msg: a.offerUsage.replace(/<[^>]+>/g, "").replace(/&lt;|&gt;/g, "") }, undefined, 400);
    const oid = await addOffer(db, { job, capacity: slots, mode, description: desc, by: m.id, price: price ?? undefined });
    await audit(db, "offer.add", m.id, oid, { job, slots, via: "app" });
    return out({ ok: true, id: oid });
  }
  if (what === "offer" && act === "withdraw") return out({ ok: await withdrawOffer(db, id) });
  return notFound();
}

// The owner-only history import (/history/history.js) needs WebAssembly for MTProto crypto and a
// WebSocket to Telegram's own web endpoints (*.web.telegram.org); nothing else is reachable.
const CSP = "default-src 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://telegram.org; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self' wss://*.web.telegram.org; img-src 'self' data:; base-uri 'none'; form-action 'none'";
