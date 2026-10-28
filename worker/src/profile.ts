// The profile is one card: what matters at a glance, and a «Ещё» sheet for the rest. /digest and the
// sheet read the same settings, so they cannot disagree (they did: «выключена» in one, «вкл» in the other).

import type { App } from "./bot";
import { langOf, memberByTg, type Member } from "./acl";
import { digestHour, timezone } from "./env";
import { setOpenWork } from "./concierge/people";
import { btn, T2 } from "./concierge/texts";
import { skillName } from "./experts";
import { T, type Lang } from "./i18n";
import { openPrompt, skillKeysAfter } from "./prompts";
import { helpedCount } from "./thread-card";
import type { InlineButton } from "./telegram";
import { escapeHtml } from "./text";
import { audit, tzOffsetMinutes } from "./util";

export type View = { text: string; buttons: InlineButton[][] };
export type Action = { toast: string; view?: View; keys: string[] };

/** Quiet hours as the club sees them ("22:00–08:00"), from the hours stored in UTC; null when they are off. */
export function quietLocal(mem: Member, tz: string): string | null {
  if (mem.quiet_from === null || mem.quiet_from === undefined || mem.quiet_to === null || mem.quiet_to === undefined) return null;
  const off = Math.round(tzOffsetMinutes(new Date(), tz) / 60);
  const hh = (utc: number) => String((utc + off + 24) % 24).padStart(2, "0") + ":00";
  return `${hh(mem.quiet_from)}–${hh(mem.quiet_to)}`;
}

/** The main card: what the person helps with, their doors, projects, pause, and the sheet. */
export function profileCard(mem: Member, skills: { code: string; state: string }[], helped: number, lang: Lang): View {
  const m = T(lang);
  const t2 = T2(lang);
  const list = skills.map((s) => `${escapeHtml(skillName(s.code, lang))}${s.state === "confirmed" ? "" : ` (${m.suggested})`}`).join(", ");
  return {
    text: [
      m.profileTitle,
      `${m.pSkills}: ${list || m.pNoSkills}`,
      `${t2.pDoors}: ${mem.doors ? `«${escapeHtml(mem.doors)}»` : t2.pNoDoors}`,
      `${m.pOpenLine}: <b>${mem.open_work ? m.yes : m.no}</b>`,
      `${m.pAvailable}: <b>${mem.available ? m.pGoing : m.pPaused}</b>`,
      m.pHelped(helped),
    ].join("\n"),
    buttons: [
      [btn(m.bHelpWith, "p:helpwith"), btn(mem.doors ? t2.bDoorsEdit : t2.bDoorsOn, "dr:ask")],
      [btn(mem.open_work ? t2.bOpenOff : t2.bOpenOn, `p:open:${mem.open_work ? 0 : 1}`)],
      [btn(mem.available ? m.bPause : m.bResume, `p:available:${mem.available ? 0 : 1}`), btn(m.bMore, "p:more")],
    ],
  };
}

/** The «Ещё» sheet: the switches that rarely change, each with its state. */
export function moreCard(mem: Member, lang: Lang, tz: string): View {
  const m = T(lang);
  const t2 = T2(lang);
  const quiet = quietLocal(mem, tz);
  const buttons: InlineButton[][] = [
    [btn(mem.digest ? m.bDigestOff : m.bDigestOn, `p:digest:${mem.digest ? 0 : 1}:m`)],
    [btn(mem.reminders ? m.bRemindersOff : m.bRemindersOn, `p:reminders:${mem.reminders ? 0 : 1}:m`)],
    [btn(quiet ? m.bQuietOff : m.bQuietOn, `p:quiet:${quiet ? 0 : 1}:m`)],
    [btn(mem.display_name ? m.bNameOff : m.bNameOn, `p:name:${mem.display_name ? 0 : 1}:m`)],
    [btn(mem.discoverable ? m.bDiscoverOff : m.bDiscoverOn, `p:discoverable:${mem.discoverable ? 0 : 1}:m`)],
    [btn(lang === "ru" ? "English" : "Русский", `p:lang:${lang === "ru" ? "en" : "ru"}:m`)],
  ];
  if (mem.doors) buttons.push([btn(t2.bDoorsOff, "dr:off:m")]);
  buttons.push([btn(m.bBack, "p:back")]);
  return {
    text: [
      m.moreTitle,
      `${m.pDigest}: <b>${mem.digest ? m.on : m.off}</b>`,
      `${m.pReminders}: <b>${mem.reminders ? m.on : m.off}</b>`,
      `${m.pQuiet}: <b>${escapeHtml(quiet ?? m.off)}</b>`,
      `${m.pName}: <b>${mem.display_name ? m.on : m.off}</b>`,
      `${m.pCollection}: <b>${mem.collection_opt_out ? m.pStopped : m.on}</b>`,
      `${m.pDiscoverable}: <b>${mem.discoverable ? m.yes : m.no}</b>`,
      `${m.pLanguage}: <b>${lang === "ru" ? "русский" : "English"}</b>`,
      "",
      m.moreNote,
    ].join("\n"),
    buttons,
  };
}

