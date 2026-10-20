export const INVENTORY_UNIT_STATUSES = [
  'available', 'reserved', 'picking', 'prepared', 'shipped', 'delivered',
  'returned', 'inspection-required', 'damaged', 'supplier-return-pending', 'returned-to-supplier', 'lost', 'retired',
] as const;
export type InventoryUnitStatus = typeof INVENTORY_UNIT_STATUSES[number];

export const INVENTORY_UNIT_ACTIONS = [
  'registered', 'reserved', 'picking-started', 'prepared', 'shipped', 'delivered',
  'returned', 'inspection-required', 'inspection-passed', 'damaged', 'released',
  'supplier-returned', 'supplier-return-reserved', 'supplier-return-released', 'lost', 'retired', 'warehouse-changed', 'label-printed', 'label-reprinted',
  'label-print-requested', 'label-reprint-requested',
  'scan-validated', 'manual-selection-confirmed', 'picking-undone',
] as const;

export const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;

/** MongoDB _id is the immutable internal identity; the SKU never enters this payload. */
export function inventoryUnitBarcode(id: { toString(): string }): string {
  const value = id.toString();
  if (!OBJECT_ID_PATTERN.test(value)) throw new Error('Invalid inventory unit identifier');
  return `SU-${value.toUpperCase()}`;
}
/** Server-supported physical label stock; shared by DTO validation and the configuration API. */
export const LABEL_SIZES = [
  { id: '50x25', widthMm: 50, heightMm: 25, qrMm: 17, marginMm: 1.5 },
  { id: '50x30', widthMm: 50, heightMm: 30, qrMm: 18, marginMm: 1.5 },
  { id: '60x40', widthMm: 60, heightMm: 40, qrMm: 23, marginMm: 2 },
  { id: '70x40', widthMm: 70, heightMm: 40, qrMm: 23, marginMm: 2 },
  { id: '80x40', widthMm: 80, heightMm: 40, qrMm: 23, marginMm: 2 },
  { id: '80x50', widthMm: 80, heightMm: 50, qrMm: 28, marginMm: 2 },
  { id: '100x50', widthMm: 100, heightMm: 50, qrMm: 28, marginMm: 2 },
  { id: '100x70', widthMm: 100, heightMm: 70, qrMm: 40, marginMm: 3 },
] as const;

