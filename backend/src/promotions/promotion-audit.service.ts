import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';

/**
 * سجل مراجعة العروض والخصومات (Nov 12, 2026).
 *
 * كان `_bundleDiscAuditLog` مصفوفة في ذاكرة المتصفح: بتتمسح مع أي تحديث للصفحة، وكل جهاز
 * شايف محاولاته هو بس — فالمدير ماكانش بيشوف أي حاجة عملها موظف. دلوقتي كل حدث بيتسجل هنا.
 *
 * نوعين من الأحداث:
 * - **استخدام** (kind = bundle | code): بيبعتها فورم البيع — تطبيق/إزالة/رفض/موافقة/انتظار موافقة.
 * - **إدارة** (kind = code | bundle | offer | tag): بيسجلها السيرفر نفسه بعد كل تعديل ناجح.
 * ⚠ اسم الموظف والوقت بيتحددوا هنا من التوكن، مش من جسم الطلب.
 */
export const USAGE_ACTIONS = ['applied', 'removed', 'denied', 'approved', 'pending_approval'] as const;
export const MANAGE_ACTIONS = ['created', 'updated', 'enabled', 'disabled', 'deleted', 'started', 'stopped', 'cancelled', 'cleared'] as const;
export const AUDIT_KINDS = ['bundle', 'code', 'offer', 'tag', 'log'] as const;
const MAX_ROWS = 5000;

export type AuditActor = { userId?: string; name?: string; username?: string } | undefined;
export type AuditEntry = {
  kind: (typeof AUDIT_KINDS)[number];
  action: string;
  ref?: string;
  label?: string;
  amount?: number;
  reason?: string;
  txRef?: string;
};

// Control and bidi-override characters would let a typed reason reorder the row it sits in.
const STRIP = /[\u0000-\u001f‪-‮⁦-⁩]/g;
const clip = (v: unknown, n: number) => String(v ?? '').replace(STRIP, ' ').trim().slice(0, n);

@Injectable()
export class PromotionAuditService {
  private readonly logger = new Logger(PromotionAuditService.name);
  private indexed = false;
  constructor(@InjectConnection() private readonly connection: Connection) {}

  private get col() { return this.connection.collection('promotionauditlogs'); }

  private async ensureIndex() {
    if (this.indexed) return;
    this.indexed = true;
    try { await this.col.createIndex({ at: -1 }); } catch { /* listing still works without it */ }
  }

  private doc(actor: AuditActor, e: AuditEntry) {
    const amount = Math.round((Number(e.amount) || 0) * 100) / 100;
    return {
      at: new Date(),
      employee: clip(actor?.name || actor?.username || 'غير معروف', 80),
      employeeId: clip(actor?.userId, 40),
      kind: e.kind,
      action: e.action,
      ref: clip(e.ref, 80),
      label: clip(e.label, 160),
      amount: amount > 0 ? amount : 0,
      reason: clip(e.reason, 300),
      txRef: clip(e.txRef, 40),
    };
  }

  /** حدث استخدام من فورم البيع — بيتحقق من القيم لأنها جاية من العميل. */
  async recordUsage(actor: AuditActor, body: any) {
    const action = String(body?.action || '');
    const kind = String(body?.kind || 'bundle');
    if (!(USAGE_ACTIONS as readonly string[]).includes(action)) throw new BadRequestException('نوع الحدث غير معروف');
    if (kind !== 'bundle' && kind !== 'code') throw new BadRequestException('نوع السجل غير معروف');
    await this.ensureIndex();
    const label = [body?.code, body?.bundleName].map((v) => clip(v, 80)).filter(Boolean).join(' / ');
    await this.col.insertOne(this.doc(actor, {
      kind: kind as 'bundle' | 'code', action, ref: clip(body?.bundleId || body?.code, 80), label,
      amount: Number(body?.amount) || 0, reason: body?.reason, txRef: body?.txRef,
    }));
    return { success: true };
  }

  /** حدث إدارة يسجله السيرفر. ⚠ مابيرميش أبدًا: التعديل نفسه اتحفظ، والسجل مش لازم يفشّله. */
  async recordManage(actor: AuditActor, e: AuditEntry) {
    try {
      await this.ensureIndex();
      await this.col.insertOne(this.doc(actor, e));
    } catch (err: any) {
      this.logger.warn(`promotion audit write failed: ${err?.message || err}`);
    }
  }

  async list(q: { limit?: unknown; kind?: unknown; action?: unknown; from?: unknown; to?: unknown }) {
    const limit = Math.min(Math.max(Number(q?.limit) || 500, 1), 2000);
    const filter: Record<string, any> = {};
    if (q?.kind && (AUDIT_KINDS as readonly string[]).includes(String(q.kind))) filter.kind = String(q.kind);
    if (q?.action) filter.action = String(q.action).slice(0, 40);
    const day = /^\d{4}-\d{2}-\d{2}$/;
    const range: Record<string, Date> = {};
    // Cairo days (UTC+2/+3); a few hours of slack at the edges is fine for an audit filter.
    if (day.test(String(q?.from || ''))) range.$gte = new Date(String(q.from) + 'T00:00:00.000+03:00');
    if (day.test(String(q?.to || ''))) range.$lte = new Date(String(q.to) + 'T23:59:59.999+02:00');
    if (Object.keys(range).length) filter.at = range;
    const [rows, total] = await Promise.all([
      this.col.find(filter).sort({ at: -1 }).limit(limit).toArray(),
      this.col.countDocuments(filter),
    ]);
    return { rows: rows.map(({ _id, ...r }) => ({ id: String(_id), ...r })), total, truncated: total > rows.length };
  }

  /** مسح السجل — أدمن فقط (الكنترولر). بيسيب سطر يقول مين مسح وإمتى. */
  async clear(actor: AuditActor) {
    const res = await this.col.deleteMany({});
    await this.recordManage(actor, { kind: 'log', action: 'cleared', label: 'سجل المراجعة', reason: String(res.deletedCount) });
    return { success: true, deleted: res.deletedCount };
  }

  /** حدّ أقصى للحجم: أقدم الصفوف بتتشال لما السجل يعدّي MAX_ROWS. */
  async trim() {
    try {
      const n = await this.col.estimatedDocumentCount();
      if (n <= MAX_ROWS) return;
      const cut = await this.col.find({}).sort({ at: -1 }).skip(MAX_ROWS).limit(1).toArray();
      if (cut[0]) await this.col.deleteMany({ at: { $lte: cut[0].at } });
    } catch { /* housekeeping only */ }
  }
}
