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
