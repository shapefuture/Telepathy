// Telegram surface of the Assistance OS (plan Track 3–8):
//   members:  /help <need> · /requests · /cancel  (+ buttons m:, o:, r:)
//   owners:   /desk [report] · /offer · /partner · /fed  (+ buttons d:, x:)

import { langOf, readable, type Member } from "../acl";
import type { App } from "../bot";
import { ENVELOPE_FIELDS, findIdentifiers, grantAllows } from "../domain/consent";
import { ownerIds, timezone } from "../env";
import { resolveSkill, TAXONOMY, labelIn } from "../experts";
import { recordAnswer } from "../feedback";
import type { Lang } from "../i18n";
import { IntroError, requestIntro } from "../intros";
import { answer, renderAnswer } from "../search";
import type { InlineButton } from "../telegram";
import { escapeHtml } from "../text";
import { audit, newId, nowIso } from "../util";
import {
  chooseOffer,
  declineInbound,
  declineOffer,
  eligiblePartners,
  fedEnabled,
  finishInbound,
  markManualSent,
  offerInbound,
  partnerList,
  policyVersion,
  receive,
  routeMission,
  safeEndpoint,
  withdrawMission,
} from "../federation/gateway";
import type { MessageType } from "../federation/envelope";
import { addOffer, deliver, listOffers, liveCommitment, MODES, openOffers, release, reserve, withdrawOffer, type CommitmentMode } from "./capacity";
import { A, type AssistMessages } from "./i18n";
import { createDraft, getMission, grantFor, isTerminal, MissionError, openMissions, receipt, recordGrant, report, revokeGrants, transition, type Mission } from "./missions";
import { b, notifyMember, notifyOwners } from "./notify";
import { balances, formatAmount, parsePrice, recent, reverse } from "./ledger";
import { bucket, openGaps, setGapStatus } from "./gaps";
import { applyRotation, refreshPartner, verifyRotation, type RotationProof } from "../federation/keys";

const short = (id: string) => id.slice(0, 6);
const jobLabel = (code: string, lang: Lang) => (TAXONOMY.get(code) ? labelIn(TAXONOMY.get(code)!, lang) : code);
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

/** Cancel: stop the mission, revoke its grants, withdraw partner exchanges, free local slots. */
async function stopMission(app: App, m: Mission, actor: "member" | "operator", to: "cancelled" | "failed_with_explanation" = "cancelled", reason?: string): Promise<string[]> {
  if (m.status === "draft") {
    await app.db.prepare("DELETE FROM missions WHERE id=? AND status='draft'").bind(m.id).run();
    return [];
  }
  if (!(await transition(app.db, m.id, to, actor, { reason }))) return [];
  await revokeGrants(app.db, m.id);
  const c = await liveCommitment(app.db, { missionId: m.id });
  if (c) await release(app.db, c.id, "cancelled");
  return withdrawMission(app, m.id);
}

/** /forget_me: stop every mission and scrub its text everywhere we hold a copy (I09). */
export async function forgetMissions(app: App, memberId: string): Promise<string[]> {
  const { results } = await app.db.prepare("SELECT * FROM missions WHERE member_id=?").bind(memberId).all<Mission>();
  const keys: string[] = [];
  for (const m of results) if (!isTerminal(m)) keys.push(...(await stopMission(app, m, "member")));
  await app.db.batch([
    app.db.prepare("UPDATE missions SET summary='[removed]', criteria='{}' WHERE member_id=?").bind(memberId),
    app.db.prepare("UPDATE federation_exchanges SET summary='[removed]', envelope='{}' WHERE mission_id IN (SELECT id FROM missions WHERE member_id=?)").bind(memberId),
    app.db.prepare("UPDATE consent_grants SET revoked_at=COALESCE(revoked_at, ?) WHERE member_id=?").bind(nowIso(), memberId),
  ]);
  return keys;
}

