// H0: the head graph from verified records only (never group size), and the Hydra numbers.

import type { App } from "../bot";
import { DAY } from "../util";
import { coverage, expandDomains, hydraIndex, independentCount, type Coverage, type HydraIndex, type PersonHeads } from "./domains";

export async function registry(db: D1Database): Promise<Record<string, string[]>> {
  const { results } = await db.prepare("SELECT id, parents FROM failure_domains").all<{ id: string; parents: string }>();
  return Object.fromEntries(results.map((r) => [r.id, JSON.parse(r.parents) as string[]]));
}

export interface GraphOptions {
  /** Drop heads of this channel for these people (head-off drills). */
  without?: { channel: string; people?: Set<string> };
  /** Only these people. */
  only?: Set<string>;
  /** Add "via:<channel>" to each head, so a whole channel can be failed (head-off drills). */
  tagChannels?: boolean;
}

/** Everyone following critical notices, with each alive, consented head's expanded domains. */
export async function loadGraph(app: App, opts: GraphOptions = {}): Promise<PersonHeads[]> {
  const db = app.db;
  const reg = await registry(db);
  const people = (await db.prepare("SELECT f.person_id AS id FROM follow_state f JOIN people p ON p.id=f.person_id WHERE f.topic='critical' AND f.status='following' AND p.removed_at IS NULL ORDER BY f.person_id").all<{ id: string }>()).results.filter((p) => !opts.only || opts.only.has(p.id));
  const heads = (
    await db
      .prepare(
        "SELECT r.person_id, r.channel, r.domains FROM delivery_registrations r WHERE r.status='verified' AND r.health<>'dead' AND r.channel<>'telegram' " +
          "AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.address_hash=r.suppress_hash AND s.scope IN ('critical','*'))",
      )
      .all<{ person_id: string; channel: string; domains: string | null }>()
  ).results;
  // A Telegram DM head is alive while the link holds and the bot isn't blocked by that person.
  const tg = (
    await db
      .prepare(
        "SELECT l.person_id FROM identity_links l JOIN members m ON m.id=l.account_id WHERE l.platform='telegram' AND l.revoked_at IS NULL AND m.removed_at IS NULL " +
          "AND NOT EXISTS (SELECT 1 FROM effects e WHERE e.chat_id=m.tg_id AND e.state='failed' AND e.error LIKE '%403%' AND e.created_at=(SELECT MAX(created_at) FROM effects x WHERE x.chat_id=m.tg_id))",
      )
      .all<{ person_id: string }>()
  ).results;
  const buddies = (await db.prepare("SELECT inviter, invitee FROM buddies WHERE status='active'").all<{ inviter: string; invitee: string }>()).results;
  const by = new Map<string, PersonHeads>(people.map((p) => [p.id, { id: p.id, heads: [], buddies: [] }]));
  const skip = (person: string, channel: string) => opts.without?.channel === channel && (!opts.without.people || opts.without.people.has(person));
  for (const h of heads) {
    const p = by.get(h.person_id);
    if (!p || skip(h.person_id, h.channel)) continue;
    const base: string[] = JSON.parse(h.domains ?? "[]").length ? JSON.parse(h.domains!) : [`${h.channel}:unknown`];
    p.heads.push(expandDomains(opts.tagChannels ? [...base, `via:${h.channel}`] : base, reg));
  }
  for (const t of tg) {
    const p = by.get(t.person_id);
    if (p && !skip(t.person_id, "telegram")) p.heads.push(expandDomains(opts.tagChannels ? ["telegram", "via:telegram"] : ["telegram"], reg));
  }
  for (const b of buddies) {
    by.get(b.inviter)?.buddies!.push(b.invitee);
    by.get(b.invitee)?.buddies!.push(b.inviter);
  }
  return [...by.values()];
}

export interface RegrowthRow {
  incident: string;
  domain: string;
  drill: boolean;
  lost: number;
  added: number;
  ratio: number | null;
  startedAt: string;
}

/** New independent heads added ÷ heads lost, per incident (members' new heads + club paths). */
export async function regrowth(db: D1Database, incidentId: string): Promise<RegrowthRow | null> {
  const inc = await db.prepare("SELECT id, domain, drill_id, started_at, heads_lost FROM head_incidents WHERE id=?").bind(incidentId).first<{ id: string; domain: string; drill_id: string | null; started_at: string; heads_lost: number }>();
  if (!inc) return null;
  const until = new Date(Date.parse(inc.started_at) + 14 * DAY).toISOString();
  const regs = await registry(db);
  const fresh = (
    await db
      .prepare("SELECT r.domains FROM delivery_registrations r JOIN regrowth_invites i ON i.person_id=r.person_id AND i.incident_id=? WHERE r.status='verified' AND r.verified_at>=? AND r.verified_at<=?")
      .bind(incidentId, inc.started_at, until)
      .all<{ domains: string | null }>()
  ).results.filter((r) => !expandDomains(JSON.parse(r.domains ?? "[]"), regs).includes(inc.domain)).length;
  const club = (await db.prepare("SELECT COUNT(*) AS n FROM club_regrowth WHERE incident_id=? AND state='done' AND (domain IS NULL OR domain<>?)").bind(incidentId, inc.domain).first<{ n: number }>())?.n ?? 0;
  const added = fresh + club;
  return { incident: inc.id, domain: inc.domain, drill: !!inc.drill_id, lost: inc.heads_lost, added, ratio: inc.heads_lost ? Math.round((added / inc.heads_lost) * 100) / 100 : null, startedAt: inc.started_at };
}

export interface HydraMetrics {
  people: number;
  coverage: Coverage;
  index: HydraIndex;
  perPersonMedian: number;
  incidents: RegrowthRow[];
  domains: { domain: string; state: string; changed_at: string }[];
}

export async function hydraMetrics(app: App): Promise<HydraMetrics> {
  const g = await loadGraph(app);
  const counts = g.map((p) => independentCount(p.heads)).sort((a, b) => a - b);
  const recent = (await app.db.prepare("SELECT id FROM head_incidents ORDER BY started_at DESC LIMIT 5").all<{ id: string }>()).results;
  const incidents = (await Promise.all(recent.map((r) => regrowth(app.db, r.id)))).filter((x): x is RegrowthRow => !!x);
  const domains = (await app.db.prepare("SELECT domain, state, changed_at FROM domain_health WHERE state<>'up' ORDER BY changed_at DESC LIMIT 10").all<{ domain: string; state: string; changed_at: string }>()).results;
  return { people: g.length, coverage: coverage(g), index: hydraIndex(g), perPersonMedian: counts.length ? counts[Math.floor(counts.length / 2)]! : 0, incidents, domains };
}
