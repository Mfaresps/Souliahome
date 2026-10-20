/** Keep the existing readable SKU format; allocate after the highest numeric suffix. */
export function nextProductCode(prefix: string, codes: string[]): string {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escaped}-(\\d+)$`);
  let highest = 0;
  for (const code of codes) {
    const match = pattern.exec(code);
    if (!match) continue;
    const value = Number(match[1]);
    if (!Number.isSafeInteger(value)) throw new Error('SKU sequence exceeds the safe integer range');
    highest = Math.max(highest, value);
  }
  if (!Number.isSafeInteger(highest + 1)) throw new Error('SKU sequence exhausted');
  return `${prefix}-${String(highest + 1).padStart(3, '0')}`;
}

export function isDuplicateProductKey(error: unknown, field: 'code' | 'name'): boolean {
  const duplicate = error as { code?: number; keyPattern?: Record<string, unknown>; keyValue?: Record<string, unknown> };
  return duplicate?.code === 11000 && !!(duplicate.keyPattern?.[field] || duplicate.keyValue?.[field]);
}
