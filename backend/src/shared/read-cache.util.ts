/**
 * A short-lived, single-flight cache for heavy READ-ONLY screens (Nov 10, 2026).
 *
 * The figures are still computed by the same function, from the same data — this only
 * stops the server from recomputing them for every tab that asks within a few seconds.
 *
 * Rules that keep it safe:
 * - Use it ONLY for what a screen displays. Never for a value a write decides on (the
 *   oversell guard, a movement's qtyBefore) — those must keep reading fresh.
 * - Business writes (webhooks included) clear every entry, at
 *   its start and again when it finishes (see main.ts), so a screen read after a save
 *   never shows the state from before it.
 *   Presence heartbeats and read-only filter POSTs leave display caches intact.
 * - Anything that changes data without a request (a cron) is covered by the TTL.
 * - Concurrent callers share one computation; a failed one is not kept.
 */
type Entry = { epoch: number; at: number; ttlMs: number; pending: boolean; promise: Promise<unknown> };

const entries = new Map<string, Entry>();
let epoch = 0;

export function invalidateReadCaches(): void {
  epoch++;
  entries.clear();
}

export function cachedRead<T>(key: string, ttlMs: number, compute: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = entries.get(key);
  if (hit && hit.epoch === epoch && (hit.pending || now - hit.at < ttlMs)) return hit.promise as Promise<T>;
  // Filter signatures can vary without bound; keep display caching within a
  // fixed entry budget on the long-running production process.
  for (const [entryKey, entry] of entries) {
    if (!entry.pending && now - entry.at >= entry.ttlMs) entries.delete(entryKey);
  }
  if (entries.size >= 128) entries.delete(entries.keys().next().value!);
  const startedEpoch = epoch;
  const promise = compute();
  const entry: Entry = { epoch: startedEpoch, at: now, ttlMs, pending: true, promise };
  entries.set(key, entry);
  promise.then(() => { entry.pending = false; entry.at = Date.now(); },
    () => { if (entries.get(key) === entry) entries.delete(key); });
  return promise;
}
