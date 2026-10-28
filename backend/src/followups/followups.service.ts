import { NotificationsService } from '../notifications/notifications.service';
import { CarrierTrackingUpdate, carrierUpdateText } from '../bosta/bosta-tracking.util';
import { Optional as PushOptional, Inject as PushInject } from '@nestjs/common';
import { Injectable, Logger, OnModuleInit, ForbiddenException, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Cron } from '@nestjs/schedule';
import { Model, Types } from 'mongoose';
import { FollowUp, FollowUpDocument } from './schemas/followup.schema';
import { CreateFollowUpDto, UpdateFollowUpDto, DeferFollowUpDto } from './dto/followup.dto';
import { MentionsService } from '../mentions/mentions.service';
import { PresenceGateway } from '../auth/presence.gateway';
import { EmployeeShiftService } from '../employee-performance/employee-shift.service';
import { CUSTOMER_CANCELLATION_QUERY } from '../employee-performance/customer-cancellation';

/**
 * A follow-up in any of these needs no further action.
 *
 * ⚠ This list is mirrored on the frontend as `FU_SETTLED_STATUSES`. They used to
 * disagree — the server knew only the first two — so a ticket closed as
 * «تمت عملية التأكيد» or «العميل ألغى الطلب» sank out of the way in the UI while
 * the server still counted it open and kept sending escalation reminders on it
 * for a week. Change one, change the other.
 */
export const DONE_STATUSES = [
  'تم حل المشكلة',     // default set — resolved
  'تمت المتابعة',      // legacy resolved
  'تمت عملية التأكيد', // confirmation set — order confirmed
  'العميل ألغى الطلب', // confirmation set — nothing left to chase
];

/**
 * Reason + status stamped on follow-ups the system opens by itself when a
 * shipment hits a delivery problem. The VALUES are Arabic because that is what
 * every other follow-up stores — the frontend maps them to English at render
 * time (`_FU_REASON_EN` / `_FU_STATUS_EN`), never in the database.
 */
export const SHIPPING_ISSUE_REASON = 'مشكلة في الاستلام';
const SHIPPING_ISSUE_STATUS = 'في انتظار المتابعة';

/**
 * Bosta status codes that count as a delivery problem worth a follow-up.
 *
 * `DELIVERY_FAILED` used to sit here and was removed: nothing in Bosta's numeric
 * state table or its text-status map ever resolves to that string, so the check
 * could never be true. It read as a covered case while covering nothing.
 */
const SHIPPING_ISSUE_STATUSES = ['FAILED_ATTEMPT', 'RETURNED'];

/** Arabic label per trigger, used in the auto-generated opening comment. */
const TRIGGER_LABELS: Record<string, string> = {
  CUSTOMER_POSTPONED: 'العميل أجّل الاستلام',
  FAILED_ATTEMPT: 'محاولة تسليم فاشلة',
  RETURNED: 'مرتجع',
};

// Escalation thresholds in hours: 12h, then 24h, 48h, 72h, ... (one per day after the first day)
const ESCALATION_HOURS = [12, 24, 48, 72, 96, 120, 144, 168];

@Injectable()
export class FollowUpsService implements OnModuleInit {
  @PushOptional() @PushInject(NotificationsService) private readonly notifications?: NotificationsService;

  private readonly logger = new Logger(FollowUpsService.name);

  constructor(
    @InjectModel(FollowUp.name) private model: Model<FollowUpDocument>,
    private readonly mentionsService: MentionsService,
    private readonly presence: PresenceGateway,
    private readonly shiftService: EmployeeShiftService,
  ) {}

  /** True when a Bosta status code is one this module opens a follow-up for. */
  static isShippingIssueStatus(status: string): boolean {
    return SHIPPING_ISSUE_STATUSES.includes(String(status || ''));
  }

