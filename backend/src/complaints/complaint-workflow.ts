import { BadRequestException, ConflictException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Types } from 'mongoose';

export const SOLUTIONS = ['exchange', 'return', 'support', 'delivery', 'compensation', 'refund_without_return'] as const;
export const OUTCOMES = ['resolved', 'rejected', 'withdrawn', 'duplicate', 'unreachable', 'partial_agreement'] as const;
export function complaintFlow(row: any): any {
  if (row.workflow?.version === 2) return structuredClone(row.workflow);
  return { version: 2, revision: 0, cycle: 1, stage: 'review', ownerId: row.submittedById || '', owner: row.submittedBy || '',
    solution: '', caseId: '', history: [], operations: [], legacy: true,
    legacyDecision: row.status === 'معلق' ? '' : row.status, legacyAction: row.managerAction || '' };
}
export function workflowEvent(w: any, action: string, actor: any, note = '', detail: any = {}) {
  w.history ||= [];
  w.history.push({ id: randomUUID(), action, by: actor.name || actor.username || actor.userId, byId: actor.userId,
    at: new Date().toISOString(), cycle: w.cycle, note, ...detail });
}
export function executionEvidence(row: any, linked: any) {
  const w = complaintFlow(row), a = linked?.workflow;
  if (['exchange', 'return'].includes(w.solution)) {
    if (!a) return { ready: false, stage: 'planned', blockers: ['case_required'], financialPending: false };
    if (a.stage === 'cancelled') return { ready: false, stage: 'blocked', blockers: ['case_cancelled'], financialPending: false };
    const blockers = [];
    if (!a.receivedAt) blockers.push('receipt');
    if (linked.requestKind === 'exchange' && !a.replacementDeliveredAt) blockers.push('delivery');
    if (a.quote?.refundDue && !a.refund) blockers.push('refund');
    if (a.quote?.collectDue && !a.collection) blockers.push('collection');
    if (a.exception) blockers.push('exception');
    const completedDates = [a.receivedAt,a.replacementDeliveredAt,a.refund?.at,a.collection?.at].filter(Boolean).sort();
    return { ready: !blockers.length, stage: a.exception ? 'blocked' : blockers.length ? 'execution' : 'confirmation', blockers,
      financialPending: a.fulfillmentChannel !== 'direct' && !a.carrierSettlement, caseRef: a.ref, caseStage: a.stage,
      trackingNumber: a.shipment?.trackingNumber, carrierStatus: a.shipment?.carrierStatus,
      refund: a.refund?.amount || 0, collection: a.collection?.amount || 0,
      receivedAt: a.receivedAt, deliveredAt: a.replacementDeliveredAt, fulfilledAt: !blockers.length ? completedDates[completedDates.length - 1] : undefined, exception: a.exception || '' };
  }
  const paid = ['compensation', 'refund_without_return'].includes(w.solution);
  const ready = !!w.solution && (paid ? !!w.payment : !!w.fulfillment);
  return { ready, stage: ready ? 'confirmation' : w.solution ? 'execution' : 'review',
    blockers: ready ? [] : [paid ? 'payment' : 'evidence'], financialPending: false, fulfilledAt: w.payment?.at || w.fulfillment?.at };
}
export function complaintView(row: any, linked?: any) {
  const raw = row.toObject ? row.toObject() : row, w = complaintFlow(raw), execution = executionEvidence(raw, linked);
  const stage = w.stage === 'closed' || w.stage === 'waiting' ? w.stage : w.caseId ? execution.stage : w.stage;
  return { ...raw, workflow: w, execution, lifecycleStage: stage,
    inFollowUp: w.stage !== 'closed' && (!!w.solution || raw.inFollowUp === true),
    overdue: w.stage !== 'closed' && !!w.dueAt && Date.parse(w.dueAt) < Date.now() };
}
export function assertCaseCoverage(complaint: any, linked: any) {
  const w = complaintFlow(complaint);
  if ((w.cycles || []).some((c: any) => c.caseId === String(linked._id))) throw new ConflictException('هذا الطلب عالج دورة سابقة؛ لا تعِد استخدام تنفيذه لحل جديد');
  if (!complaint.transactionId || String(linked.originalTransactionId) !== complaint.transactionId) throw new BadRequestException('الطلب لا يخص فاتورة الشكوى');
  if (linked.requestKind !== w.solution || linked.workflow?.version !== 2 || linked.workflow.stage === 'cancelled') throw new BadRequestException('نوع الطلب أو حالته لا يطابق الحل المختار');
  const items = complaint.items?.length ? complaint.items : complaint.productCode ? [{ code: complaint.productCode, qty: complaint.productQty }] : [];
  if (!items.length) throw new BadRequestException('حدد بنود الشكوى والكميات قبل ربط التنفيذ');
  for (const item of items) {
    const lines = (linked.workflow.selectedLines || linked.items || []).filter((i: any) =>
      item.lineId ? i.lineId === item.lineId : item.lineIndex != null ? i.lineIndex === item.lineIndex : i.code === item.code);
    if (lines.reduce((n: number, i: any) => n + Number(i.qty), 0) !== Number(item.qty)) throw new BadRequestException('كميات طلب التنفيذ لا تطابق بنود الشكوى');
    if ((item.unitIds || []).some((id: string) => !lines.some((i: any) => i.unitIds?.includes(id)))) throw new BadRequestException('هويات الطلب لا تطابق القطع محل الشكوى');
  }
}

