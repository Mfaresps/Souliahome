/**
 * Transaction test fixtures (sales, purchases, returns).
 */

export const mockSaleItems = [
  { code: 'P001', name: 'منتج اختبار 1', qty: 2, price: 100, total: 200 },
  { code: 'P002', name: 'منتج اختبار 2', qty: 1, price: 250, total: 250 },
];

export const mockPurchaseItems = [
  { code: 'P001', name: 'منتج اختبار 1', qty: 10, price: 60, total: 600 },
  { code: 'P002', name: 'منتج اختبار 2', qty: 5, price: 150, total: 750 },
];

export const buildSaleTransaction = (overrides: Record<string, unknown> = {}) => ({
  _id: 'tx-sale-001',
  date: '2026-04-26',
  type: 'مبيعات',
  client: 'عميل تجريبي',
  phone: '0100000000',
  ref: '1001',
  items: mockSaleItems,
  total: 450,
  itemsTotal: 450,
  deposit: 200,
  remaining: 250,
  payment: 'كاش',
  depMethod: 'كاش',
  payStatus: 'معلق',
  employee: 'موظف اختبار',
  shipCost: 0,
  discount: 0,
  cancelled: false,
  archived: false,
  notes: '',
  ...overrides,
});

export const buildPurchaseTransaction = (overrides: Record<string, unknown> = {}) => ({
  _id: 'tx-purchase-001',
  date: '2026-04-26',
  type: 'مشتريات',
  client: 'مورد تجريبي',
  ref: '5001',
  items: mockPurchaseItems,
  total: 1350,
  itemsTotal: 1350,
  deposit: 500,
  remaining: 850,
  payment: 'كاش',
  depMethod: 'كاش',
  payStatus: 'معلق',
  employee: 'موظف اختبار',
  shipCost: 0,
  discount: 0,
  cancelled: false,
  archived: false,
  notes: '',
  ...overrides,
});

export const buildReturnTransaction = (overrides: Record<string, unknown> = {}) => ({
  _id: 'tx-return-001',
  date: '2026-04-26',
  type: 'مرتجع',
  client: 'عميل تجريبي',
  ref: '1001-RET',
  items: [{ code: 'P001', name: 'منتج اختبار 1', qty: 1, price: 100, total: 100 }],
  total: 100,
  itemsTotal: 100,
  deposit: 0,
  remaining: 0,
  payment: 'كاش',
  depMethod: 'كاش',
  payStatus: 'معتمد',
  employee: 'موظف اختبار',
  shipCost: 0,
  discount: 0,
  cancelled: false,
  archived: false,
  notes: 'مرتجع معتمد (طلب كان معلقاً)',
  ...overrides,
});
