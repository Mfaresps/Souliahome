import { randomUUID } from 'crypto';
import { compressReceipt, MAX_STORED_RECEIPT_BYTES } from '../shopify/receipt-upload-policy.util';

// Use the same validated, metadata-free image compression as deposit receipts, without OCR.
export const compressComplaintEvidence = compressReceipt;
export const MAX_COMPLAINT_EVIDENCE_BYTES = MAX_STORED_RECEIPT_BYTES;
export const COMPLAINT_EVIDENCE_PREFIX = 'complaint-evidence/';

export function complaintEvidenceKey(row: { _id: unknown; complaintNo?: string; createdAt?: unknown }, attachmentId: string): string {
  const date = new Date(String(row.createdAt || ''));
  const month = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit' })
    .format(Number.isNaN(date.getTime()) ? new Date() : date);
  const label = String(row.complaintNo || 'complaint').normalize('NFKC').replace(/[^\p{L}\p{N}_-]/gu, '-').slice(0, 80);
  // Each upload attempt owns its object, so rolling back a duplicate cannot delete the winner.
  return `${COMPLAINT_EVIDENCE_PREFIX}${month}/${label}_${row._id}/${attachmentId}-${randomUUID()}.jpg`;
}