async function deskCard(app: App, m: Mission, a: AssistMessages, lang: Lang): Promise<{ text: string; buttons: InlineButton[][] }> {
  const g = await grantFor(app.db, m.id, "external_discovery");
  const pv = await policyVersion(app.db);
  const external = !!g && !g.revoked_at && g.mission_version === m.version && g.policy_version === pv && g.expires_at > nowIso();
  const buttons: InlineButton[][] = [];
  if (["local_investigation", "external_permission_needed", "no_eligible_provider"].includes(m.status)) {
    for (const o of await openOffers(app.db, m.job_code)) buttons.push([b(a.bAssign(o.description.slice(0, 40)), `d:${m.id}:a:${o.id}`)]);
    const row = [b(a.bIntro, `d:${m.id}:i`)];
    if (external && fedEnabled(app.env) && m.status !== "local_investigation") row.push(b(a.bRoute, `d:${m.id}:rt`));
    buttons.push(row, [b(a.bNoProvider, `d:${m.id}:np`)]);
  } else if (["service_committed", "in_delivery"].includes(m.status) && (await liveCommitment(app.db, { missionId: m.id }))) {
    buttons.push([b(a.bDelivered, `d:${m.id}:dv`), b(a.bRelease, `d:${m.id}:rl`)]);
  }
  return { text: a.deskMission(short(m.id), a.status(m.status), escapeHtml(jobLabel(m.job_code, lang)), escapeHtml(m.summary), m.local_hits, external), buttons };
}