/** The daily digest on its own: what /digest shows, and the same switch as the sheet's. */
export function digestCard(mem: Member, lang: Lang, hour: number): View {
  const m = T(lang);
  return { text: m.digestState(!!mem.digest, hour), buttons: [[btn(mem.digest ? m.bDigestOff : m.bDigestOn, `c:dg:${mem.digest ? 0 : 1}`)]] };
}

/** The main card as it stands now. */
export async function profileFor(app: App, mem: Member): Promise<View> {
  const skills = (await app.db.prepare("SELECT code, state FROM skills WHERE member_id=? ORDER BY code").bind(mem.id).all<{ code: string; state: string }>()).results;
  return profileCard(mem, skills, await helpedCount(app.db, mem.id), langOf(mem));
}

/**
 * A press on the profile or its sheet. `sheet` says which card to draw again; `firstName` is what the
 * name switch shows in answers (Telegram gives it with the press).
 */
export async function profileAction(app: App, mem: Member, a: string, b: string, sheet: boolean, firstName?: string, now = new Date()): Promise<Action> {
  const db = app.db;
  const tz = timezone(app.env);
  const on = b === "1";
  const m0 = T(langOf(mem));
  const current = async (): Promise<Member> => (await memberByTg(db, mem.tg_id)) ?? mem;
  const back = async (toast: string, keys: string[] = []): Promise<Action> => {
    const fresh = await current();
    const view = sheet ? moreCard(fresh, langOf(fresh), tz) : await profileFor(app, fresh);
    return { toast, keys, view };
  };
  switch (a) {
    case "more":
      return { toast: "", keys: [], view: moreCard(await current(), langOf(mem), tz) };
    case "back":
      return { toast: "", keys: [], view: await profileFor(app, await current()) };
    case "helpwith":
      await openPrompt(app, mem, "bio", m0.bioPrompt, now);
      return { toast: "", keys: [] };
    case "open": {
      const r = await setOpenWork(app, mem, on);
      if (r === "needs_optin") return { toast: T2(langOf(mem)).openNeedsOptIn, keys: [] };
      return back(r === "on" ? T2(langOf(mem)).openOn : T2(langOf(mem)).openOff);
    }
    case "digest": {
      if (!!mem.digest === on) return back(m0.digestAlready(on));
      await db.prepare("UPDATE members SET digest=? WHERE id=?").bind(on ? 1 : 0, mem.id).run();
      return back(on ? m0.digestOn(digestHour(app.env)) : m0.digestOff);
    }
    case "reminders":
      await db.prepare("UPDATE members SET reminders=? WHERE id=?").bind(on ? 1 : 0, mem.id).run();
      return back(m0.saved);
    case "quiet": {
      // 22:00–08:00 in the club's timezone, stored in UTC.
      const off = Math.round(tzOffsetMinutes(new Date(), tz) / 60);
      const utc = (h: number) => (h - off + 24) % 24;
      await db.prepare("UPDATE members SET quiet_from=?, quiet_to=? WHERE id=?").bind(on ? utc(22) : null, on ? utc(8) : null, mem.id).run();
      return back(m0.saved);
    }
    case "name":
      await db.prepare("UPDATE members SET display_name=? WHERE id=?").bind(on ? (firstName ?? null) : null, mem.id).run();
      return back(m0.saved);
    case "discoverable": {
      if (!!mem.discoverable === on) return back(on ? m0.optinAlready("") : m0.optoutAlready);
      await db.prepare("UPDATE members SET discoverable=? WHERE id=?").bind(on ? 1 : 0, mem.id).run();
      await audit(db, "consent.discovery", mem.id, mem.id, { granted: on });
      return back(on ? m0.saved : m0.optoutAlready, on ? await skillKeysAfter(app, mem.id, now) : []);
    }
    case "available": {
      if (!!mem.available === on) return back(m0.alreadySet);
      await db.prepare("UPDATE members SET available=? WHERE id=?").bind(on ? 1 : 0, mem.id).run();
      return back(m0.saved, on ? await skillKeysAfter(app, mem.id, now) : []);
    }
    case "lang": {
      if (b !== "en" && b !== "ru") return back(m0.saved);
      await db.prepare("UPDATE members SET lang=?, lang_explicit=1 WHERE id=?").bind(b, mem.id).run();
      return back(T(b).saved);
    }
    default:
      return { toast: "", keys: [] };
  }
}
