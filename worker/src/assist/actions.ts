// Assistance actions shared by the bot (inline buttons) and the Mini App (JSON API).
// Each function applies one decision and returns a structured outcome; callers render it.

import { langOf, readable, type Member } from "../acl";
import type { App } from "../bot";
import { ENVELOPE_FIELDS, findIdentifiers } from "../domain/consent";
import { TAXONOMY, labelIn } from "../experts";
import { recordAnswer } from "../feedback";
import type { Lang } from "../i18n";
import { IntroError, requestIntro } from "../intros";
import { answer, type Answer } from "../search";
import { escapeHtml } from "../text";
import { audit, nowIso } from "../util";
import {
  chooseOffer,
  declineInbound,
  declineOffer,
  eligiblePartners,
  fedEnabled,
  finishInbound,
  markManualSent,
  offerInbound,
  policyVersion,
  routeMission,
  withdrawMission,
  type Partner,
} from "../federation/gateway";
import { deliver, liveCommitment, openOffers, release, reserve, type Offer } from "./capacity";
import { CLUB_ACTS, inClubs, missionClubs } from "./club";
import { setGapStatus } from "./gaps";
import { A, type AssistMessages } from "./i18n";
import { getMission, grantFor, isTerminal, receipt, recordGrant, revokeGrants, transition, type Mission } from "./missions";
import { b, notifyIds, notifyMember, notifyOwners } from "./notify";
import { chatAdminIds } from "../admins";
import { ownerIds } from "../env";

export const short = (id: string) => id.slice(0, 6);
export const jobLabel = (code: string, lang: Lang) => (TAXONOMY.get(code) ? labelIn(TAXONOMY.get(code)!, lang) : code);

export interface Outcome {
  ok: boolean;
  /** Short localized result for a toast. */
  msg?: string;
  keys: string[];
  answer?: Answer;
  answerId?: string;
  partners?: Partner[];
  blocked?: string[];
  brand?: string;
}
const no = (msg?: string): Outcome => ({ ok: false, msg, keys: [] });

/** Cancel/close: stop the mission, revoke grants, free local slots, withdraw partner exchanges. */
export async function stopMission(app: App, m: Mission, actor: "member" | "operator" | "club", to: "cancelled" | "failed_with_explanation" = "cancelled", reason?: string): Promise<string[] | null> {
  if (m.status === "draft") {
    await app.db.prepare("DELETE FROM missions WHERE id=? AND status='draft'").bind(m.id).run();
    return [];
  }
  if (!(await transition(app.db, m.id, to, actor, { reason }))) return null;
  await revokeGrants(app.db, m.id);
  const c = await liveCommitment(app.db, { missionId: m.id });
  if (c) await release(app.db, c.id, "cancelled");
  return withdrawMission(app, m.id);
}

/** /forget_me: stop every mission and scrub its text everywhere we hold a copy (I09). */
export async function forgetMissions(app: App, memberId: string): Promise<string[]> {
  const { results } = await app.db.prepare("SELECT * FROM missions WHERE member_id=?").bind(memberId).all<Mission>();
  const keys: string[] = [];
  for (const m of results) if (!isTerminal(m)) keys.push(...((await stopMission(app, m, "member")) ?? []));
  await app.db.batch([
    app.db.prepare("UPDATE missions SET summary='[removed]', criteria='{}' WHERE member_id=?").bind(memberId),
    app.db.prepare("UPDATE federation_exchanges SET summary='[removed]', envelope='{}' WHERE mission_id IN (SELECT id FROM missions WHERE member_id=?)").bind(memberId),
    app.db.prepare("UPDATE consent_grants SET revoked_at=COALESCE(revoked_at, ?) WHERE member_id=?").bind(nowIso(), memberId),
  ]);
  return keys;
}

