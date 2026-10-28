// Links to a stored message, for citations and cards. No imports: anything that shows a link can use
// this without pulling in ingestion (which depends on the concierge, which depends on cards).

/**
 * Bot API ids of supergroups and channels are -100 followed by their channel id, so they are at most
 * -10^12. A basic group's id is smaller in magnitude, even when it happens to start with "-100".
 */
export const SUPERGROUP_MAX = -1_000_000_000_000;
export const isSupergroupId = (chatId: number): boolean => chatId <= SUPERGROUP_MAX;

export function citation(chatId: number, msgId: number, username: string | null, topicId?: number | null): string | null {
  if (username) return `https://t.me/${username}/${msgId}`;
  if (!isSupergroupId(chatId)) return null; // basic groups have no message links
  const s = String(chatId).slice(4); // without the -100 prefix
  return topicId ? `https://t.me/c/${s}/${topicId}/${msgId}` : `https://t.me/c/${s}/${msgId}`;
}
