/**
 * Numbers the interface writes the way its language does: Turkish puts the percent sign first
 * and the decimal mark is a comma (`%140`, `1,5 KB`, `1,8°`), English keeps `140%`, `1.5 KB` and `1.8°`.
 */

const FORMATS = new Map<string, Intl.NumberFormat>();

function numberFormat(locale: string, style: 'oneDecimal' | 'percent', digits = 0): Intl.NumberFormat {
  const key = `${locale}:${style}:${digits}`;
  let format = FORMATS.get(key);
  if (format === undefined) {
    format =
      style === 'percent'
        ? new Intl.NumberFormat(locale, {
            style: 'percent',
            minimumFractionDigits: digits,
            maximumFractionDigits: digits,
          })
        : new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    FORMATS.set(key, format);
  }
  return format;
}

/**
 * A byte size for people: `900 B`, `1.5 KB`, `5.3 MB`, with the locale's decimal mark. A size
 * that is not a finite, non-negative number is unknown and written as a dash.
 */
export function formatBytes(bytes: number, locale: string): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const oneDecimal = numberFormat(locale, 'oneDecimal');
  // Rounded before the unit is chosen, so 1,048,575 B is `1.0 MB` and not `1,024.0 KB`.
  const kilobytes = Math.round((bytes / 1024) * 10) / 10;
  if (kilobytes < 1024) return `${oneDecimal.format(kilobytes)} KB`;
  return `${oneDecimal.format(bytes / (1024 * 1024))} MB`;
}

/**
 * A fraction as a percent in the locale's own form: `1.4` is `140%` in English, `%140` in Turkish.
 * Whole percents unless `digits` asks for decimals (`0.0037` with 2 is `0.37%` and `%0,37`).
 */
export function formatPercent(fraction: number, locale: string, digits = 0): string {
  return numberFormat(locale, 'percent', digits).format(fraction);
}

/** An angle in degrees to one decimal, with the locale's decimal mark: `1,8°` in Turkish, `1.8°` in English. */
export function formatDegrees(degrees: number, locale: string): string {
  return `${numberFormat(locale, 'oneDecimal').format(degrees)}°`;
}