const toDesk = (app: App, m: Mission, tag: string) =>
  notifyOwners(app, `desk:${m.id}:${tag}`, (a) => ({ text: a.deskMission(short(m.id), a.status(m.status), escapeHtml(m.job_code), escapeHtml(m.summary), m.local_hits, tag === "ext"), buttons: [[b("/desk", `d:${m.id}:show`)]] }));

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

  if (kind === "g") {
    if (!isOwner(app, cb.from.id)) {
      await toast();
      return [];
    }
    const ok = await setGapStatus(app.db, id, act === "off" ? "actioned" : "dismissed");
    await toast(ok ? a.done : a.notOpen);
    await clear();
    if (ok && act === "off") await send(app, chat, a.gapOfferHint(escapeHtml(id)));
    return [];
  }
  if (kind === "d" || kind === "x") {
    if (!isOwner(app, cb.from.id)) {
      await toast();
      return [];
    }
    return kind === "d" ? deskAction(app, id, act, extra, a, lang, toast, clear, chat) : exchangeAction(app, id, act, extra, a, toast, clear);
  }
  if (!mem) {
    await toast(a.notOpen);
    return [];
  }

  if (kind === "o") {
    if (act === "y") {
      const contact = `tg://user?id=${cb.from.id}${cb.from.username ? ` @${cb.from.username}` : ""}`;
      const r = await chooseOffer(app, mem.id, id, contact);
      await toast(r.ok ? a.chosen(r.brand ?? "") : a.notOpen, true);
      await clear();
      return r.keys;
    }
    const r = await declineOffer(app, mem.id, id);
    await toast(r.ok ? a.offerDeclined : a.notOpen);
    await clear();
    return r.keys;
  }

  const m = await getMission(app.db, id);
  if (!m || m.member_id !== mem.id) {
    await toast(a.notOpen);
    return [];
  }

  if (kind === "r") {
    if (m.status !== "delivered") {
      await toast(a.notOpen);
      return [];
    }
    await receipt(app.db, m.id, { useful: act === "1" });
    if (await transition(app.db, m.id, "evaluated", "member")) await transition(app.db, m.id, "closed", "system");
    await toast(a.thanks);
    await clear();
    return [];
  }
  if (kind !== "m") {
    await toast();
    return [];
  }

  switch (act) {
    case "ok": {
      if (!(await transition(app.db, m.id, "confirmed", "member", { from: "draft" }))) break;
      await recordGrant(app.db, m, "local", "home", ["job", "summary"], "assistance", await policyVersion(app.db));
      await transition(app.db, m.id, "local_investigation", "system");
      const ans = await answer(app.db, await readable(app.db, mem), m.summary);
      await app.db.prepare("UPDATE missions SET local_hits=? WHERE id=?").bind(ans.quotes.length, m.id).run();
      await toast();
      await clear();
      if (ans.status === "answered") {
        const r = renderAnswer(ans, timezone(app.env), lang, { answerId: await recordAnswer(app.db, mem.id, ans.quotes.map((q) => q.id)) });
        await send(app, chat, `${a.foundLocal}\n${r.text}`, r.buttons);
        await send(app, chat, a.solvedQ, [[b(a.bSolved, `m:${m.id}:solved`), b(a.bMore, `m:${m.id}:more`)]]);
      } else {
        await send(app, chat, a.nothingLocal, [[b(a.bToDesk, `m:${m.id}:more`), b(a.bCancel, `m:${m.id}:x`)]]);
      }
      return [];
    }
    case "solved":
      if (await transition(app.db, m.id, "locally_satisfied", "member")) {
        await receipt(app.db, m.id, { service: "knowledge_answer", useful: true });
        await transition(app.db, m.id, "evaluated", "member");
        await transition(app.db, m.id, "closed", "system");
        await toast(a.solved);
        await clear();
        return [];
      }
      break;
    case "more": {
      const moved = await transition(app.db, m.id, "external_permission_needed", "member", { handler: "operator" });
      if (!moved) break;
      const partners = await eligiblePartners(app, m);
      await toast();
      await clear();
      await send(app, chat, a.onDesk(partners.length > 0), partners.length ? [[b(a.bPreview, `m:${m.id}:pv`)]] : undefined);
      return toDesk(app, moved, "new");
    }
    case "pv": {
      if (m.status !== "external_permission_needed" && m.status !== "no_eligible_provider") break;
      await toast();
      const found = findIdentifiers(m.summary);
      if (found.length) {
        await send(app, chat, a.previewBlocked(found.join(", ")));
        return [];
      }
      const partners = await eligiblePartners(app, m);
      if (!partners.length) {
        await send(app, chat, a.noPartners);
        return [];
      }
      await send(app, chat, a.preview(escapeHtml(jobLabel(m.job_code, lang)), escapeHtml(m.summary), escapeHtml(partners.map((p) => p.brand_label).join(", "))), [
        [b(a.bAllow, `m:${m.id}:allow`)],
        [b(a.bKeepInside, `m:${m.id}:in`)],
      ]);
      return [];
    }
    case "allow": {
      const partners = await eligiblePartners(app, m);
      if (!partners.length || findIdentifiers(m.summary).length || !["external_permission_needed", "no_eligible_provider"].includes(m.status)) break;
      await recordGrant(app.db, m, "external_discovery", JSON.stringify(partners.map((p) => p.id)), [...ENVELOPE_FIELDS], "evaluate_willing_provider", await policyVersion(app.db));
      await audit(app.db, "consent.external", mem.id, m.id, { partners: partners.length });
      await toast(a.allowed);
      await clear();
      return toDesk(app, m, "ext");
    }
    case "in":
      await toast(a.keptInside);
      await clear();
      return [];
    case "x": {
      const keys = await stopMission(app, m, "member");
      await toast(a.cancelled);
      await clear();
      return keys;
    }
  }
  await toast(a.notOpen);
  return [];
}

// ---- operator side -------------------------------------------------------------------------

