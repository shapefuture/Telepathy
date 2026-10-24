// Mission state machine (plan D.1). Pure: no I/O, so every transition rule is unit-testable.

export type MissionStatus =
  | "draft"
  | "confirmed"
  | "local_investigation"
  | "locally_satisfied"
  | "external_permission_needed"
  | "routed"
  | "offers_available"
  | "no_eligible_provider"
  | "provider_selected"
  | "pending_final_approvals"
  | "service_committed"
  | "in_delivery"
  | "delivered"
  | "evaluated"
  | "closed"
  | "cancelled"
  | "expired"
  | "failed_with_explanation";

export type MissionActor = "member" | "operator" | "system" | "partner";

export const MISSION_TERMINAL: ReadonlySet<MissionStatus> = new Set(["closed", "cancelled", "expired", "failed_with_explanation"]);

/** Statuses where external offers may still be pending; a consent revocation invalidates them. */
export const MISSION_EXTERNAL: ReadonlySet<MissionStatus> = new Set(["routed", "offers_available", "provider_selected", "pending_final_approvals"]);

const M = (to: MissionStatus, ...actors: MissionActor[]) => ({ to, actors });

/** from -> allowed targets with the actors who may cause them. */
export const MISSION_TRANSITIONS: Partial<Record<MissionStatus, { to: MissionStatus; actors: MissionActor[] }[]>> = {
  draft: [M("confirmed", "member")],
  confirmed: [M("local_investigation", "system")],
  local_investigation: [
    M("locally_satisfied", "member"),
    M("external_permission_needed", "member", "operator"),
    M("provider_selected", "operator"),
  ],
  locally_satisfied: [M("evaluated", "member", "system"), M("closed", "system")],
  external_permission_needed: [M("routed", "operator"), M("provider_selected", "operator"), M("no_eligible_provider", "operator", "system")],
  routed: [M("offers_available", "partner", "operator"), M("no_eligible_provider", "operator", "system")],
  offers_available: [M("provider_selected", "member"), M("no_eligible_provider", "member", "system"), M("offers_available", "partner")],
  no_eligible_provider: [M("closed", "operator", "system", "member"), M("routed", "operator"), M("provider_selected", "operator")],
  provider_selected: [M("pending_final_approvals", "system"), M("service_committed", "operator", "partner"), M("offers_available", "partner", "system")],
  pending_final_approvals: [M("service_committed", "partner", "operator"), M("offers_available", "partner", "system"), M("external_permission_needed", "partner", "system")],
  // A provider that releases its slot sends the mission back to the operator desk.
  service_committed: [M("in_delivery", "operator", "partner"), M("delivered", "operator", "partner"), M("external_permission_needed", "partner", "operator")],
  in_delivery: [M("delivered", "operator", "partner")],
  delivered: [M("evaluated", "member"), M("closed", "system", "operator")],
  evaluated: [M("closed", "system", "member", "operator")],
};

/** Any non-terminal mission can stop; who may stop it depends on how. */
const STOPS: Record<"cancelled" | "expired" | "failed_with_explanation", MissionActor[]> = {
  cancelled: ["member", "operator"],
  expired: ["system"],
  failed_with_explanation: ["operator", "system"],
};

export function nextMission(from: MissionStatus, to: MissionStatus, actor: MissionActor): boolean {
  if (MISSION_TERMINAL.has(from)) return false;
  if (to in STOPS) return STOPS[to as keyof typeof STOPS].includes(actor);
  return !!MISSION_TRANSITIONS[from]?.some((t) => t.to === to && t.actors.includes(actor));
}

export const MISSION_TTL_DAYS = 30;

/** Case types from plan Track 1. Only the first four are served by this node today. */
export type CaseType = "knowledge_answer" | "qualified_expert_review" | "warm_intro" | "reserved_office_hour" | "small_panel" | "commercial_project";