export const notifyDesk = (app: App, m: Mission, tag: string) =>
  notifyOwners(app, `desk:${m.id}:${tag}`, (a) => ({
    text: a.deskMission(short(m.id), a.status(m.status), escapeHtml(m.job_code), escapeHtml(m.summary), m.local_hits, tag === "ext"),
    buttons: [[b("/desk", `d:${m.id}:show`)]],
  }));

/** The admins of the member's own groups hear about an escalated request (they answer their members). */
export async function notifyClubs(app: App, m: Mission): Promise<string[]> {
  const owners = ownerIds(app.env);
  const admins = new Set<number>();
  for (const chat of await missionClubs(app.db, m.member_id)) for (const id of await chatAdminIds(app, chat)) if (!owners.has(id)) admins.add(id);
  return notifyIds(app, [...admins], `club:${m.id}:new`, (a) => ({
    text: a.clubMission(short(m.id), escapeHtml(m.job_code), escapeHtml(m.summary), m.local_hits),
    buttons: [[b(a.bOpenDesk, `d:${m.id}:show`)]],
  }));
}

/** Who acts on the desk: the operator (every mission) or a club's admins (their members' escalated requests). */
export type DeskScope = "operator" | { clubs: number[] };

// ---- member ------------------------------------------------------------------------------

export type MemberAct = "ok" | "solved" | "more" | "pv" | "allow" | "in" | "x";

export async function memberAction(app: App, mem: Member, missionId: string, act: string): Promise<Outcome> {
  const a = A(langOf(mem));
  const m = await getMission(app.db, missionId);
  if (!m || m.member_id !== mem.id) return no(a.notOpen);
  switch (act) {
    case "ok": {
      if (!(await transition(app.db, m.id, "confirmed", "member", { from: "draft" }))) return no(a.notOpen);
      await recordGrant(app.db, m, "local", "home", ["job", "summary"], "assistance", await policyVersion(app.db));
      await transition(app.db, m.id, "local_investigation", "system");
      const ans = await answer(app.db, await readable(app.db, mem), m.summary);
      await app.db.prepare("UPDATE missions SET local_hits=? WHERE id=?").bind(ans.quotes.length, m.id).run();
      const answerId = ans.status === "answered" ? await recordAnswer(app.db, mem.id, ans.quotes.map((q) => q.id)) : undefined;
      return { ok: true, keys: [], answer: ans, answerId };
    }
    case "solved":
      if (!(await transition(app.db, m.id, "locally_satisfied", "member"))) return no(a.notOpen);
      await receipt(app.db, m.id, { service: "knowledge_answer", useful: true });
      await transition(app.db, m.id, "evaluated", "member");
      await transition(app.db, m.id, "closed", "system");
      return { ok: true, msg: a.solved, keys: [] };
    case "more": {
      const moved = await transition(app.db, m.id, "external_permission_needed", "member", { handler: "operator" });
      if (!moved) return no(a.notOpen);
      return { ok: true, keys: [...(await notifyDesk(app, moved, "new")), ...(await notifyClubs(app, moved))], partners: await eligiblePartners(app, m) };
    }
    case "pv": {
      if (m.status !== "external_permission_needed" && m.status !== "no_eligible_provider") return no(a.notOpen);
      const found = findIdentifiers(m.summary);
      if (found.length) return { ok: false, keys: [], blocked: found };
      return { ok: true, keys: [], partners: await eligiblePartners(app, m) };
    }
    case "allow": {
      const partners = await eligiblePartners(app, m);
      if (!partners.length || findIdentifiers(m.summary).length || !["external_permission_needed", "no_eligible_provider"].includes(m.status)) return no(a.notOpen);
      await recordGrant(app.db, m, "external_discovery", JSON.stringify(partners.map((p) => p.id)), [...ENVELOPE_FIELDS], "evaluate_willing_provider", await policyVersion(app.db));
      await audit(app.db, "consent.external", mem.id, m.id, { partners: partners.length });
      return { ok: true, msg: a.allowed, keys: await notifyDesk(app, m, "ext") };
    }
    case "in":
      return { ok: true, msg: a.keptInside, keys: [] };
    case "x": {
      const keys = await stopMission(app, m, "member");
      return keys ? { ok: true, msg: a.cancelled, keys } : no(a.notOpen);
    }
  }
  return no(a.notOpen);
}

