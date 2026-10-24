// Telegram surface of the Assistance OS (plan Track 3–8):
//   members:  /help <need> · /requests · /cancel  (+ buttons m:, o:, r:)
//   owners:   /desk [report] · /offer · /partner · /fed  (+ buttons d:, x:)

import { langOf, type Member } from "../acl";
import type { App } from "../bot";
import { ownerIds, timezone } from "../env";
import { resolveSkill } from "../experts";
import type { Lang } from "../i18n";
import { renderAnswer } from "../search";
import type { InlineButton } from "../telegram";
import { escapeHtml } from "../text";
import { audit, nowIso } from "../util";
import { partnerList, receive, safeEndpoint } from "../federation/gateway";
import type { MessageType } from "../federation/envelope";
import { addOffer, listOffers, MODES, openOffers, withdrawOffer, type CommitmentMode } from "./capacity";
import { A, type AssistMessages } from "./i18n";
import { createDraft, getMission, isTerminal, MissionError, openMissions, report, type Mission } from "./missions";
import { b } from "./notify";
import { deskAction, deskActions, exchangeAction, forgetMissions, gapAction, jobLabel, memberAction, offerChoice, rateMission, short, type Outcome } from "./actions";
import { balances, formatAmount, parsePrice, recent, reverse } from "./ledger";
import { bucket, openGaps } from "./gaps";
import { applyRotation, refreshPartner, verifyRotation, type RotationProof } from "../federation/keys";
import { verifyRoot, type RootMeta } from "../continuity/identity";
import type { Signed } from "../continuity/crypto";

const send = (app: App, chat: number, text: string, buttons?: InlineButton[][]) => app.tg.sendMessage(chat, text, { buttons });
const isOwner = (app: App, tgId: number) => ownerIds(app.env).has(tgId);

export const MEMBER_COMMANDS = new Set(["requests", "cancel"]);
export const OWNER_COMMANDS = new Set(["desk", "offer", "partner", "fed", "ledger"]);
export const CASE_TYPES = ["knowledge_answer", "qualified_expert_review", "warm_intro", "reserved_office_hour", "small_panel", "commercial_project"];

// ---- member side ---------------------------------------------------------------------------

export async function cmdHelpNeed(app: App, chat: number, mem: Member, text: string): Promise<string[]> {
  const a = A(langOf(mem));
  try {
    const m = await createDraft(app.db, mem.id, text);
    await send(app, chat, a.draft(escapeHtml(jobLabel(m.job_code, langOf(mem))), escapeHtml(m.summary)), [[b(a.bConfirm, `m:${m.id}:ok`), b(a.bCancel, `m:${m.id}:x`)]]);
  } catch (e) {
    if (!(e instanceof MissionError)) throw e;
    await send(app, chat, e.message === "too many" ? a.tooManyOpen : a.helpUsage);
  }
  return [];
}

/** Missions part of /requests and /cancel. Returns how many were listed. */
export async function listMissions(app: App, chat: number, mem: Member): Promise<number> {
  const a = A(langOf(mem));
  const ms = await openMissions(app.db, mem.id);
  for (const m of ms) await send(app, chat, a.requestLine(escapeHtml(m.summary), a.status(m.status)), [[b(a.bCancel, `m:${m.id}:x`)]]);
  return ms.length;
}

export { forgetMissions };

async function deskCard(app: App, m: Mission, a: AssistMessages, lang: Lang): Promise<{ text: string; buttons: InlineButton[][] }> {
  const { external, actions } = await deskActions(app, m, a);
  const buttons: InlineButton[][] = [];
  const rest: InlineButton[] = [];
  for (const x of actions) {
    const btn = b(x.label, `d:${m.id}:${x.act}${x.extra ? `:${x.extra}` : ""}`);
    if (x.act === "a" || x.act === "np") buttons.push([btn]);
    else rest.push(btn);
  }
  // Order: assignments, then intro/route (and delivered/release), then "no provider" last.
  const np = buttons.findIndex((r) => r[0]!.callback_data.endsWith(":np"));
  if (rest.length) buttons.splice(np >= 0 ? np : buttons.length, 0, rest);
  return { text: a.deskMission(short(m.id), a.status(m.status), escapeHtml(jobLabel(m.job_code, lang)), escapeHtml(m.summary), m.local_hits, external), buttons };
}

