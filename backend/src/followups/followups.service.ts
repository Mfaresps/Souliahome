import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Cron } from '@nestjs/schedule';
import { Model } from 'mongoose';
import { FollowUp, FollowUpDocument } from './schemas/followup.schema';
import { CreateFollowUpDto, UpdateFollowUpDto } from './dto/followup.dto';
import { MentionsService } from '../mentions/mentions.service';
import { PresenceGateway } from '../auth/presence.gateway';
import { EmployeeShiftService } from '../employee-performance/employee-shift.service';

/**
 * A follow-up in any of these needs no further action.
 *
 * ⚠ This list is mirrored on the frontend as `FU_SETTLED_STATUSES`. They used to
 * disagree — the server knew only the first two — so a ticket closed as
 * «تمت عملية التأكيد» or «العميل ألغى الطلب» sank out of the way in the UI while
 * the server still counted it open and kept sending escalation reminders on it
 * for a week. Change one, change the other.
 */
const DONE_STATUSES = [
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
  FAILED_ATTEMPT: 'محاولة تسليم فاشلة',
  RETURNED: 'مرتجع',
};

// Escalation thresholds in hours: 12h, then 24h, 48h, 72h, ... (one per day after the first day)
const ESCALATION_HOURS = [12, 24, 48, 72, 96, 120, 144, 168];

