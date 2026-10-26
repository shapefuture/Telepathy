import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach } from "vitest";
import { resetRateLimits } from "../src/bot";
import { setDefaultLang } from "../src/i18n";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

const TABLES = ["history_pages", "history_jobs", "ai_cache", "welcomed", "pending_deletes", "seal_shares", "sealed_held", "gossip_notices", "escrow_runs", "announce_outbox", "public_notices", "canaries", "club_regrowth", "regrowth_invites", "head_incidents", "domain_health", "failure_domains", "buddies", "recovery_approvals", "recovery_requests", "guardians", "login_challenges", "login_factors", "drill_cohort", "relay_notices", "recovery_drills", "alert_deliveries", "continuity_alerts", "membership_attestations", "suppressions", "follow_state", "subscription_ops", "delivery_registrations", "sessions", "recovery_codes", "login_codes", "identity_links", "people", "destination_manifests", "community_identity", "ledger_entries", "ledger_txns", "gap_signals", "fed_nonces", "fed_outbox", "outcome_receipts", "service_commitments", "exchange_offers", "federation_exchanges", "consent_grants", "capability_offers", "mission_events", "missions", "events", "skill_dismissed", "answer_votes", "passage_votes", "answers", "doc_queue", "passages", "settings", "members", "sources", "source_access", "skills", "needs", "intros", "effects", "audit"];

// Storage persists across tests within a file, so start every test from an empty database.
beforeEach(async () => {
  await env.DB.batch([...TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t}`)), env.DB.prepare("DELETE FROM organizations WHERE kind='partner'")]);
  resetRateLimits();
  setDefaultLang((env as { DEFAULT_LANG?: string }).DEFAULT_LANG); // tests start in English
});