interface Cb {
  id: string;
  from: { id: number; username?: string };
  message?: { message_id: number; chat: { id: number } };
}

export async function assistCallback(app: App, cb: Cb, mem: Member | null, data: string): Promise<string[]> {
  const [kind, id = "", act = "", extra = ""] = data.split(":");
  const lang: Lang = mem ? langOf(mem) : "en";
  const a = A(lang);
  const toast = (text = "", alert = false) => app.tg.call("answerCallbackQuery", { callback_query_id: cb.id, text: text.slice(0, 190), show_alert: alert });
  const clear = async () => {
    if (cb.message) await app.tg.call("editMessageReplyMarkup", { chat_id: cb.message.chat.id, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => undefined);
  };
  const chat = cb.from.id;
  const done = async (r: Outcome & { alert?: boolean }) => {
    await toast(r.msg ?? "", !!r.alert);
    if (r.ok) await clear();
    return r.keys;
  };

  if (kind === "g" || kind === "d" || kind === "x") {
    if (!isOwner(app, cb.from.id)) {
      await toast();
      return [];
    }
    if (kind === "g") {
      const r = await gapAction(app, id, act, lang);
      if (r.ok && act === "off") await send(app, chat, a.gapOfferHint(escapeHtml(id)));
      return done(r);
    }
    if (kind === "x") return done(await exchangeAction(app, id, act, extra, lang));
    if (act === "show") {
      const m = await getMission(app.db, id);
      await toast(m ? "" : a.notOpen);
      if (m && !isTerminal(m)) {
        const c = await deskCard(app, m, a, lang);
        await send(app, chat, c.text, c.buttons.length ? c.buttons : undefined);
      }
      return [];
    }
    return done(await deskAction(app, id, act, extra, lang));
  }
  if (!mem) {
    await toast(a.notOpen);
    return [];
  }
  if (kind === "o") {
    const contact = `tg://user?id=${cb.from.id}${cb.from.username ? ` @${cb.from.username}` : ""}`;
    const r = await offerChoice(app, mem, id, act === "y", contact);
    await toast(r.msg ?? "", act === "y" && r.ok);
    await clear();
    return r.keys;
  }
  if (kind === "r") return done(await rateMission(app, mem, id, act === "1"));
  if (kind !== "m") {
    await toast();
    return [];
  }

  const r = await memberAction(app, mem, id, act);
  if (act === "pv") {
    await toast(r.ok || r.blocked ? "" : r.msg);
    const m = await getMission(app.db, id);
    if (r.blocked) await send(app, chat, a.previewBlocked(r.blocked.join(", ")));
    else if (r.ok && m && !r.partners?.length) await send(app, chat, a.noPartners);
    else if (r.ok && m)
      await send(app, chat, a.preview(escapeHtml(jobLabel(m.job_code, lang)), escapeHtml(m.summary), escapeHtml(r.partners!.map((p) => p.brand_label).join(", "))), [
        [b(a.bAllow, `m:${m.id}:allow`)],
        [b(a.bKeepInside, `m:${m.id}:in`)],
      ]);
    return r.keys;
  }
  await toast(r.msg ?? "");
  if (!r.ok) return [];
  await clear();
  if (act === "ok") {
    const ans = r.answer!;
    if (ans.status === "answered") {
      const out = renderAnswer(ans, timezone(app.env), lang, { answerId: r.answerId });
      await send(app, chat, `${a.foundLocal}\n${out.text}`, out.buttons);
      await send(app, chat, a.solvedQ, [[b(a.bSolved, `m:${id}:solved`), b(a.bMore, `m:${id}:more`)]]);
    } else {
      await send(app, chat, a.nothingLocal, [[b(a.bToDesk, `m:${id}:more`), b(a.bCancel, `m:${id}:x`)]]);
    }
  } else if (act === "more") {
    const n = r.partners?.length ?? 0;
    await send(app, chat, a.onDesk(n > 0), n ? [[b(a.bPreview, `m:${id}:pv`)]] : undefined);
  }
  return r.keys;
}

/** Owner commands in private chat. */
export async function ownerAssistCommand(app: App, chat: number, cmd: string, args: string, lang: Lang, ownerMemberId: string): Promise<string[]> {
  const a = A(lang);
  const words = args.trim().split(/\s+/).filter(Boolean);
  if (cmd === "desk") {
    if (words[0] === "gaps") {
      const gs = await openGaps(app.db);
      await send(app, chat, gs.length ? [a.gapsTitle, ...gs.map((g) => a.gap(escapeHtml(jobLabel(g.job_code, lang)), bucket(g.members)))].join("\n\n") : a.gapsNone);
      return [];
    }
    if (words[0] === "tag") {
      const sid = (words[1] ?? "").replace(/^#/, "");
      const ct = words[2] ?? "";
      const r = sid.length >= 6 && CASE_TYPES.includes(ct) ? await app.db.prepare("UPDATE missions SET case_type=? WHERE substr(id,1,?)=? RETURNING id").bind(ct, sid.length, sid).all() : null;
      await send(app, chat, r?.results.length === 1 ? a.done : a.tagUsage);
      return [];
    }
    if (words[0] === "report") {
      const r = await report(app.db);
      const cases = (await app.db.prepare("SELECT COALESCE(case_type,'untagged') AS k, COUNT(*) AS n FROM missions WHERE status<>'draft' GROUP BY k ORDER BY n DESC").all<{ k: string; n: number }>()).results;
      const lines = [a.reportTitle, ...r.stages.map(([k, n]) => `${escapeHtml(a.status(k))}: <b>${n}</b>`), "", ...r.receipts.map(([k, n]) => `${escapeHtml(k)}: <b>${n}</b>`), `useful / not useful: <b>${r.useful} / ${r.notUseful}</b>`, "", ...cases.map((c) => `${escapeHtml(c.k)}: <b>${c.n}</b>`)];
      await send(app, chat, lines.join("\n"));
      return [];
    }
    const { results } = await app.db
      .prepare(
        "SELECT * FROM missions WHERE status IN ('local_investigation','external_permission_needed','no_eligible_provider','routed','offers_available','pending_final_approvals','service_committed','in_delivery') " +
          "ORDER BY handler='operator' DESC, updated_at LIMIT 10",
      )
      .all<Mission>();
    const inbound = (await app.db.prepare("SELECT id, partner_id, job_code, summary, state FROM federation_exchanges WHERE direction='in' AND state IN ('received','committed') ORDER BY created_at LIMIT 5").all<{ id: string; partner_id: string; job_code: string; summary: string; state: string }>()).results;
    const manual = (await app.db.prepare("SELECT id, partner_id, body FROM fed_outbox WHERE state='manual' ORDER BY created_at LIMIT 5").all<{ id: string; partner_id: string; body: string }>()).results;
    if (!results.length && !inbound.length && !manual.length) await send(app, chat, a.deskEmpty);
    for (const m of results) {
      const c = await deskCard(app, m, a, lang);
      await send(app, chat, c.text, c.buttons.length ? c.buttons : undefined);
    }
    for (const ex of inbound) {
      const buttons =
        ex.state === "received"
          ? [...(await openOffers(app.db, ex.job_code)).map((o) => [b(a.bOfferWith(o.description.slice(0, 40)), `x:${ex.id}:o:${o.id}`)]), [b(a.bDecline, `x:${ex.id}:d`)]]
          : [[b(a.bDelivered, `x:${ex.id}:v`), b(a.bRelease, `x:${ex.id}:r`)]];
      await send(app, chat, a.deskInbound(escapeHtml(ex.partner_id), escapeHtml(ex.job_code), escapeHtml(ex.summary)), buttons);
    }
    for (const f of manual) await send(app, chat, `${a.manual(escapeHtml(f.partner_id))}\n<pre>${escapeHtml(f.body)}</pre>`, [[b(a.bMarkSent, `x:${f.id}:s`)]]);
    return [];
  }

  if (cmd === "offer") {
    if (words[0] === "add" && words.length >= 4) {
      const job = words[1] === "general" ? "general" : resolveSkill(words[1]!);
      const slots = Number(words[2]);
      const price = parsePrice(words[3]!);
      const hasMode = MODES.includes(words[3] as CommitmentMode) || !!price;
      const mode: CommitmentMode = price ? "paid" : hasMode ? (words[3] as CommitmentMode) : "volunteer";
      const desc = words.slice(hasMode ? 4 : 3).join(" ");
      // "paid" needs a price so the ledger and the partner see the same terms.
      if (job && Number.isInteger(slots) && slots >= 1 && slots <= 1000 && desc.length >= 3 && (mode !== "paid" || price)) {
        const id = await addOffer(app.db, { job, capacity: slots, mode, description: desc, by: ownerMemberId, price: price ?? undefined });
        await audit(app.db, "offer.add", ownerMemberId, id, { job, slots });
        await send(app, chat, a.offerAdded(id));
        return [];
      }
    } else if (words[0] === "withdraw" && words[1]) {
      await send(app, chat, (await withdrawOffer(app.db, words[1])) ? a.done : a.notOpen);
      return [];
    } else if (!words.length) {
      const os = await listOffers(app.db);
      await send(app, chat, os.map((o) => a.offerLine(o.id, escapeHtml(o.job_code), escapeHtml(o.description), o.reserved, o.capacity_total, o.commitment_mode, o.status)).join("\n") || a.noOffers);
      return [];
    }
    await send(app, chat, a.offerUsage);
    return [];
  }

  if (cmd === "partner") {
    if ((words[0] === "add" || words[0] === "manual") && words.length >= 5) {
      const id = words[0] === "add" ? safeEndpoint(words[1]!) : /^[a-z0-9][\w.:-]{2,100}$/i.test(words[1]!) ? words[1]! : null;
      const key = words[2]!;
      let keyOk = false;
      try {
        keyOk = atob(key).length === 32;
      } catch {
        keyOk = false;
      }
      const cats = words[3] === "*" ? ["*"] : words[3]!.split(",").map((c) => (c === "general" ? "general" : resolveSkill(c))).filter((c): c is string => !!c);
      if (!id || !keyOk || !cats.length) {
        await send(app, chat, id ? a.partnerUsage : a.partnerBadUrl);
        return [];
      }
      await app.db
        .prepare(
          "INSERT INTO organizations(id, kind, brand_label, status, endpoint, public_key, categories, created_at) VALUES (?, 'partner', ?, 'active', ?, ?, ?, ?) " +
            "ON CONFLICT(id) DO UPDATE SET brand_label=excluded.brand_label, status='active', endpoint=excluded.endpoint, public_key=excluded.public_key, categories=excluded.categories WHERE kind='partner'",
        )
        .bind(id, words.slice(4).join(" ").slice(0, 80), words[0] === "add" ? id : null, key, JSON.stringify([...new Set(cats)]), nowIso())
        .run();
      await audit(app.db, "partner.save", ownerMemberId, id, { categories: cats.length, manual: words[0] === "manual" });
      await send(app, chat, a.partnerSaved(escapeHtml(id)));
      return [];
    }
    if (words[0] === "refresh" && words[1]) {
      const p = await app.db.prepare("SELECT * FROM organizations WHERE id=? AND kind='partner'").bind(words[1]).first<Parameters<typeof refreshPartner>[1]>();
      await send(app, chat, a.rotated(p ? await refreshPartner(app, p, new Date(), true) : "unknown"));
      return [];
    }
    if (words[0] === "rotate" && words[1] && words[2]) {
      // Manual partners: paste the rotation proof they sent; it must be signed by the key we trust.
      const p = await app.db.prepare("SELECT id, public_key FROM organizations WHERE id=? AND kind='partner'").bind(words[1]).first<{ id: string; public_key: string | null }>();
      let proof: RotationProof | null = null;
      try {
        proof = JSON.parse(words.slice(2).join(" "));
      } catch {
        proof = null;
      }
      const ok = !!p?.public_key && !!proof && (await verifyRotation(proof, p.public_key, p.id));
      if (ok) await applyRotation(app.db, p!.id, proof!, ownerMemberId);
      await send(app, chat, a.rotated(ok ? "rotated" : "rejected"));
      return [];
    }
    if ((words[0] === "root" || words[0] === "pin") && words[1]) {
      // Pin a partner's club root (CONT-8). Operators confirm it out of band; we only check that it
      // is internally valid (threshold of its own keys) and, on update, chained to the old pin.
      const p = await app.db.prepare("SELECT id, endpoint, root_json FROM organizations WHERE id=? AND kind='partner'").bind(words[1]).first<{ id: string; endpoint: string | null; root_json: string | null }>();
      let doc: unknown = null;
      try {
        if (words[0] === "root") doc = JSON.parse(words.slice(2).join(" "));
        else if (p?.endpoint) doc = ((await (await (app.net ?? fetch)(`${p.endpoint}/.well-known/nexus-community.json`, { signal: AbortSignal.timeout(5000) } as RequestInit)).json()) as { root?: unknown }).root;
      } catch {
        doc = null;
      }
      const v = p && doc ? await verifyRoot(doc as Signed<RootMeta>, p.root_json ? JSON.parse(p.root_json) : null) : { ok: false as const, reason: "unknown" };
      if (v.ok) {
        await app.db.prepare("UPDATE organizations SET root_json=? WHERE id=?").bind(JSON.stringify(doc), p!.id).run();
        await audit(app.db, "partner.root_pinned", ownerMemberId, p!.id);
        const r = (doc as Signed<RootMeta>).signed;
        await send(app, chat, `Root pinned for <code>${escapeHtml(p!.id)}</code>: ${escapeHtml(r.org)} v${r.version}, ${r.threshold} of ${r.root_keys.length} keys (${r.root_keys.map((k) => k.keyid).join(", ")}). Confirm these key ids with the partner by phone or in person.`);
      } else await send(app, chat, `Not pinned: <code>${escapeHtml(v.ok ? "" : v.reason)}</code>`);
      return [];
    }
    if (words[0] === "suspend" && words[1]) {
      const r = await app.db.prepare("UPDATE organizations SET status='suspended' WHERE id=? AND kind='partner' RETURNING id").bind(words[1]).all();
      if (r.results.length) await audit(app.db, "partner.suspend", ownerMemberId, words[1]);
      await send(app, chat, r.results.length ? a.done : a.notOpen);
      return [];
    }
    if (!words.length) {
      const ps = await partnerList(app.db);
      await send(app, chat, ps.map((p) => a.partnerLine(escapeHtml(p.id), escapeHtml(p.brand_label), p.status, escapeHtml(p.categories), !p.endpoint)).join("\n") || a.noPartnersYet);
      return [];
    }
    await send(app, chat, a.partnerUsage);
    return [];
  }

  if (cmd === "ledger") {
    if (words[0] === "reverse" && words[1]) {
      await send(app, chat, (await reverse(app.db, words[1], ownerMemberId)) ? a.done : a.notOpen);
      return [];
    }
    if (words.length) {
      await send(app, chat, a.ledgerUsage);
      return [];
    }
    const bs = await balances(app.db);
    const rs = await recent(app.db);
    const lines = [a.ledgerTitle, ...(bs.length ? bs.map((x) => `${escapeHtml(x.account.replace(/^partner:/, ""))}: <b>${formatAmount(x.amount, x.unit)}</b>`) : [a.ledgerEmpty])];
    if (rs.length) lines.push("", a.ledgerRecent, ...rs.map((t) => `<code>${t.id}</code> · ${t.kind} · ${escapeHtml(t.memo)}`));
    await send(app, chat, lines.join("\n"));
    return [];
  }

  // /fed <signed json>: E0 manual inbound, verified exactly like the HTTP route.
  let raw: { type?: MessageType; exchange_id?: string } | null = null;
  try {
    raw = JSON.parse(args);
  } catch {
    raw = null;
  }
  if (!raw || !raw.type) {
    await send(app, chat, a.fedResult("json"));
    return [];
  }
  const r = await receive(app, raw, { types: [raw.type], id: raw.exchange_id });
  await send(app, chat, a.fedResult(r.body.ok ? (r.body.duplicate ? "duplicate" : "ok") : String(r.body.reason)));
  return r.keys;
}

