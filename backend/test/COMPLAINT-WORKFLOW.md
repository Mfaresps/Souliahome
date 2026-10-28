# Complaint workflow v2

The customer-care workspace now records one complaint with multiple affected invoice lines. The original invoice, after-sales case, stock movements and payments remain authoritative. The UI uses evidence returned by the server to choose the next action; it does not set a complaint to “resolved” from a free-text status picker.

## Lifecycle and permissions

`review → planned → execution → confirmation → closed`

Waiting requires a reason, a responsible owner and a future deadline. Execution exceptions are shown as blocked. The default first follow-up is 24 hours after creation. Dates in the UI are entered and displayed in Africa/Cairo time. The owner receives a due reminder through the existing notification system; account notification preferences still apply.

Staff with `complaints` or `transaction` can read the workspace, capture complaints, document contact/evidence and follow up. Managers choose the resolution, link cases, record money, close, reopen and archive. Execution actions retain the existing warehouse, preparation and after-sales permissions.

Closure outcomes: resolved, agreed partial resolution, rejected with reason, withdrawn, duplicate, unreachable. Successful closure requires actual fulfillment and customer confirmation, or two unanswered follow-ups at least 24 hours apart after fulfillment. An outstanding dispute requires explicit renewed confirmation. Unreachable is not reported as successfully resolved. Existing open execution obligations prevent every closure outcome.

## Execution linkage

- Creating an AS case from a complaint passes its ID and expected workflow revision. The case and complaint link are written in the same Mongo transaction.
- Existing cases can be linked only when invoice, request kind, affected quantities and selected identities agree. Previously completed cycles cannot reuse old execution as new proof.
- Receipt, replacement delivery, refund and collection are checked when reading and closing the complaint. Carrier settlement may remain pending after the customer's problem is resolved.
- After-sales/Bosta events are appended to the complaint's execution history. The existing after-sales socket event refreshes open complaint workspaces without interrupting forms.
- Direct warehouse handover is an explicit AS fulfillment channel. It requires preparation, physical receipt and delivery evidence, but creates no courier shipment or carrier settlement.
- Cancelled execution can be unlinked with a reason, preserving its reference, before choosing a new plan. Active shipping/stock/payment effects cannot be erased by closing or unlinking the complaint.

## Money and persistence

Workflow commands require `operationKey` and `expectedRevision`. Repeating an identical operation returns the committed result. A conflicting action or a reused key with different data is rejected. Complaint creation also deduplicates retry keys and uses one record for all selected items.

Compensation and refunds without physical return create one approved customer-compensation expense and one actual vault deduction in the same transaction. The related expense/vault entries cannot be independently deleted, edited or frozen. No-return refunds also reduce available invoice credit, including eligibility for subsequent AS refunds. Refunds require actual payment confirmation and a reference.

Reopening creates a new resolution cycle and retains the previous solution, execution, payment and feedback. It does not replay inventory or money. Archive preserves the complete record. System history cannot be edited/deleted; corrections are appended.

Older complaints are projected into a review state without destructive migration or inferred fulfillment. Their original decision and notes are retained. Old surveys are not re-enabled until execution has been reviewed and a v2 successful closure issues a new link.

## Evidence and privacy

Customer messages appear in a read-only preview at the top of the workspace with a copy button, including immediately after registration and closure. The server chooses registration, progress, confirmation, successful resolution or unsuccessful closure from the actual lifecycle. Copying never sends a message or records customer contact. Admins can edit Arabic/English templates using the workspace's template editor; changes persist in `complaintmessageconfigs` and apply to subsequent previews for all staff. Revision checks prevent overwriting a newer edit. Allowed placeholders are `{customerName}`, `{complaintNo}`, `{invoiceRef}`, `{resolution}` and `{customerMessage}`. The last field is the explicit customer-facing closure text; internal notes and payment references are never substituted.

Up to 10 images can be uploaded to a complaint. JPEG, PNG and WebP images up to 5 MB are decoded, resized and re-encoded as WebP. Authenticated evidence endpoints serve these images; they are not part of the public survey payload. Uploading the same normalized image again is idempotent.

The public survey exposes only the complaint number, first name, resolution label, explicit customer-facing message and survey completion flag. It does not return phone numbers, internal notes, workflow history, attachments, tokens or payment references. Low ratings create a review flag rather than an automatic financial action.

## Exception handling boundary

Stock shortages, failed carrier handover, disputed quantities, partial physical receipts and lost shipments remain explicit blocked/waiting work with an owner and deadline. This change does not invent stock receipts, cancel an external carrier shipment or write off unresolved financial obligations. Those effects must be resolved through the execution/inventory process before a successful closure. The existing AS receipt operation still receives the selected quantities together; it is not a new incremental-receipt engine.

## Local verification

```powershell
npm run build --prefix backend
npm test --prefix backend -- --runInBand --testPathPatterns="complaint-workflow.spec.ts|after-sales.spec.ts"
node backend/test/browser/complaint-workflow.cjs
node backend/test/browser/after-sales-rollback.cjs
node backend/test/browser/after-sales-print.cjs
```

Integration tests launch a separate loopback Mongo replica set with a temporary database; they do not use application environment credentials. HTTP tests run the real complaint controller, validation and permission guard with a test-only authentication override. The linked-return test runs the real AS receipt/identity/vault services.

Browser tests use the real application HTML and scripts with mocked HTTP. They exercise creation, drafts, grouped quantities, planning, AS prefill/linking, closure/reopening and staff permissions. Arabic/English desktop/mobile and dark-mode screenshots are written to `artifacts/complaint-workflow/`.

Deployment requires the usual backend restart/build and serving the updated frontend assets. New schema indexes are additive. No live customer records, carrier requests or payments are created by the test commands above.
