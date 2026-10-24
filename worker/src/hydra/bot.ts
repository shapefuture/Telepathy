// /hydra for owners: the head graph in numbers, incidents and regrowth, canaries, registry,
// playbook, public notices, escrow and sealed relocations. Counts only; never names or addresses.

import type { App } from "../bot";
import { escapeHtml } from "../text";
import { nowIso } from "../util";
import { hydraMetrics } from "./graph";
import { addCanary, clubStep, openIncident, playbook, reviewIncident, setPlaybook, type CanaryKind } from "./regrow";
import { dueDrills, markDrillDone } from "./chaos";
import { publishNotice } from "./notices";
import { availableHeads } from "./deliver";
import { emailSenders } from "../continuity/email";
import { escrowRecipients, escrowTargets } from "./escrow";

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");

export async function hydraStatus(app: App): Promise<string> {
  const m = await hydraMetrics(app);
  const c = m.coverage;
  const idx = m.index;
  const open = (await app.db.prepare("SELECT id, domain, cause, drill_id, people_affected FROM head_incidents WHERE state='open' ORDER BY started_at DESC LIMIT 5").all<{ id: string; domain: string; cause: string; drill_id: string | null; people_affected: number }>()).results;
  const canaries = (await app.db.prepare("SELECT kind, domain, last_result, fails FROM canaries ORDER BY created_at").all<{ kind: string; domain: string; last_result: string | null; fails: number }>()).results;
  const escrow = await app.db.prepare("SELECT at, bytes, targets_ok, targets_failed FROM escrow_runs ORDER BY at DESC LIMIT 1").first<{ at: string; bytes: number; targets_ok: number; targets_failed: number }>();
  const seals = (await app.db.prepare("SELECT state, COUNT(*) AS n FROM sealed_held GROUP BY state").all<{ state: string; n: number }>()).results;
  const due = await dueDrills(app.db);
  const heads = availableHeads(app.env).map((h) => h.kind);
  const lines = [
    "<b>Hydra</b> (verified records only; people following critical notices)",
    `People: ${m.people} · ≥2 independent paths: ${c.atLeast2} (${pct(c.atLeast2, c.people)}) · ≥3: ${c.atLeast3} (${pct(c.atLeast3, c.people)}) · none: ${c.people - c.atLeast1}`,
    `Hydra index: <b>${idx.atLeast ? "≥" : ""}${idx.index}</b> (target ≥3)${idx.worst.length ? ` — weakest: ${idx.worst.map((w) => `<code>${escapeHtml(w)}</code>`).join(" + ")} would cut ${idx.cutOff}` : ""}`,
    `Heads on offer: ${heads.length ? heads.join(", ") : "email only"}${emailSenders(app.env).length === 1 ? " · ⚠️ one email provider (add EMAIL_B_*)" : ""}`,
    ...m.incidents.slice(0, 3).map((r) => `${r.drill ? "Drill" : "Incident"} <code>${escapeHtml(r.domain)}</code> ${r.startedAt.slice(0, 10)}: lost ${r.lost}, regrew ${r.added} (ratio ${r.ratio ?? "—"}, target ≥2)`),
    open.length ? `Open: ${open.map((o) => `<code>${o.id.slice(0, 6)}</code> ${escapeHtml(o.domain)} (${o.people_affected} people)`).join(", ")}` : "No open incidents.",
    m.domains.length ? `Not up: ${m.domains.map((d) => `${escapeHtml(d.domain)}=${d.state}`).join(", ")}` : "",
    `Canaries: ${canaries.length ? canaries.map((k) => `${k.kind}${k.fails ? "✗" : k.last_result ? "✓" : "…"}`).join(" ") : "none — /hydra canary add"}`,
    `Escrow: ${escrowRecipients(app.env).length} recipients, ${escrowTargets(app.env).length + (app.env.ESCROW_R2 ? 1 : 0)} targets${escrow ? ` · last ${escrow.at.slice(0, 10)} (${escrow.targets_ok} ok, ${escrow.targets_failed} failed)` : " · never run"}`,
    seals.length ? `Sealed relocations we hold for partners: ${seals.map((s) => `${s.n} ${s.state}`).join(", ")}` : "",
    due.length ? `Drills due: ${due.map((d) => d.type).join(", ")}` : "Drills: on schedule.",
    `Playbook (runs on its own): ${(await playbook(app.db)).join(", ") || "nothing"}`,
  ];
  return lines.filter(Boolean).join("\n");
}

