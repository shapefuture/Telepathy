export interface Env {
  DB: D1Database;
  // Secrets (wrangler secret put ...)
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  ADMIN_TOKEN: string;
  OWNER_IDS: string; // comma-separated Telegram user ids
  // Vars
  COMMUNITY_LABEL?: string;
  /** Product name shown in the Mini App header (default "Миндальная связь", as on the landing). */
  BRAND_NAME?: string;
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
  /** JSON rotation proof from `npm run fed:rotate`, published in the manifest after a key change. */
  FEDERATION_ROTATION?: string;
  // ---- Continuity (CONT-1..10) ----
  /** Secret: 32+ random bytes, base64. Keys address encryption, code/session hashes, pseudonyms. */
  CONTINUITY_KEY?: string;
  /** Secret: Ed25519 online key (pkcs8 base64) delegated by the club root to sign address lists. */
  IDENTITY_ONLINE_KEY?: string;
  /** Its public half (raw base64). */
  IDENTITY_ONLINE_PUBLIC_KEY?: string;
  /** "resend" | "log" | "" (off). */
  EMAIL_PROVIDER?: string;
  /** Secret for the email provider. */
  EMAIL_API_KEY?: string;
  EMAIL_FROM?: string;
  EMAIL_API_URL?: string;
  // ---- Hydra (P16, docs/HYDRA.md): more independent heads. Each is off until configured. ----
  /** Second email provider, a different company ("resend" | "postmark"); automatic failover. */
  EMAIL_B_PROVIDER?: string;
  EMAIL_B_API_KEY?: string;
  EMAIL_B_FROM?: string;
  EMAIL_B_API_URL?: string;
  /** Secret: token in the provider's bounce webhook URL (/hydra/bounce?t=...). */
  EMAIL_WEBHOOK_SECRET?: string;
  /** Web Push (VAPID): public key var (base64url), private key secret, contact subject. */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  /** ntfy servers members may use, comma-separated https origins (e.g. https://ntfy.sh). Unset = off. */
  NTFY_SERVERS?: string;
  /** Matrix bot: homeserver URL (var) and access token (secret). */
  MATRIX_HOMESERVER?: string;
  MATRIX_ACCESS_TOKEN?: string;
  /** Optional paid SMS for critical notices: "twilio" + account SID, auth token (secret), sender. */
  SMS_PROVIDER?: string;
  SMS_ACCOUNT_SID?: string;
  SMS_AUTH_TOKEN?: string;
  SMS_FROM?: string;
  /** Public announcements only (never a follow graph): Mastodon and Bluesky accounts. */
  MASTODON_URL?: string;
  MASTODON_TOKEN?: string;
  BLUESKY_HANDLE?: string;
  BLUESKY_APP_PASSWORD?: string;
  BLUESKY_PDS?: string;
  /** "true": ask the Internet Archive to save the public identity document after each change. */
  ARCHIVE_ANCHOR?: string;
  /** Escrow: comma-separated X25519 public keys (base64) that can decrypt nightly backups. */
  ESCROW_RECIPIENTS?: string;
  /** Escrow targets, JSON: [{"name","url","region","keyIdSecret","secretSecret"}] (S3-compatible). */
  ESCROW_TARGETS?: string;
  /** Optional R2 bucket binding for one escrow copy (a second storage kind next to D1). */
  ESCROW_R2?: R2Bucket;
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
