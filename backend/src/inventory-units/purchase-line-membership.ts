/** Old invoice editors could replace line IDs. Recover only a unique SKU within
 * the exact original invoice; never borrow identities from another receipt. */
export function resolvePurchaseLine(items: any[], originLineId: string | undefined, sku: string) {
  const exact = originLineId && items.find(line => line.lineId === originLineId);
  if (exact) return String(exact.code || '').trim() === sku ? exact : null;
  const matches = items.filter(line => String(line.code || '').trim() === sku);
  return matches.length === 1 ? matches[0] : null;
}

export function purchaseLineOrigins(items: any[], line: any) {
  const clauses: any[] = [];
  if (line.lineId) clauses.push({ 'origin.purchaseLineId': line.lineId });
  if (items.filter(row => String(row.code || '').trim() === String(line.code || '').trim()).length === 1) {
    clauses.push({ 'origin.purchaseLineId': { $nin: items.map(row => row.lineId).filter(Boolean) } });
  }
  return clauses.length ? { $or: clauses } : { _id: { $in: [] } };
}
