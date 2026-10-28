// Continuity in the chat: /passport for members; /continuity, /destinations, /alert, /drill for owners.

import { langOf, type Member } from "../acl";
import type { App } from "../bot";
import type { Lang } from "../i18n";
import type { InlineButton } from "../telegram";
import { escapeHtml } from "../text";
import { AlertError, createAlert, metrics, startDrill } from "./alerts";
import { ownerHydra } from "../hydra/bot";
import { endAnyDrill, HEAD_CHANNELS, startHeadOffDrill } from "../hydra/chaos";
import { anchorRecord, publishNotice, touchOwners } from "../hydra/notices";
import { currentManifest, editBackups, KINDS, type DestKind } from "./identity";
import { personForMember, protection } from "./people";

export const CONTINUITY_OWNER = new Set(["continuity", "destinations", "alert", "drill", "hydra"]);

const T = {
  en: {
    off: "Continuity isn't set up on this bot yet (CONTINUITY_KEY).",
    why: "<b>Passport</b>: keep your connection to the community even if this chat changes or Telegram is unavailable. You choose what you receive; nothing is turned on without you.",
    level: { protected: "✅ Protected: you can log in and be reached without Telegram.", login_only: "🟡 You can log in without Telegram; critical notices have no verified route yet.", not_yet_protected: "🟡 Not yet protected: add and verify an email.", not_enrolled: "⚪ Not set up yet." } as Record<string, string>,
    open: "Open Passport",
    noApp: "Open the app from the menu button, tab “Passport”.",
  },
  ru: {
    off: "Непрерывность связи ещё не настроена (CONTINUITY_KEY).",
    why: "<b>Паспорт</b>: сохраните связь с сообществом, даже если чат изменится или Telegram будет недоступен. Вы сами выбираете, что получать; без вас ничего не включается.",
    level: { protected: "✅ Защищено: можно войти и получать сообщения без Telegram.", login_only: "🟡 Вход без Telegram есть; для важных уведомлений ещё нет проверенного канала.", not_yet_protected: "🟡 Пока не защищено: добавьте и подтвердите email.", not_enrolled: "⚪ Ещё не настроено." } as Record<string, string>,
    open: "Открыть паспорт",
    noApp: "Откройте приложение кнопкой «Приложение» внизу слева, вкладка «Паспорт».",
  },
};

export async function cmdPassport(app: App, chat: number, mem: Member): Promise<string[]> {
  const t = T[langOf(mem) as Lang];
  if (!app.env.CONTINUITY_KEY) {
    await app.tg.sendMessage(chat, t.off);
    return [];
  }
  const p = await protection(app.env, app.db, await personForMember(app.db, mem.id));
  const origin = (app.env.PUBLIC_URL ?? "").replace(/\/$/, "");
  const buttons = origin ? [[{ text: t.open, web_app: { url: `${origin}/app#passport` } } as unknown as InlineButton]] : undefined;
  await app.tg.sendMessage(chat, `${t.why}\n\n${t.level[p.level]}${origin ? "" : `\n\n${t.noApp}`}`, { buttons });
  return [];
}

