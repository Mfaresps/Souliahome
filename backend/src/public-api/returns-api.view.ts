/**
 * GET /v1/returns — one view over both return systems, which share the `returnrequests` collection:
 *  - after-sales cases (`workflow.version === 2`, the live flow): requested → approved → shipping (pickup
 *    from the customer) → settlement (received in the warehouse; refund / collection due) → closed,
 *    or cancelled. Approval = `workflow.approvedBy/At` (admin). ⚠ The top-level `approvedBy/At` on these
 *    rows is written at RECEIPT, not approval — never read it as the approval.
 *  - legacy ReturnRequest rows: معلق (pending) → معتمد (approved: the return transaction, stock and the
 *    vault refund are written at once) or مرفوض; a later cancellation of that transaction sets `reversedAt`.
 * Pure: no I/O. Field by field — no cost, no vault ids, no phone.
 */

const num = (v: unknown) => Math.round((Number(v) || 0) * 100) / 100;
const iso = (v: unknown) => { if (!v) return null; const d = new Date(v as any); return Number.isNaN(d.getTime()) ? null : d.toISOString(); };

const V2_REASON: Record<string, string> = { defect: 'عيب في المنتج', 'wrong-item': 'منتج خاطئ', 'customer-choice': 'رغبة العميل' };

export const RETURN_STAGES: Record<string, string> = {
  requested: 'طلب — بانتظار الموافقة',
  approved: 'تمت الموافقة — بانتظار استلام المرتجع',
  shipping: 'في الطريق من العميل',
  received: 'تم الاستلام في المخزن — بانتظار التسوية',
  closed: 'مكتمل',
  cancelled: 'ملغي',
  rejected: 'مرفوض',
  reversed: 'تم التراجع عنه',
};

export function returnStage(r: any): string {
  const w = r?.workflow;
  if (w?.version === 2) {
    if (w.stage === 'settlement') return 'received';
    if (RETURN_STAGES[w.stage]) return w.stage;
    return w.receivedAt ? 'received' : w.approvedAt ? 'approved' : 'requested';
  }
  if (r?.reversedAt) return 'reversed';
  if (r?.status === 'مرفوض') return 'rejected';
  if (r?.status === 'معتمد') return 'closed'; // legacy approval = return booked, stock and refund done
  return 'requested';
}

/** استرداد / استبدال / مخزن — what happened (or will happen) to the customer's money. */
export function returnResolution(r: any): 'exchange' | 'refund' | 'stock' {
  if (r?.requestKind === 'exchange') return 'exchange';
  const w = r?.workflow;
  const refund = w?.version === 2 ? Number(w.quote?.refundDue) || Number(w.refund?.amount) || 0 : Number(r?.total) || 0;
  return refund > 0 ? 'refund' : 'stock';
}
const RESOLUTION_LABEL = { exchange: 'استبدال', refund: 'استرداد', stock: 'مخزن (بدون رد مبلغ)' };

export function returnView(r: any) {
  const w = r?.workflow?.version === 2 ? r.workflow : null;
  const stage = returnStage(r);
  const resolution = returnResolution(r);
  const items = (Array.isArray(r?.items) ? r.items : []).map((it: any) => ({
    code: it.code || '', name: it.name || '', qty: Number(it.qty) || 0, condition: it.condition || '',
  }));
  const amount = w ? num(w.quote?.credit ?? r.itemsTotal ?? r.total) : num(r?.total);
  const approval = w
    ? { required: true, approved: !!w.approvedAt, by: w.approvedBy || '', at: iso(w.approvedAt) }
    : { required: true, approved: r?.status === 'معتمد', by: r?.status === 'معتمد' ? r.approvedBy || '' : '', at: r?.status === 'معتمد' ? iso(r.approvedAt) : null };
  const rejected = w ? stage === 'cancelled' : stage === 'rejected';
  return {
    id: String(r._id),
    caseRef: w?.ref || '',
    system: w ? 'after-sales' : 'legacy',
    orderRef: String(r?.originalRef || '').replace(/^#/, ''),
    returnRef: r?.returnTxRef || '',
    kind: r?.requestKind === 'exchange' ? 'exchange' : 'return',
    date: iso(r?.createdAt),
    amount,
    reason: { code: w ? (r.reason || '') : '', label: w ? (V2_REASON[r.reason] || r.reason || '') : (r?.reason || ''), details: r?.reasonDetails || '' },
    items,
    resolution: { state: resolution, label: RESOLUTION_LABEL[resolution] },
    stage: { state: stage, label: RETURN_STAGES[stage] },
    recordedBy: r?.requestedBy || w?.history?.[0]?.by || '',
    approval,
    rejection: rejected ? { by: w ? (w.cancelledBy || '') : (r.approvedBy || ''), at: iso(w ? (w.cancelledAt || r.updatedAt) : r.approvedAt), reason: r?.rejectedReason || '' } : null,
    received: w ? (w.receivedAt ? { by: w.receivedBy || '', at: iso(w.receivedAt) } : null)
      : (r?.status === 'معتمد' ? { by: r.approvedBy || '', at: iso(r.approvedAt) } : null),
    refund: w
      ? { due: num(w.quote?.refundDue), paid: num(w.refund?.amount), method: w.refund?.method || '', at: iso(w.refund?.at), by: w.refund?.by || '' }
      : { due: num(r?.total), paid: r?.status === 'معتمد' && !r?.reversedAt ? num(r.total) : 0, method: r?.vaultRefundAccount || '', at: r?.status === 'معتمد' ? iso(r.approvedAt) : null, by: r?.status === 'معتمد' ? r.approvedBy || '' : '' },
    // Pieces back on the shelf vs damaged — only once the return physically arrived.
    stock: !(w ? w.receivedAt : r?.status === 'معتمد') ? null : {
      restocked: items.filter((i: any) => i.condition !== 'تالف').reduce((n: number, i: any) => n + i.qty, 0),
      damaged: items.filter((i: any) => i.condition === 'تالف').reduce((n: number, i: any) => n + i.qty, 0),
    },
    reversed: r?.reversedAt ? { at: iso(r.reversedAt), by: r.reversedBy || '', reason: r.reversalReason || '' } : null,
  };
}
