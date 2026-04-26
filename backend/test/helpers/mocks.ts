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
    exec: jest.fn(),
    save: jest.fn(),
  };
  return mock as jest.Mocked<any>;
};

export const createMockProductsService = () => ({
  findAll: jest.fn(),
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
