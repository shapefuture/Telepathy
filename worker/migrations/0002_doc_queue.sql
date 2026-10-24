-- Documents too heavy to parse inside a Worker (PDF/DOCX/PPTX, up to Telegram's 20 MB bot
-- download limit). Parsed by the GitHub Actions offload job, only when OFFLOAD_DOCUMENTS=true.
CREATE TABLE doc_queue(
  source_id TEXT NOT NULL,
  msg_id INTEGER NOT NULL,
  file_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_size INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done','failed','skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(source_id, msg_id)
) WITHOUT ROWID;
CREATE INDEX idx_doc_queue_status ON doc_queue(status, created_at);
