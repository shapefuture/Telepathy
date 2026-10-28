// The concierge's permission envelope (ADR-007). Code, not the prompt, decides what the agent may
// do: each action has a ceiling, the owner configures a level up to it, and "auto" is only granted
// once enough of the agent's past decisions of that kind were reviewed and judged right.

export type Action =
  | "clarify"
  | "answer"
  | "ask_people"
  | "follow_up"
  | "introduce"
  | "ask_partners"
  | "paid_provider"
  | "escalate"
  | "best_answer"
  | "admit"
  | "moderate";
export type Level = "off" | "suggest" | "auto";

export const ACTIONS: Action[] = [
  "clarify",
  "answer",
  "ask_people",
  "follow_up",
  "introduce",
  "ask_partners",
  "paid_provider",
  "escalate",
  "best_answer",
  "admit",
  "moderate",
];
const RANK: Record<Level, number> = { off: 0, suggest: 1, auto: 2 };
const lower = (a: Level, b: Level): Level => (RANK[a] <= RANK[b] ? a : b);

/**
 * The most each action can ever have. "suggest" = a person approves before it happens: the owner
 * for most steps, both people for an introduction, the member for partners and anything paid.
 * Disclosure, leaving the club and money are never autonomous, whatever the configuration says.
 */
export const CEILING: Record<Action, Level> = {
  clarify: "auto",
  answer: "auto", // only with verified quotes
  ask_people: "auto", // only to people who agreed in advance, within their weekly cap
  follow_up: "auto",
  escalate: "auto", // telling the club's team is the safe fallback
  introduce: "suggest",
  ask_partners: "suggest",
  paid_provider: "suggest",
  best_answer: "suggest", // the club's canonical answer is the owner's call
  admit: "auto", // letting someone in: only for clear-cut screenings, and only once earned
  moderate: "auto", // deleting a message and restricting its author: only once earned
};

/** Evidence needed before an action may run on its own. */
export const AUTO_MIN_REVIEWED = 50;
export const AUTO_MIN_GOOD = 0.9;

export interface ReviewStats {
  reviewed: number;
  good: number;
}

export const earned = (s: ReviewStats | undefined): boolean => !!s && s.reviewed >= AUTO_MIN_REVIEWED && s.good / s.reviewed >= AUTO_MIN_GOOD;

/** `CONCIERGE_AUTONOMY`, e.g. "clarify:auto,answer:suggest". Unknown or missing entries are off. */
export function parseAutonomy(raw: string | undefined): Record<Action, Level> {
  const out = Object.fromEntries(ACTIONS.map((a) => [a, "off"])) as Record<Action, Level>;
  for (const part of (raw ?? "").split(",")) {
    const [a, l] = part.split(":").map((x) => x.trim().toLowerCase());
    if (ACTIONS.includes(a as Action) && (l === "off" || l === "suggest" || l === "auto")) out[a as Action] = l;
  }
  return out;
}

/** What the agent may actually do: the configured level, capped by the ceiling and by evidence. */
export function effectiveLevel(action: Action, configured: Record<Action, Level>, stats?: ReviewStats): Level {
  const capped = lower(configured[action], CEILING[action]);
  return capped === "auto" && !earned(stats) ? "suggest" : capped;
}