const HELP = [
  "<code>/hydra</code> status · <code>/hydra index</code>",
  "<code>/hydra canary add ntfy|mirror|email|matrix|telegram [target]</code>",
  "<code>/hydra domain &lt;id&gt; parents &lt;a,b&gt;</code> (correlated failures)",
  "<code>/hydra incident &lt;domain&gt;</code> · <code>/hydra review &lt;id&gt; &lt;cause&gt; &lt;notes&gt;</code>",
  "<code>/hydra done|decline &lt;action&gt; [new-domain]</code> · <code>/hydra playbook a,b</code>",
  "<code>/hydra notice &lt;title&gt; | &lt;text&gt;</code> (public, signed)",
  "<code>/hydra drilled nexus_down|custodians</code>",
].join("\n");

export async function ownerHydra(app: App, chat: number, args: string, by: string): Promise<string[]> {
  const send = (t: string) => app.tg.sendMessage(chat, t);
  if (!app.env.CONTINUITY_KEY) {
    await send("Hydra builds on continuity, which isn't set up (CONTINUITY_KEY).");
    return [];
  }
  const w = args.trim().split(/\s+/).filter(Boolean);
  const sub = w[0] ?? "";
  if (!sub) {
    await send(await hydraStatus(app));
    return [];
  }
  if (sub === "index") {
    const m = await hydraMetrics(app);
    await send(`Hydra index ${m.index.atLeast ? "≥" : ""}${m.index.index} over ${m.people} people. Median independent paths per person: ${m.perPersonMedian}.\n${m.index.worst.length ? `Smallest cut: ${m.index.worst.map(escapeHtml).join(" + ")} → ${m.index.cutOff} unreachable.` : "No cut found within 4 domains."}`);
    return [];
  }
  if (sub === "canary" && w[1] === "add") {
    const r = await addCanary(app, w[2] as CanaryKind, w[3] ?? "");
    await send(r.ok ? `Canary added for <code>${escapeHtml(r.domain!)}</code>; it runs daily.` : `Not added: <code>${r.reason}</code>`);
    return [];
  }
  if (sub === "domain" && w[1]) {
    const id = w[1].slice(0, 80);
    if (w[2] === "parents") {
      const parents = (w[3] ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 8);
      await app.db.prepare("INSERT INTO failure_domains(id, parents, notes, updated_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET parents=excluded.parents, notes=excluded.notes, updated_at=excluded.updated_at").bind(id, JSON.stringify(parents), w.slice(4).join(" ").slice(0, 200), nowIso()).run();
      await send(`<code>${escapeHtml(id)}</code> now falls with: ${parents.map(escapeHtml).join(", ") || "nothing"}.`);
    } else {
      const r = await app.db.prepare("SELECT parents, notes FROM failure_domains WHERE id=?").bind(id).first<{ parents: string; notes: string | null }>();
      await send(r ? `<code>${escapeHtml(id)}</code> falls with ${escapeHtml(r.parents)}${r.notes ? ` — ${escapeHtml(r.notes)}` : ""}` : "Not in the registry (built-in rules only).");
    }
    return [];
  }
  if (sub === "incident" && w[1]) {
    const id = await openIncident(app, w[1].slice(0, 80), { cause: "operator_reported" });
    await send(`Incident <code>${id.slice(0, 6)}</code> open for <code>${escapeHtml(w[1])}</code>; affected members will be invited to add paths.`);
    return [];
  }
  if (sub === "review" && w[1] && w[2]) {
    await send((await reviewIncident(app.db, w[1], w[2], w.slice(3).join(" "))) ? "Review recorded. Future suggestions steer away from this domain." : "No such incident.");
    return [];
  }
  if ((sub === "done" || sub === "decline") && w[1]) {
    await send((await clubStep(app.db, w[1], w[2] ?? null, sub === "done" ? "done" : "declined")) ? `Recorded: ${escapeHtml(w[1])} ${sub === "done" ? "done" : "declined"}.` : "No proposed step with that name.");
    return [];
  }
  if (sub === "playbook") {
    const allowed = ["email_failover", "public_notice"];
    const list = (w[1] ?? "").split(",").map((s) => s.trim()).filter((s) => allowed.includes(s));
    await setPlaybook(app.db, list);
    await send(`Steps that run on their own: ${list.join(", ") || "none"}. Everything else is proposed to you. (Allowed: ${allowed.join(", ")}.)`);
    return [];
  }
  if (sub === "notice") {
    const [title, ...body] = w.slice(1).join(" ").split("|");
    const doc = title?.trim() ? await publishNotice(app, "notice", title, body.join("|") || title, by) : null;
    await send(doc ? `Published signed notice #${doc.signed.seq} to the feeds${app.env.MASTODON_URL || app.env.BLUESKY_HANDLE ? " and public accounts" : ""}.` : "Not published (needs club identity and a title).");
    return [];
  }
  if (sub === "drilled" && w[1]) {
    await send((await markDrillDone(app.db, w[1])) ? `Recorded ${escapeHtml(w[1])} drill as done today.` : "Use nexus_down or custodians.");
    return [];
  }
  await send(HELP);
  return [];
}


