// Telegram edge cases and privacy floors found in review: each test reproduces one bug.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handleUpdate } from "../src/bot";
import { redact } from "../src/ai/redact";
import { makeApp } from "../src/index";
import { GROUP, OWNER, enableGroup, feed, groupCmd, groupMsg, nextMsg, nextUpdate, testApp } from "./helpers";

/** Telegram's HTML parse mode: every '<' opens a supported tag, every '&' starts an entity. */
const TG_TAGS = new Set(["b", "strong", "i", "em", "u", "ins", "s", "strike", "del", "a", "code", "pre", "blockquote", "tg-spoiler", "span", "tg-emoji"]);
function telegramHtmlErrors(s: string): string[] {
  const errs: string[] = [];
  for (const m of s.matchAll(/<\/?([^\s>/]*)/g)) if (!TG_TAGS.has(m[1]!.toLowerCase())) errs.push(`unsupported tag <${m[1]}`);
  for (const m of s.matchAll(/&(?!(?:lt|gt|amp|quot|#\d+);)/g)) errs.push(`bare & at ${m.index}`);
  return errs;
}

const access = async (tgId: number) =>
  env.DB.prepare("SELECT a.revoked_at FROM source_access a JOIN members m ON m.id=a.member_id JOIN sources s ON s.id=a.source_id WHERE m.tg_id=? AND s.chat_id=?")
    .bind(tgId, GROUP)
    .first<{ revoked_at: string | null }>();

const memberUpdate = (id: number, from: Record<string, unknown>, to: Record<string, unknown>) => ({
  update_id: nextUpdate(),
  chat_member: {
    chat: { id: GROUP, type: "supergroup", title: "G" },
    from: { id, is_bot: false },
    old_chat_member: { user: { id, is_bot: false }, ...from },
    new_chat_member: { user: { id, is_bot: false, first_name: "A" }, ...to },
  },
});

describe("leaving a group revokes access (C06)", () => {
  it("also when the person was restricted: Telegram reports status 'restricted' with is_member false", async () => {
    const { app } = testApp();
    await enableGroup(app);
    await feed(app, groupMsg(41, "hello everyone"));
    expect((await access(41))?.revoked_at).toBeNull();
    await handleUpdate(app, memberUpdate(41, { status: "restricted", is_member: true }, { status: "restricted", is_member: false }) as any);
    expect((await access(41))?.revoked_at).not.toBeNull();
  });
});
