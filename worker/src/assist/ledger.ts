// Clearing ledger (plan §K.3, Track 9). Double-entry: every transaction's entries sum to zero
// per unit. It records what partners agreed (reciprocal credits, informational fees); it never
// moves money, and nothing here is tied to capital raised or securities (plan §J.1).

import { newId, nowIso } from "../util";

export type TxnKind = "reciprocal_credit" | "service_fee" | "member_benefit" | "reversal" | "adjustment";
export interface Entry {
  account: string;
  unit: string;
  amount: number;
}
export interface Terms {
  mode?: string;
  price?: { amount_minor: number; currency: string };
}

export class LedgerError extends Error {}

export function balanced(entries: Entry[]): boolean {
  if (entries.length < 2) return false;
  const sums = new Map<string, number>();
  for (const e of entries) {
    if (!Number.isSafeInteger(e.amount) || !e.account || !/^(credit|[A-Z]{3})$/.test(e.unit)) return false;
    sums.set(e.unit, (sums.get(e.unit) ?? 0) + e.amount);
  }
  return [...sums.values()].every((v) => v === 0);
}

/** Post once per business key. Returns the txn id, or null if that key was already posted. */
export async function post(db: D1Database, key: string, kind: TxnKind, entries: Entry[], memo: string, by: string, reversalOf: string | null = null): Promise<string | null> {
  if (!balanced(entries)) throw new LedgerError("unbalanced");
  const id = newId();
  const [t] = await db.batch([
    db.prepare("INSERT OR IGNORE INTO ledger_txns(id, key, kind, memo, reversal_of, created_by, created_at) VALUES (?,?,?,?,?,?,?) RETURNING id").bind(id, key, kind, memo.slice(0, 200), reversalOf, by, nowIso()),
    // Entries only if the txn row was new (changes() = rows written by the statement above).
    db
      .prepare(
        "INSERT INTO ledger_entries(txn_id, account, unit, amount) SELECT ?, json_extract(value,'$.account'), json_extract(value,'$.unit'), json_extract(value,'$.amount') FROM json_each(?) WHERE changes()=1",
      )
      .bind(id, JSON.stringify(entries)),
  ]);
  return t!.results.length ? id : null;
}

export async function reverse(db: D1Database, txnId: string, by: string): Promise<string | null> {
  const t = await db.prepare("SELECT id, kind FROM ledger_txns WHERE id=? AND reversal_of IS NULL").bind(txnId).first<{ id: string; kind: string }>();
  if (!t) return null;
  const { results } = await db.prepare("SELECT account, unit, amount FROM ledger_entries WHERE txn_id=?").bind(txnId).all<Entry>();
  try {
    return await post(db, `rev:${txnId}`, "reversal", results.map((e) => ({ ...e, amount: -e.amount })), `reverses ${txnId}`, by, txnId);
  } catch (e) {
    if (String(e).includes("UNIQUE")) return null;
    throw e;
  }
}

/** What each partner owes us (+) or we owe them (−), per unit. */
export async function balances(db: D1Database): Promise<{ account: string; unit: string; amount: number }[]> {
  return (
    await db
      .prepare("SELECT account, unit, SUM(amount) AS amount FROM ledger_entries WHERE account<>'home' GROUP BY account, unit HAVING SUM(amount)<>0 ORDER BY account, unit")
      .all<{ account: string; unit: string; amount: number }>()
  ).results.map((r) => ({ ...r, amount: -r.amount })); // flip to "partner owes us" view
}

export async function recent(db: D1Database, n = 10) {
  return (await db.prepare("SELECT id, kind, memo, created_at FROM ledger_txns ORDER BY created_at DESC, rowid DESC LIMIT ?").bind(n).all<{ id: string; kind: string; memo: string; created_at: string }>()).results;
}

/**
 * Post a delivered cross-community service. `weProvided` = we helped the partner's member.
 * reciprocal → 1 credit; paid with a price → informational fee; volunteer/member_benefit → nothing.
 */
export async function postDelivery(db: D1Database, partnerId: string, exchangeId: string, terms: Terms, weProvided: boolean): Promise<string | null> {
  const sign = weProvided ? 1 : -1; // + = partner owes home
  const partner = `partner:${partnerId}`;
  if (terms.mode === "reciprocal") {
    return post(db, `deliv:${exchangeId}`, "reciprocal_credit", [{ account: partner, unit: "credit", amount: -sign }, { account: "home", unit: "credit", amount: sign }], `exchange ${exchangeId}`, "system");
  }
  if (terms.mode === "paid" && terms.price && Number.isSafeInteger(terms.price.amount_minor) && terms.price.amount_minor > 0 && /^[A-Z]{3}$/.test(terms.price.currency)) {
    const n = terms.price.amount_minor;
    return post(db, `deliv:${exchangeId}`, "service_fee", [{ account: partner, unit: terms.price.currency, amount: -sign * n }, { account: "home", unit: terms.price.currency, amount: sign * n }], `exchange ${exchangeId}`, "system");
  }
  return null;
}

/** "paid:49.90EUR" → { amount_minor: 4990, currency: "EUR" }. */
export function parsePrice(token: string): { amount_minor: number; currency: string } | null {
  const m = /^paid:(\d{1,7})(?:\.(\d{1,2}))?([A-Za-z]{3})$/.exec(token);
  if (!m) return null;
  const minor = Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
  return minor > 0 ? { amount_minor: minor, currency: m[3]!.toUpperCase() } : null;
}

export const formatAmount = (amount: number, unit: string) => (unit === "credit" ? `${amount} credit${Math.abs(amount) === 1 ? "" : "s"}` : `${(amount / 100).toFixed(2)} ${unit}`);
