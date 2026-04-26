/**
 * Product test fixtures for use across test suites.
 */

export const mockProducts = [
  {
    _id: '60d5f1f1f1f1f1f1f1f1f1f1',
    code: 'P001',
    name: 'منتج اختبار 1',
    sellPrice: 100,
    buyPrice: 60,
    minStock: 10,
    openingBalance: 50,
    supplier: 'مورد افتراضي',
  },
  {
    _id: '60d5f1f1f1f1f1f1f1f1f1f2',
    code: 'P002',
    name: 'منتج اختبار 2',
    sellPrice: 250,
    buyPrice: 150,
    minStock: 5,
    openingBalance: 30,
    supplier: 'مورد افتراضي',
  },
  {
    _id: '60d5f1f1f1f1f1f1f1f1f1f3',
    code: 'P003',
    name: 'منتج منخفض',
    sellPrice: 500,
    buyPrice: 300,
    minStock: 20,
    openingBalance: 5,
    supplier: 'مورد افتراضي',
  },
  {
    _id: '60d5f1f1f1f1f1f1f1f1f1f4',
    code: 'P004',
    name: 'منتج نافد',
    sellPrice: 75,
    buyPrice: 40,
    minStock: 10,
    openingBalance: 0,
    supplier: 'مورد افتراضي',
  },
];

export const buildProduct = (overrides: Partial<typeof mockProducts[0]> = {}) => ({
  ...mockProducts[0],
  ...overrides,
});
