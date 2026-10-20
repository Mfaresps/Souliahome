/** A damaged-label exception is not a scanned or allocated inventory identity. */
export function pickingExceptions(sale: any, line: any): any[] {
  return (sale.pickingExceptions || []).filter((entry: any) => entry.active === true && entry.kind === 'damaged-label' &&
    entry.lineId === line.lineId && entry.sku === String(line.code || '').trim() && entry.quantity === 1);
}