export async function rateMission(app: App, mem: Member, missionId: string, useful: boolean): Promise<Outcome> {
  const a = A(langOf(mem));
  const m = await getMission(app.db, missionId);
  if (!m || m.member_id !== mem.id || m.status !== "delivered") return no(a.notOpen);
  await receipt(app.db, m.id, { useful });
  if (await transition(app.db, m.id, "evaluated", "member")) await transition(app.db, m.id, "closed", "system");
  return { ok: true, msg: a.thanks, keys: [] };
}

export async function offerChoice(app: App, mem: Member, offerId: string, yes: boolean, contact: string): Promise<Outcome> {
  const a = A(langOf(mem));
  if (yes) {
    const r = await chooseOffer(app, mem.id, offerId, contact);
    return r.ok ? { ok: true, msg: a.chosen(r.brand ?? ""), keys: r.keys, brand: r.brand } : no(a.notOpen);
  }
  const r = await declineOffer(app, mem.id, offerId);
  return r.ok ? { ok: true, msg: a.offerDeclined, keys: r.keys } : no(a.notOpen);
}

// ---- operator ----------------------------------------------------------------------------

export interface DeskAction {
  act: "a" | "i" | "rt" | "np" | "dv" | "rl";
  extra?: string;
  label: string;
}

/** What the desk can do with this mission right now (same list for bot buttons and app). */
export async function deskActions(app: App, m: Mission, a: AssistMessages, scope: DeskScope = "operator"): Promise<{ external: boolean; actions: DeskAction[] }> {
  if (scope !== "operator") {
    const club: DeskAction[] = (await inClubs(app.db, m, scope.clubs)) ? [{ act: "i", label: a.bIntro }, { act: "np", label: a.bNoProvider }] : [];
    return { external: false, actions: club };
  }
  const g = await grantFor(app.db, m.id, "external_discovery");
  const pv = await policyVersion(app.db);
  const external = !!g && !g.revoked_at && g.mission_version === m.version && g.policy_version === pv && g.expires_at > nowIso();
  const actions: DeskAction[] = [];
  if (["local_investigation", "external_permission_needed", "no_eligible_provider"].includes(m.status)) {
    for (const o of await openOffers(app.db, m.job_code)) actions.push({ act: "a", extra: o.id, label: a.bAssign(o.description.slice(0, 40)) });
    actions.push({ act: "i", label: a.bIntro });
    if (external && fedEnabled(app.env) && m.status !== "local_investigation") actions.push({ act: "rt", label: a.bRoute });
    actions.push({ act: "np", label: a.bNoProvider });
  } else if (["service_committed", "in_delivery"].includes(m.status) && (await liveCommitment(app.db, { missionId: m.id }))) {
    actions.push({ act: "dv", label: a.bDelivered }, { act: "rl", label: a.bRelease });
  }
  return { external, actions };
}