export async function ownerContinuity(app: App, chat: number, cmd: string, args: string, by: string): Promise<string[]> {
  const send = (text: string) => app.tg.sendMessage(chat, text);
  if (!app.env.CONTINUITY_KEY) {
    await send(T.en.off);
    return [];
  }
  await touchOwners(app.db); // heartbeat: owners are around (sealed relocations watch this)
  if (cmd === "hydra") return ownerHydra(app, chat, args, by);
  const words = args.trim().split(/\s+/).filter(Boolean);
  if (cmd === "continuity") {
    const m = await metrics(app.db);
    const pct = (x: number | null) => (x === null ? "—" : `${x}%`);
    const lines = [
      "<b>Continuity</b> (counts are verified records, not group size)",
      `Club identity: ${m.identity.root ? "root pinned ✓" : "no root yet"} · address list ${m.identity.manifestVersion ? `v${m.identity.manifestVersion}, expires ${m.identity.manifestExpires?.slice(0, 10)}` : "not published"}`,
      `Independent enrolment (IER): ${pct(m.IER)} — ${m.independentLogin} of ${m.eligibleMembers} members can log in without Telegram`,
      `Verified alternate reach (VAR): ${pct(m.VAR)} — ${m.verifiedAlternate} of ${m.followingCritical} following critical notices have a verified email`,
      `Recovery eligible (RE): ${pct(m.RE)} of ${m.enrolled} enrolled`,
      m.lastDrill ? `Last drill (${m.lastDrill.scenario}${m.lastDrill.ended ? "" : ", running"}): ${m.lastDrill.confirmed}/${m.lastDrill.invited} confirmed (RDS ${pct(m.lastDrill.RDS)})` : "No recovery drill yet: /drill start telegram_down",
      `Unverified "protected" claims (PI): ${m.PI}`,
    ];
    await send(lines.join("\n"));
    return [];
  }
  if (cmd === "destinations") {
    if (words[0] === "add" && KINDS.includes(words[1] as DestKind) && words[2]) {
      const r = await editBackups(app, { add: { kind: words[1] as DestKind, url: words[2], role: "backup" } }, by);
      if (r.ok) await publishNotice(app, "anchor", "Address list updated", (await anchorRecord(app.db)) ?? "", by);
      await send(r.ok ? `Backup added; signed address list v${r.version}.` : `Not changed: <code>${escapeHtml(r.reason)}</code>`);
      return [];
    }
    if (words[0] === "remove" && words[1]) {
      const r = await editBackups(app, { removeUrl: words[1] }, by);
      if (r.ok) await publishNotice(app, "anchor", "Address list updated", (await anchorRecord(app.db)) ?? "", by);
      await send(r.ok ? `Removed; signed address list v${r.version}.` : `Not changed: <code>${escapeHtml(r.reason)}</code>`);
      return [];
    }
    if (words[0] === "resign") {
      const r = await editBackups(app, null, by);
      if (r.ok) await publishNotice(app, "anchor", "Address list updated", (await anchorRecord(app.db)) ?? "", by);
      await send(r.ok ? `Re-signed; v${r.version}, valid 30 days.` : `Not changed: <code>${escapeHtml(r.reason)}</code>`);
      return [];
    }
    const m = await currentManifest(app.db);
    await send(
      (m ? `<b>Official places</b> (signed v${m.signed.version}, expires ${m.signed.expires.slice(0, 10)})\n` + m.signed.destinations.map((d) => `${d.role === "primary" ? "★" : "·"} ${d.kind}: ${escapeHtml(d.url)}`).join("\n") : "No signed address list yet.") +
        `\n\n<code>/destinations add ${KINDS.join("|")} &lt;url&gt;</code> · <code>/destinations remove &lt;url&gt;</code> · <code>/destinations resign</code>\nChanging the primary address needs the root keys (OPERATOR_GUIDE).`,
    );
    return [];
  }
  if (cmd === "alert") {
    const kind = words[0] === "relocation" ? "relocation" : words[0] === "incident" ? "incident" : null;
    if (!kind) {
      await send("<code>/alert incident [public] &lt;note&gt;</code> or <code>/alert relocation &lt;note&gt;</code>. Goes only to people who chose critical notices, over every path they verified; at most one a day. Relocations (and incidents marked public) also go to the signed public feeds.");
      return [];
    }
    const isPublic = kind === "relocation" || words[1] === "public";
    const note = words.slice(isPublic && kind === "incident" ? 2 : 1).join(" ");
    try {
      const r = await createAlert(app, kind, note, by);
      const pub = isPublic ? await publishNotice(app, kind, kind === "relocation" ? "We have moved" : "Service notice", note || "See the official address list.", by) : null;
      await send(`Queued: ${r.queued} deliveries.${pub ? ` Public notice #${pub.signed.seq} published.` : ""}`);
      return []; // Telegram copies go out through the effect ledger on the next cron run
    } catch (e) {
      if (!(e instanceof AlertError)) throw e;
      await send(`Not sent: <code>${e.message}</code>`);
      return [];
    }
  }
  // drill
  if (words[0] === "start" && words[1] === "head_off" && HEAD_CHANNELS.includes(words[2] ?? "")) {
    try {
      const r = await startHeadOffDrill(app, words[2]!, Number(words[3] ?? "20") || 20, by);
      await send(`Head-off drill: ${words[2]} switched off for ${r.cohort} people; ${r.queued} drill deliveries queued over their other paths. They'll be invited to add two paths. End with /drill end.`);
    } catch (e) {
      if (!(e instanceof AlertError)) throw e;
      await send(`Not started: <code>${e.message}</code>`);
    }
    return [];
  }
  if (words[0] === "start" && ["telegram_down", "nexus_down", "domain_down"].includes(words[1] ?? "")) {
    try {
      const r = await startDrill(app, words[1] as "telegram_down", by);
      await send(`Drill started: ${r.invited} people invited to confirm. End it with /drill end.`);
    } catch (e) {
      if (!(e instanceof AlertError)) throw e;
      await send(`Not started: <code>${e.message}</code>`);
    }
    return [];
  }
  if (words[0] === "end") {
    const r = await endAnyDrill(app, words.slice(1).join(" "));
    await send(
      r
        ? `Drill ended: ${r.confirmed}/${r.invited} confirmed (${r.reachedPct ?? "—"}%, target ≥90%).` + (r.regrowth ? ` Regrowth: ${r.regrowth.added} new paths for ${r.regrowth.lost} lost (ratio ${r.regrowth.ratio ?? "—"}, target ≥2; counts keep growing for 14 days, see /hydra).` : "")
        : "No drill is running.",
    );
    return [];
  }
  await send(`<code>/drill start telegram_down|nexus_down|domain_down</code> · <code>/drill start head_off ${HEAD_CHANNELS.join("|")} [percent]</code> · <code>/drill end [notes]</code>`);
  return [];
}
