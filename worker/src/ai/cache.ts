// Results keyed by the exact input they came from. An edited message changes the key, so an
// old answer is never reused for new text; stale rows are dropped by age.

export const CACHE_DAYS = 30;

export async function contentKey(...parts: string[]): Promise<string> {
  const data = new TextEncoder().encode(parts.join("\u0000"));
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function cached(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT result FROM ai_cache WHERE key = ?").bind(key).first<{ result: string }>();
  return row?.result ?? null;
}

export async function remember(db: D1Database, key: string, kind: string, result: string, now = new Date()): Promise<void> {
  await db
    .prepare("INSERT INTO ai_cache(key, kind, result, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO NOTHING")
    .bind(key, kind, result, now.toISOString())
    .run();
}

export async function pruneCache(db: D1Database, now = new Date()): Promise<number> {
  const cut = new Date(now.getTime() - CACHE_DAYS * 86_400_000).toISOString();
  const r = await db.prepare("DELETE FROM ai_cache WHERE created_at < ?").bind(cut).run();
  return r.meta.changes ?? 0;
}