export async function recordComplaintExecution(connection: any, row: any, event: any, session: any) {
  const ids = (row.workflow?.complaintIds || []).filter((id: string) => /^[a-f\d]{24}$/i.test(id)).map((id: string) => new Types.ObjectId(id));
  if (!ids.length) return;
  await connection.collection('complaints').updateMany({ _id: { $in: ids }, 'workflow.executionEvents.id': { $ne: event.eventId } },
    { $push: { 'workflow.executionEvents': { id: event.eventId, at: event.at || new Date().toISOString(), action: event.action, by: event.by,
      note: event.note || '', caseRef: row.workflow.ref, caseId: String(row._id) } }, $inc: { __v: 1 } }, { session });
}

/** Called inside the same Mongo transaction as creation/linking of the execution case. */
export async function linkComplaintCase(connection: any, complaintId: string, linked: any, actor: any, expectedRevision: number, session: any) {
  if (!/^[a-f\d]{24}$/i.test(complaintId || '')) throw new BadRequestException('رقم الشكوى غير صالح');
  const collection = connection.collection('complaints'), row = await collection.findOne({ _id: new Types.ObjectId(complaintId) }, { session });
  if (!row) throw new BadRequestException('الشكوى غير موجودة');
  const w = complaintFlow(row);
  if (w.stage === 'closed' || w.archivedAt) throw new ConflictException('أعد فتح الشكوى قبل بدء تنفيذ جديد');
  if (w.revision !== expectedRevision) throw new ConflictException('تغيرت الشكوى؛ حدّث الملف قبل المتابعة');
  if (w.caseId && w.caseId !== String(linked._id)) throw new ConflictException('يوجد طلب مرتبط؛ راجع تنفيذه قبل استبداله');
  assertCaseCoverage(row, linked);
  if (w.caseId === String(linked._id)) return;
  w.caseId = String(linked._id); w.caseRef = linked.workflow.ref; w.stage = 'execution'; w.revision++;
  w.decisionAt = new Date().toISOString(); w.decisionBy = actor.name || actor.username || actor.userId;
  workflowEvent(w, 'case_linked', actor, '', { caseId: w.caseId, caseRef: w.caseRef });
  await collection.updateOne({ _id: row._id }, { $set: { workflow: w, status: 'مقبول', inFollowUp: true, updatedAt: new Date() }, $inc: { __v: 1 } }, { session });
  linked.workflow.complaintIds = [...new Set([...(linked.workflow.complaintIds || []), complaintId])];
}
