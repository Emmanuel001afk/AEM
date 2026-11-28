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

/** Display recorded events in the device's local timezone, never fabricate a timestamp. */
export function formatDownloadTime(value: unknown, timeZone?: string): string | undefined {
  if (value == null || value === '') return undefined;
  const millis = Date.parse(String(value));
  if (!Number.isFinite(millis)) return undefined;
  try {
    return new Intl.DateTimeFormat(undefined, {dateStyle: 'medium', timeStyle: 'short', ...(timeZone ? {timeZone} : {})}).format(new Date(millis));
  } catch { return undefined; }
}

/** Approximate remaining transfer time; unavailable without a meaningful speed and total. */
export function downloadTimeRemaining(bytes: number, total: number, bytesPerSecond: number): string | undefined {
  if (![bytes,total,bytesPerSecond].every(Number.isFinite) || bytes < 0 || total <= 0 || bytes >= total || bytesPerSecond <= 0) return undefined;
  const seconds = Math.ceil((total - bytes) / bytesPerSecond);
  if (seconds > 7 * 24 * 60 * 60) return undefined;
  if (seconds < 60) return `About ${seconds} sec left`;
  if (seconds < 3600) return `About ${Math.ceil(seconds / 60)} min left`;
  return `About ${Math.ceil(seconds / 3600)} hr left`;
}
