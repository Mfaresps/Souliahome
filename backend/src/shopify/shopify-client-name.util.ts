function nameOf(contact: any): string | undefined {
  const parts = [contact?.first_name, contact?.last_name]
    .filter((value): value is string => typeof value === 'string')
    .map(value => value.trim()).filter(Boolean);
  return parts.join(' ') || (typeof contact?.name === 'string' ? contact.name.trim() || undefined : undefined);
}

function namesOf(data: any): Array<string | undefined> {
  return [data?.customer, data?.shipping_address, data?.billing_address].map(nameOf);
}

/** Prefer customer names on import; on updates use the changed contact copy.
 * Missing or redacted names must not erase the saved name, and unrelated updates
 * must not revert a shipping-specific or locally edited name. */
export function resolveShopifyClientName(data: any, previous?: any, current = ''): string | undefined {
  const incoming = namesOf(data);
  const first = incoming.find(Boolean);
  if (!first) return undefined;
  if (!previous) return first;
  const before = namesOf(previous);
  const changed = incoming.find((name, index) => name !== undefined && name !== before[index]);
  if (changed) return changed;
  if (current.trim() && before.includes(current.trim())) return undefined;
  // Preserve local edits when the source is unchanged; fill missing/default names.
  if (current.trim() && current !== 'عميل Shopify' && before.some(Boolean)) return undefined;
  return first;
}
