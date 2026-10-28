// The two switches behind the jobs people bring (plan: hiring and warm introductions). Each is the
// person's own choice, needs /optin first so that they can be found, and can be turned off at any
// time. Nothing here messages anyone: a request that matches them still goes through the consent steps.
// The bot's commands and the Mini App call the same functions, so the two can't disagree.

import type { App } from "../bot";
import { langOf, type Member } from "../acl";
import { escapeHtml } from "../text";
import { audit } from "../util";
import { T2 } from "./texts";

/** Doors are a short line, matched against requests; nothing else is kept about them. */
export const DOORS_MAX = 200;

/** The line as stored: plain text, no markup, short. Empty when nothing usable is left. */
export function cleanDoors(raw: string): string {
  return raw.replace(/[\u0000-\u001f\u007f<>&"]/g, " ").replace(/\s+/g, " ").trim().slice(0, DOORS_MAX).trim();
}

/** Turns hiring offers on or off. Turning them on needs /optin first. */
export async function setOpenWork(app: App, mem: Member, on: boolean): Promise<"on" | "off" | "needs_optin"> {
  if (on && !mem.discoverable) return "needs_optin";
  await app.db.prepare("UPDATE members SET open_work=? WHERE id=?").bind(on ? 1 : 0, mem.id).run();
  await audit(app.db, "consent.open_work", mem.id, mem.id, { granted: on });
  return on ? "on" : "off";
}

/** Saves a cleaned, non-empty doors line. Needs /optin first. */
export async function saveDoors(app: App, mem: Member, text: string): Promise<"saved" | "needs_optin"> {
  if (!mem.discoverable) return "needs_optin";
  await app.db.prepare("UPDATE members SET doors=? WHERE id=?").bind(text, mem.id).run();
  await audit(app.db, "consent.doors", mem.id, mem.id, { granted: true });
  return "saved";
}

/** Clears the doors line: nobody is asked for an introduction through this person any more. */
export async function clearDoors(app: App, mem: Member): Promise<void> {
  await app.db.prepare("UPDATE members SET doors=NULL WHERE id=?").bind(mem.id).run();
  await audit(app.db, "consent.doors", mem.id, mem.id, { granted: false });
}

/** /open on | off | (status): be offered hiring requests from people in your groups. */
export async function openCommand(app: App, mem: Member, args: string): Promise<string> {
  const t = T2(langOf(mem));
  const arg = args.trim().toLowerCase();
  if (arg === "on" || arg === "off") {
    const r = await setOpenWork(app, mem, arg === "on");
    if (r === "needs_optin") return t.openNeedsOptIn;
    return r === "on" ? t.openOn : t.openOff;
  }
  if (arg) return t.openUsage;
  const cur = await app.db.prepare("SELECT open_work FROM members WHERE id=?").bind(mem.id).first<{ open_work: number }>();
  return t.openStatus(!!cur?.open_work);
}

/**
 * /introduce <who or where you can open doors to> saves that line; /introduce off clears it. The line
 * is only matched against requests for introductions. It is never shown to anyone.
 */
export async function introduceCommand(app: App, mem: Member, args: string): Promise<string> {
  const t = T2(langOf(mem));
  const text = cleanDoors(args);
  if (text.toLowerCase() === "off") {
    await clearDoors(app, mem);
    return t.introduceOff;
  }
  if (!text) return t.introduceUsage;
  if ((await saveDoors(app, mem, text)) === "needs_optin") return t.introduceNeedsOptIn;
  return t.introduceOn(escapeHtml(text));
}
