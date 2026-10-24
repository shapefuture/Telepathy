// Consent decisions (plan D.3). A grant authorizes one action, for one audience, purpose,
// field set and mission version. There is no broad `consented=true` flag anywhere.

export type ConsentAction = "local" | "external_discovery" | "reveal" | "feedback";

export interface Grant {
  action: ConsentAction;
  audience: string; // 'home' or JSON array of partner ids
  fields: string; // JSON array
  mission_version: number;
  policy_version: number;
  expires_at: string;
  revoked_at: string | null;
}

/** Fields that may ever appear in an Opportunity Envelope (E.2). Everything else is refused. */
export const ENVELOPE_FIELDS = ["job", "summary", "criteria"] as const;
export type EnvelopeField = (typeof ENVELOPE_FIELDS)[number];

export const CONSENT_TTL_DAYS = 14;

export function audienceOf(g: Pick<Grant, "audience">): string[] {
  if (g.audience === "home") return ["home"];
  try {
    const a = JSON.parse(g.audience);
    return Array.isArray(a) ? a.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Is this grant valid right now for `action` towards `audience` on `missionVersion` under
 * `policyVersion`? Deny on anything stale or unknown (I08: deny on stale policy data).
 */
export function grantAllows(
  g: Grant | null | undefined,
  want: { action: ConsentAction; audience: string; missionVersion: number; policyVersion: number; fields?: readonly string[]; now: string },
): boolean {
  if (!g || g.revoked_at || g.action !== want.action) return false;
  if (g.expires_at <= want.now) return false;
  if (g.mission_version !== want.missionVersion) return false;
  if (g.policy_version !== want.policyVersion) return false;
  if (!audienceOf(g).includes(want.audience)) return false;
  if (want.fields) {
    let allowed: string[] = [];
    try {
      allowed = JSON.parse(g.fields);
    } catch {
      return false;
    }
    if (!want.fields.every((f) => allowed.includes(f))) return false;
  }
  return true;
}

// Personal identifiers that must never leave inside a summary (I05, E.2).
const IDENTIFIER_PATTERNS: [string, RegExp][] = [
  ["email", /[\w.+-]+@[\w-]+\.[\w.-]+/],
  ["handle", /(^|[^\w])@[a-z0-9_]{4,}/i],
  ["link", /(https?:\/\/|t\.me\/|tg:\/\/)/i],
  ["phone", /\+?\d[\d\s().-]{7,}\d/],
];

/** Names of identifier kinds found in `text` (empty = safe to propose for an envelope). */
export function findIdentifiers(text: string): string[] {
  return IDENTIFIER_PATTERNS.filter(([, re]) => re.test(text)).map(([k]) => k);
}