  /**
   * Picks who handles a live delivery problem, preferring somebody who is
   * actually at a screen right now.
   *
   * The tiers, in order:
   *   1. on shift AND online       — the ideal: on duty and reachable
   *   2. scheduled AND online      — off their window but working; better than
   *                                  a ticket sitting on an empty chair
   *   3. on shift (offline)        — on duty, will see it when they log in
   *   4. the on-call employee      — the standing fallback
   *   5. nobody                    — returns null, and the CALLER still opens
   *                                  the ticket unassigned. A problem with no
   *                                  free employee is exactly the one that must
   *                                  not vanish.
   *
   * Within tiers 1 and 2 the person holding the fewest open follow-ups wins, so
   * a busy night does not pile everything on one employee.
   */
  private async pickAvailableAssignee(): Promise<{ userId: string; username: string; name: string; reason: string } | null> {
    try {
      const candidates = await this.shiftService.listShiftCandidates(new Date().toISOString());
      const onlineIds = new Set(this.presence.getOnlineUserIds().map(String));

      const onlineFrom = (list: Array<{ userId: string; username: string; name: string }>) =>
        list.filter((c) => onlineIds.has(String(c.userId)));

      const leastBusy = async (
        list: Array<{ userId: string; username: string; name: string }>,
        reason: string,
      ) => {
        if (!list.length) return null;
        const counts = await Promise.all(
          list.map((c) =>
            this.model
              .countDocuments({
                responsibleId: c.userId,
                cancelled: { $ne: true },
                status: { $nin: DONE_STATUSES },
              })
              .exec()
              .catch(() => 0),
          ),
        );
        let best = 0;
        for (let i = 1; i < list.length; i++) if (counts[i] < counts[best]) best = i;
        return { userId: list[best].userId, username: list[best].username || '', name: list[best].name, reason };
      };

      return (
        (await leastBusy(onlineFrom(candidates.onShift), 'shift-online')) ||
        (await leastBusy(onlineFrom(candidates.scheduled), 'available-online')) ||
        (candidates.onShift.length
          ? { userId: candidates.onShift[0].userId, username: candidates.onShift[0].username || '', name: candidates.onShift[0].name, reason: 'shift' }
          : null) ||
        (candidates.onCall
          ? { userId: candidates.onCall.userId, username: candidates.onCall.username || '', name: candidates.onCall.name, reason: 'on-call-fallback' }
          : null)
      );
    } catch (err: any) {
      this.logger.warn(`Assignee lookup failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Opens — or reopens — the "مشكلة في الاستلام" follow-up for an order the
   * courier reported a delivery problem on, assigns it to an available employee
   * and pings them.
   *
   * ⚠ ONE TICKET PER ORDER, for the whole life of the order. A closed ticket is
   * reopened rather than replaced. The old rule reused a ticket only while it
   * was still open, which produced the duplicate the shop actually saw: the
   * ordinary sequence is FAILED_ATTEMPT → employee calls and closes → the
   * courier tries again and fails → RETURNED, and that second event landed on
   * whoever happened to be on shift *then*, as a fresh ticket with no trace of
   * the call that already happened. Same order, two tickets, two employees,
   * neither aware of the other.
   *
   * Never throws. Delivery-status ingestion must not fail because follow-up
   * assignment did, so every failure path is logged and swallowed; callers get
   * `null` back rather than an exception.
   */
  async openShippingIssueFollowUp(tx: {
    _id: unknown;
    ref?: string;
    client?: string;
    phone?: string;
    shopifyOrderId?: string;
  }, trigger: string, carrierUpdate?: CarrierTrackingUpdate): Promise<FollowUpDocument | null> {
    try {
      const transactionId = String(tx._id || '');
      if (!transactionId) return null;
      const triggerLabelForThread = carrierUpdate ? carrierUpdateText(carrierUpdate) : TRIGGER_LABELS[trigger] || trigger;
      const requestKey = carrierUpdate ? `bosta:${carrierUpdate.key}` : undefined;
      const postponed = trigger === 'CUSTOMER_POSTPONED';
      const autoSource = postponed ? 'shipping-followup' : 'shipping-issue';
      const reason = postponed ? 'أجل الاستلام' : SHIPPING_ISSUE_REASON;
      const scheduled = carrierUpdate?.scheduledAt;
      // A date-only promise has no agreed hour: retain it in the note, don't guess one.
      const deferredUntil = postponed && scheduled?.includes('T') && Date.parse(scheduled) > Date.now()
        ? new Date(scheduled) : null;

      // Any auto-ticket for this order — open, closed or cancelled. Newest first
      // so a legacy order carrying duplicates from before this rule converges on
      // one thread instead of resurrecting the oldest.
      const existing = await this.model
        .findOne({ transactionId, autoSource: { $in: ['shipping-issue', 'shipping-followup'] } })
        .sort({ createdAt: -1 })
        .exec();

      if (existing) {
        if (requestKey && existing.autoTrigger === trigger
          && existing.comments?.some(comment => comment.requestKey === requestKey)) return existing;
        const wasSettled = existing.cancelled || DONE_STATUSES.includes(existing.status);
        const lastAction = existing.lastCarrierAction || existing.carrierUpdate;
        const sameAttempt = carrierUpdate && lastAction
          && existing.autoTrigger === trigger
          && lastAction.reasonCode === carrierUpdate.reasonCode
          && lastAction.reasonAr === carrierUpdate.reasonAr
          && lastAction.reason === carrierUpdate.reason
          && lastAction.exceptionAt === carrierUpdate.exceptionAt
          && lastAction.attempts === carrierUpdate.attempts
          && lastAction.scheduledAt === carrierUpdate.scheduledAt;
        if (wasSettled && sameAttempt) {
          await this.recordCarrierUpdate(transactionId, carrierUpdate);
          return existing;
        }

        if (wasSettled) {
          // Reopened: a new failure on an order somebody already signed off is a
          // new piece of work, and it goes to whoever is free NOW — the person
          // who closed it may be off shift.
          const next = await this.pickAvailableAssignee();
          existing.status = SHIPPING_ISSUE_STATUS;
          existing.cancelled = false;
          existing.cancelReason = '';
          existing.escalationBaseline = new Date();
          existing.escalationLevel = 0;
          if (next?.userId) {
            existing.responsibleId = next.userId;
            existing.responsibleUsername = next.username || '';
            existing.responsibleName = next.name;
            existing.assignSource = next.reason;
          }
          (existing.comments as any[]).push({
            requestKey,
            authorId: 'system',
            authorName: 'النظام',
            text: `أُعيد فتح المتابعة — تحديث جديد على نفس الطلب: ${triggerLabelForThread}`,
            edited: false,
            kind: 'note',
          });
        } else if (existing.autoTrigger !== trigger || carrierUpdate) {
          // Still open, new trigger (FAILED_ATTEMPT → RETURNED): record the
          // escalation on the thread rather than opening a second ticket.
          (existing.comments as any[]).push({
            requestKey,
            authorId: 'system',
            authorName: 'النظام',
            text: `تحديث حالة الشحنة: ${triggerLabelForThread}`,
            edited: false,
            kind: 'note',
          });
        } else {
          return existing; // nothing new to say
        }

        existing.autoTrigger = trigger;
        existing.autoSource = autoSource;
        existing.reason = reason;
        if (carrierUpdate) { existing.carrierUpdate = carrierUpdate; existing.lastCarrierAction = carrierUpdate; }
        if (!sameAttempt || wasSettled) {
          existing.deferredUntil = deferredUntil;
          existing.deferReason = postponed ? 'customer_postponed' : '';
          existing.deferReminderSent = false;
        }
        if (wasSettled) { existing.resolution = ''; existing.closedAt = undefined; }
        await existing.save();
        this.presence.emitEvent('followup:changed', { action: 'update', id: String(existing._id) });
        if ((wasSettled || (carrierUpdate && !sameAttempt)) && existing.responsibleId) {
          await this.notifyAssignee(
            String(existing.responsibleId),
            existing.responsibleName || '',
            String(existing._id),
            existing.orderRef || '',
            triggerLabelForThread,
            wasSettled,
            postponed,
          );
        }
        return existing;
      }

      // ⚠ An unassignable problem still gets a ticket. The old code returned
      // null here, so a failure reported at 2am with nobody on shift produced no
      // record at all — the order fell out of the process entirely and the only
      // trace was a warning in the log.
      const assignee = await this.pickAvailableAssignee();
      if (!assignee?.userId) {
        this.logger.warn(
          `No employee on shift, online or on-call — shipping issue on tx=${transactionId} (${trigger}) opened UNASSIGNED`,
        );
      }

      const orderRef = String(tx.ref || transactionId);
      const ticketNo = await this.generateTicketNo(orderRef);
      const triggerLabel = triggerLabelForThread;

      const doc = await this.model.create({
        ticketNo,
        orderRef,
        transactionId,
        shopifyOrderId: tx.shopifyOrderId || '',
        clientName: tx.client || '',
        clientPhone: tx.phone || '',
        responsibleId: assignee?.userId || '',
        responsibleUsername: assignee?.username || '',
        responsibleName: assignee?.name || '',
        reason,
        status: SHIPPING_ISSUE_STATUS,
        autoSource,
        autoTrigger: trigger,
        deferredUntil,
        deferReason: postponed ? 'customer_postponed' : '',
        ...(carrierUpdate ? { carrierUpdate, lastCarrierAction: carrierUpdate } : {}),
        assignSource: assignee?.reason || 'unassigned',
        notified: true,
        comments: [
          {
            requestKey,
            authorId: 'system',
            authorName: 'النظام',
            text: assignee?.userId
              ? `تم فتح المتابعة تلقائياً — أبلغت شركة الشحن عن: ${triggerLabel}`
              : `تم فتح المتابعة تلقائياً — أبلغت شركة الشحن عن: ${triggerLabel}. لا يوجد موظف متاح الآن، التذكرة بانتظار الإسناد.`,
            edited: false,
            kind: 'note',
          },
        ],
      });

      if (assignee?.userId) {
        await this.notifyAssignee(assignee.userId, assignee.name, String(doc._id), orderRef, triggerLabel, false, postponed);
      }

      // Broadcast so every open client (dashboard shipping-issues card included)
      // picks the new ticket up without a manual refresh.
      this.presence.emitEvent('followup:changed', { action: 'create', id: String(doc._id) });
      this.presence.emitEvent('tx:updated', { _id: transactionId });

      this.logger.log(
        `Auto follow-up ${ticketNo} opened for tx=${transactionId} (${trigger}) → ${assignee?.name || 'UNASSIGNED'} [${assignee?.reason || 'unassigned'}]`,
      );
      return doc;
    } catch (err: any) {
      this.logger.error(`openShippingIssueFollowUp failed (${trigger}): ${err.message}`);
      return null;
    }
  }

  /** Every meaningful carrier update stays on the same ticket, including recovery. */
  async recordCarrierUpdate(transactionId: string, event: CarrierTrackingUpdate, historical = false): Promise<void> {
    try {
      const requestKey = `bosta:${event.key}`;
      const result = await this.model.updateMany({ transactionId: String(transactionId),
        autoSource: { $in: ['shipping-issue', 'shipping-followup'] }, 'comments.requestKey': { $ne: requestKey },
      }, {
        ...(!historical ? { $set: { carrierUpdate: event } } : {}),
        $push: { comments: { requestKey, authorId: 'system', authorName: 'بوسطة',
          text: carrierUpdateText(event), edited: false, kind: 'note', createdAt: new Date(), updatedAt: new Date() } },
      }).exec();
      if (result.modifiedCount) this.presence.emitEvent('followup:changed', { action: 'update', transactionId });
    } catch (err: any) {
      this.logger.error(`Carrier follow-up update failed for tx=${transactionId}: ${err.message}`);
    }
  }

  /**
   * Mention + socket ping for a shipping-issue assignment. Extracted because the
   * open and reopen paths both need it and were drifting apart.
   * Never throws — a notification failure must not undo a ticket that was saved.
   */
  private async notifyAssignee(
    userId: string,
    name: string,
    followUpId: string,
    orderRef: string,
    triggerLabel: string,
    reopened: boolean,
    postponed = false,
  ): Promise<void> {
    const notifyText = postponed ? `متابعة تأجيل استلام الطلب #${orderRef} (${triggerLabel})` : reopened
      ? `مشكلة جديدة على طلب #${orderRef} (${triggerLabel}) — أُعيد فتح المتابعة`
      : `مشكلة في الاستلام — طلب #${orderRef} (${triggerLabel})`;
    try {
      const created = await this.mentionsService.create({
        targetUserId: userId,
        targetName: name,
        fromUserId: 'system',
        fromName: 'متابعة تلقائية',
        txId: followUpId,
        txRef: orderRef,
        commentId: 0,
        commentText: notifyText,
      });
      this.presence.emitToUser(userId, 'mention:new', {
        id: String(created._id),
        _id: String(created._id),
        targetUserId: userId,
        targetName: name,
        fromUserId: 'system',
        fromName: 'متابعة تلقائية',
        txId: followUpId,
        txRef: orderRef,
        commentId: 0,
        commentText: notifyText,
        read: false,
        ts: new Date().toISOString(),
      });
      this.presence.emitToUser(userId, 'followup:notify', {
        id: followUpId,
        orderRef,
        reason: postponed ? 'أجل الاستلام' : SHIPPING_ISSUE_REASON,
        fromName: 'متابعة تلقائية',
        auto: true,
      });
    } catch (err: any) {
      this.logger.warn(`Failed to notify ${userId} of shipping follow-up ${followUpId}: ${err.message}`);
    }
  }

  /**
   * Closes the auto-opened shipping-issue ticket for an order whose failed
   * delivery has been resolved. Called from TransactionsService once the closing
   * decision is recorded, so the ticket and the order can never disagree about
   * whether the problem is over.
   *
   * Never throws: the money and the stock have already moved by the time this
   * runs, and a ticket-bookkeeping failure must not fail that.
   */
  async closeShippingIssueFollowUp(transactionId: string, outcomeLabel: string, by: string): Promise<void> {
    try {
      const at = new Date();
      // Close every open auto-ticket, including legacy duplicates. Repeated
      // courier updates must neither append duplicate notes nor reopen work.
      const result = await this.model.updateMany({
        transactionId: String(transactionId), autoSource: { $in: ['shipping-issue', 'shipping-followup'] },
        cancelled: { $ne: true }, status: { $nin: DONE_STATUSES },
      }, {
        $set: { status: 'تم حل المشكلة', resolution: outcomeLabel, closedAt: at,
          escalationBaseline: at, escalationLevel: 0 },
        $push: { comments: { authorId: 'system', authorName: 'النظام',
          text: `أُغلقت المشكلة: ${outcomeLabel}${by ? ` — بواسطة ${by}` : ''}`,
          edited: false, kind: 'note', createdAt: at, updatedAt: at } },
      }).exec();
      if (result.modifiedCount) this.presence.emitEvent('followup:changed', { action: 'update', transactionId: String(transactionId) });
    } catch (err: any) {
      this.logger.error(`closeShippingIssueFollowUp failed for tx=${transactionId}: ${err.message}`);
    }
  }

  findAll() {
    return this.model.find().sort({ createdAt: -1 }).lean();
  }

  findById(id: string) {
    return this.model.findById(id).lean();
  }

  /**
   * Builds the human-facing ticket id: FU-YYMMDD-{orderRef}, adding a -2/-3
   * suffix when the same order already has a follow-up opened the same day.
   * Deliberately mirrors ComplaintsService.generateComplaintNo so a follow-up
   * ticket and a complaint number read identically apart from the prefix.
   */
  private async generateTicketNo(orderRef?: string, when: Date = new Date()): Promise<string> {
    const yy = String(when.getFullYear()).slice(-2);
    const mm = String(when.getMonth() + 1).padStart(2, '0');
    const dd = String(when.getDate()).padStart(2, '0');
    const ref = (orderRef || '').replace(/^#+/, '').trim();
    const datePart = `${yy}${mm}${dd}`;

    if (ref) {
      // Escape the ref before interpolating it into a regex — order refs can
      // carry dashes and other literal characters (e.g. "2254-RET").
      const safeRef = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const base = `FU-${datePart}-${ref}`;
      const existing = await this.model
        .find({ ticketNo: { $regex: `^FU-${datePart}-${safeRef}(-\\d+)?$` } })
        .select('ticketNo')
        .lean()
        .exec();
      if (!existing.length) return base;
      let maxSuffix = 1;
      for (const e of existing) {
        const m = (e as any).ticketNo?.match(/-(\d+)$/);
        const n = m && (e as any).ticketNo !== base ? parseInt(m[1], 10) : 1;
        if (n > maxSuffix) maxSuffix = n;
      }
      return `${base}-${maxSuffix + 1}`;
    }

    // No linked order — fall back to a daily sequence so the id stays unique.
    const sameDay = await this.model
      .find({ ticketNo: { $regex: `^FU-${datePart}-N\\d+$` } })
      .select('ticketNo')
      .lean()
      .exec();
    let seq = 1;
    for (const e of sameDay) {
      const m = (e as any).ticketNo?.match(/-N(\d+)$/);
      const n = m ? parseInt(m[1], 10) : 0;
      if (n >= seq) seq = n + 1;
    }
    return `FU-${datePart}-N${String(seq).padStart(3, '0')}`;
  }

  async create(dto: CreateFollowUpDto, actorUserId = '') {
    const ticketNo = await this.generateTicketNo(dto.orderRef);
    const doc = await this.model.create({ ...dto, ticketNo });
    if (doc.status === 'العميل ألغى الطلب' && doc.reason === 'عملية تأكيد الطلب') {
      try { await this.closeCustomerCancellationSiblings(doc); }
      catch (err: any) { this.logger.error(`Customer cancellation follow-up closure failed: ${err.message}`); }
    }
    await this.notifications?.enqueue('followup', 'followup:' + doc._id, doc.orderRef, 'followup:' + doc._id, undefined, undefined, { actorUserId });
    return doc;
  }

  /**
   * Backfills ticketNo on records created before the field existed. Runs once
   * on boot; each ticket is derived from that record's own createdAt so the
   * date embedded in the id stays truthful rather than reflecting migration
   * day. Sequential (not Promise.all) because generateTicketNo reads back the
   * rows it just wrote to resolve same-day suffixes.
   */
  async onModuleInit(): Promise<void> {
    try {
      const missing = await this.model
        .find({ $or: [{ ticketNo: { $exists: false } }, { ticketNo: '' }, { ticketNo: null }] })
        .select('_id orderRef createdAt')
        .sort({ createdAt: 1 })
        .lean()
        .exec();
      for (const f of missing as any[]) {
        const when = f.createdAt ? new Date(f.createdAt) : new Date();
        const ticketNo = await this.generateTicketNo(f.orderRef, when);
        await this.model.updateOne({ _id: f._id }, { ticketNo }).exec();
      }
      if (missing.length) this.logger.log(`Backfilled ticketNo on ${missing.length} follow-up(s)`);
    } catch (err: any) {
      this.logger.error(`ticketNo backfill failed: ${err.message}`);
    }
    await this.reconcileCancelledOrders();
    await this.reconcileDepositConfirmations();
    await this.reconcileCustomerCancellations();
  }

  /** A submitted deposit confirms the customer, independently of financial approval. */
  async closeConfirmationForDeposit(order: any, by = ''): Promise<void> {
    if (!order || order.cancelled || order.status === 'rejected') return;
    const receipts = (order.depositReceipts || []).filter((r: any) =>
      ['معلق', 'معتمد'].includes(r.status) && Number(r.amount) > 0);
    if (!receipts.length) return;
    await this.closeForOrder({ shopifyOrderIds: [String(order._id), order.shopifyId], orderRef: order.ref },
      'confirmed', receipts.some((r: any) => r.status === 'معتمد')
        ? 'تم تسجيل ديبوزت معتمد' : 'تم تسجيل ديبوزت بانتظار المراجعة', by, true);
  }

  /** Repairs existing trails and retries closure if a receipt event could not be saved. */
  @Cron('15 * * * * *')
  async reconcileDepositConfirmations(): Promise<void> {
    try {
      const open = await this.model.find({ reason: 'عملية تأكيد الطلب', cancelled: { $ne: true },
        autoSource: { $ne: 'shipping-issue' }, status: { $nin: DONE_STATUSES },
        orderOutcome: { $in: ['', null] } }).select('orderRef shopifyOrderId').lean().exec();
      if (!open.length) return;
      // Batch the lookup rather than scanning all historical orders every minute.
      for (let offset = 0; offset < open.length; offset += 200) {
        const batch = open.slice(offset, offset + 200);
        const ids = [...new Set(batch.map(f => String(f.shopifyOrderId || '')).filter(Boolean))];
        const refs = [...new Set(batch.map(f => String(f.orderRef || '').replace(/^#/, '').trim()).filter(Boolean))];
        const orders = await this.model.db.collection('shopifyorders').find({
          cancelled: { $ne: true }, status: { $ne: 'rejected' },
          depositReceipts: { $elemMatch: { status: { $in: ['معلق', 'معتمد'] }, amount: { $gt: 0 } } },
          $or: [{ _id: { $in: ids.filter(id => Types.ObjectId.isValid(id)).map(id => new Types.ObjectId(id)) } },
            { shopifyId: { $in: ids } }, { ref: { $in: refs.flatMap(ref => [ref, '#' + ref]) } }],
        }, { projection: { _id: 1, ref: 1, shopifyId: 1, status: 1, cancelled: 1, depositReceipts: 1 } }).toArray();
        for (const order of orders) await this.closeConfirmationForDeposit(order);
      }
    } catch (err: any) {
      this.logger.error(`Deposit confirmation reconciliation failed: ${err.message}`);
    }
  }

  /** Repair trails left open by cancellations recorded before outcome syncing existed. */
  async reconcileCancelledOrders(): Promise<void> {
    try {
      const open = await this.model.find({ cancelled: { $ne: true }, status: { $nin: DONE_STATUSES },
        orderOutcome: { $in: ['', null] } }).select('orderRef').lean().exec();
      const refs = [...new Set(open.map(f => String(f.orderRef || '').replace(/^#/, '').trim()).filter(Boolean))];
      if (!refs.length) return;
      for (const collection of ['shopifyorders', 'transactions']) {
        const orders = await this.model.db.collection(collection).find({ cancelled: true,
          ref: { $in: refs.flatMap(ref => [ref, '#' + ref]) },
          ...(collection === 'transactions' ? { type: 'مبيعات' } : {}),
        }, { projection: { _id: 1, ref: 1, shopifyId: 1, shopifyOrderId: 1, cancelReason: 1, cancelledBy: 1, cancelledAt: 1 } }).toArray();
        for (const order of orders) await this.closeForOrder({
          ...(collection === 'transactions' ? { transactionId: String(order._id) } : {}),
          shopifyOrderIds: collection === 'shopifyorders' ? [String(order._id), order.shopifyId] : [order.shopifyOrderId],
          orderRef: order.ref, cancelledAt: order.cancelledAt,
        }, 'cancelled', order.cancelReason || '', order.cancelledBy || '');
      }
    } catch (err: any) {
      this.logger.error(`Cancelled order follow-up reconciliation failed: ${err.message}`);
    }
  }

  async defer(id: string, dto: DeferFollowUpDto, userId: string, role: string, name: string) {
    const until = new Date(dto.until), now = new Date();
    const labels: Record<string, string> = { confirmation_contact: 'إعادة التواصل لتأكيد الطلب', awaiting_deposit: 'متابعة سداد العربون', confirm_details: 'تأكيد بيانات الطلب مع العميل', awaiting_customer: 'بانتظار رد العميل', customer_postponed: 'تأجيل بناءً على طلب العميل', carrier_delay: 'بانتظار شركة الشحن', awaiting_return: 'بانتظار استلام المرتجع' };
    if (!labels[dto.reason] || !Number.isFinite(until.getTime()) || until <= now || until.getTime() > now.getTime() + 30 * 86400000) throw new BadRequestException('اختر موعد متابعة قادم خلال 30 يومًا');
    const doc = await this.model.findOneAndUpdate({ _id: id, cancelled: { $ne: true }, status: { $nin: DONE_STATUSES },
      ...(['confirmation_contact', 'awaiting_deposit', 'confirm_details'].includes(dto.reason) ? { reason: 'عملية تأكيد الطلب', autoSource: { $ne: 'shipping-issue' } } : {}),
      orderOutcome: { $in: ['', null] },
      ...(dto.requestId ? { 'comments.requestKey': { $ne: dto.requestId } } : {}),
      ...(role === 'admin' ? {} : { responsibleId: userId }),
    }, { $set: { deferredUntil: until, deferReason: dto.reason, deferNote: String(dto.note || '').trim(), deferReminderSent: false,
      escalationBaseline: until, escalationLevel: 0 },
      $push: { comments: { authorId: userId, authorName: name, kind: 'note', edited: false,
        ...(dto.requestId ? { requestKey: dto.requestId } : {}),
        ...(dto.channel ? { contactChannel: dto.channel } : {}),
        text: `${labels[dto.reason]} — موعد المتابعة: ${until.toISOString()}${dto.note ? ` — ${dto.note.trim()}` : ''}`, createdAt: now, updatedAt: now } },
    }, { new: true }).lean();
    if (!doc) {
      if (dto.requestId) {
        const saved = await this.model.findOne({ _id: id,
          ...(role === 'admin' ? {} : { responsibleId: userId }),
          comments: { $elemMatch: { requestKey: dto.requestId, authorId: userId } },
        }).lean();
        if (saved) return saved;
      }
      throw new ForbiddenException('يمكنك تأجيل متابعاتك المفتوحة فقط');
    }
    try {
      const recipients = await this.notifications?.notifyFollowUpSchedule({ id, orderRef: doc.orderRef, responsibleId: doc.responsibleId,
        until: until.toISOString(), reason: dto.reason }, false, userId, name);
      for (const recipient of recipients || []) this.presence.emitToUser(recipient, 'followup:notify', { id, orderRef: doc.orderRef, reason: 'تم تحديد موعد المتابعة', fromName: name });
    } catch (err: any) { this.logger.warn(`Follow-up schedule notification failed: ${err.message}`); }
    this.presence.emitEvent('followup:changed', { action: 'update', id });
    return doc;
  }

  async update(id: string, dto: UpdateFollowUpDto) {
    const existing = await this.model.findById(id).lean();
    if (existing?.orderOutcome) throw new ForbiddenException('المتابعة مغلقة بنتيجة الطلب');
    const patch: Record<string, unknown> = { ...dto };
    const statusChanged = dto.status !== undefined && existing && dto.status !== existing.status;
    const reasonChanged = dto.reason !== undefined && existing && dto.reason !== existing.reason;
    if (statusChanged || reasonChanged) {
      patch.deferredUntil = null;
      patch.deferReminderSent = false;
      patch.escalationBaseline = new Date();
      patch.escalationLevel = 0;
    }
    const updated = await this.model.findOneAndUpdate({ _id: id, orderOutcome: { $in: ['', null] } }, patch, { new: true }).lean();
    if (updated?.status === 'العميل ألغى الطلب' && updated.reason === 'عملية تأكيد الطلب' && updated.autoSource !== 'shipping-issue') {
      try { await this.closeCustomerCancellationSiblings(updated); }
      catch (err: any) { this.logger.error(`Customer cancellation follow-up closure failed: ${err.message}`); }
    }
    return updated;
  }

  /** Older tickets on the same order must not keep asking the customer to confirm. */
  async closeCustomerCancellationSiblings(source: any): Promise<void> {
    const links: Record<string, unknown>[] = [];
    if (source.shopifyOrderId) links.push({ shopifyOrderId: String(source.shopifyOrderId) });
    if (source.transactionId) links.push({ transactionId: String(source.transactionId) });
    const ref = String(source.orderRef || '').trim().replace(/^#+/, '');
    if (ref) links.push({ orderRef: { $in: [ref, '#' + ref] } });
    if (!links.length) return;
    const now = new Date();
    const result = await this.model.updateMany({
      _id: { $ne: source._id }, $or: links,
      reason: 'عملية تأكيد الطلب', autoSource: { $ne: 'shipping-issue' },
      cancelled: { $ne: true }, status: { $nin: DONE_STATUSES }, orderOutcome: { $in: ['', null] },
    }, {
      $set: { status: 'العميل ألغى الطلب', orderOutcome: 'cancelled', closedAt: now,
        resolution: 'العميل ألغى الطلب في متابعة أخرى لنفس الطلب',
        deferredUntil: null, deferReminderSent: false, escalationLevel: 0, escalationBaseline: now },
      $push: { comments: { authorId: 'system', authorName: 'النظام', kind: 'decision', edited: false,
        text: `أُغلقت متابعة التأكيد — العميل ألغى الطلب في المتابعة ${source.ticketNo || String(source._id)}`,
        createdAt: now, updatedAt: now } },
    }).exec();
    if (result.modifiedCount) this.presence.emitEvent('followup:changed', { action: 'update' });
  }

  /** Also repair records saved before cancellation was shared across tickets. */
  @Cron('30 * * * * *')
  async reconcileCustomerCancellations(): Promise<void> {
    try {
      const sources = await this.model.find(CUSTOMER_CANCELLATION_QUERY)
        .select('shopifyOrderId transactionId orderRef ticketNo').lean().exec();
      for (const source of sources) await this.closeCustomerCancellationSiblings(source);
    } catch (err: any) { this.logger.error(`Customer cancellation reconciliation failed: ${err.message}`); }
  }

  /** Records a customer-confirmation outcome or a completed cancellation. */
  async closeForOrder(order: {
    transactionId?: string; shopifyOrderIds?: string[]; orderRef?: string; cancelledAt?: string | Date;
  }, outcome: 'confirmed' | 'cancelled', detail: string, by = '', confirmationOnly = false): Promise<void> {
    const links: Record<string, unknown>[] = [];
    if (order.transactionId) links.push({ transactionId: String(order.transactionId) });
    const shopifyIds = (order.shopifyOrderIds || []).filter(Boolean).map(String);
    if (shopifyIds.length) links.push({ shopifyOrderId: { $in: shopifyIds } });
    const ref = String(order.orderRef || '').replace(/^#/, '').trim();
    // Legacy trails may only have a reference, or still carry the local Shopify
    // ID after conversion to a transaction (whose Shopify ID is the remote ID).
    if (ref) links.push({ orderRef: { $in: [ref, '#' + ref] },
      transactionId: { $in: ['', null] },
      ...(!order.transactionId ? { shopifyOrderId: { $in: ['', null] } } : {}) });
    if (!links.length) return;
    const cancelledAt = order.cancelledAt ? new Date(order.cancelledAt) : null;
    const at = outcome === 'cancelled' && cancelledAt && Number.isFinite(cancelledAt.getTime()) ? cancelledAt : new Date();
    const text = outcome === 'confirmed'
      ? `العميل أكد الطلب — ${detail}`
      : `تم إلغاء الطلب — السبب: ${detail || 'لم يُسجل سبب'}`;
    try {
      const result = await this.model.updateMany({
        $or: links,
        orderOutcome: outcome === 'confirmed' ? { $in: ['', null] } : { $ne: 'cancelled' },
        ...(outcome === 'confirmed' ? { cancelled: { $ne: true }, autoSource: { $ne: 'shipping-issue' } } : {}),
        ...(confirmationOnly ? { reason: 'عملية تأكيد الطلب', status: { $nin: DONE_STATUSES } } : {}),
      }, {
        $set: {
          status: outcome === 'confirmed' ? 'تمت عملية التأكيد' : 'العميل ألغى الطلب',
          orderOutcome: outcome, closedAt: at, resolution: detail,
          deferredUntil: null, deferReminderSent: false,
          ...(order.transactionId ? { transactionId: String(order.transactionId) } : {}),
          escalationBaseline: at, escalationLevel: 0,
        },
        $push: { comments: { authorId: 'system', authorName: 'النظام',
          text: text + (by ? ` — بواسطة ${by}` : ''), kind: 'decision', edited: false,
          createdAt: at, updatedAt: at } },
      }).exec();
      if (result.modifiedCount) this.presence.emitEvent('followup:changed', { action: 'update' });
    } catch (err: any) {
      // The order and its money have already committed; retain an explicit operational error.
      this.logger.error(`Follow-up closure failed for ${ref || order.transactionId}: ${err.message}`);
    }
  }

  markNotified(id: string) {
    return this.model.findByIdAndUpdate(id, { notified: true }, { new: true }).lean();
  }

  remove(id: string) {
    return this.model.findByIdAndDelete(id);
  }

  async cancel(id: string, cancelReason: string, userId: string, userName: string) {
    const existing = await this.model.findById(id).lean();
    if (existing?.orderOutcome) throw new ForbiddenException('المتابعة مغلقة بنتيجة الطلب');
    return this.model
      .findOneAndUpdate(
        { _id: id, orderOutcome: { $in: ['', null] } },
        {
          cancelled: true,
          cancelReason,
          cancelledAt: new Date(),
          cancelledById: userId,
          cancelledByName: userName,
        },
        { new: true },
      )
      .lean();
  }

  async addComment(id: string, authorId: string, authorName: string, text: string, requestId?: string) {
    const before = await this.model.findById(id).lean();
    if (!before) return null;
    if (before.orderOutcome) throw new ForbiddenException('المتابعة مغلقة بنتيجة الطلب');
    const requestKey = requestId ? authorId + ':' + requestId : undefined;
    if (requestKey && before.comments.some(c => c.requestKey === requestKey)) return before;
    const doc = await this.model
      .findOneAndUpdate(
        { _id: id, orderOutcome: { $in: ['', null] }, ...(requestKey ? { 'comments.requestKey': { $ne: requestKey } } : {}) },
        { $push: { comments: { authorId, authorName, text, edited: false, ...(requestKey ? { requestKey } : {}) } } },
        { new: true },
      )
      .lean();
    if (!doc) return this.model.findById(id).lean();
    // Notify everyone already involved in this thread (responsible user +
    // anyone who has commented before) except whoever just wrote this one —
    // computed from the pre-push snapshot so the author's own new entry
    // never counts as a "prior participant" of itself.
    const participantIds = new Set<string>();
    if (before.responsibleId) participantIds.add(String(before.responsibleId));
    ((before.comments as any[]) || []).forEach((c) => participantIds.add(String(c.authorId)));
    participantIds.delete(String(authorId));

    // $push guarantees the new entry lands last — its _id is what the
    // notification needs so the client can scroll to/highlight this exact
    // comment instead of just opening the thread at the top.
    const newComments = (doc?.comments as any[]) || [];
    const newCommentId = newComments.length ? String(newComments[newComments.length - 1]._id) : '';

    if (newCommentId) await this.notifications?.enqueue('comment', 'comment:followup:' + id + ':' + newCommentId, before.orderRef, 'followup:' + id, undefined, undefined, { actorUserId: authorId, actorName: authorName, commentId: newCommentId, commentText: text });
    const preview = text.length > 80 ? `${text.slice(0, 80)}…` : text;
    const commentText = `تعليق جديد على متابعة #${before.orderRef}: ${preview}`;
    for (const targetUserId of participantIds) {
      try {
        const created = await this.mentionsService.create({
          targetUserId,
          fromUserId: authorId,
          fromName: authorName,
          txId: String(id),
          txRef: before.orderRef,
          commentId: 0,
          commentText,
          fuCommentId: newCommentId,
        });
        this.presence.emitToUser(targetUserId, 'mention:new', {
          id: String(created._id),
          _id: String(created._id),
          targetUserId,
          fromUserId: authorId,
          fromName: authorName,
          txId: String(id),
          txRef: before.orderRef,
          commentId: 0,
          commentText,
          fuCommentId: newCommentId,
          read: false,
          ts: new Date().toISOString(),
        });
      } catch (err: any) {
        this.logger.warn(`Failed to notify ${targetUserId} of new followup comment: ${err.message}`);
      }
    }
    return doc;
  }

  async addCallAttempt(id: string, authorId: string, authorName: string, outcome: 'answered' | 'no_answer') {
    const before = await this.model.findById(id).lean();
    if (!before) return null;
    if (before.orderOutcome) throw new ForbiddenException('المتابعة مغلقة بنتيجة الطلب');
    const existingAttempts = ((before.comments as any[]) || []).filter((c) => c.kind === 'call').length;
    if (existingAttempts >= 3) throw new Error('CALL_LIMIT_REACHED');
    const attemptNo = existingAttempts + 1;
    const outcomeLabel = outcome === 'answered' ? 'تم الرد' : 'لم يتم الرد';
    const text = `محاولة اتصال رقم ${attemptNo} بالعميل — ${outcomeLabel}`;
    const doc = await this.model
      .findOneAndUpdate(
        { _id: id, orderOutcome: { $in: ['', null] } },
        { $push: { comments: { authorId, authorName, text, edited: false, kind: 'call', callAttemptNo: attemptNo, callOutcome: outcome } } },
        { new: true },
      )
      .lean();

    const participantIds = new Set<string>();
    if (before.responsibleId) participantIds.add(String(before.responsibleId));
    ((before.comments as any[]) || []).forEach((c) => participantIds.add(String(c.authorId)));
    participantIds.delete(String(authorId));

    const newComments = (doc?.comments as any[]) || [];
    const newCommentId = newComments.length ? String(newComments[newComments.length - 1]._id) : '';
    const commentText = `تعليق جديد على متابعة #${before.orderRef}: ${text}`;
    for (const targetUserId of participantIds) {
      try {
        const created = await this.mentionsService.create({
          targetUserId,
          fromUserId: authorId,
          fromName: authorName,
          txId: String(id),
          txRef: before.orderRef,
          commentId: 0,
          commentText,
          fuCommentId: newCommentId,
        });
        this.presence.emitToUser(targetUserId, 'mention:new', {
          id: String(created._id),
          _id: String(created._id),
          targetUserId,
          fromUserId: authorId,
          fromName: authorName,
          txId: String(id),
          txRef: before.orderRef,
          commentId: 0,
          commentText,
          fuCommentId: newCommentId,
          read: false,
          ts: new Date().toISOString(),
        });
      } catch (err: any) {
        this.logger.warn(`Failed to notify ${targetUserId} of new call attempt: ${err.message}`);
      }
    }
    return doc;
  }

  async editComment(id: string, commentId: string, authorId: string, text: string, isAdmin = false) {
    const doc = await this.model.findById(id);
    if (!doc) return null;
    const entry = (doc.comments as any[]).find((c) => String(c._id) === String(commentId));
    if (!entry) return null;
    if (entry.authorId === 'system' && entry.kind === 'decision') throw new ForbiddenException('لا يمكن تعديل نتيجة النظام');
    if (!isAdmin && String(entry.authorId) !== String(authorId)) {
      throw new Error('FORBIDDEN');
    }
    entry.text = text;
    entry.edited = true;
    await doc.save();
    return doc.toObject();
  }

  async deleteComment(id: string, commentId: string, authorId: string, isAdmin = false) {
    const doc = await this.model.findById(id);
    if (!doc) return null;
    const entry = (doc.comments as any[]).find((c) => String(c._id) === String(commentId));
    if (!entry) return null;
    if (entry.authorId === 'system' && entry.kind === 'decision') throw new ForbiddenException('لا يمكن حذف نتيجة النظام');
    if (!isAdmin && String(entry.authorId) !== String(authorId)) {
      throw new Error('FORBIDDEN');
    }
    (doc.comments as any[]).splice((doc.comments as any[]).indexOf(entry), 1);
    await doc.save();
    return doc.toObject();
  }

  /**
   * Re-pings the responsible employee when an open follow-up has sat past a
   * reminder threshold (12h, then every 24h) since its last status/reason
   * change. Runs as a backstop cron rather than a client timer so the
   * reminder still fires even if nobody has the app open.
   */
  @Cron('0 * * * * *')
  async scheduledDeferredScan(): Promise<void> {
    const now = new Date();
    try {
      const due = await this.model.find({ cancelled: { $ne: true }, status: { $nin: DONE_STATUSES },
        orderOutcome: { $in: ['', null] },
        deferredUntil: { $ne: null, $lte: now }, deferReminderSent: { $ne: true } }).lean();
      for (const f of due) {
        const claimed = await this.model.findOneAndUpdate({ _id: f._id, deferredUntil: f.deferredUntil,
          deferReminderSent: { $ne: true }, cancelled: { $ne: true }, status: { $nin: DONE_STATUSES }, orderOutcome: { $in: ['', null] } },
          { $set: { deferReminderSent: true } }, { new: true }).lean();
        if (!claimed) continue;
        try {
          const reminder = { id: String(claimed._id), orderRef: claimed.orderRef, clientName: claimed.clientName,
            responsibleId: claimed.responsibleId, deferredUntil: new Date(claimed.deferredUntil!).toISOString(), deferReason: claimed.deferReason };
          const recipients = await this.notifications?.notifyFollowUpSchedule({ id: reminder.id, orderRef: reminder.orderRef,
            responsibleId: reminder.responsibleId, until: reminder.deferredUntil, reason: reminder.deferReason }, true);
          for (const recipient of new Set([reminder.responsibleId, ...(recipients || [])].filter(Boolean))) {
            this.presence.emitToUser(recipient, 'followup:changed', { action: 'reminder', ...reminder });
          }
        } catch (err) {
          await this.model.updateOne({ _id: f._id, deferredUntil: f.deferredUntil }, { $set: { deferReminderSent: false } }).exec();
          this.logger.warn(`Deferred reminder failed for ${f._id}`);
        }
      }
    } catch (err: any) { this.logger.error(`Deferred scan failed: ${err.message}`); }
  }

  @Cron('0 */15 * * * *')
  async scheduledEscalationScan(): Promise<void> {
    try {
      const open = await this.model.find({ status: { $nin: DONE_STATUSES }, cancelled: { $ne: true } }).lean();
      const now = Date.now();
      for (const f of open as any[]) {
        if (f.deferredUntil && new Date(f.deferredUntil).getTime() > now) continue;
        const baseline = f.escalationBaseline ? new Date(f.escalationBaseline).getTime() : new Date(f.createdAt).getTime();
        const hoursElapsed = (now - baseline) / 3_600_000;
        const currentLevel = f.escalationLevel || 0;
        let newLevel = currentLevel;
        for (let i = currentLevel; i < ESCALATION_HOURS.length; i++) {
          if (hoursElapsed >= ESCALATION_HOURS[i]) newLevel = i + 1;
          else break;
        }
        if (newLevel > currentLevel) {
          await this.model.updateOne({ _id: f._id }, { escalationLevel: newLevel }).exec();
          const thresholdHours = ESCALATION_HOURS[newLevel - 1];
          const label = thresholdHours < 24 ? `${thresholdHours} ساعة` : `${thresholdHours / 24} يوم`;
          const reminderText = `تذكير متابعة: طلب #${f.orderRef} بدون تحديث منذ ${label}${f.reason ? ` — ${f.reason}` : ''}`;
          try {
            const created = await this.mentionsService.create({
              targetUserId: f.responsibleId,
              targetName: f.responsibleName,
              fromUserId: 'system',
              fromName: 'تذكير المتابعة',
              txId: String(f._id),
              txRef: f.orderRef,
              commentId: 0,
              commentText: reminderText,
            });
            this.presence.emitToUser(String(f.responsibleId), 'mention:new', {
              id: String(created._id),
              _id: String(created._id),
              targetUserId: f.responsibleId,
              targetName: f.responsibleName,
              fromUserId: 'system',
              fromName: 'تذكير المتابعة',
              txId: String(f._id),
              txRef: f.orderRef,
              commentId: 0,
              commentText: reminderText,
              read: false,
              ts: new Date().toISOString(),
            });
          } catch (err: any) {
            this.logger.warn(`Failed to send escalation reminder for followup ${f._id}: ${err.message}`);
          }
        }
      }
    } catch (err: any) {
      this.logger.error(`Escalation scan failed: ${err.message}`);
    }
  }
}
