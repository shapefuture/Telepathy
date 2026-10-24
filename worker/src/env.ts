export interface Env {
  DB: D1Database;
  // Secrets (wrangler secret put ...)
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  ADMIN_TOKEN: string;
  OWNER_IDS: string; // comma-separated Telegram user ids
  // Vars
  COMMUNITY_LABEL?: string;
  TIMEZONE?: string;
  DIGEST_HOUR?: string;
  ASK_RATE_PER_MINUTE?: string;
  BOT_USERNAME?: string;
  /** "true" = queue PDF/DOCX/PPTX for the GitHub Actions parser (sends files via GitHub runners). */
  OFFLOAD_DOCUMENTS?: string;
  /** Public https origin of this Worker, e.g. https://telepathy.you.workers.dev (Mini App links). */
  PUBLIC_URL?: string;
  /** "true" enables the partner gateway (/v1/*, /.well-known/nexus-node.json). Off by default. */
  FEDERATION_ENABLED?: string;
  /** This node's id as partners know it; defaults to PUBLIC_URL. */
  FEDERATION_NODE_ID?: string;
  /** Ed25519 public key (base64, raw), published in the node manifest. */
  FEDERATION_PUBLIC_KEY?: string;
  /** Secret: Ed25519 private key (base64 pkcs8). `npm run fed:keys` makes a pair. */
  FEDERATION_PRIVATE_KEY?: string;
}

export function ownerIds(env: Env): Set<number> {
  return new Set(
    (env.OWNER_IDS ?? "")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0),
  );
}

export function timezone(env: Env): string {
  return env.TIMEZONE || "Asia/Jerusalem";
}

export function digestHour(env: Env): number {
  const h = Number(env.DIGEST_HOUR ?? "9");
  return Number.isInteger(h) && h >= 0 && h <= 23 ? h : 9;
}
