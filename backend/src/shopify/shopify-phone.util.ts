function phoneFields(data: any): Array<string | undefined> {
  return [data?.phone, data?.customer?.phone, data?.shipping_address?.phone, data?.billing_address?.phone]
    .map(value => typeof value === 'string' && value.trim() ? value.trim() : undefined);
}

/** Order contact phone first; a changed shipping/customer field also wins over
 * unchanged copies. Missing/redacted phone fields must never erase a saved number. */
export function resolveShopifyPhone(data: any, previous?: any, current = ''): string | undefined {
  const incoming = phoneFields(data);
  const first = incoming.find(Boolean);
  if (!first) return undefined;
  if (!previous) return first;
  const before = phoneFields(previous);
  const changed = incoming.find((phone, index) => phone !== undefined && phone !== before[index]);
  if (changed) return changed;
  // Preserve a prior shipping/customer-specific change on later unrelated updates.
  // Legacy rows whose raw payload advanced while their phone did not can be repaired.
  if (current.trim() && before.includes(current.trim())) return undefined;
  return first;
}
