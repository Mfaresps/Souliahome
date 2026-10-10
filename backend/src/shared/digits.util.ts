/**
 * Arabic-Indic (٠-٩) and Extended/Persian (۰-۹) digits → Latin (0-9).
 *
 * ⚠ The recurring trap in this codebase: Arabic text arrives with either digit system, and a
 * regex written for `\d` silently misses ٥٠٠. Normalise BEFORE matching, never after.
 * `٬` (Arabic thousands separator) becomes `,` and `٫` (Arabic decimal point) becomes `.`, so a
 * caller that strips thousands separators handles both scripts with one rule.
 */
const AR_INDIC_DIGITS = /[٠-٩۰-۹]/g;

export function toLatinDigits(s: string): string {
  return String(s ?? '')
    .replace(AR_INDIC_DIGITS, (d) => {
      const c = d.charCodeAt(0);
      return String(c >= 0x06f0 ? c - 0x06f0 : c - 0x0660);
    })
    .replace(/٬/g, ',')
    .replace(/٫/g, '.');
}
