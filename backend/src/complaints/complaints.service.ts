import { Injectable, NotFoundException, BadRequestException, ConflictException, ForbiddenException, Optional, Logger, ServiceUnavailableException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { randomBytes, randomUUID, createHash } from 'crypto';
import { SettingsService } from '../settings/settings.service';
import { r2PutObject, r2GetObjectBuffer, r2DeleteObject } from '../shared/r2-uploader.util';
import { complaintEvidenceKey, compressComplaintEvidence, COMPLAINT_EVIDENCE_PREFIX } from './complaint-evidence.util';
import { Cron } from '@nestjs/schedule';
import { NotificationsService } from '../notifications/notifications.service';
import { VaultService } from '../vault/vault.service';
import { normalizeVaultAccountLabel } from '../returns/returns.constants';
import { complaintFlow, complaintView, executionEvidence, assertCaseCoverage, workflowEvent, OUTCOMES, SOLUTIONS } from './complaint-workflow';
import { ComplaintWorkflowDto } from './dto/complaint.dto';
import { Complaint, ComplaintDocument } from './schemas/complaint.schema';
import { DEFAULT_COMPLAINT_MESSAGES, MESSAGE_TOKENS, validateComplaintMessages, renderComplaintMessage } from './complaint-messages';
import {
  CreateComplaintDto,
  UpdateComplaintDto,
  ResolveComplaintDto,
  SurveyResponseDto,
  CreateNoteDto,
  UpdateNoteDto,
} from './dto/complaint.dto';

@Injectable()
export class ComplaintsService {
  private readonly logger = new Logger(ComplaintsService.name);
  constructor(
    @InjectModel(Complaint.name)
    private readonly complaintModel: Model<ComplaintDocument>,
    @Optional() private readonly vault?: VaultService,
    @Optional() private readonly notifications?: NotificationsService,
    @Optional() private readonly settings?: SettingsService,
  ) {}

  async messageTemplates() {
    const saved = await this.complaintModel.db.collection('complaintmessageconfigs').findOne({ _id: 'templates' as any });
    return { templates: saved?.templates || DEFAULT_COMPLAINT_MESSAGES, revision: saved?.revision || 0, tokens: MESSAGE_TOKENS };
  }

  async saveMessageTemplates(body: any, actor: any) {
    if (actor.role !== 'admin') throw new ForbiddenException('تعديل قوالب الرسائل للأدمن فقط');
    if (!Number.isSafeInteger(body?.revision) || body.revision < 0) throw new BadRequestException('إصدار القوالب غير صالح');
    const templates = validateComplaintMessages(body.templates);
    const collection = this.complaintModel.db.collection('complaintmessageconfigs');
    try {
      const result = await collection.updateOne({ _id: 'templates' as any, revision: body.revision }, {
        $set: { templates, updatedAt: new Date(), updatedBy: actor.userId }, $inc: { revision: 1 },
      }, { upsert: body.revision === 0 });
      if (!result.matchedCount && !result.upsertedCount) throw new ConflictException('تغيرت القوالب؛ افتح المحرر مجددًا قبل الحفظ');
    } catch (e) {
      if (e.code === 11000) throw new ConflictException('تغيرت القوالب؛ افتح المحرر مجددًا قبل الحفظ');
      throw e;
    }
    return this.messageTemplates();
  }

  async customerMessage(id: string, language: string, event?: string) {
    const [row, config] = await Promise.all([this.detail(id), this.messageTemplates()]);
    return this.renderCustomerMessage(row, config, language, event);
  }

  async workspace(id: string, language: string, event?: string) {
    const [row, config] = await Promise.all([this.detail(id), this.messageTemplates()]);
    return { ...row, customerMessage: this.renderCustomerMessage(row, config, language, event) };
  }

  private renderCustomerMessage(row: any, config: any, language: string, event?: string) {
    const w = row.workflow, en = language === 'en', lang = en ? 'en' : 'ar';
    const successful = ['resolved','partial_agreement'].includes(w.outcome);
    const kind = w.stage === 'closed' ? successful ? 'resolved' : 'closed' : row.execution.ready ? 'confirmation' : event === 'registered' && w.stage === 'review' && w.cycle === 1 ? 'registered' : 'update';
    const labels: any = en ? { exchange:'Exchange',return:'Return and refund',support:'Customer support',delivery:'Delivery issue addressed',compensation:'Compensation',refund_without_return:'Refund without return',partial_agreement:'Agreed partial resolution',rejected:'Request declined',withdrawn:'Withdrawn by customer',duplicate:'Linked to the primary complaint',unreachable:'Unable to reach customer' } : { exchange:'استبدال',return:'استرجاع ورد المستحق',support:'حل بالدعم والتوضيح',delivery:'معالجة مشكلة التوصيل',compensation:'تعويض مالي',refund_without_return:'رد مبلغ دون استلام منتج',partial_agreement:'حل جزئي متفق عليه',rejected:'رفض الطلب',withdrawn:'سحب الشكوى بطلب العميل',duplicate:'متابعة المشكلة ضمن الشكوى الأساسية',unreachable:'تعذر التواصل' };
    const values = { customerName: row.clientName || (en ? 'valued customer' : 'عميلنا العزيز'), complaintNo: row.complaintNo,
      invoiceRef: row.transactionRef ? '#'+row.transactionRef : (en ? 'not linked' : 'غير مرتبطة'),
      resolution: labels[w.outcome === 'partial_agreement' || !successful && w.stage === 'closed' ? w.outcome : w.solution] || (en ? 'Customer care follow-up' : 'متابعة خدمة العملاء'),
      customerMessage: w.stage === 'closed' ? w.customerMessage || '' : '' };
    return { kind, language: lang, text: renderComplaintMessage(config.templates[kind][lang], values), templateRevision: config.revision };
  }

  async findAll(): Promise<any[]> {
    const rows = await this.complaintModel.find().select('-notes -workflow.history -workflow.cycles -workflow.operations -workflow.executionEvents -createKey -createFingerprint').sort({ createdAt: -1 }).lean();
    const ids = [...new Set(rows.map(r => r.workflow?.caseId).filter(id => Types.ObjectId.isValid(id)))];
    const cases = ids.length ? await this.complaintModel.db.collection('returnrequests').find({ _id: { $in: ids.map(id => new Types.ObjectId(id)) } }).toArray() : [];
    const byId = new Map(cases.map(c => [String(c._id), c]));
    return rows.map(row => complaintView(row, byId.get(row.workflow?.caseId)));
  }

  async detail(id: string) {
    const row = await this.complaintModel.findById(this.oid(id)).lean().exec();
    if (!row) throw new NotFoundException('الشكوى غير موجودة');
    const linked = row.workflow?.caseId ? await this.complaintModel.db.collection('returnrequests').findOne({ _id: this.oid(row.workflow.caseId) }) : null;
    return complaintView(row, linked);
  }

  @Cron('0 */15 * * * *')
  async remindOverdue() {
    if (!this.notifications) return;
    const rows = await this.complaintModel.find({ 'workflow.version':2,'workflow.stage':{$ne:'closed'},
      'workflow.dueAt':{$lte:new Date().toISOString()}, $expr:{$ne:[{$ifNull:['$workflow.remindedFor','']},'$workflow.dueAt']} }).limit(250).lean();
    for (const row of rows) {
      const w=row.workflow;
      if (!w.ownerId) continue;
      await this.notifications.enqueue('followup',`complaint-due:${row._id}:${w.cycle}:${w.dueAt}`,row.complaintNo,`complaint:${row._id}`,w.ownerId,undefined,
        { actionKey:'followup-due',followupAt:w.dueAt,followupReason:w.waitingFor==='carrier'?'carrier_delay':'awaiting_customer' });
      await this.complaintModel.updateOne({_id:row._id,'workflow.dueAt':w.dueAt},{$set:{'workflow.remindedFor':w.dueAt}});
    }
  }

  async findById(id: string): Promise<ComplaintDocument> {
    const complaint = await this.complaintModel.findById(id).exec();
    if (!complaint) throw new NotFoundException('الشكوى غير موجودة');
    return complaint;
  }

  async findBySurveyToken(token: string): Promise<ComplaintDocument> {
    const complaint = await this.complaintModel
      .findOne({ $or: [{ surveySlug: token }, { surveyToken: token }] })
      .exec();
    if (!complaint || complaint.workflow?.version !== 2 || complaint.workflow.stage !== 'closed' || !['resolved','partial_agreement'].includes(complaint.workflow.outcome)) throw new NotFoundException('رابط الاستبيان غير صالح');
    return complaint;
  }

  async publicSurvey(token: string) {
    const c = await this.findBySurveyToken(token);
    return { complaintNo: c.complaintNo, clientName: c.clientName?.split(' ')[0] || '', status: c.status,
      managerAction: c.managerAction, actionNote: c.workflow.customerMessage || '', surveyCompletedAt: c.surveyCompletedAt };
  }

  /** Short, random, unguessable slug for the customer-facing survey link — doesn't reveal the internal domain structure. */
  private async generateSurveySlug(): Promise<string> {
    const alphabet = 'abcdefghijkmnpqrstuvwxyzACDEFGHJKLMNPQRTUVWXY34679'; // no ambiguous 0/O/1/l/I
    for (let attempt = 0; attempt < 5; attempt++) {
      const bytes = randomBytes(9);
      let slug = '';
      for (let i = 0; i < 9; i++) slug += alphabet[bytes[i] % alphabet.length];
      const exists = await this.complaintModel.exists({ surveySlug: slug });
      if (!exists) return slug;
    }
    throw new Error('تعذّر إنشاء رابط الاستبيان');
  }

  private async generateComplaintNo(transactionRef?: string): Promise<string> {
    const ref = (transactionRef || '').replace(/^#+/, '').trim();
    if (ref) {
      // رقم مرتبط بأوردر: CMP-YYMMDD-REF (مع لاحقة -2, -3.. لو تكررت الشكوى لنفس الأوردر في نفس اليوم)
      const now = new Date();
      const yy = String(now.getFullYear()).slice(-2);
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      const dd = String(now.getDate()).padStart(2, '0');
      const base = `CMP-${yy}${mm}${dd}-${ref}`;
      const existing = await this.complaintModel
        .find({ complaintNo: { $regex: `^${base}(-\\d+)?$` } })
        .select('complaintNo')
        .lean()
        .exec();
      if (!existing.length) return base;
      let maxSuffix = 1;
      for (const e of existing) {
        const m = e.complaintNo.match(/-(\d+)$/);
        const n = m && e.complaintNo !== base ? parseInt(m[1], 10) : 1;
        if (n > maxSuffix) maxSuffix = n;
      }
      return `${base}-${maxSuffix + 1}`;
    }

    // بدون أوردر مرتبط: الترقيم التسلسلي القديم
    const year = new Date().getFullYear();
    const prefix = `CMP-${year}-`;
    const last = await this.complaintModel
      .findOne({ complaintNo: { $regex: `^${prefix}\\d+$` } })
      .sort({ complaintNo: -1 })
      .exec();
    let seq = 1;
    if (last) {
      const parts = last.complaintNo.split('-');
      seq = (parseInt(parts[parts.length - 1], 10) || 0) + 1;
    }
    return `${prefix}${String(seq).padStart(4, '0')}`;
  }

  async create(
    dto: CreateComplaintDto,
    submittedBy: string,
    submittedById: string,
  ): Promise<ComplaintDocument> {
    const createKey = dto.operationKey || randomUUID();
    const fingerprint = createHash('sha256').update(JSON.stringify(dto)).digest('hex');
    const previous = await this.complaintModel.findOne({ submittedById, createKey });
    if (previous) {
      if (previous.createFingerprint !== fingerprint) throw new ConflictException('مفتاح الحفظ مستخدم لشكوى مختلفة');
      return previous;
    }
    const data: any = { ...dto };
    delete data.operationKey;
    delete data.ownerId;
    let ownerId = submittedById, ownerName = submittedBy;
    if (dto.ownerId && dto.ownerId !== submittedById) {
      const operator = await this.complaintModel.db.collection('users').findOne({ _id:this.oid(submittedById) });
      if (operator?.role !== 'admin') throw new ForbiddenException('تحويل الشكوى لموظف آخر يحتاج صلاحية المسؤول');
      const owner = await this.complaintModel.db.collection('users').findOne({ _id:this.oid(dto.ownerId), active:{$ne:false},isActive:{$ne:false} });
      if (!owner || owner.role !== 'admin' && !(owner.perms || []).some((p:string)=>['complaints','transaction'].includes(p))) throw new BadRequestException('الموظف غير مؤهل لاستلام الشكوى');
      ownerId = dto.ownerId; ownerName = owner.name || owner.username;
    }
    if (data.transactionId) {
      const tx = await this.complaintModel.db.collection('transactions').findOne({ _id: this.oid(data.transactionId), type: 'مبيعات' });
      if (!tx) throw new BadRequestException('فاتورة المبيعات غير موجودة');
      data.transactionRef = tx.ref; data.clientName = tx.client || data.clientName; data.phone = tx.phone || data.phone;
      data.items = this.validateItems(dto.items || [], tx);
      if (data.items.length) Object.assign(data, { productCode: data.items[0].code, productName: data.items.map((i: any) => i.name).join('، '), productQty: data.items.reduce((n: number, i: any) => n + i.qty, 0) });
    } else if (!data.clientName?.trim() || !data.phone?.trim()) throw new BadRequestException('أدخل اسم العميل ورقم التواصل للشكوى بدون فاتورة');
    if (!data.phone?.trim()) throw new BadRequestException('أدخل رقم التواصل مع العميل');
    if (!data.description?.trim()) throw new BadRequestException('اكتب وصف المشكلة');
    const complaintNo = await this.generateComplaintNo(data.transactionRef);
    const now = new Date().toISOString();
    const imageMeta = dto.imageUrl
      ? { imageAddedBy: submittedBy, imageAddedAt: now }
      : {};
    try { return await this.complaintModel.create({
      ...data,
      ...imageMeta,
      complaintNo,
      submittedBy,
      submittedById,
      status: 'معلق',
      createKey, createFingerprint: fingerprint,
      workflow: { version: 2, revision: 0, cycle: 1, stage: 'review', solution: '', ownerId, owner: ownerName,
        dueAt: new Date(Date.now() + 24 * 3600000).toISOString(), history: [], operations: [] },
      notes: [
        {
          id: randomUUID(),
          text: 'تم إنشاء الشكوى',
          author: submittedBy,
          authorId: submittedById,
          createdAt: now,
          updatedAt: now,
          kind: 'system',
        },
      ],
    }); } catch (error: any) {
      if (error.code !== 11000) throw error;
      const existing = await this.complaintModel.findOne({ submittedById, createKey });
      if (existing?.createFingerprint === fingerprint) return existing;
      if (existing) throw new ConflictException('مفتاح الحفظ مستخدم لشكوى مختلفة');
      // Another complaint consumed the same human-readable number; retry allocation.
      return this.create(dto, submittedBy, submittedById);
    }
  }

  /**
   * Admin edit of complaint fields. Only keys present in the DTO are written, so a
   * partial payload never blanks out the rest. Each change is appended to the notes
   * timeline as a system entry, keeping the same audit trail as resolve/progress-stage.
   */
  async update(
    id: string,
    dto: UpdateComplaintDto,
    author: string,
  ): Promise<ComplaintDocument> {
    const complaint = await this.findById(id);
    if (complaint.workflow?.stage === 'closed') throw new ConflictException('أعد فتح الشكوى قبل تعديل بياناتها');
    const labels: Record<string, string> = {
      clientName: 'اسم العميل',
      phone: 'الهاتف',
      variantDetail: 'اللون/المقاس',
      categoryGroup: 'مجموعة السبب',
      category: 'السبب',
      imageUrl: 'صورة المشكلة',
      description: 'وصف الشكوى',
      priority: 'الأولوية',
    };
    const changes: string[] = [];
    for (const key of Object.keys(labels)) {
      if (!(key in dto)) continue;
      const next = ((dto as Record<string, string>)[key] ?? '').trim();
      const prev = ((complaint as unknown as Record<string, string>)[key] || '')
        .toString()
        .trim();
      if (next === prev) continue;
      (complaint as unknown as Record<string, string>)[key] = next;
      changes.push(
        key === 'description' || key === 'imageUrl'
          ? `تم تعديل ${labels[key]}`
          : `${labels[key]}: ${prev || '—'} → ${next || '—'}`,
      );
    }
    if (!changes.length) return complaint;
    if ('imageUrl' in dto && complaint.imageUrl && !complaint.imageAddedBy) {
      complaint.imageAddedBy = author;
      complaint.imageAddedAt = new Date().toISOString();
    }
    const now = new Date().toISOString();
    complaint.notes.push({
      id: randomUUID(),
      text: `تم تعديل الشكوى — ${changes.join(' • ')}`,
      author,
      authorId: '',
      createdAt: now,
      updatedAt: now,
      kind: 'system',
    });
    return complaint.save();
  }

  async resolve(
    id: string,
    dto: ResolveComplaintDto,
    resolvedBy: string,
  ): Promise<ComplaintDocument> {
    throw new BadRequestException('استخدم مسار الحل الجديد لربط التنفيذ وتوثيق الإغلاق');

  }

  async submitSurvey(
    token: string,
    dto: SurveyResponseDto,
  ): Promise<any> {
    const complaint = await this.findBySurveyToken(token);
    if (complaint.surveyCompletedAt) {
      throw new BadRequestException('تم تعبئة الاستبيان مسبقاً');
    }
    complaint.surveyRating = dto.rating;
    complaint.surveyComment = dto.comment || '';
    complaint.surveyCompletedAt = new Date().toISOString();
    if (dto.rating <= 2) {
      complaint.workflow.reviewRequired = true;
      workflowEvent(complaint.workflow, 'negative_rating', { name: 'العميل' }, 'تقييم منخفض يحتاج مراجعة المسؤول');
      complaint.markModified('workflow');
    }
    await complaint.save();
    return { success: true, surveyCompletedAt: complaint.surveyCompletedAt };
  }

  async remove(id: string, actor: any): Promise<void> {
    // The application's manager role is stored as "admin". Check the current
    // account as well as the authenticated role, including for direct callers.
    if (actor?.role !== 'admin') throw new ForbiddenException('الحذف النهائي متاح للمدير والأدمن فقط');
    const connection = this.complaintModel.db;
    const operator = await connection.collection('users').findOne({_id:this.oid(actor.userId),role:'admin',active:{$ne:false},isActive:{$ne:false}});
    if (!operator) throw new ForbiddenException('الحذف النهائي متاح للمدير والأدمن النشط فقط');
    const objectId = this.oid(id), complaintId = String(objectId), evidence = connection.collection('complaintevidence');
    const session = await connection.startSession();
    try {
      // Freeze additions and legacy migration before listing the objects to delete.
      // Keep their references if R2 fails, so the same DELETE can finish on retry.
      await session.withTransaction(async()=>{
        const row = await this.complaintModel.findById(objectId).session(session);
        if (row) await this.complaintModel.updateOne({_id:objectId},{$set:{workflow:{...complaintFlow(row),deletingAt:new Date().toISOString()}},$inc:{__v:1}},{session});
        await evidence.updateMany({complaintId},{$set:{deleting:true}},{session});
      });
      const images = await evidence.find({complaintId}).toArray();
      const cloudImages = images.filter(image=>image.imageKey);
      if (cloudImages.some(image=>typeof image.imageKey !== 'string' || !image.imageKey.startsWith(COMPLAINT_EVIDENCE_PREFIX))) throw new BadRequestException('مسار صورة الشكوى غير صالح');
      if (cloudImages.length) {
        const cfg = await this.evidenceR2();
        for (const image of cloudImages) {
          const result = await r2DeleteObject(cfg,image.imageKey);
          if (!result.ok) throw new ServiceUnavailableException('تعذّر حذف صور المشكلة من Cloudflare؛ أعد محاولة الحذف النهائي');
        }
      }
      await session.withTransaction(async()=>{
        // Keep execution and financial records; remove only their navigable case link.
        await connection.collection('returnrequests').updateMany({'workflow.complaintIds':complaintId},{$pull:{'workflow.complaintIds':complaintId} as any,$inc:{__v:1}},{session});
        await this.complaintModel.updateMany({'workflow.duplicateId':complaintId},{$unset:{'workflow.duplicateId':''},$inc:{__v:1}},{session});
        await evidence.deleteMany({complaintId},{session});
        await this.complaintModel.deleteOne({_id:objectId},{session});
      });
    } finally { await session.endSession(); }
  }

  async countComplaints(): Promise<number> {
    return this.complaintModel.countDocuments().exec();
  }

  async updateProgressStage(
    id: string,
    progressStage: string,
    author?: string,
  ): Promise<ComplaintDocument> {
    throw new BadRequestException('اختر الإجراء التالي من ملف الشكوى؛ الحالة تتبع التنفيذ الفعلي');

  }

  async addNote(
    id: string,
    dto: CreateNoteDto,
    author: string,
    authorId: string,
  ): Promise<ComplaintDocument> {
    const complaint = await this.findById(id);
    const now = new Date().toISOString();
    complaint.notes.push({
      id: randomUUID(),
      text: dto.text.trim(),
      author,
      authorId,
      createdAt: now,
      updatedAt: now,
      kind: 'note',
    });
    return complaint.save();
  }

  async updateNote(
    id: string,
    noteId: string,
    dto: UpdateNoteDto,
    userId: string,
    isAdmin: boolean,
  ): Promise<ComplaintDocument> {
    const complaint = await this.findById(id);
    const note = complaint.notes.find((n) => n.id === noteId);
    if (!note) throw new NotFoundException('الملاحظة غير موجودة');
    if (note.kind === 'system') throw new BadRequestException('سجل النظام لا يقبل التعديل؛ أضف ملاحظة تصحيح');
    if (!isAdmin && note.authorId !== userId) {
      throw new BadRequestException('لا يمكنك تعديل ملاحظة موظف آخر');
    }
    note.text = dto.text.trim();
    note.updatedAt = new Date().toISOString();
    return complaint.save();
  }

  async removeNote(
    id: string,
    noteId: string,
    userId: string,
    isAdmin: boolean,
  ): Promise<ComplaintDocument> {
    const complaint = await this.findById(id);
    const note = complaint.notes.find((n) => n.id === noteId);
    if (!note) throw new NotFoundException('الملاحظة غير موجودة');
    if (note.kind === 'system') throw new BadRequestException('لا يمكن حذف سجل النظام');
    if (!isAdmin && note.authorId !== userId) {
      throw new BadRequestException('لا يمكنك حذف ملاحظة موظف آخر');
    }
    complaint.notes = complaint.notes.filter((n) => n.id !== noteId);
    return complaint.save();
  }

  private oid(value: string) {
    if (!/^[a-f\d]{24}$/i.test(value || '')) throw new BadRequestException('معرّف السجل غير صالح');
    return new Types.ObjectId(value);
  }
  async uploadEvidence(id: string, file: { buffer: Buffer; originalname: string }, actor: any) {
    if (!file?.buffer?.length || file.buffer.length > 5 * 1024 * 1024) throw new BadRequestException('اختر صورة بحد أقصى 5 ميجابايت');
    const initial = await this.findById(String(this.oid(id)));
    if (initial.workflow?.deletingAt) throw new ConflictException('جارٍ حذف المشكلة نهائيًا؛ أعد محاولة الحذف لإكماله');
    let buffer: Buffer;
    try {
      buffer = await compressComplaintEvidence(file.buffer);
    } catch { throw new BadRequestException('استخدم صورة JPEG أو PNG أو WebP ثابتة وواضحة يمكن ضغطها إلى 180 كيلوبايت'); }
    const attachmentId = createHash('sha256').update(String(initial._id)).update(buffer).digest('hex');
    if (initial.attachments.some(a=>a.id===attachmentId)) return this.detail(id);
    if (initial.attachments.length >= 10) throw new BadRequestException('الحد الأقصى 10 صور لكل شكوى');
    const stored = await this.storeEvidenceImage(initial, attachmentId, buffer, file.buffer.length);
    let committed = false, linked = false;
    const session = await this.complaintModel.db.startSession().catch(async error=>{await this.deleteUnusedEvidence(stored.imageKey);throw error;});
    try {
      await session.withTransaction(async()=>{
        linked = false;
        const row = await this.complaintModel.findById(this.oid(id)).session(session);
        if (!row) throw new NotFoundException('الشكوى غير موجودة');
        if (row.workflow?.deletingAt) throw new ConflictException('جارٍ حذف المشكلة نهائيًا؛ أعد محاولة الحذف لإكماله');
        if (row.attachments.some(a=>a.id===attachmentId)) return;
        if (row.attachments.length >= 10) throw new BadRequestException('الحد الأقصى 10 صور لكل شكوى');
        const at = new Date().toISOString(), name = String(file.originalname||'image').slice(0,150);
        await this.complaintModel.db.collection('complaintevidence').updateOne({ _id:attachmentId as any }, { $setOnInsert:{ complaintId:String(row._id),...stored,createdAt:new Date() } }, { session,upsert:true });
        row.attachments.push({id:attachmentId,name,at,by:actor.name||actor.username,imageBytes:buffer.length});
        const w=complaintFlow(row);w.revision++;workflowEvent(w,'attachment',actor,name);row.workflow=w;row.markModified('workflow');
        await row.save({session});
        linked = true;
      });
      committed = true;
      if (!linked) await this.deleteUnusedEvidence(stored.imageKey);
      return this.detail(id);
    } catch (error) {
      // Unknown commit outcomes may already reference the uploaded image. Keep that object.
      if (!committed && !error.hasErrorLabel?.('UnknownTransactionCommitResult')) await this.deleteUnusedEvidence(stored.imageKey);
      throw error;
    } finally { await session.endSession(); }
  }

  private async evidenceR2() {
    const cfg = await this.settings?.getR2Config();
    if (!cfg) throw new ServiceUnavailableException('إعدادات Cloudflare R2 غير مكتملة — لا يمكن حفظ صورة الشكوى');
    return cfg;
  }

  private async storeEvidenceImage(row: any, attachmentId: string, buffer: Buffer, originalBytes: number) {
    const cfg = await this.evidenceR2(), imageKey = complaintEvidenceKey(row, attachmentId);
    const result = await r2PutObject(cfg, imageKey, buffer, 'image/jpeg', 30000);
    if (!result.ok) throw new ServiceUnavailableException('تعذّر حفظ صورة الشكوى على التخزين السحابي؛ أعد المحاولة');
    return { imageKey, contentType:'image/jpeg', imageBytes:buffer.length, originalBytes };
  }

  private async deleteUnusedEvidence(imageKey: string) {
    try {
      if (!imageKey.startsWith(COMPLAINT_EVIDENCE_PREFIX)) return;
      if (await this.complaintModel.db.collection('complaintevidence').findOne({imageKey})) return;
      const result = await r2DeleteObject(await this.evidenceR2(), imageKey);
      if (!result.ok) this.logger.warn('Could not remove an unused complaint evidence upload');
    } catch { this.logger.warn('Could not verify or remove an unused complaint evidence upload'); }
  }

  async removeEvidence(id: string, attachmentId: string, actor: any) {
    const row = await this.findById(String(this.oid(id)));
    if (!/^[a-f\d]{64}$/.test(attachmentId) || !row.attachments.some(a=>a.id===attachmentId)) throw new NotFoundException('الصورة غير موجودة');
    const collection = this.complaintModel.db.collection('complaintevidence');
    // Keep a durable reference until R2 confirms deletion. Failed requests can be retried,
    // and legacy-image migration must not create a new cloud object during deletion.
    const image = await collection.findOneAndUpdate(
      {_id:attachmentId as any,complaintId:String(row._id)},
      {$set:{deleting:true}}, {returnDocument:'after'},
    );
    if (!image) throw new NotFoundException('الصورة غير موجودة');
    if (image.imageKey) {
      if (!image.imageKey.startsWith(COMPLAINT_EVIDENCE_PREFIX)) throw new BadRequestException('مسار صورة الشكوى غير صالح');
      const result = await r2DeleteObject(await this.evidenceR2(), image.imageKey);
      if (!result.ok) throw new ServiceUnavailableException('تعذّر حذف الصورة من Cloudflare؛ أعد المحاولة');
    }
    const session = await this.complaintModel.db.startSession();
    try {
      await session.withTransaction(async()=>{
        // Match the exact upload, so a late concurrent delete cannot remove a re-upload.
        const removed = await collection.deleteOne({_id:image._id,complaintId:String(row._id),deleting:true,imageKey:image.imageKey ?? {$exists:false}}, {session});
        if (!removed.deletedCount) return;
        const current = await this.complaintModel.findById(row._id).session(session);
        if (!current) return;
        current.attachments = current.attachments.filter(a=>a.id!==attachmentId);
        const w = complaintFlow(current);w.revision++;workflowEvent(w,'attachment_removed',actor,row.attachments.find(a=>a.id===attachmentId)?.name||'');
        current.workflow=w;current.markModified('workflow');
        await current.save({session});
      });
    } finally { await session.endSession(); }
    return this.detail(id);
  }

  async evidenceImage(id: string, attachmentId: string) {
    const row = await this.findById(id);
    if (row.workflow?.deletingAt) throw new ConflictException('جارٍ حذف المشكلة نهائيًا');
    if (!/^[a-f\d]{64}$/.test(attachmentId) || !row.attachments.some(a=>a.id===attachmentId)) throw new NotFoundException();
    const collection = this.complaintModel.db.collection('complaintevidence');
    let image = await collection.findOne({ _id:attachmentId as any,complaintId:String(row._id) });
    if (!image) throw new NotFoundException();
    if (!image.imageKey && image.data && !image.deleting) {
      // Migrate legacy images when read. Only discard the database bytes after a successful PUT.
      const legacyData = image.data;
      let uploadedKey: string | undefined;
      try {
        const original = Buffer.from(image.data, 'base64'), compressed = await compressComplaintEvidence(original);
        const stored = await this.storeEvidenceImage(row, attachmentId, compressed, original.length);
        uploadedKey = stored.imageKey;
        const moved = await collection.updateOne({_id:image._id,data:image.data,imageKey:{$exists:false},deleting:{$ne:true}},{$set:{...stored,migratedAt:new Date()},$unset:{data:''}});
        if (moved.modifiedCount) return {data:'data:image/jpeg;base64,'+compressed.toString('base64')};
        await this.deleteUnusedEvidence(stored.imageKey);
        image = await collection.findOne({_id:image._id,complaintId:String(row._id)});
      } catch {
        if (uploadedKey) await this.deleteUnusedEvidence(uploadedKey);
        this.logger.warn(`Legacy complaint image migration deferred for ${attachmentId}`);
        return {data:'data:image/webp;base64,'+legacyData};
      }
    }
    if (!image?.imageKey?.startsWith(COMPLAINT_EVIDENCE_PREFIX)) throw new NotFoundException();
    const result = await r2GetObjectBuffer(await this.evidenceR2(), image.imageKey);
    if (!result.ok) throw new ServiceUnavailableException('تعذّر تحميل صورة الشكوى من التخزين السحابي');
    return { data:'data:image/jpeg;base64,'+result.body.toString('base64') };
  }
  private validateItems(items: any[], tx: any) {
    if (!Array.isArray(items) || items.length > 100) throw new BadRequestException('بنود الشكوى غير صالحة');
    const seen = new Set<number>();
    return items.map(item => {
      const index = Number(item.lineIndex), qty = Number(item.qty), source = tx.items?.[index];
      if (!source || !Number.isInteger(index) || seen.has(index) || !Number.isSafeInteger(qty) || qty < 1 || qty > source.qty) throw new BadRequestException('راجع كمية القطع المتضررة وبنود الفاتورة');
      seen.add(index);
      const unitIds = Array.isArray(item.unitIds) ? [...new Set(item.unitIds.map((v: string) => String(this.oid(v))))] : [];
      if (unitIds.length > qty) throw new BadRequestException('عدد هويات القطع يتجاوز الكمية المحددة');
      return { lineIndex: index, lineId: source.lineId, code: source.code, name: source.name, productId: source.productId,
        imageUrl: source.imageUrl, qty, unitIds };
    });
  }

  async workflow(id: string, body: ComplaintWorkflowDto, actor: any) {
    const connection = this.complaintModel.db, session = await connection.startSession();
    let effects: Array<() => any> = [];
    const fingerprint = createHash('sha256').update(JSON.stringify({ ...body, actor: actor.userId })).digest('hex');
    try {
      await session.withTransaction(async () => {
        effects = [];
        const row = await this.complaintModel.findById(this.oid(id)).session(session);
        if (!row) throw new NotFoundException('الشكوى غير موجودة');
        const w = complaintFlow(row), previous = w.operations?.find((o: any) => o.key === body.operationKey);
        if (w.deletingAt) throw new ConflictException('جارٍ حذف المشكلة نهائيًا؛ أعد محاولة الحذف لإكماله');
        if (previous) {
          if (previous.fingerprint !== fingerprint) throw new ConflictException('مفتاح الإجراء مستخدم لبيانات مختلفة');
          return;
        }
        if (!body.operationKey || body.expectedRevision !== w.revision) throw new ConflictException('تغير ملف الشكوى؛ حدّث البيانات قبل تنفيذ الإجراء');
        const operator = await connection.collection('users').findOne({ _id: this.oid(actor.userId), active: { $ne: false }, isActive: { $ne: false } }, { session });
        if (!operator) throw new ForbiddenException('المستخدم غير نشط');
        actor = { ...actor, name: operator.name || operator.username };
        const adminActions = ['plan','link','unlink','payment','close','reopen','archive'];
        if (adminActions.includes(body.action) && actor.role !== 'admin') throw new ForbiddenException('هذا الإجراء يحتاج اعتماد المسؤول');
        if (w.stage === 'closed' && !['reopen','archive','contact','comment'].includes(body.action)) throw new ConflictException('أعد فتح الشكوى قبل تعديل الحل');
        const note = String(body.note || '').trim();
        if (!note && body.action === 'close') throw new BadRequestException('اكتب سبب الإغلاق');
        if (!note && body.action === 'comment') throw new BadRequestException('اكتب نص الملاحظة');
        const now = new Date().toISOString();
        let linked: any = w.caseId ? await connection.collection('returnrequests').findOne({ _id: this.oid(w.caseId) }, { session }) : null;
        const evidence = executionEvidence({ ...row.toObject(), workflow: w }, linked);
        const setDeadline = () => {
          if (!body.dueAt || !Number.isFinite(Date.parse(body.dueAt)) || Date.parse(body.dueAt) <= Date.now()) throw new BadRequestException('حدد موعد متابعة قادمًا');
          w.dueAt = new Date(body.dueAt).toISOString();
        };
        switch (body.action) {
          case 'comment': break;
          case 'assign': {
            const owner = await connection.collection('users').findOne({ _id: this.oid(body.ownerId || actor.userId), active: { $ne: false }, isActive: { $ne: false } }, { session });
            if (!owner || owner.role !== 'admin' && !(owner.perms || []).some((p: string) => ['complaints','transaction'].includes(p))) throw new BadRequestException('اختر موظفًا نشطًا لديه صلاحية خدمة العملاء');
            if (actor.role !== 'admin' && String(owner._id) !== actor.userId) throw new ForbiddenException('يمكنك استلام الشكوى لنفسك؛ التحويل لموظف آخر للمسؤول');
            w.ownerId = String(owner._id); w.owner = owner.name || owner.username; setDeadline(); break;
          }
          case 'review': if (w.caseId) throw new ConflictException('يوجد تنفيذ مرتبط؛ افتح الطلب لمعالجة التعثر'); w.stage = 'review'; break;
          case 'wait':
            if (!body.waitingFor) throw new BadRequestException('حدد جهة الانتظار');
            w.stage = 'waiting'; w.waitingFor = body.waitingFor; w.waitReason = note; setDeadline(); break;
          case 'resume': w.stage = evidence.ready ? 'confirmation' : w.caseId ? evidence.stage : w.solution ? 'planned' : 'review'; delete w.waitingFor; delete w.waitReason; setDeadline(); break;
          case 'items': {
            if (w.caseId || w.fulfillment || w.payment) throw new ConflictException('لا تعدّل البنود بعد بدء التنفيذ');
            const tx = await connection.collection('transactions').findOne({ _id: this.oid(body.transactionId || row.transactionId) }, { session });
            if (!tx || tx.type !== 'مبيعات') throw new BadRequestException('اختر فاتورة مبيعات');
            if (row.transactionId && row.transactionId !== String(tx._id)) throw new ConflictException('لا يمكن نقل الشكوى إلى فاتورة أخرى');
            if (row.phone && tx.phone && row.phone.replace(/\D/g,'').slice(-10) !== String(tx.phone).replace(/\D/g,'').slice(-10)) throw new BadRequestException('رقم العميل لا يطابق الفاتورة');
            row.transactionId = String(tx._id); row.transactionRef = tx.ref; row.clientName = tx.client || row.clientName; row.phone = tx.phone || row.phone;
            row.items = this.validateItems(body.items || [], tx); if (!row.items.length) throw new BadRequestException('اختر بنود الشكوى'); break;
          }
          case 'plan':
            if (!SOLUTIONS.includes(body.solution as any)) throw new BadRequestException('اختر نوع الحل');
            if (w.caseId || w.payment || w.fulfillment) throw new ConflictException('يوجد تنفيذ مسجل؛ راجعه قبل تغيير الحل');
            if (['exchange','return'].includes(body.solution!)) {
              if (!row.transactionId || !row.items?.length) throw new BadRequestException('حدد الفاتورة والبنود والكميات أولًا');
              const tx = await connection.collection('transactions').findOne({ _id: this.oid(row.transactionId) }, { session });
              if (!tx || !(tx.deliveredAt || tx.pickupStatus === 'Delivered' || tx.bostaStatus === 'DELIVERED')) throw new BadRequestException('الفاتورة لم تُسلّم؛ اختر معالجة التوصيل');
            }
            if (['compensation','refund_without_return'].includes(body.solution!) && (!Number.isFinite(body.amount) || !body.amount || body.amount < .01 || body.amount > 1000000 || Math.abs(body.amount*100-Math.round(body.amount*100)) > .000001 || body.confirmed !== true)) throw new BadRequestException('حدد واعتمد مبلغًا صحيحًا بالجنيه والقرش');
            w.solution = body.solution; w.planNote = note; w.amount = body.amount || 0; w.stage = 'planned';
            w.plannedAt = now; w.plannedBy = actor.name; setDeadline();
            row.managerAction = ({ exchange:'استبدال', return:'استرداد', support:'دعم', delivery:'معالجة توصيل', compensation:'تعويض', refund_without_return:'رد دون استلام' } as any)[body.solution!];
            row.status = ['exchange','return'].includes(w.solution) ? 'معلق' : 'مقبول'; break;
          case 'link': {
            linked = await connection.collection('returnrequests').findOne({ _id: this.oid(body.caseId!) }, { session });
            if (!linked) throw new NotFoundException('طلب التنفيذ غير موجود');
            if (w.caseId) throw new ConflictException('يوجد طلب مرتبط بالفعل');
            assertCaseCoverage({ ...row.toObject(), workflow: w }, linked);
            w.caseId = String(linked._id); w.caseRef = linked.workflow.ref; w.stage = 'execution'; w.decisionAt = now;
            row.status = 'مقبول';
            await connection.collection('returnrequests').updateOne({ _id: linked._id }, { $addToSet: { 'workflow.complaintIds': id }, $inc: { __v: 1 } }, { session }); break;
          }
          case 'unlink':
            if (!linked || linked.workflow.stage !== 'cancelled') throw new ConflictException('لا يمكن فصل طلب غير ملغى؛ عالج آثاره من ملف التنفيذ');
            w.previousCases = [...(w.previousCases || []), { caseId: w.caseId, cycle: w.cycle, reason: note }];
            w.caseId = ''; w.caseRef = ''; w.stage = 'review'; w.solution = ''; row.status = 'معلق'; break;
          case 'fulfill':
            if (!['support','delivery'].includes(w.solution) || !body.reference?.trim() || body.confirmed !== true) throw new BadRequestException('وثّق الحل ومرجع الإثبات وأكد تنفيذه');
            if (w.fulfillment) throw new ConflictException('تنفيذ الحل مسجل بالفعل');
            w.fulfillment = { reference: body.reference.trim(), note, at: now, by: actor.name }; w.stage = 'confirmation'; break;
          case 'payment': {
            if (!['compensation','refund_without_return'].includes(w.solution) || w.payment || !w.amount || !this.vault) throw new ConflictException('لا يوجد مبلغ مستحق غير منفذ');
            const method = normalizeVaultAccountLabel(body.method);
            if (!method || !body.reference?.trim() || body.confirmed !== true) throw new BadRequestException('حدد الخزنة ومرجع الدفع وأكد دفع المبلغ فعليًا');
            if (w.solution === 'refund_without_return') {
              if (!row.transactionId) throw new BadRequestException('رد المبلغ دون استلام يتطلب فاتورة مرتبطة');
              const tx: any = await connection.collection('transactions').findOne({ _id: this.oid(row.transactionId), cancelled: { $ne: true } }, { session });
              if (!tx) throw new BadRequestException('الفاتورة غير فعالة');
              const previousReturns = await connection.collection('returnrequests').find({ originalTransactionId:row.transactionId,status:{$in:['معلق','معتمد']},reversedAt:null }, { session }).toArray();
              const held = tx.deliverySource === 'BOSTA' && tx.codCollectionStatus === 'CODWaitingCollection' ? Math.min(Number(tx.remaining||0),Number(tx.bostaOriginalCod||0)) : 0;
              const available = Number(tx.total||0)-Number(tx.remaining||0)+held-previousReturns.reduce((n,r)=>n+Number(r.total||0),0)-Number(tx.afterSales?.complaintRefunded||0);
              if (w.amount > available + .01) throw new ConflictException('المبلغ يتجاوز الرصيد المتبقي بعد المرتجعات والردود السابقة');
              await connection.collection('transactions').updateOne({_id:tx._id},{$set:{afterSales:{...(tx.afterSales||{}),complaintRefunded:Number(tx.afterSales?.complaintRefunded||0)+w.amount}},$inc:{unitTrackingRevision:1}},{session});
            }
            const expenseId = new Types.ObjectId(), date = new Date().toLocaleDateString('en-CA',{timeZone:'Africa/Cairo'});
            const entry = await this.vault.addSystemEntry(-w.amount, method, `شكوى ${row.complaintNo}: ${note}`, date, 'مصروف', String(expenseId),
              { customer: row.clientName }, actor.name, { complaintId: id, cycle: w.cycle, reference: body.reference }, { session, afterCommit: effects });
            await connection.collection('expenses').insertOne({ _id:expenseId,date,desc:`${row.complaintNo} — ${row.managerAction}`,category:'تعويضات العملاء',amount:w.amount,
              employee:actor.name,notes:`${note} — ${body.reference}`,account:method,status:'معتمد',expenseNo:`CMP-${id}-${w.cycle}`,approvedBy:actor.name,approvedAt:now,
              complaintId:id,complaintCycle:w.cycle,vaultEntryId:String(entry._id),createdAt:new Date(),updatedAt:new Date() },{session});
            w.payment = { amount: w.amount, method, reference: body.reference, vaultEntryId: String(entry._id), expenseId:String(expenseId), at: now, by: actor.name }; w.stage = 'confirmation'; break;
          }
          case 'contact':
            if (!body.channel || !body.contactResult) throw new BadRequestException('حدد وسيلة التواصل ونتيجته');
            w.contacts = [...(w.contacts || []), { channel: body.channel, result: body.contactResult, at: now, by: actor.name, note }];
            if (body.contactResult === 'confirmed' && evidence.ready) { w.customerConfirmedAt = now; w.reviewRequired = false; }
            if (body.contactResult === 'disputed') { w.reviewRequired = true; delete w.customerConfirmedAt; }
            if (w.stage !== 'closed') setDeadline(); break;
          case 'close': {
            if (!OUTCOMES.includes(body.outcome as any)) throw new BadRequestException('اختر نتيجة الإغلاق');
            const success = ['resolved','partial_agreement'].includes(body.outcome!);
            if (success && !evidence.ready) throw new ConflictException('الحل غير مكتمل؛ راجع الاستلام والتسليم والمدفوعات');
            if (linked && linked.workflow.stage !== 'cancelled' && !evidence.ready) throw new ConflictException('يوجد التزام تنفيذ مفتوح؛ لا يمكن إغلاق الشكوى');
            if (!success && (w.payment || evidence.ready)) throw new ConflictException('تم تنفيذ الحل؛ وثّق نتيجته أو اتفاق الحل الجزئي');
            const unanswered = (w.contacts || []).filter((c: any) => c.result === 'no_answer' && (!success || !evidence.fulfilledAt || c.at >= evidence.fulfilledAt));
            const followedUp = unanswered.length >= 2 && Date.parse(unanswered[unanswered.length-1].at) - Date.parse(unanswered[0].at) >= 24 * 3600000;
            if (success && !body.customerConfirmed && !w.customerConfirmedAt && !followedUp) throw new BadRequestException('أكد موافقة العميل أو وثّق محاولتي تواصل يفصل بينهما يوم على الأقل');
            if (success && w.reviewRequired && !body.customerConfirmed) throw new ConflictException('العميل اعترض على الحل؛ عالج الاعتراض وأكد موافقته قبل الإغلاق');
            if (body.outcome === 'partial_agreement' && !body.customerConfirmed) throw new BadRequestException('الحل الجزئي يتطلب موافقة العميل الصريحة');
            if (body.outcome === 'unreachable' && !followedUp) throw new BadRequestException('وثّق محاولتي تواصل يفصل بينهما يوم على الأقل');
            if (body.outcome === 'duplicate') {
              const target = await this.complaintModel.findById(this.oid(body.duplicateId!)).session(session);
              if (!target || String(target._id) === id || target.workflow?.outcome === 'duplicate' ||
                  (row.transactionId ? target.transactionId !== row.transactionId : !row.phone || target.phone !== row.phone)) throw new BadRequestException('اختر الشكوى الأساسية لنفس الفاتورة أو العميل');
              w.duplicateId = String(target._id);
            }
            w.stage = 'closed'; w.outcome = body.outcome; w.closedAt = now; w.closedBy = actor.name; w.closureNote = note;
            w.customerMessage = body.customerMessage || ''; w.customerConfirmedAt = body.customerConfirmed ? now : w.customerConfirmedAt;
            w.reviewRequired = false;
            w.financialPending = evidence.financialPending; row.inFollowUp = false;
            row.status = success ? 'مقبول' : 'مرفوض'; row.resolvedAt = now; row.resolvedBy = actor.name;
            if (success) { row.surveyToken = randomBytes(24).toString('hex'); row.surveySlug = await this.generateSurveySlug(); }
            break;
          }
          case 'reopen':
            if (w.stage !== 'closed') throw new ConflictException('الشكوى مفتوحة بالفعل');
            w.cycles = [...(w.cycles || []), { cycle: w.cycle, outcome: w.outcome, closedAt: w.closedAt, closureNote: w.closureNote,
              solution: w.solution, caseId: w.caseId, payment: w.payment, fulfillment: w.fulfillment, surveyRating: row.surveyRating, surveyComment: row.surveyComment }];
            w.cycle++; w.stage = 'review'; w.solution = ''; w.caseId = ''; w.caseRef = ''; w.reviewRequired = false;
            for (const key of ['closedAt','closedBy','closureNote','outcome','payment','fulfillment','customerConfirmedAt','archivedAt','waitingFor','contacts']) delete w[key];
            row.surveyToken = undefined as any; row.surveySlug = undefined as any; row.surveyCompletedAt = undefined as any; row.surveyRating = undefined as any; row.surveyComment = undefined as any;
            row.resolvedAt = undefined as any; row.resolvedBy = undefined as any; row.status = 'معلق'; row.managerAction = ''; setDeadline(); break;
          case 'archive':
            if (w.stage !== 'closed') throw new ConflictException('أغلق الشكوى بنتيجة موثقة قبل الأرشفة');
            if (w.reviewRequired) throw new ConflictException('راجع اعتراض العميل أو التقييم المنخفض قبل الأرشفة');
            w.archivedAt = now; break;
          default: throw new BadRequestException('الإجراء غير معروف');
        }
        w.revision++; w.operations ||= []; w.operations.push({ key: body.operationKey, fingerprint });
        workflowEvent(w, body.action, actor, note, { outcome: body.outcome, solution: body.solution, caseId: w.caseId });
        row.workflow = w; row.markModified('workflow');
        row.inFollowUp = w.stage !== 'closed' && !!w.solution;
        await row.save({ session });
      });
      for (const effect of effects) { try { await effect(); } catch {} }
      return this.detail(id);
    } finally { await session.endSession(); }
  }
}
