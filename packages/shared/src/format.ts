/**
 * Numbers the interface writes the way its language does: Turkish puts the percent sign first
 * and the decimal mark is a comma (`%140`, `1,5 KB`), English keeps `140%` and `1.5 KB`.
 */

const FORMATS = new Map<string, Intl.NumberFormat>();

function numberFormat(locale: string, style: 'oneDecimal' | 'percent'): Intl.NumberFormat {
  const key = `${locale}:${style}`;
  let format = FORMATS.get(key);
  if (format === undefined) {
    format =
      style === 'percent'
        ? new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 })
        : new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    FORMATS.set(key, format);
  }
  return format;
}

/** A byte size for people: `900 B`, `1.5 KB`, `5.3 MB`, with the locale's decimal mark. */
export function formatBytes(bytes: number, locale: string): string {
  if (bytes < 1024) return `${bytes} B`;
  const oneDecimal = numberFormat(locale, 'oneDecimal');
  if (bytes < 1024 * 1024) return `${oneDecimal.format(bytes / 1024)} KB`;
  return `${oneDecimal.format(bytes / (1024 * 1024))} MB`;
}

/** A fraction as a whole percent in the locale's own form: `1.4` is `140%` in English, `%140` in Turkish. */
export function formatPercent(fraction: number, locale: string): string {
  return numberFormat(locale, 'percent').format(fraction);
}
