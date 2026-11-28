/** Formats an amount in minor units (cents) using the currency's own number of minor digits. */
export function formatPrice(priceMinor: number, currency: string): string {
  const format = new Intl.NumberFormat("en", { style: "currency", currency });
  const minorDigits = format.resolvedOptions().maximumFractionDigits ?? 2;
  return format.format(priceMinor / 10 ** minorDigits);
}

const dateTimeFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

export function formatDateTime(date: Date): string {
  return dateTimeFormat.format(date);
}

/**
 * A duration for the admin dashboard: tenths of a second below a minute, then minutes and seconds,
 * then hours and minutes.
 */
export function formatDuration(ms: number): string {
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)} s`;
  }
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) {
    return `${minutes} min ${totalSeconds % 60} s`;
  }
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
