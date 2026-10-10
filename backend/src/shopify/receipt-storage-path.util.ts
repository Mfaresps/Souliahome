/** Preserve Arabic names while preventing names from introducing storage directories. */
function pathLabel(value: unknown, fallback: string, maxLength: number): string {
  const label = String(value || '').normalize('NFKC')
    .replace(/[^\p{L}\p{N}\p{M}_-]+/gu, '-')
    .replace(/-+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, maxLength).replace(/-+$/g, '');
  return label || fallback;
}

/** A readable order/customer folder and filename; receipt IDs keep multiple payments distinct. */
export function receiptImageKey(order: { ref?: unknown; client?: unknown; _id: unknown }, month: string, receiptId: string): string {
  const ref = pathLabel(order.ref, pathLabel(order._id, 'unknown-order', 60), 60);
  const customer = pathLabel(order.client, 'unknown-customer', 80);
  const label = `order-${ref}_${customer}`;
  return `deposit-receipts/${month}/${label}/${label}_${receiptId}.jpg`;
}
