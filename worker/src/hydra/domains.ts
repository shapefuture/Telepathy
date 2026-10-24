// H0: count paths that don't fall together. Every delivery head depends on one or more failure
// domains; a head is alive only while all of them are up. Two Gmail addresses share
// "mail:google"; Gmail and Chrome push share the parent "org:google". The registry table lets
// people add correlations the code can't see (e.g. a self-hosted ntfy on the same cloud).
// Pure functions here; loading from D1 is in graph.ts.

export type HeadKind = "telegram" | "email" | "webpush" | "ntfy" | "matrix" | "sms";

const MAIL: Record<string, string> = {
  "gmail.com": "google", "googlemail.com": "google",
  "outlook.com": "microsoft", "hotmail.com": "microsoft", "live.com": "microsoft", "msn.com": "microsoft",
  "yahoo.com": "yahoo", "aol.com": "yahoo", "ymail.com": "yahoo",
  "icloud.com": "apple", "me.com": "apple", "mac.com": "apple",
  "proton.me": "proton", "protonmail.com": "proton", "pm.me": "proton",
  "yandex.ru": "yandex", "ya.ru": "yandex", "yandex.com": "yandex",
  "mail.ru": "vk", "bk.ru": "vk", "inbox.ru": "vk", "list.ru": "vk",
  "gmx.de": "united_internet", "gmx.net": "united_internet", "web.de": "united_internet",
  "fastmail.com": "fastmail", "tutanota.com": "tuta", "tuta.io": "tuta", "zoho.com": "zoho",
};
/** MX host suffix → mailbox operator (custom domains hosted by a big provider). */
const MX: [RegExp, string][] = [
  [/(google\.com|googlemail\.com)\.?$/, "google"],
  [/(outlook\.com|office365\.us)\.?$/, "microsoft"],
  [/(yahoodns\.net)\.?$/, "yahoo"],
  [/(icloud\.com)\.?$/, "apple"],
  [/(protonmail\.ch)\.?$/, "proton"],
  [/(yandex\.(ru|net))\.?$/, "yandex"],
  [/(mail\.ru)\.?$/, "vk"],
  [/(messagingengine\.com)\.?$/, "fastmail"],
  [/(zoho\.(com|eu))\.?$/, "zoho"],
];
const PUSH: [RegExp, string][] = [
  [/(^|\.)googleapis\.com$/, "google"],
  [/(^|\.)mozilla\.com$/, "mozilla"],
  [/(^|\.)push\.apple\.com$/, "apple"],
  [/(^|\.)notify\.windows\.com$/, "microsoft"],
];
/** Mailbox and push operators that are the same company: one big outage takes both. */
const ORG_PARENT: Record<string, string> = { google: "org:google", microsoft: "org:microsoft", apple: "org:apple", yahoo: "org:yahoo" };

export const PUSH_HOSTS = PUSH.map(([re]) => re);

export function mailboxOperator(email: string, mxHost?: string | null): string {
  const d = email.trim().toLowerCase().split("@")[1] ?? "";
  if (MAIL[d]) return MAIL[d]!;
  if (mxHost) for (const [re, op] of MX) if (re.test(mxHost.toLowerCase())) return op;
  return d || "unknown";
}

export function pushOperator(endpoint: string): string | null {
  let h: string;
  try {
    h = new URL(endpoint).hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const [re, op] of PUSH) if (re.test(h)) return op;
  return null;
}

/** Base failure domains of one head (before the registry adds parents). */
export function headDomains(kind: HeadKind, address: string, opts: { mx?: string | null; senders?: string[]; matrixServer?: string } = {}): string[] {
  const out: string[] = [];
  switch (kind) {
    case "telegram":
      out.push("telegram");
      break;
    case "email": {
      const op = mailboxOperator(address, opts.mx);
      out.push(`mail:${op}`);
      // With one sending provider, it is a single point of failure for every email head.
      // With two or more (automatic failover), no single sender takes email down.
      if ((opts.senders ?? []).length === 1) out.push(`sender:${opts.senders![0]}`);
      break;
    }
    case "webpush":
      out.push(`push:${pushOperator(address) ?? "unknown"}`);
      break;
    case "ntfy":
      out.push(`ntfy:${safeHost(address)}`);
      break;
    case "matrix": {
      out.push(`matrix:${address.split(":").slice(1).join(":").toLowerCase()}`);
      if (opts.matrixServer) out.push(`matrix:${safeHost(opts.matrixServer)}`);
      break;
    }
    case "sms":
      out.push("sms");
      break;
  }
  return [...new Set(out)];
}

function safeHost(u: string): string {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return "unknown";
  }
}

/** Built-in parents plus the registry's. Transitive, cycle-safe. */
export function expandDomains(base: string[], registry: Record<string, string[]>): string[] {
  const out = new Set<string>();
  const stack = [...base];
  while (stack.length) {
    const d = stack.pop()!;
    if (out.has(d)) continue;
    out.add(d);
    const op = /^(mail|push):(.+)$/.exec(d)?.[2];
    if (op && ORG_PARENT[op]) stack.push(ORG_PARENT[op]!);
    for (const p of registry[d] ?? []) stack.push(p);
  }
  return [...out].sort();
}

// ---- the head graph and its numbers -----------------------------------------------------------

