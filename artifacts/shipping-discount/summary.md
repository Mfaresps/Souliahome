# Shipping-discount reclassification — Dry Run

Source: local `soulia` (copied to `soulia_shipdisc_20261113b`). Generated 2026-11-13T13:15:22.844Z.

| | Before | After |
|---|---:|---:|
| Product discount | 49765 | 11365 |
| Net product sales | 908185 | 946585 |
| Shipping collected | 38666 | 266 |
| Shipping subsidy | 0 | 38400 |
| Gross profit | 581243 | 581243 |

Affected sales 305 · cancelled for review 4 · skipped 5

- PASS — gross profit equal for every sale (0 مختلفة من 305)
- PASS — gross profit equal for every month (5 شهر)
- PASS — product discount + shipping subsidy = stored discount (لكل فاتورة)
- PASS — net product sales + shipping charged = what the customer was charged (مجموع الإجمالي 946851)
- PASS — clamped rows (Shopify shipping discount above stored shipping/discount) (0 فاتورة)
- PASS — invoices edited in Soulia (total differs from Shopify) — listed for confirmation (48 فاتورة)
- PASS — credentials blanked in both copies (Shopify, Bosta, R2, push)
- PASS — dry run wrote nothing (fingerprints before = after)
- PASS — apply: vault, inventory, Bosta settlement, deposits, remaining, totals unchanged (vaultentries, vaultbalances, inventorymovements, inventoryunits, carrierpayouts, carrierimports, supplierledgerentries, expenses, returnrequests, settings, productcostevents, products, transactions:protected-fields, shopifyorders:except-shippingDiscount)
- PASS — apply: only shippingDiscount, shippingDiscountSource and one history line changed ()
- PASS — second run writes nothing (0/0)
- PASS — rollback restores every collection byte for byte (all identical)
- PASS — source database soulia untouched (read only)

## Log
    1. Copy soulia → soulia_shipdisc_20261113b and soulia_shipdisc_20261113b_apply
       71 / 71 collections
    2. Blank credentials
       remaining credentials: none
    3. Fingerprint (copy 1)
    4. Dry run on copy 1 (writes nothing)
       affected 305, cancelled review 4, skipped 5, orders 423
       database unchanged by the dry run: true
    5. Apply test on copy 2
       written 309 sales (+4 cancelled), 423 order records, conflicts 0
       money/stock/protected fields unchanged after apply: true
       only the new fields + history line changed: true
       second run wrote: 0 sales, 0 orders
       rollback: 309 sales, 423 orders; collections differing afterwards: none
    6. Source database soulia untouched: true