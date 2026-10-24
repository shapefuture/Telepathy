-- Content-keyed AI results (summaries). Key = sha256(model, prompt version, redacted input).
CREATE TABLE IF NOT EXISTS ai_cache (
  key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_cache_age ON ai_cache(created_at);
