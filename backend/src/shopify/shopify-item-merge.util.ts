export function itemKey(item: any): string {
  if (item.productId) return 'product:' + String(item.productId);
  if (item.code && item.code !== 'SHOPIFY') return 'code:' + String(item.code);
  return 'name:' + String(item.shopifyName || item.name || '');
}

function groups(items: any[]): Map<string, any[]> {
  const result = new Map<string, any[]>();
  for (const item of items) {
    const key = itemKey(item);
    result.set(key, [...(result.get(key) || []), item]);
  }
  return result;
}
function signature(items: any[] = []): string {
  return JSON.stringify(items.map(i => [Number(i.qty), Number(i.price)]).sort((a, b) => a[0] - b[0] || a[1] - b[1]));
}
export function differingItemKeys(left: any[], right: any[]): string[] {
  const a = groups(left), b = groups(right);
  return [...new Set([...a.keys(), ...b.keys()])].filter(key => signature(a.get(key)) !== signature(b.get(key)));
}

/** Compare remote and local edits against the last remote baseline. Independent
 * product edits merge automatically; conflicting edits preserve the local rows. */
export function mergeShopifyItems(base: any[], local: any[], remote: any[]): { items: any[]; conflictingKeys: string[] } {
  const before = groups(base), ours = groups(local), theirs = groups(remote);
  const items: any[] = [], conflictingKeys: string[] = [];
  for (const key of new Set([...ours.keys(), ...theirs.keys(), ...before.keys()])) {
    const old = before.get(key), current = ours.get(key), incoming = theirs.get(key);
    const localChanged = signature(current) !== signature(old);
    const remoteChanged = signature(incoming) !== signature(old);
    if (localChanged && remoteChanged && signature(current) !== signature(incoming)) conflictingKeys.push(key);
    items.push(...((localChanged ? current : incoming) || []));
  }
  return { items, conflictingKeys };
}

export function applyShopifyConflictItems(local: any[], remote: any[], keys: string[]): any[] {
  const ours = groups(local), theirs = groups(remote), selected = new Set(keys);
  return [...new Set([...ours.keys(), ...theirs.keys()])]
    .flatMap(key => (selected.has(key) ? theirs.get(key) : ours.get(key)) || []);
}