@Injectable()
export class FollowUpsService implements OnModuleInit {
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
  private async pickAvailableAssignee(): Promise<{ userId: string; name: string; reason: string } | null> {
    try {
      const candidates = await this.shiftService.listShiftCandidates(new Date().toISOString());
      const onlineIds = new Set(this.presence.getOnlineUserIds().map(String));

      const onlineFrom = (list: Array<{ userId: string; name: string }>) =>
        list.filter((c) => onlineIds.has(String(c.userId)));

      const leastBusy = async (
        list: Array<{ userId: string; name: string }>,
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
        return { userId: list[best].userId, name: list[best].name, reason };
      };

      return (
        (await leastBusy(onlineFrom(candidates.onShift), 'shift-online')) ||
        (await leastBusy(onlineFrom(candidates.scheduled), 'available-online')) ||
        (candidates.onShift.length
          ? { userId: candidates.onShift[0].userId, name: candidates.onShift[0].name, reason: 'shift' }
          : null) ||
        (candidates.onCall
          ? { userId: candidates.onCall.userId, name: candidates.onCall.name, reason: 'on-call-fallback' }
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
  }, trigger: string): Promise<FollowUpDocument | null> {
    try {
      const transactionId = String(tx._id || '');
      if (!transactionId) return null;
      const triggerLabelForThread = TRIGGER_LABELS[trigger] || trigger;

      // Any auto-ticket for this order — open, closed or cancelled. Newest first
      // so a legacy order carrying duplicates from before this rule converges on
      // one thread instead of resurrecting the oldest.
      const existing = await this.model
        .findOne({ transactionId, autoSource: 'shipping-issue' })
        .sort({ createdAt: -1 })
        .exec();

      if (existing) {
        const wasSettled = existing.cancelled || DONE_STATUSES.includes(existing.status);

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
            existing.responsibleName = next.name;
            existing.assignSource = next.reason;
          }
          (existing.comments as any[]).push({
            authorId: 'system',
            authorName: 'النظام',
            text: `أُعيد فتح المتابعة — مشكلة جديدة على نفس الطلب: ${triggerLabelForThread}`,
            edited: false,
            kind: 'note',
          });
        } else if (existing.autoTrigger !== trigger) {
          // Still open, new trigger (FAILED_ATTEMPT → RETURNED): record the
          // escalation on the thread rather than opening a second ticket.
          (existing.comments as any[]).push({
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
        await existing.save();
        this.presence.emitEvent('followup:changed', { action: 'update', id: String(existing._id) });
        if (wasSettled && existing.responsibleId) {
          await this.notifyAssignee(
            String(existing.responsibleId),
            existing.responsibleName || '',
            String(existing._id),
            existing.orderRef || '',
            triggerLabelForThread,
            true,
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
      const triggerLabel = TRIGGER_LABELS[trigger] || trigger;

      const doc = await this.model.create({
        ticketNo,
        orderRef,
        transactionId,
        shopifyOrderId: tx.shopifyOrderId || '',
        clientName: tx.client || '',
        clientPhone: tx.phone || '',
        responsibleId: assignee?.userId || '',
        responsibleName: assignee?.name || '',
        reason: SHIPPING_ISSUE_REASON,
        status: SHIPPING_ISSUE_STATUS,
        autoSource: 'shipping-issue',
        autoTrigger: trigger,
        assignSource: assignee?.reason || 'unassigned',
        notified: true,
        comments: [
          {
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
        await this.notifyAssignee(assignee.userId, assignee.name, String(doc._id), orderRef, triggerLabel, false);
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
  ): Promise<void> {
    const notifyText = reopened
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
        reason: SHIPPING_ISSUE_REASON,
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
      const doc = await this.model
        .findOne({ transactionId: String(transactionId), autoSource: 'shipping-issue' })
        .sort({ createdAt: -1 })
        .exec();
      if (!doc) return;
      if (doc.cancelled || DONE_STATUSES.includes(doc.status)) return;

      doc.status = 'تم حل المشكلة';
      doc.resolution = outcomeLabel;
      doc.escalationBaseline = new Date();
      doc.escalationLevel = 0;
      (doc.comments as any[]).push({
        authorId: 'system',
        authorName: 'النظام',
        text: `أُغلقت المشكلة: ${outcomeLabel}${by ? ` — بواسطة ${by}` : ''}`,
        edited: false,
        kind: 'note',
      });
      await doc.save();
      this.presence.emitEvent('followup:changed', { action: 'update', id: String(doc._id) });
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

  async create(dto: CreateFollowUpDto) {
    const ticketNo = await this.generateTicketNo(dto.orderRef);
    return this.model.create({ ...dto, ticketNo });
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
      if (!missing.length) return;
      for (const f of missing as any[]) {
        const when = f.createdAt ? new Date(f.createdAt) : new Date();
        const ticketNo = await this.generateTicketNo(f.orderRef, when);
        await this.model.updateOne({ _id: f._id }, { ticketNo }).exec();
      }
      this.logger.log(`Backfilled ticketNo on ${missing.length} follow-up(s)`);
    } catch (err: any) {
      this.logger.error(`ticketNo backfill failed: ${err.message}`);
    }
  }

  async update(id: string, dto: UpdateFollowUpDto) {
    const existing = await this.model.findById(id).lean();
    const patch: Record<string, unknown> = { ...dto };
    const statusChanged = dto.status !== undefined && existing && dto.status !== existing.status;
    const reasonChanged = dto.reason !== undefined && existing && dto.reason !== existing.reason;
    if (statusChanged || reasonChanged) {
      patch.escalationBaseline = new Date();
      patch.escalationLevel = 0;
    }
    return this.model.findByIdAndUpdate(id, patch, { new: true }).lean();
  }

  markNotified(id: string) {
    return this.model.findByIdAndUpdate(id, { notified: true }, { new: true }).lean();
  }

  remove(id: string) {
    return this.model.findByIdAndDelete(id);
  }

  cancel(id: string, cancelReason: string, userId: string, userName: string) {
    return this.model
      .findByIdAndUpdate(
        id,
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

  async addComment(id: string, authorId: string, authorName: string, text: string) {
    const before = await this.model.findById(id).lean();
    if (!before) return null;
    const doc = await this.model
      .findByIdAndUpdate(
        id,
        { $push: { comments: { authorId, authorName, text, edited: false } } },
        { new: true },
      )
      .lean();
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
    const existingAttempts = ((before.comments as any[]) || []).filter((c) => c.kind === 'call').length;
    if (existingAttempts >= 3) throw new Error('CALL_LIMIT_REACHED');
    const attemptNo = existingAttempts + 1;
    const outcomeLabel = outcome === 'answered' ? 'تم الرد' : 'لم يتم الرد';
    const text = `محاولة اتصال رقم ${attemptNo} بالعميل — ${outcomeLabel}`;
    const doc = await this.model
      .findByIdAndUpdate(
        id,
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
  @Cron('0 */15 * * * *')
  async scheduledEscalationScan(): Promise<void> {
    try {
      const open = await this.model.find({ status: { $nin: DONE_STATUSES }, cancelled: { $ne: true } }).lean();
      const now = Date.now();
      for (const f of open as any[]) {
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
