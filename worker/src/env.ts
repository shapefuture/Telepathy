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
