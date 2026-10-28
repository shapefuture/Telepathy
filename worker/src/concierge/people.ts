// The two switches behind the jobs people bring (plan: hiring and warm introductions). Each is the
// person's own choice, needs /optin first so that they can be found, and can be turned off at any
// time. Nothing here messages anyone: a request that matches them still goes through the consent steps.

import type { App } from "../bot";
import { langOf, type Member } from "../acl";
import { escapeHtml } from "../text";
import { audit } from "../util";
import { T2 } from "./texts";

/** Doors are a short line, matched against requests; nothing else is kept about them. */
export const DOORS_MAX = 200;

/** /open on | off | (status): be offered hiring requests from people in your groups. */
export async function openCommand(app: App, mem: Member, args: string): Promise<string> {
  const t = T2(langOf(mem));
  const arg = args.trim().toLowerCase();
  if (arg === "on") {
    if (!mem.discoverable) return t.openNeedsOptIn;
    await app.db.prepare("UPDATE members SET open_work=1 WHERE id=?").bind(mem.id).run();
    await audit(app.db, "consent.open_work", mem.id, mem.id, { granted: true });
    return t.openOn;
  }
  if (arg === "off") {
    await app.db.prepare("UPDATE members SET open_work=0 WHERE id=?").bind(mem.id).run();
    await audit(app.db, "consent.open_work", mem.id, mem.id, { granted: false });
    return t.openOff;
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
  const text = args.replace(/[\u0000-\u001f\u007f<>&"]/g, " ").replace(/\s+/g, " ").trim().slice(0, DOORS_MAX).trim();
  if (text.toLowerCase() === "off") {
    await app.db.prepare("UPDATE members SET doors=NULL WHERE id=?").bind(mem.id).run();
    await audit(app.db, "consent.doors", mem.id, mem.id, { granted: false });
    return t.introduceOff;
  }
  if (!text) return t.introduceUsage;
  if (!mem.discoverable) return t.introduceNeedsOptIn;
  await app.db.prepare("UPDATE members SET doors=? WHERE id=?").bind(text, mem.id).run();
  await audit(app.db, "consent.doors", mem.id, mem.id, { granted: true });
  return t.introduceOn(escapeHtml(text));
}