export interface PersonHeads {
  id: string;
  /** Each alive head as its full (expanded) domain list. */
  heads: string[][];
  /** People who agreed to pass critical notices to this person (buddy mesh). */
  buddies?: string[];
}

/** Largest number of heads with pairwise disjoint domains (independent paths). */
export function independentCount(heads: string[][]): number {
  const hs = dedupe(heads).slice(0, 12);
  let best = 0;
  const pick = (i: number, used: Set<string>, n: number) => {
    if (n + (hs.length - i) <= best) return;
    if (i === hs.length) {
      best = Math.max(best, n);
      return;
    }
    const h = hs[i]!;
    if (h.every((d) => !used.has(d))) pick(i + 1, new Set([...used, ...h]), n + 1);
    pick(i + 1, used, n);
  };
  pick(0, new Set(), 0);
  return best;
}

function dedupe(heads: string[][]): string[][] {
  const seen = new Set<string>();
  return heads.filter((h) => {
    const k = [...h].sort().join("|");
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export interface Coverage {
  people: number;
  atLeast1: number;
  atLeast2: number;
  atLeast3: number;
}

export function coverage(graph: PersonHeads[]): Coverage {
  const c = { people: graph.length, atLeast1: 0, atLeast2: 0, atLeast3: 0 };
  for (const p of graph) {
    const n = independentCount(p.heads) + (p.buddies?.length ? 1 : 0);
    if (n >= 1) c.atLeast1++;
    if (n >= 2) c.atLeast2++;
    if (n >= 3) c.atLeast3++;
  }
  return c;
}

export interface HydraIndex {
  /** Fewest domains whose joint failure cuts off more than `threshold` of people. */
  index: number;
  /** True when no cut was found up to maxK: the real index is larger than reported. */
  atLeast: boolean;
  worst: string[];
  cutOff: number;
  people: number;
}

/**
 * Hydra index. A person is cut off when every head shares a domain with the failed set and no
 * buddy (reached directly) can pass the message on. Exhaustive over combinations of the 24 most
 * used domains up to maxK, on deduplicated head signatures, using bitmasks (fast enough for a
 * Worker command; the cron never runs it).
 */
export function hydraIndex(graph: PersonHeads[], opts: { threshold?: number; maxK?: number } = {}): HydraIndex {
  const threshold = opts.threshold ?? 0.1;
  const maxK = opts.maxK ?? 4;
  const total = graph.length;
  if (!total) return { index: 0, atLeast: false, worst: [], cutOff: 0, people: 0 };
  const freq = new Map<string, number>();
  for (const p of graph) for (const h of p.heads) for (const d of h) freq.set(d, (freq.get(d) ?? 0) + 1);
  const domains = [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 24).map(([d]) => d);
  const bit = new Map(domains.map((d, i) => [d, 1 << i]));
  const OTHER = 1 << 30; // domains outside the top 24 never fail in this search
  const mask = (h: string[]) => h.reduce((m, d) => m | (bit.get(d) ?? OTHER), 0) & ~OTHER;
  const idx = new Map(graph.map((p, i) => [p.id, i]));
  const people = graph.map((p) => ({ heads: p.heads.map(mask), buddies: (p.buddies ?? []).map((b) => idx.get(b)).filter((x): x is number => x !== undefined) }));
  const cut = (failed: number) => {
    const direct = people.map((p) => p.heads.some((h) => (h & failed) === 0));
    let n = 0;
    for (let i = 0; i < people.length; i++) if (!direct[i] && !people[i]!.buddies.some((b) => direct[b])) n++;
    return n;
  };
  const limit = total * threshold;
  const zero = cut(0);
  if (zero > limit) return { index: 0, atLeast: false, worst: [], cutOff: zero, people: total };
  for (let k = 1; k <= Math.min(maxK, domains.length); k++) {
    const combo: number[] = [];
    let found: { m: number; n: number } | null = null;
    const walk = (start: number, m: number) => {
      if (found) return;
      if (combo.length === k) {
        const n = cut(m);
        if (n > limit) found = { m, n };
        return;
      }
      for (let i = start; i < domains.length; i++) {
        combo.push(i);
        walk(i + 1, m | (1 << i));
        combo.pop();
      }
    };
    walk(0, 0);
    if (found) {
      const f = found as { m: number; n: number };
      return { index: k, atLeast: false, worst: domains.filter((_, i) => f.m & (1 << i)), cutOff: f.n, people: total };
    }
  }
  return { index: Math.min(maxK, domains.length) + 1, atLeast: true, worst: [], cutOff: 0, people: total };
}

/**
 * Which kinds to suggest so the next two heads are independent of what the person has and of
 * each other. `available` = kinds this club has switched on; `recentlyHit` = domains of recent
 * incidents (learned from hits: suggest those last).
 */
export function suggestHeads(current: string[][], available: { kind: HeadKind | "recovery_card" | "buddy"; domain: string }[], recentlyHit: string[] = [], n = 2): string[] {
  const have = new Set(current.flat());
  const hit = new Set(recentlyHit);
  const picks: string[] = [];
  const used = new Set<string>();
  const ranked = available
    .filter((a) => !have.has(a.domain))
    .sort((a, b) => Number(hit.has(a.domain)) - Number(hit.has(b.domain)));
  for (const a of ranked) {
    if (picks.length >= n) break;
    if (used.has(a.domain) || picks.includes(a.kind)) continue;
    picks.push(a.kind);
    used.add(a.domain);
  }
  return picks;
}
