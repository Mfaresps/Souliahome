/** Shopify retains removed lines in order payloads; quantity is historical.
 * current_quantity represents what remains. Fulfillable quantity is unrelated:
 * a fully shipped product must still remain in the order. */
export function shopifyLineQuantity(item: any): number {
  const quantity = Number(item?.current_quantity ?? item?.quantity ?? 1);
  return Number.isFinite(quantity) && quantity > 0 ? quantity : 0;
}