async function deskAction(
  app: App,
  id: string,
  act: string,
  extra: string,
  a: AssistMessages,
  lang: Lang,
  toast: (t?: string, alert?: boolean) => Promise<unknown>,
  clear: () => Promise<void>,
  chat: number,
): Promise<string[]> {
  const m = await getMission(app.db, id);
  if (!m || isTerminal(m)) {
    await toast(a.notOpen);
    return [];
  }
  if (act === "show") {
    const c = await deskCard(app, m, a, lang);
    await toast();
    await send(app, chat, c.text, c.buttons);
    return [];
  }
  if (act === "a") {
    const offer = (await openOffers(app.db, m.job_code)).find((o) => o.id === extra);
    if (!offer) {
      await toast(a.capacityFull, true);
      return [];
    }
    // Slot first (atomic), then the state change; give the slot back if the mission moved meanwhile.
    const cid = await reserve(app.db, offer.id, { missionId: m.id });
    if (!cid) {
      await toast(a.capacityFull, true);
      return [];
    }
    if (!(await transition(app.db, m.id, "provider_selected", "operator", { from: m.status }))) {
      await release(app.db, cid, "cancelled");
      await toast(a.notOpen);
      return [];
    }
    await transition(app.db, m.id, "service_committed", "operator", { handler: "operator" });
    await toast(a.done);
    await clear();
    return notifyMember(app, m.member_id, `mcl:${m.id}`, (x) => ({ text: x.committedLocal(escapeHtml(offer.description)) }));
  }
  if (act === "i") {
    try {
      const r = await requestIntro(app.db, m.member_id, m.summary, nowIso(), lang);
      await app.db.prepare("UPDATE missions SET handler='intro' WHERE id=?").bind(m.id).run();
      await toast(a.done);
      return [...r.keys, ...(await notifyMember(app, m.member_id, `mint:${m.id}`, (x) => ({ text: x.introStarted })))];
    } catch (e) {
      if (!(e instanceof IntroError)) throw e;
      await toast(e.message, true);
      return [];
    }
  }
  if (act === "rt") {
    if (!fedEnabled(app.env)) {
      await toast(a.fedOff, true);
      return [];
    }
    const r = await routeMission(app, m.id);
    await toast(a.routed(r.routed), true);
    if (r.routed) await clear();
    return r.keys;
  }
  if (act === "np") {
    const keys = await stopMission(app, m, "operator", "failed_with_explanation", "no_provider");
    await receipt(app.db, m.id, { service: "no_provider" });
    await toast(a.done);
    await clear();
    return [...keys, ...(await notifyMember(app, m.member_id, `mnp:${m.id}`, (x) => ({ text: x.noProvider })))];
  }
  const c = await liveCommitment(app.db, { missionId: m.id });
  if (act === "dv" && c && (await deliver(app.db, c.id))) {
    await transition(app.db, m.id, "delivered", "operator", { handler: "member" });
    await receipt(app.db, m.id, { service: "local_service", commitmentId: c.id, provider: true });
    await toast(a.done);
    await clear();
    return notifyMember(app, m.member_id, `mdv:${m.id}`, (x) => ({ text: x.deliveredQ, buttons: [[b(x.bUseful, `r:${m.id}:1`), b(x.bNotUseful, `r:${m.id}:0`)]] }));
  }
  if (act === "rl" && c && (await release(app.db, c.id))) {
    await transition(app.db, m.id, "external_permission_needed", "operator", { handler: "operator" });
    await toast(a.done);
    await clear();
    return notifyMember(app, m.member_id, `mrl:${m.id}:${c.id}`, (x) => ({ text: x.released }));
  }
  await toast(a.notOpen);
  return [];
}

async function exchangeAction(app: App, id: string, act: string, extra: string, a: AssistMessages, toast: (t?: string, alert?: boolean) => Promise<unknown>, clear: () => Promise<void>): Promise<string[]> {
  let r: { ok: boolean; keys: string[] } = { ok: false, keys: [] };
  if (act === "s") r = { ok: await markManualSent(app.db, id), keys: [] };
  else if (act === "o") r = await offerInbound(app, id, extra);
  else if (act === "d") r = await declineInbound(app, id);
  else if (act === "v") r = await finishInbound(app, id, "delivered");
  else if (act === "r") r = await finishInbound(app, id, "released");
  await toast(r.ok ? a.done : a.notOpen);
  if (r.ok) await clear();
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

