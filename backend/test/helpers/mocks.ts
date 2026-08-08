/**
 * Common Jest mock helpers for service-level unit testing.
 */

export const createMockMongooseModel = <T = unknown>() => {
  const mock: any = {
    create: jest.fn(),
    find: jest.fn().mockReturnThis(),
    findOne: jest.fn().mockReturnThis(),
    findById: jest.fn().mockReturnThis(),
    findByIdAndUpdate: jest.fn().mockReturnThis(),
    findByIdAndDelete: jest.fn().mockReturnThis(),
    findOneAndUpdate: jest.fn().mockReturnThis(),
    updateOne: jest.fn().mockReturnThis(),
    deleteOne: jest.fn().mockReturnThis(),
    deleteMany: jest.fn().mockReturnThis(),
    countDocuments: jest.fn().mockReturnThis(),
    aggregate: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    populate: jest.fn().mockReturnThis(),
    lean: jest.fn().mockReturnThis(),
    // Defaults to [] rather than undefined: service methods that internally list documents
    // (e.g. getInventory() iterating tx.items) would otherwise throw on an unstubbed query,
    // failing tests for reasons unrelated to what they assert.
    exec: jest.fn().mockResolvedValue([]),
    save: jest.fn(),
  };
  return mock as jest.Mocked<any>;
};

export const createMockProductsService = () => ({
  // Defaults to [] for the same reason as the model mock's exec() — tests that don't care about
  // products shouldn't crash inside getInventory(). Tests that do care override it.
  findAll: jest.fn().mockResolvedValue([]),
  findById: jest.fn(),
  findByCode: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
});

export const createMockVaultService = () => ({
  findAll: jest.fn(),
  create: jest.fn(),
  recordTransactionDeposit: jest.fn(),
  recordCollection: jest.fn(),
  assertSufficientBalance: jest.fn(),
  getCurrentBalance: jest.fn().mockResolvedValue(10000),
  getStatistics: jest.fn(),
  cancelByRef: jest.fn(),
  addSystemEntry: jest.fn().mockResolvedValue({ _id: 'vault-entry-1' }),
});

export const createMockSettingsService = () => ({
  getSettings: jest.fn().mockResolvedValue({
    cairoPrice: 100,
    govPrice: 150,
    vaultPass: '1234',
  }),
  getSettingsSafe: jest.fn(),
  updateSettings: jest.fn(),
  verifyVaultPassword: jest.fn(),
  adjustVaultBalance: jest.fn(),
});

export const createMockPresenceGateway = () => ({
  emitEvent: jest.fn(),
});

export const createMockMentionsService = () => ({
  create: jest.fn(),
  notifyAdmins: jest.fn(),
});

export const createMockDiscountOtpService = () => ({
  assertOtpForTransaction: jest.fn(),
  assertPurchaseOtp: jest.fn(),
  assertSupplierPayOtp: jest.fn(),
  attachToTransaction: jest.fn(),
});

export const createMockShopifyAdminService = () => ({
  syncOrder: jest.fn(),
});

export const createMockSuppliersService = () => ({
  findAll: jest.fn().mockResolvedValue([]),
  findById: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  remove: jest.fn(),
  addLog: jest.fn(),
});

export const createMockSupplierLedgerService = () => ({
  getCurrentBalance: jest.fn().mockResolvedValue(0),
  getBalanceSummary: jest
    .fn()
    .mockResolvedValue({ balance: 0, debt: 0, credit: 0 }),
  findBySupplier: jest.fn().mockResolvedValue([]),
  findById: jest.fn(),
  postPurchaseDebt: jest.fn(),
  postPayment: jest.fn(),
  postReturnSettlement: jest.fn().mockResolvedValue({
    entries: [],
    debtOffsetAmount: 0,
    creditAmount: 0,
    refundAmount: 0,
    balanceAfter: 0,
  }),
  postCreditUsed: jest.fn(),
  postManualAdjustment: jest.fn(),
  reverseEntry: jest.fn(),
  reverseReturnSettlement: jest.fn().mockResolvedValue({
    reversedEntries: [],
    balanceAfter: 0,
    supplierId: '',
  }),
});

export const createMockInventoryMovementsService = () => ({
  record: jest.fn().mockResolvedValue(undefined),
  adjustStock: jest.fn().mockResolvedValue(undefined),
  findAll: jest.fn().mockResolvedValue([]),
  // Defaults to an empty Map, not undefined: both derived-stock loops call this on every run, so
  // an unstubbed mock would throw inside getInventory() and fail tests that never touch
  // adjustments. Tests that assert on adjustments override it.
  getManualAdjustmentQtyByProductCode: jest.fn().mockResolvedValue(new Map()),
});
