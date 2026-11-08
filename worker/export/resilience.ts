// Resumable, read-only Telegram request handling. Flood waits are server instructions, not export
// failures: wait the requested time and repeat the same page. Only transient failures use backoff.

import { tl } from "@mtcute/web";

export interface PageCursor {
  id: number;
  date: number;
}

export interface HistoryPage<T> {
  items: T[];
  next?: PageCursor;
  total?: number;
}

export interface ReadWait {
  kind: "flood" | "retry";
  remaining: number;
  attempt: number;
}

export interface RetryOptions {
  signal: AbortSignal;
  onWait?: (wait: ReadWait | null) => void;
  /** Injectable for deterministic tests. Defaults to an abortable browser timer. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Consecutive network/5xx attempts per page, after the initial request. */
  maxTransientRetries?: number;
}

export class TelegramReadRetryError extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super(`Telegram could not recover this read: ${errorText(cause)}`);
    this.name = "TelegramReadRetryError";
    this.cause = cause;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortError(): Error {
  const error = new Error("Export stopped");
  error.name = "AbortError";
  return error;
}

export function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", aborted);
      resolve();
    }, ms);
    function aborted() {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      reject(abortError());
    }
    signal.addEventListener("abort", aborted, { once: true });
  });
}

/** Extract Telegram's exact FLOOD_WAIT_N duration from mtcute or compatible RPC errors. */
export function floodWaitSeconds(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as { code?: unknown; seconds?: unknown; text?: unknown; message?: unknown };
  const text = String(candidate.text ?? candidate.message ?? "");
  if (candidate.code !== 420 && !/(?:FLOOD|SLOWMODE)/i.test(text)) return null;
  const match = text.match(/(?:FLOOD(?:_PREMIUM|_TEST_PHONE)?|SLOWMODE)_WAIT_(\d+)/i);
  const seconds = match ? Number(match[1]) : typeof candidate.seconds === "number" ? candidate.seconds : 60;
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 1;
}

/** Read-only history calls are safe to repeat after network failures and Telegram 5xx errors. */
export function transientReadError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; code?: unknown };
  if (candidate.name === "AbortError") return false;
  if (tl.RpcError.is(error)) return error.code >= 500;
  return typeof candidate.code !== "number" || candidate.code >= 500;
}

export async function retryTelegramRead<T>(operation: () => Promise<T>, options: RetryOptions): Promise<T> {
  const sleep = options.sleep ?? sleepWithAbort;
  const maxTransientRetries = options.maxTransientRetries ?? 4;
  let transientAttempts = 0;
  for (;;) {
    if (options.signal.aborted) throw abortError();
    try {
      const result = await operation();
      options.onWait?.(null);
      return result;
    } catch (error) {
      if (options.signal.aborted) throw abortError();
      const flood = floodWaitSeconds(error);
      if (flood === null) {
        if (!transientReadError(error)) throw error;
        transientAttempts++;
        if (transientAttempts > maxTransientRetries) throw new TelegramReadRetryError(error);
      }
      const seconds = flood ?? Math.min(8, 2 ** (transientAttempts - 1));
      const kind = flood === null ? "retry" : "flood";
      // Flood waits do not consume the transient-error budget: Telegram may issue more than one
      // during a large export. Every attempt repeats the identical request after the full delay.
      for (let remaining = seconds; remaining > 0; remaining--) {
        options.onWait?.({ kind, remaining, attempt: transientAttempts + 1 });
        await sleep(Math.min(1000, remaining * 1000), options.signal);
      }
      options.onWait?.(null);
    }
  }
}

/**
 * Sequentially consume newest-first history. A failed page never advances the cursor, so retrying
 * cannot skip messages. The consumer can return false for filters, limits, or stop-and-save.
 */
export async function readHistoryPages<T>(
  fetchPage: (offset?: PageCursor) => Promise<HistoryPage<T>>,
  consume: (items: T[]) => boolean | void,
  options: RetryOptions,
): Promise<number | undefined> {
  let offset: PageCursor | undefined;
  let total: number | undefined;
  while (!options.signal.aborted) {
    const page = await retryTelegramRead(() => fetchPage(offset), options);
    if (total === undefined) total = page.total;
    if (consume(page.items) === false || !page.next || page.items.length === 0) return total;
    offset = page.next;
  }
  return total;
}
