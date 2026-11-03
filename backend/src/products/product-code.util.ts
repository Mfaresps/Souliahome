/** Take the first three characters of every word, including Arabic names. */
export function productCodePrefix(name: string): string {
  const words = String(name || '').normalize('NFKC').toUpperCase().match(/[\p{L}\p{N}]+/gu) || [];
  return words.map(word => Array.from(word).slice(0, 3).join('')).join('-');
}

export function isDuplicateProductKey(error: unknown, field: 'code' | 'name'): boolean {
  const duplicate = error as { code?: number; keyPattern?: Record<string, unknown>; keyValue?: Record<string, unknown> };
  return duplicate?.code === 11000 && !!(duplicate.keyPattern?.[field] || duplicate.keyValue?.[field]);
}
