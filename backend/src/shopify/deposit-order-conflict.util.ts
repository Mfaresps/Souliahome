/** A pending edit or cancellation must be resolved before adding new payment decisions. */
export function depositOrderConflict(order: {
  status?: string;
  cancelled?: boolean;
  cancelRequest?: { status?: string } | null;
  editRequest?: { status?: string } | null;
}): string {
  if (order.cancelled || order.status === 'cancelled') return 'الأوردر ملغي؛ لا يمكن إضافة عربون أو الشحن بدون عربون';
  if (order.status && order.status !== 'pending') return 'الأوردر لم يعد معلقًا؛ راجع حالته قبل تغيير العربون';
  if (order.cancelRequest?.status === 'معلق') return 'يوجد طلب إلغاء قيد المراجعة؛ راجع طلب الإلغاء أولًا';
  if (['معلق', 'قيد التنفيذ'].includes(order.editRequest?.status || '')) return 'يوجد تعديل للطلب قيد المراجعة؛ شوف التعديل أولًا';
  return '';
}

/** Recheck in the write filter because another employee may request a change concurrently. */
export const DEPOSIT_NO_PENDING_REQUESTS = {
  'cancelRequest.status': { $ne: 'معلق' },
  'editRequest.status': { $nin: ['معلق', 'قيد التنفيذ'] },
};
