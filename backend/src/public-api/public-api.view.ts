import { maskPhone } from '../browse-access/browse-access.service';
import { SHIP_ISSUE_ACTIVE_STATES } from '../shared/ship-issue-state.util';
import { approvedDepositOf, ConfirmationBucket, FOLLOWUP_SETTLED_STATUSES } from '../shared/shopify-confirmation-bucket.util';

/**
 * What the external API sends. Every field is chosen here, on purpose: a raw document would leak
 * purchase cost (`unitCost`, `buyPrice`), raw carrier dumps, receipt images and internal ids.
 * ⚠ Never return a stored document as is from a /v1 route — add the field here.
 */

const iso = (v: unknown): string | null => {
  if (!v) return null;
  const d = new Date(v as any);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const num = (v: unknown) => Math.round((Number(v) || 0) * 100) / 100;

export const BUCKET_LABEL: Record<ConfirmationBucket, string> = {
  cancelled: 'ملغي',
  deposit: 'مؤكد بعربون',
  nodep: 'مؤكد بدون عربون',
  followup: 'في متابعة',
  open: 'لم يُتخذ إجراء',
};

export const FOLLOWUP_OPEN_FILTER = { cancelled: { $ne: true }, status: { $nin: FOLLOWUP_SETTLED_STATUSES } };

export function phoneFor(value: unknown, mode: 'detail' | 'masked' | 'full', isDetail: boolean): string {
  const s = String(value ?? '');
  if (!s) return '';
  if (mode === 'full' || (mode === 'detail' && isDetail)) return s;
  return maskPhone(s);
}

const STAGE_LABEL: Record<string, string> = {
  Pending: 'في الانتظار', Preparing: 'قيد التجهيز', Ready: 'جاهز للشحن', 'Picked-Up': 'استلمها المندوب',
  Shipped: 'تم الشحن', Delivered: 'تم التسليم',
};
const ISSUE_LABEL: Record<string, string> = {
  attempt: 'محاولة تسليم فاشلة — الشحنة مع المندوب وسيعيد المحاولة',
  open: 'الشحنة راجعة للمخزن',
  awaiting: 'بانتظار تأكيد وصول المرتجع للمخزن',
};

/** Shipping status and problems of a sale. `detailed` adds the carrier event history. */
export function shippingView(tx: any, detailed = false) {
  if (!tx) return null;
  const issueState = String(tx.shipIssueState || '');
  const last = tx.bostaLastTrackingUpdate || null;
  const exc = tx.bostaDeliveryException || null;
  const problem = SHIP_ISSUE_ACTIVE_STATES.includes(issueState)
    ? {
        state: issueState,
        label: ISSUE_LABEL[issueState] || issueState,
        trigger: tx.shipIssueTrigger || '',
        openedAt: iso(tx.shipIssueOpenedAt),
        reason: last?.reasonAr || last?.reason || exc?.reason || '',
        attempts: last?.attempts ?? null,
        nextAttemptAt: iso(last?.scheduledAt || exc?.scheduledAt),
        lastExceptionAt: iso(last?.exceptionAt || exc?.at),
      }
    : null;
  const stage = String(tx.pickupStatus || 'Pending');
  const view: Record<string, unknown> = {
    stage,
    stageLabel: STAGE_LABEL[stage] || stage,
    carrier: tx.shipCo || '',
    trackingNumber: tx.bostaTrackingNumber || '',
    carrierStatus: tx.bostaStatus || '',
    carrierStatusLabel: tx.bostaStatusLabel || '',
    delayed: !!tx.bostaIsDelayed,
    shippedAt: iso(tx.shippedAt),
    deliveredAt: iso(tx.deliveredAt),
    lastCarrierUpdateAt: iso(tx.bostaLastSync),
    hasProblem: !!problem,
    problem,
    failedDelivery: tx.failedDelivery
      ? { closedAt: iso(tx.failedDelivery.closedAt || tx.failedDelivery.at), outcome: tx.failedDelivery.outcome || tx.failedDelivery.result || '' }
      : null,
  };
  if (detailed) {
    const events = Array.isArray(tx.bostaTrackingEvents) ? tx.bostaTrackingEvents : [];
    view.events = events.slice(-30).map((e: any) => ({
      at: iso(e.at || e.exceptionAt),
      status: e.status || '',
      statusLabel: e.statusLabel || '',
      reason: e.reasonAr || e.reason || '',
      nextAttemptAt: iso(e.scheduledAt),
      attempts: e.attempts ?? null,
    }));
  }
  return view;
}

function itemsView(items: any[]) {
  return (Array.isArray(items) ? items : []).map((it: any) => ({
    code: it.code || '',
    name: it.name || it.shopifyName || '',
    qty: Number(it.qty) || 0,
    price: num(it.price),
    total: num(it.total ?? (Number(it.price) || 0) * (Number(it.qty) || 0)),
  }));
}

export function followupSummary(f: any) {
  if (!f) return null;
  return {
    id: String(f._id),
    ticketNo: f.ticketNo || '',
    status: f.status || '',
    open: !f.cancelled && !FOLLOWUP_SETTLED_STATUSES.includes(f.status),
    reason: f.reason === 'أخرى' && f.reasonOther ? f.reasonOther : f.reason || '',
    responsible: f.responsibleName || '',
    commentsCount: Array.isArray(f.comments) ? f.comments.length : 0,
    lastCommentAt: iso(Array.isArray(f.comments) && f.comments.length ? f.comments[f.comments.length - 1].createdAt : null),
    deferredUntil: iso(f.deferredUntil),
    createdAt: iso(f.createdAt),
  };
}

export function followupView(f: any, phoneMode: 'detail' | 'masked' | 'full', isDetail: boolean) {
  const base = followupSummary(f)!;
  return {
    ...base,
    orderRef: f.orderRef || '',
    clientName: f.clientName || '',
    clientPhone: phoneFor(f.clientPhone, phoneMode, isDetail),
    automatic: !!f.autoSource,
    resolution: f.resolution || '',
    closedAt: iso(f.closedAt),
    ...(isDetail
      ? {
          comments: (Array.isArray(f.comments) ? f.comments : []).map((c: any) => ({
            id: String(c._id || ''),
            author: c.authorName || '',
            authorId: c.authorId || '',
            text: c.text || '',
            kind: c.kind || 'note',
            callOutcome: c.callOutcome || undefined,
            edited: !!c.edited,
            at: iso(c.createdAt),
          })),
        }
      : {}),
  };
}

/** One order: the Shopify record and/or the confirmed sale behind it. */
export function orderView(input: { shop?: any; tx?: any; followups: any[]; bucket: ConfirmationBucket | null; phoneMode: 'detail' | 'masked' | 'full'; isDetail: boolean; withShipping: boolean }) {
  const { shop, tx, followups, bucket, phoneMode, isDetail, withShipping } = input;
  const src = tx || shop || {};
  const cancelled = !!(tx ? tx.cancelled : shop?.cancelled || shop?.status === 'rejected');
  const deposit = tx ? Number(tx.deposit) || 0 : approvedDepositOf(shop);
  const total = Number(src.total) || 0;
  const open = followups.filter((f) => !f.cancelled && !FOLLOWUP_SETTLED_STATUSES.includes(f.status));
  const view: Record<string, unknown> = {
    ref: String(src.ref || ''),
    source: shop ? 'shopify' : 'manual',
    createdAt: iso(shop?.shopifyCreatedAt || shop?.createdAt || tx?.transactionDate || tx?.createdAt || tx?.date),
    client: src.client || '',
    phone: phoneFor(src.phone, phoneMode, isDetail),
    city: src.shippingCity || src.shippingGov || '',
    total: num(total),
    deposit: num(deposit),
    remaining: num(tx ? tx.remaining : Math.max(0, total - deposit)),
    recorded: !!tx,
    cancelled,
    cancelReason: (tx ? tx.cancelReason : shop?.cancelReason) || '',
    confirmation: bucket ? { state: bucket, label: BUCKET_LABEL[bucket] } : null,
    assignedTo: shop?.assignedToName || '',
    tags: Array.isArray(src.tags) ? src.tags : String(src.tags || '').split(',').map((s: string) => s.trim()).filter(Boolean),
    followUp: {
      has: followups.length > 0,
      open: open.length > 0,
      latest: followupSummary(open[0] || followups[0] || null),
    },
  };
  if (withShipping) view.shipping = tx ? shippingView(tx, isDetail) : null;
  if (isDetail) {
    view.items = itemsView(src.items);
    view.address = src.shippingAddress || '';
    view.notes = src.notes || '';
    view.shipCost = num(src.shipCost);
    view.discount = num(src.discount);
    view.followUps = followups.map((f) => followupSummary(f));
  }
  return view;
}

export function complaintView(c: any, phoneMode: 'detail' | 'masked' | 'full', isDetail: boolean) {
  return {
    id: String(c._id),
    complaintNo: c.complaintNo || '',
    orderRef: c.transactionRef || '',
    clientName: c.clientName || '',
    phone: phoneFor(c.phone, phoneMode, isDetail),
    categoryGroup: c.categoryGroup || '',
    category: c.category || '',
    status: c.status || '',
    priority: c.priority || '',
    progressStage: c.progressStage || '',
    product: c.productName ? { code: c.productCode || '', name: c.productName, qty: Number(c.productQty) || 0 } : null,
    description: c.description || '',
    managerAction: c.managerAction || '',
    inFollowUp: !!c.inFollowUp,
    createdAt: iso(c.createdAt),
    resolvedAt: iso(c.resolvedAt),
    ...(isDetail ? { notes: (Array.isArray(c.notes) ? c.notes : []).map((n: any) => ({ author: n.author || '', text: n.text || '', kind: n.kind || 'note', at: iso(n.createdAt) })) } : {}),
  };
}

/** A mention aimed at the key's account; says where to reply. */
export async function mentionView(db: any, m: any) {
  let kind: 'followup' | 'order' = m.fuCommentId ? 'followup' : 'order';
  let followupId = '';
  if (kind === 'followup') followupId = String(m.txId || '');
  else {
    try {
      const { ObjectId } = await import('mongodb');
      if (ObjectId.isValid(String(m.txId))) {
        const fu = await db.collection('followups').findOne({ _id: new ObjectId(String(m.txId)) }, { projection: { _id: 1 } });
        if (fu) { kind = 'followup'; followupId = String(fu._id); }
      }
    } catch { /* keep 'order' */ }
  }
  return {
    id: String(m._id),
    kind,
    from: m.fromName || '',
    fromUserId: m.fromUserId || '',
    orderRef: m.txRef || '',
    followupId: followupId || undefined,
    commentId: m.fuCommentId || undefined,
    text: m.commentText || '',
    read: !!m.read,
    at: iso(m.createdAt),
    replyWith: kind === 'followup' ? `POST /api/v1/followups/${followupId}/notes` : `POST /api/v1/orders/${encodeURIComponent(String(m.txRef || ''))}/followup-notes`,
  };
}