export async function deskAction(app: App, missionId: string, act: string, extra: string, lang: Lang, scope: DeskScope = "operator"): Promise<Outcome & { alert?: boolean }> {
  const a = A(lang);
  const m = await getMission(app.db, missionId);
  if (!m || isTerminal(m)) return no(a.notOpen);
  if (scope !== "operator" && (!CLUB_ACTS.has(act) || !(await inClubs(app.db, m, scope.clubs)))) return no(a.notOpen);
  if (act === "a") {
    const offer: Offer | undefined = (await openOffers(app.db, m.job_code)).find((o) => o.id === extra);
    if (!offer) return { ...no(a.capacityFull), alert: true };
    // Slot first (atomic), then the state change; give the slot back if the mission moved meanwhile.
    const cid = await reserve(app.db, offer.id, { missionId: m.id });
    if (!cid) return { ...no(a.capacityFull), alert: true };
    if (!(await transition(app.db, m.id, "provider_selected", "operator", { from: m.status }))) {
      await release(app.db, cid, "cancelled");
      return no(a.notOpen);
    }
    await transition(app.db, m.id, "service_committed", "operator", { handler: "operator" });
    return { ok: true, msg: a.done, keys: await notifyMember(app, m.member_id, `mcl:${m.id}`, (x) => ({ text: x.committedLocal(escapeHtml(offer.description)) })) };
  }
  if (act === "i") {
    try {
      const r = await requestIntro(app.db, m.member_id, m.summary, nowIso(), lang);
      await app.db.prepare("UPDATE missions SET handler='intro' WHERE id=?").bind(m.id).run();
      return { ok: true, msg: a.done, keys: [...r.keys, ...(await notifyMember(app, m.member_id, `mint:${m.id}`, (x) => ({ text: x.introStarted })))] };
    } catch (e) {
      if (!(e instanceof IntroError)) throw e;
      return { ...no(e.message), alert: true };
    }
  }
  if (act === "rt") {
    if (!fedEnabled(app.env)) return { ...no(a.fedOff), alert: true };
    const r = await routeMission(app, m.id);
    return { ok: r.routed > 0, msg: a.routed(r.routed), keys: r.keys, alert: true };
  }
  if (act === "np") {
    const keys = (await stopMission(app, m, scope === "operator" ? "operator" : "club", "failed_with_explanation", "no_provider")) ?? [];
    await receipt(app.db, m.id, { service: "no_provider" });
    return { ok: true, msg: a.done, keys: [...keys, ...(await notifyMember(app, m.member_id, `mnp:${m.id}`, (x) => ({ text: x.noProvider })))] };
  }
  const c = await liveCommitment(app.db, { missionId: m.id });
  if (act === "dv" && c && (await deliver(app.db, c.id))) {
    await transition(app.db, m.id, "delivered", "operator", { handler: "member" });
    await receipt(app.db, m.id, { service: "local_service", commitmentId: c.id, provider: true });
    return {
      ok: true,
      msg: a.done,
      keys: await notifyMember(app, m.member_id, `mdv:${m.id}`, (x) => ({ text: x.deliveredQ, buttons: [[b(x.bUseful, `r:${m.id}:1`), b(x.bNotUseful, `r:${m.id}:0`)]] })),
    };
  }
  if (act === "rl" && c && (await release(app.db, c.id))) {
    await transition(app.db, m.id, "external_permission_needed", "operator", { handler: "operator" });
    return { ok: true, msg: a.done, keys: await notifyMember(app, m.member_id, `mrl:${m.id}:${c.id}`, (x) => ({ text: x.released })) };
  }
  return no(a.notOpen);
}

export async function exchangeAction(app: App, id: string, act: string, extra: string, lang: Lang): Promise<Outcome> {
  const a = A(lang);
  let r: { ok: boolean; keys: string[] } = { ok: false, keys: [] };
  if (act === "s") r = { ok: await markManualSent(app.db, id), keys: [] };
  else if (act === "o") r = await offerInbound(app, id, extra);
  else if (act === "d") r = await declineInbound(app, id);
  else if (act === "v") r = await finishInbound(app, id, "delivered");
  else if (act === "r") r = await finishInbound(app, id, "released");
  return { ok: r.ok, msg: r.ok ? a.done : a.notOpen, keys: r.keys };
}

export async function gapAction(app: App, job: string, act: string, lang: Lang): Promise<Outcome> {
  const a = A(lang);
  const ok = await setGapStatus(app.db, job, act === "off" ? "actioned" : "dismissed");
  return { ok, msg: ok ? a.done : a.notOpen, keys: [] };
}
