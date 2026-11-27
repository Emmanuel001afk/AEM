/** Parse source timestamps for release ordering, rejecting implausible future dates. */
export function parseCatalogTimestamp(value: unknown, now = Date.now(), futureToleranceMs = 5 * 60 * 1000): number {
  const parsed = Date.parse(String(value || ""));
  if (!Number.isFinite(parsed) || parsed > now + futureToleranceMs) return 0;
  return parsed;
}

export function isFutureCatalogTimestamp(value: unknown, now = Date.now(), futureToleranceMs = 5 * 60 * 1000): boolean {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) && parsed > now + futureToleranceMs;
}
