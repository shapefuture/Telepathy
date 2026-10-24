// Pure converter: Telegram Desktop export (result.json) -> D1 SQL statements.
// Every statement is idempotent (INSERT OR IGNORE) and only writes when the target chat is an
// ENABLED source, so importing an unapproved chat stores nothing (C01). Members who used
// /forget_me (collection_opt_out) are skipped (C13). Live data is never overwritten.

/** Desktop exports store supergroup ids without the -100 prefix. */
export function botApiChatId(exp) {
  const raw = Number(exp.id);
  if (raw < 0) return raw;
  return ["private_supergroup", "public_supergroup", "private_channel", "public_channel"].includes(exp.type)
    ? Number(`-100${raw}`)
    : -raw;
}

/** Export `text` is a string or a mixed array of strings and entity objects. */
export function plainText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((v) => (typeof v === "string" ? v : String(v?.text ?? ""))).join("");
  return "";
}

/** SQL string literal; newlines become char(10) so every statement stays on one line. */
export function lit(s) {
  const clean = String(s).replaceAll("\u0000", "").replaceAll("\r", "");
  return clean
    .split("\n")
    .map((part) => `'${part.replaceAll("'", "''")}'`)
    .join(" || char(10) || ");
}

const iso = (unix) => new Date(unix * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

/** Yields one SQL statement per line, in order. */
export function* toSql(exp, chatId, now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z")) {
  const src = `(SELECT id FROM sources WHERE chat_id=${Number(chatId)} AND enabled=1)`;
  for (const m of exp.messages ?? []) {
    if (m.type !== "message") continue; // service messages carry no knowledge
    const text = plainText(m.text);
    if (!text.trim()) continue; // media without caption: files aren't in the JSON
    const id = Number(m.id);
    const unix = Number(m.date_unixtime ?? Date.parse(`${m.date}Z`) / 1000);
    const edit = m.edited_unixtime ? Number(m.edited_unixtime) : 0;
    const reply = m.reply_to_message_id ? Number(m.reply_to_message_id) : "NULL";
    const uid = typeof m.from_id === "string" && /^user\d+$/.test(m.from_id) ? Number(m.from_id.slice(4)) : null;
    if (uid) {
      yield `INSERT OR IGNORE INTO members(id, tg_id, created_at) SELECT lower(hex(randomblob(16))), ${uid}, '${now}' WHERE EXISTS ${src};`;
      yield `INSERT OR IGNORE INTO source_access(source_id, member_id, granted_at) SELECT ${src}, m.id, '${now}' FROM members m WHERE m.tg_id=${uid} AND m.collection_opt_out=0 AND EXISTS ${src};`;
      yield (
        `INSERT OR IGNORE INTO passages(source_id, msg_id, part, author_id, body, event_at, edit_version, reply_to) ` +
        `SELECT ${src}, ${id}, 0, m.id, ${lit(text)}, '${iso(unix)}', ${edit}, ${reply} FROM members m ` +
        `WHERE m.tg_id=${uid} AND m.collection_opt_out=0 AND EXISTS ${src};`
      );
    } else {
      yield (
        `INSERT OR IGNORE INTO passages(source_id, msg_id, part, author_id, body, event_at, edit_version, reply_to) ` +
        `SELECT ${src}, ${id}, 0, NULL, ${lit(text)}, '${iso(unix)}', ${edit}, ${reply} WHERE EXISTS ${src};`
      );
    }
  }
}

/** Number of text messages that will be imported (for planning the daily write quota). */
export function countMessages(exp) {
  return (exp.messages ?? []).filter((m) => m.type === "message" && plainText(m.text).trim()).length;
}
