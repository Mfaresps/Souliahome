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

# Generate detailed report at backend/TEST-REPORT.txt
npm run test:report
```

## Coverage

| Module                       | Tests | Focus |
|------------------------------|-------|-------|
| Sales                        | 25    | Creation, totals, discounts, stock, payment, invoice |
| Sales Extended               | 24    | Boundaries, multi-discount stacking, exchange, post-sale discount |
| Purchases                    | 20    | Deposit-as-debt rule, supplier, vault check |
| Purchases Extended           | 17    | Multi-payment, debt aggregation, VAT, return-to-supplier |
| Returns                      | 20    | Stock adjustment, refund (product-only), credit notes |
| Returns Extended             | 14    | Exchange flow, partial returns, refund-to-vault |
| Vault & Stock Sync           | 25    | Segments, deposits, withdrawals, atomic sync |
| Invoice Log                  | 23    | Filtering, retrieval, integrity, CSV export with HTML stripping |
| Reports                      | 23    | Sales/purchase/cash summaries, profit, formatting |
| Inventory & Stock            | 13    | Stock movement aggregation, opening balance, alerts |
| Dashboard KPIs               | 10    | KPI calc, top sellers, stock alerts |
| Auth & Permissions           | 14    | Roles, perms, admin-only features, vault password |
| Export Formats               | 20    | CSV escaping, Excel BOM, column selection, HTML strip |
| General                      | 31    | Error handling, consistency, cancellation, integrity |
| Edge Cases                   | 28    | Numerical, string, date, array, concurrency, pagination |
| Integration (NestJS)         |  9    | Service-level with mocked deps |
| **Total**                    | **316** | All passing in <10s |

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
