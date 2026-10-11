import { toLatinDigits } from '../shared/digits.util';

/** Store Egyptian mobile numbers in one searchable local form. Never complete masked digits. */
export function normalizeReceiptPhone(value: unknown): string {
  let phone = toLatinDigits(String(value ?? '')).replace(/[\s()\-]/g, '');
  if (/^(?:\+20|0020|20)1[0125]\d{8}$/.test(phone)) phone = '0' + phone.replace(/^(?:\+20|0020|20)/, '');
  return /^01[0125]\d{8}$/.test(phone) ? phone : '';
}
