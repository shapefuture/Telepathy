-- P14-09 ledger, P14-10 gap signals, P14-12 key rotation, P14-11 case types.

-- Double-entry ledger (plan §K.3). A transaction's entries sum to zero per unit.
-- Units: 'credit' (reciprocal exchange credits) or an ISO currency code (informational fees:
-- this node records what was agreed; it never moves money).
CREATE TABLE ledger_txns (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,                -- business key: one posting per event, replay-safe
  kind TEXT NOT NULL CHECK (kind IN ('reciprocal_credit','service_fee','member_benefit','reversal','adjustment')),
  memo TEXT NOT NULL DEFAULT '',
  reversal_of TEXT REFERENCES ledger_txns(id),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE ledger_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  txn_id TEXT NOT NULL REFERENCES ledger_txns(id),
  account TEXT NOT NULL,                   -- 'home' | 'partner:<id>' | 'pool:member_benefit'
  unit TEXT NOT NULL,
  amount INTEGER NOT NULL                  -- minor units; + = owed to this account
);
CREATE INDEX ledger_entries_account ON ledger_entries(account, unit);
CREATE UNIQUE INDEX ledger_one_reversal ON ledger_txns(reversal_of) WHERE reversal_of IS NOT NULL;

-- Offer price (informational; required for mode 'paid').
ALTER TABLE capability_offers ADD COLUMN price_minor INTEGER;
ALTER TABLE capability_offers ADD COLUMN currency TEXT;

-- Gap signals (plan Track 11): repeated unserved needs, shown only above an anonymity threshold.
CREATE TABLE gap_signals (
  job_code TEXT PRIMARY KEY,
  members INTEGER NOT NULL,                -- distinct requesters in the window (>= threshold)
  missions INTEGER NOT NULL,
  window_days INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','notified','dismissed','actioned')),
  updated_at TEXT NOT NULL
);

-- Key rotation (P14-12): the previous partner key stays valid for a grace period.
ALTER TABLE organizations ADD COLUMN prev_public_key TEXT;
ALTER TABLE organizations ADD COLUMN prev_valid_until TEXT;
ALTER TABLE organizations ADD COLUMN manifest_checked_at TEXT;

-- Track 1: operators classify cases (knowledge_answer, qualified_expert_review, warm_intro,
-- reserved_office_hour, small_panel, commercial_project).
ALTER TABLE missions ADD COLUMN case_type TEXT;
