# SOULIA Test Suite

Unit and integration tests for the SOULIA inventory management system.

## Structure

```
test/
├── fixtures/          Mock data (products, transactions)
├── helpers/           Mock factories for Mongoose models & services
├── unit/              Pure logic tests (no Nest module)
│   ├── sales.spec.ts            Sales creation, totals, stock decrement
│   ├── purchases.spec.ts        Purchases, deposit logic, supplier
│   ├── returns.spec.ts          Returns, stock adjustments, refunds
│   ├── vault-stock-sync.spec.ts Cash ↔ Stock synchronization
│   ├── invoice-log.spec.ts      Filtering, retrieval, CSV export
│   ├── reports.spec.ts          Sales/purchases/cash reports, profit
│   └── general.spec.ts          Errors, edge cases, consistency
├── integration/       NestJS-module-level tests with mocked deps
│   └── transactions.service.spec.ts
└── README.md
```

## Running

```bash
# Install dev deps (one time)
npm i -D jest ts-jest @types/jest @nestjs/testing

# Run all tests
npm test

# Watch mode
npm run test:watch

# Coverage
npm run test:cov
```

## Coverage

| Module                 | Tests | Focus |
|------------------------|-------|-------|
| Sales                  | 26    | Creation, totals, discounts, stock, payment, invoice |
| Purchases              | 22    | Deposit-as-debt rule, supplier, vault check |
| Returns                | 22    | Stock adjustment, refund (product-only), credit notes |
| Vault & Stock Sync     | 28    | Segments, deposits, withdrawals, edge cases |
| Invoice Log            | 21    | Filtering, detail integrity, CSV export, HTML stripping |
| Reports                | 22    | Sales/purchase/cash summaries, profit, formatting |
| General                | 26    | Error handling, consistency, edge cases |
| Integration (NestJS)   |  9    | Service-level with mocked deps |
| **Total**              | **176** | All passing in <5s |

## Conventions

- All tests use Arabic strings where the system does (e.g. `'مبيعات'`, `'معلق'`).
- Logic helpers in `unit/*.spec.ts` mirror the service code so business rules
  can be verified without Mongo.
- The integration spec demonstrates the NestJS pattern with `Test.createTestingModule`
  and mocked `ProductsService` / `VaultService` / `Model` providers.

## Key business rules tested

- **Purchase deposit = 0 ⇒ full debt** (CLAUDE.md, Apr 24, 2026)
- **Returns deduct product price only** (not shipping) from profit
- **Returns deduct from net sales** in dashboard/reports (Apr 25, 2026)
- **Approved expenses only** counted in dashboard totals
- **Reference numbers** must be digits-only and unique among non-cancelled
- **Stock cannot go negative** — validated before sale persists
- **Vault balance must cover** purchase deposits
