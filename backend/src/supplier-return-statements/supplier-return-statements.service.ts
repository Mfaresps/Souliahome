import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException,
  OnModuleInit, Optional, ServiceUnavailableException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { ObjectId } from 'mongodb';
import { createHash, randomBytes } from 'crypto';
import { SettingsService } from '../settings/settings.service';
import sharp from 'sharp';
import { r2DeleteObject, r2GetObjectBuffer, r2PutObject } from '../shared/r2-uploader.util';
import {
  RS_COLLECTION, RS_IMAGES_COLLECTION, RS_IMAGE_PREFIX, RS_MAX_IMAGES_PER_LINE, RS_MAX_LINES,
  RS_MAX_QTY, RS_NOTE_MAX, RS_PERMS, RS_PERM_LIST, RS_REASON_CODES, RS_STATUS_CODES,
} from './supplier-return-statement.constants';

export interface RsActor { userId: string; username?: string; name?: string; role?: string; perms?: string[] }

const ID_RE = /^[a-f0-9]{24}$/;
const LINE_ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
const ATT_ID_RE = /^[a-f0-9]{64}$/;
const REQUEST_KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Removes control and bidi-override characters and collapses runs of spaces; keeps line breaks.
 * The stored text must display exactly as typed (the statement is printed and sent outside).
 */
export function cleanRsText(value: unknown, max = RS_NOTE_MAX): string {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[‪-‮⁦-⁩]/g, '')
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

/** Photos only need to show the defect (and print as small thumbnails), so they get a tighter
 *  budget than transfer receipts, whose text must stay legible: ≤ 1280 px and ≤ 90 KB. */
export const RS_PHOTO_MAX_BYTES = 90 * 1024;
export async function compressRsPhoto(input: Buffer): Promise<Buffer> {
  const options = { failOn: 'error' as const, limitInputPixels: 40_000_000 };
  const meta = await sharp(input, options).metadata();
  if (!['jpeg', 'png', 'webp', 'heif'].includes(meta.format || '') || (meta.pages || 1) > 1) throw new Error('Unsupported image');
  let smallest: Buffer | null = null;
  for (const side of [1280, 1024, 800]) {
    for (const quality of [72, 62, 52]) {
      const out = await sharp(input, options).rotate().flatten({ background: '#fff' })
        .resize({ width: side, height: side, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality, mozjpeg: true }).toBuffer();
      if (out.length <= RS_PHOTO_MAX_BYTES) return out;
      if (!smallest || out.length < smallest.length) smallest = out;
    }
  }
  return smallest!;
}

export function cairoToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export function formatRsNumber(seq: number): string {
  return 'SR-' + String(seq).padStart(5, '0');
}

/** The rules a statement must meet before it leaves «مسودة». Returns the first problem, or ''. */
export function rsCompletenessError(lines: any[]): string {
  if (!Array.isArray(lines) || !lines.length) return 'أضف منتجاً واحداً على الأقل قبل تغيير حالة البيان';
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i], n = i + 1;
    if (!l.productId) return `السطر ${n}: اختر المنتج`;
    if (!(Number(l.qty) > 0)) return `السطر ${n}: أدخل الكمية`;
    if (!l.reason) return `السطر ${n}: اختر سبب المرتجع`;
    if (l.reason === 'other' && !l.reasonNote) return `السطر ${n}: اكتب وصف السبب`;
  }
  return '';
}

/**
 * «بيانات المرتجعات» — documentation only. See supplier-return-statement.constants.ts.
 *
 * ⚠ This service reads suppliers / products / purchaseorders / transactions only to check a
 * reference and to copy a name onto the statement. It WRITES only `supplierreturnstatements`
 * and `supplierreturnstatementimages`. A test asserts no other collection changes.
 */
@Injectable()
export class SupplierReturnStatementsService implements OnModuleInit {
  private readonly logger = new Logger(SupplierReturnStatementsService.name);
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @Optional() private readonly settings?: SettingsService,
  ) {}

  private get statements() { return this.connection.collection(RS_COLLECTION); }
  private get images() { return this.connection.collection(RS_IMAGES_COLLECTION); }

  async onModuleInit() {
    try {
      await this.statements.createIndex({ seq: 1 }, { unique: true, name: 'rs_seq_unique' });
      await this.statements.createIndex({ supplierId: 1, seq: -1 });
      await this.statements.createIndex(
        { createdById: 1, requestKey: 1 },
        { unique: true, partialFilterExpression: { requestKey: { $type: 'string' } }, name: 'rs_request_key_unique' },
      );
      await this.images.createIndex({ statementId: 1 });
    } catch (e: any) {
      this.logger.warn('Index creation for supplier return statements failed: ' + (e?.message || e));
    }
  }

  // ── Permissions ─────────────────────────────────────────────────────────
  static can(user: RsActor | undefined, perm: string): boolean {
    if (!user) return false;
    if (user.role === 'admin') return true;
    return (user.perms || []).includes(perm);
  }
  /** Any statement perm opens the list read-only — whoever creates one must be able to see it. */
  static canView(user: RsActor | undefined): boolean {
    if (!user) return false;
    if (user.role === 'admin') return true;
    return (user.perms || []).some((p) => RS_PERM_LIST.includes(p));
  }
  private require(ok: boolean) { if (!ok) throw new ForbiddenException('ليست لديك صلاحية لهذا الإجراء على بيانات المرتجعات'); }
  /** Editing: the edit perm, or the creator of a draft who holds the create perm. */
  private canEditDoc(user: RsActor, doc: any): boolean {
    if (SupplierReturnStatementsService.can(user, RS_PERMS.edit)) return true;
    return doc.status === 'draft' && doc.createdById === user.userId
      && SupplierReturnStatementsService.can(user, RS_PERMS.create);
  }

  private actorName(user: RsActor) { return String(user.name || user.username || '').trim() || 'مستخدم'; }
  private oid(id: string) {
    if (!ID_RE.test(String(id || ''))) throw new BadRequestException('معرّف البيان غير صالح');
    return new ObjectId(id);
  }

  private async loadDoc(id: string) {
    const doc = await this.statements.findOne({ _id: this.oid(id), deletedAt: { $exists: false } });
    if (!doc) throw new NotFoundException('البيان غير موجود');
    return doc;
  }

  /** Purchase prices follow the app's existing rule: admin, `purchase-edit-price` or `purchase-create`
   *  (the same people who can read supplier prices). Everyone else gets the lines without prices. */
  static canSeePrices(user: RsActor | undefined): boolean {
    if (!user) return false;
    if (user.role === 'admin') return true;
    return (user.perms || []).some((p) => p === 'purchase-edit-price' || p === 'purchase-create');
  }

  private present(doc: any, user?: RsActor) {
    const { requestKey, ...rest } = doc;
    const out: any = { ...rest, _id: String(doc._id) };
    if (!SupplierReturnStatementsService.canSeePrices(user)) {
      out.lines = (doc.lines || []).map(({ unitPrice, priceSource, priceRef, ...l }: any) => l);
      out.pricesHidden = true;
    }
    return out;
  }

  /**
   * The supplier's price for each line, fixed on the statement (a documentation snapshot — it is
   * never posted anywhere). Order: the linked purchase invoice line -> the linked PO line -> this
   * supplier's row in the product's supplier-price table -> the product card's purchase price.
   * Only lines that are new, changed product, or have no price yet are priced, unless `force`
   * (the linked document changed).
   */
  private async priceLines(lines: any[], supplierId: string, linkedDoc: any, force: boolean) {
    const todo = lines.filter((l) => force || l._reprice || l.unitPrice === undefined);
    lines.forEach((l) => { delete l._reprice; });
    if (!todo.length) return lines;
    let docItems: any[] = [];
    if (linkedDoc?.id && ID_RE.test(linkedDoc.id)) {
      if (linkedDoc.kind === 'purchase') {
        const tx = await this.connection.collection('transactions').findOne({ _id: new ObjectId(linkedDoc.id) }, { projection: { items: 1 } });
        docItems = (tx?.items || []).map((it: any) => ({ productId: String(it.productId || ''), code: String(it.code || ''), price: Number(it.price) }));
      } else {
        const po = await this.connection.collection('purchaseorders').findOne({ _id: new ObjectId(linkedDoc.id) }, { projection: { items: 1 } });
        docItems = (po?.items || []).map((it: any) => ({ productId: '', code: String(it.productCode || ''), price: Number(it.unitPrice) }));
      }
    }
    const pids = [...new Set(todo.map((l) => l.productId))];
    const [supplierRows, products] = await Promise.all([
      this.connection.collection('productsuppliers').find({ supplierId, productId: { $in: pids }, active: { $ne: false } }, { projection: { productId: 1, price: 1 } }).toArray(),
      this.connection.collection('products').find({ _id: { $in: pids.map((v) => new ObjectId(v)) } }, { projection: { buyPrice: 1 } }).toArray(),
    ]);
    const supplierPrice = new Map(supplierRows.filter((r: any) => Number(r.price) > 0).map((r: any) => [String(r.productId), Number(r.price)]));
    const cardPrice = new Map(products.filter((p: any) => Number(p.buyPrice) > 0).map((p: any) => [String(p._id), Number(p.buyPrice)]));
    for (const l of todo) {
      const fromDoc = docItems.find((it) => it.price > 0 && ((it.productId && it.productId === l.productId) || (it.code && it.code === l.code)));
      if (fromDoc) { l.unitPrice = fromDoc.price; l.priceSource = linkedDoc.kind === 'purchase' ? 'invoice' : 'po'; l.priceRef = linkedDoc.ref || ''; }
      else if (supplierPrice.has(l.productId)) { l.unitPrice = supplierPrice.get(l.productId); l.priceSource = 'supplier'; l.priceRef = ''; }
      else if (cardPrice.has(l.productId)) { l.unitPrice = cardPrice.get(l.productId); l.priceSource = 'card'; l.priceRef = ''; }
      else { l.unitPrice = null; l.priceSource = ''; l.priceRef = ''; }
      l.unitPrice = l.unitPrice == null ? null : Math.round(l.unitPrice * 100) / 100;
    }
    return lines;
  }

  // ── Reads ───────────────────────────────────────────────────────────────
  async list(user: RsActor, supplierId: string) {
    this.require(SupplierReturnStatementsService.canView(user));
    if (!ID_RE.test(String(supplierId || ''))) throw new BadRequestException('معرّف المورد غير صالح');
    const rows = await this.statements
      .find({ supplierId, deletedAt: { $exists: false } }, { projection: { requestKey: 0 } })
      .sort({ seq: -1 })
      .limit(2000)
      .toArray();
    return rows.map((r) => this.present(r, user));
  }

  async get(user: RsActor, id: string) {
    this.require(SupplierReturnStatementsService.canView(user));
    return this.present(await this.loadDoc(id), user);
  }

  // ── Validation ──────────────────────────────────────────────────────────
  private async resolveSupplier(supplierId: string) {
    if (!ID_RE.test(String(supplierId || ''))) throw new BadRequestException('معرّف المورد غير صالح');
    const s = await this.connection.collection('suppliers').findOne({ _id: new ObjectId(supplierId) }, { projection: { name: 1 } });
    if (!s) throw new BadRequestException('المورد غير موجود');
    return { supplierId, supplierName: String(s.name || '') };
  }

  private async resolveLinkedDoc(raw: any, supplierId: string, supplierName: string, previous: any) {
    if (!raw || !raw.id) return null;
    const kind = raw.kind === 'purchase' ? 'purchase' : raw.kind === 'po' ? 'po' : '';
    const id = String(raw.id);
    if (!kind || !ID_RE.test(id)) throw new BadRequestException('المستند المرتبط غير صالح');
    if (previous && previous.kind === kind && previous.id === id) return previous;
    if (kind === 'po') {
      const po = await this.connection.collection('purchaseorders').findOne({ _id: new ObjectId(id) }, { projection: { supplierId: 1, poNumber: 1, createdDate: 1 } });
      if (!po || String(po.supplierId) !== supplierId) throw new BadRequestException('أمر الشراء غير موجود لهذا المورد');
      return { kind, id, ref: String(po.poNumber || ''), date: String(po.createdDate || '').slice(0, 10) };
    }
    const tx = await this.connection.collection('transactions').findOne(
      { _id: new ObjectId(id) }, { projection: { type: 1, supplierId: 1, supplier: 1, client: 1, ref: 1, date: 1 } },
    );
    const belongs = tx && tx.type === 'مشتريات'
      && (String(tx.supplierId || '') === supplierId
        // A purchase keeps the supplier's name in `client` (getSupplierPurchases); older ones have no id.
        || (!tx.supplierId && [tx.client, tx.supplier].some((v) => String(v || '').trim() === supplierName.trim())));
    if (!belongs) throw new BadRequestException('فاتورة الشراء غير موجودة لهذا المورد');
    return { kind, id, ref: String(tx!.ref || ''), date: String(tx!.date || '').slice(0, 10) };
  }

  /**
   * Builds the stored lines. The client sends product id, qty, reason and notes; the server copies
   * the product's code and name (kept as they were at creation, so the document stays true after a
   * product is renamed) and carries each line's photos from the stored copy — never from the client.
   */
  private async buildLines(raw: unknown, previous: any[] = []) {
    if (raw === undefined) return previous;
    if (!Array.isArray(raw)) throw new BadRequestException('بنود البيان غير صالحة');
    if (raw.length > RS_MAX_LINES) throw new BadRequestException(`الحد الأقصى ${RS_MAX_LINES} منتج في البيان`);
    const prevById = new Map(previous.map((l: any) => [l.lineId, l]));
    const ids = [...new Set(raw.map((l: any) => String(l?.productId || '')).filter((v) => ID_RE.test(v)))];
    const products = ids.length
      ? await this.connection.collection('products').find({ _id: { $in: ids.map((v) => new ObjectId(v)) } }, { projection: { code: 1, name: 1, imageUrl: 1 } }).toArray()
      : [];
    const productById = new Map(products.map((p: any) => [String(p._id), p]));
    const seen = new Set<string>();
    return raw.map((l: any, i: number) => {
      const n = i + 1;
      const productId = String(l?.productId || '');
      if (!ID_RE.test(productId)) throw new BadRequestException(`السطر ${n}: اختر المنتج`);
      let lineId = String(l?.lineId || '');
      if (!LINE_ID_RE.test(lineId) || seen.has(lineId)) lineId = randomBytes(8).toString('hex');
      seen.add(lineId);
      const prev: any = prevById.get(lineId);
      let code: string, name: string, imageUrl: string;
      const sameProduct = !!prev && prev.productId === productId;
      if (sameProduct) { code = prev.code; name = prev.name; imageUrl = prev.imageUrl ?? String(productById.get(productId)?.imageUrl || ''); }
      else {
        const p: any = productById.get(productId);
        if (!p) throw new BadRequestException(`السطر ${n}: المنتج غير موجود`);
        code = String(p.code || ''); name = String(p.name || ''); imageUrl = String(p.imageUrl || '');
      }
      const qtyRaw = l?.qty;
      let qty: number | null = null;
      if (qtyRaw !== null && qtyRaw !== undefined && qtyRaw !== '') {
        qty = Number(qtyRaw);
        if (!Number.isInteger(qty) || qty < 1 || qty > RS_MAX_QTY) throw new BadRequestException(`السطر ${n}: الكمية يجب أن تكون عدداً صحيحاً أكبر من صفر`);
      }
      const reason = String(l?.reason || '');
      if (reason && !RS_REASON_CODES.includes(reason)) throw new BadRequestException(`السطر ${n}: سبب المرتجع غير معروف`);
      const reasonNote = cleanRsText(l?.reasonNote, 300);
      if (reason === 'other' && !reasonNote) throw new BadRequestException(`السطر ${n}: اكتب وصف السبب عند اختيار «سبب آخر»`);
      const priced = sameProduct && prev.unitPrice !== undefined
        ? { unitPrice: prev.unitPrice, priceSource: prev.priceSource || '', priceRef: prev.priceRef || '' }
        : { _reprice: true };
      return {
        lineId, productId, code, name, imageUrl, qty, reason, ...priced,
        reasonNote: reason === 'other' ? reasonNote : cleanRsText(l?.reasonNote, 300),
        notes: cleanRsText(l?.notes),
        attachments: Array.isArray(prev?.attachments) ? prev.attachments : [],
      };
    });
  }

  private normalizeDate(raw: unknown, fallback?: string) {
    if (raw === undefined) return fallback || cairoToday();
    const v = String(raw || '').slice(0, 10);
    if (!DATE_RE.test(v) || Number.isNaN(new Date(v + 'T00:00:00Z').getTime())) throw new BadRequestException('تاريخ البيان غير صالح');
    return v;
  }

  // ── Writes (own collections only) ───────────────────────────────────────
  async create(user: RsActor, body: any) {
    this.require(SupplierReturnStatementsService.can(user, RS_PERMS.create));
    const requestKey = REQUEST_KEY_RE.test(String(body?.requestKey || '')) ? String(body.requestKey) : null;
    if (requestKey) {
      const existing = await this.statements.findOne({ createdById: user.userId, requestKey });
      if (existing) return this.present(existing, user);
    }
    const { supplierId, supplierName } = await this.resolveSupplier(String(body?.supplierId || ''));
    const lines = await this.buildLines(body?.lines ?? []);
    const date = this.normalizeDate(body?.date);
    const linkedDoc = await this.resolveLinkedDoc(body?.linkedDoc, supplierId, supplierName, null);
    await this.priceLines(lines, supplierId, linkedDoc, false);
    const notes = cleanRsText(body?.notes);
    const now = new Date(), by = this.actorName(user);
    for (let attempt = 0; attempt < 6; attempt++) {
      const last = await this.statements.find({}, { projection: { seq: 1 } }).sort({ seq: -1 }).limit(1).toArray();
      const seq = (Number(last[0]?.seq) || 0) + 1;
      const doc: any = {
        seq, number: formatRsNumber(seq), supplierId, supplierName, date, linkedDoc, notes,
        status: 'draft', lines, revision: 1,
        createdById: user.userId, createdBy: by, createdAt: now, updatedAt: now, updatedBy: by,
        history: [{ at: now, by, byId: user.userId, action: 'created', to: 'draft' }],
      };
      if (requestKey) doc.requestKey = requestKey;
      try {
        const res = await this.statements.insertOne(doc);
        return this.present({ ...doc, _id: res.insertedId }, user);
      } catch (e: any) {
        if (e?.code !== 11000) throw e;
        if (requestKey) {
          const existing = await this.statements.findOne({ createdById: user.userId, requestKey });
          if (existing) return this.present(existing, user);
        }
        // Another statement took this number — read the max again.
      }
    }
    throw new ConflictException('تعذّر إصدار رقم للبيان؛ أعد المحاولة');
  }

  async update(user: RsActor, id: string, body: any) {
    const doc = await this.loadDoc(id);
    this.require(this.canEditDoc(user, doc));
    if (doc.status === 'closed') throw new ConflictException('البيان مغلق — أعد فتحه لتعديله');
    const revision = Number(body?.revision);
    if (!Number.isInteger(revision) || revision !== doc.revision) {
      throw new ConflictException('تم تعديل هذا البيان من مكان آخر — أعد فتحه لترى آخر نسخة');
    }
    const lines = await this.buildLines(body?.lines, doc.lines || []);
    if (doc.status !== 'draft') {
      const err = rsCompletenessError(lines);
      if (err) throw new BadRequestException(err);
    }
    const date = this.normalizeDate(body?.date, doc.date);
    const linkedDoc = body && 'linkedDoc' in body
      ? await this.resolveLinkedDoc(body.linkedDoc, doc.supplierId, doc.supplierName, doc.linkedDoc)
      : doc.linkedDoc;
    const notes = body && 'notes' in body ? cleanRsText(body.notes) : doc.notes;
    const linkedChanged = (linkedDoc?.id || '') !== (doc.linkedDoc?.id || '');
    const pricedLines = await this.priceLines(lines.map((l: any) => ({ ...l })), doc.supplierId, linkedDoc, linkedChanged);

    const changes: string[] = [];
    if (date !== doc.date) changes.push('date');
    if (notes !== doc.notes) changes.push('notes');
    if ((linkedDoc?.id || '') !== (doc.linkedDoc?.id || '')) changes.push('linkedDoc');
    const sig = (ls: any[]) => JSON.stringify((ls || []).map((l) => [l.lineId, l.productId, l.qty, l.reason, l.reasonNote, l.notes]));
    if (sig(pricedLines) !== sig(doc.lines)) changes.push('lines');
    const psig = (ls: any[]) => JSON.stringify((ls || []).map((l) => [l.unitPrice, l.priceSource, l.imageUrl]));
    if (psig(pricedLines) !== psig(doc.lines)) changes.push('prices');
    if (!changes.length) return this.present(doc, user);

    const now = new Date(), by = this.actorName(user);
    const removed = (doc.lines || []).filter((l: any) => !pricedLines.some((n: any) => n.lineId === l.lineId));
    const res = await this.statements.findOneAndUpdate(
      { _id: doc._id, revision: doc.revision, deletedAt: { $exists: false } },
      {
        $set: { lines: pricedLines, date, linkedDoc, notes, updatedAt: now, updatedBy: by },
        $inc: { revision: 1 },
        $push: { history: { at: now, by, byId: user.userId, action: 'edited', fields: changes } } as any,
      },
      { returnDocument: 'after' },
    );
    const updated: any = (res as any)?.value !== undefined ? (res as any).value : res;
    if (!updated) throw new ConflictException('تم تعديل هذا البيان من مكان آخر — أعد فتحه لترى آخر نسخة');
    // Photos of a removed line go with it.
    for (const line of removed) for (const a of line.attachments || []) await this.dropImage(String(doc._id), a.id);
    return this.present(updated, user);
  }

  async setStatus(user: RsActor, id: string, body: any) {
    this.require(SupplierReturnStatementsService.can(user, RS_PERMS.status));
    const doc = await this.loadDoc(id);
    const to = String(body?.status || '');
    if (!RS_STATUS_CODES.includes(to)) throw new BadRequestException('حالة غير معروفة');
    if (to === doc.status) return this.present(doc, user);
    if (to !== 'draft') {
      const err = rsCompletenessError(doc.lines);
      if (err) throw new BadRequestException(err);
    }
    const note = cleanRsText(body?.note, 300);
    const now = new Date(), by = this.actorName(user);
    const res = await this.statements.findOneAndUpdate(
      { _id: doc._id, status: doc.status, deletedAt: { $exists: false } },
      {
        $set: { status: to, updatedAt: now, updatedBy: by, statusChangedAt: now },
        $inc: { revision: 1 },
        $push: { history: { at: now, by, byId: user.userId, action: 'status', from: doc.status, to, note } } as any,
      },
      { returnDocument: 'after' },
    );
    const updated: any = (res as any)?.value !== undefined ? (res as any).value : res;
    if (!updated) throw new ConflictException('تغيّرت حالة البيان من مكان آخر — أعد فتحه');
    return this.present(updated, user);
  }

  /** Soft delete: the record (and its history) is kept, it just leaves every list. */
  async remove(user: RsActor, id: string) {
    this.require(SupplierReturnStatementsService.can(user, RS_PERMS.delete));
    const doc = await this.loadDoc(id);
    const now = new Date(), by = this.actorName(user);
    await this.statements.updateOne(
      { _id: doc._id, deletedAt: { $exists: false } },
      {
        $set: { deletedAt: now, deletedBy: by, deletedById: user.userId },
        $push: { history: { at: now, by, byId: user.userId, action: 'deleted' } } as any,
      },
    );
    return { ok: true };
  }

  // ── Photos ──────────────────────────────────────────────────────────────
  private async r2() { return (await this.settings?.getR2Config()) || null; }

  async uploadImage(user: RsActor, id: string, lineId: string, file: { buffer: Buffer; originalname?: string } | undefined) {
    const doc = await this.loadDoc(id);
    this.require(this.canEditDoc(user, doc));
    if (doc.status === 'closed') throw new ConflictException('البيان مغلق — أعد فتحه لإضافة صور');
    const line = (doc.lines || []).find((l: any) => l.lineId === lineId);
    if (!line) throw new NotFoundException('سطر المنتج غير موجود — احفظ البيان أولاً');
    if (!file?.buffer?.length || file.buffer.length > 8 * 1024 * 1024) throw new BadRequestException('اختر صورة بحد أقصى 8 ميجابايت');
    let buffer: Buffer;
    try { buffer = await compressRsPhoto(file.buffer); }
    catch { throw new BadRequestException('استخدم صورة JPEG أو PNG أو WebP واضحة'); }
    const attId = createHash('sha256').update(String(doc._id)).update(lineId).update(buffer).digest('hex');
    if ((line.attachments || []).some((a: any) => a.id === attId)) return this.present(doc, user);
    if ((line.attachments || []).length >= RS_MAX_IMAGES_PER_LINE) throw new BadRequestException(`الحد الأقصى ${RS_MAX_IMAGES_PER_LINE} صور لكل منتج`);

    // Cloud storage when configured; otherwise the compressed image (≤180 KB) is kept in Mongo.
    const cfg = await this.r2();
    const stored: any = { _id: attId, statementId: String(doc._id), lineId, contentType: 'image/jpeg', bytes: buffer.length, createdAt: new Date() };
    if (cfg) {
      const key = `${RS_IMAGE_PREFIX}${doc.number}_${doc._id}/${attId}.jpg`;
      const put = await r2PutObject(cfg, key, buffer, 'image/jpeg', 30000);
      if (!put.ok) throw new ServiceUnavailableException('تعذّر حفظ الصورة على التخزين السحابي؛ أعد المحاولة');
      stored.imageKey = key;
    } else {
      stored.data = buffer.toString('base64');
    }
    await this.images.updateOne({ _id: attId as any }, { $setOnInsert: stored }, { upsert: true });
    const name = cleanRsText(file.originalname || 'photo', 120) || 'photo';
    const now = new Date(), by = this.actorName(user);
    const res = await this.statements.findOneAndUpdate(
      { _id: doc._id, deletedAt: { $exists: false }, lines: { $elemMatch: { lineId, 'attachments.id': { $ne: attId } } } },
      {
        $push: {
          'lines.$.attachments': { id: attId, name, bytes: buffer.length, at: now, by },
          history: { at: now, by, byId: user.userId, action: 'photo-added', lineId, name },
        } as any,
        $set: { updatedAt: now, updatedBy: by },
      },
      { returnDocument: 'after' },
    );
    const updated: any = (res as any)?.value !== undefined ? (res as any).value : res;
    return this.present(updated || (await this.loadDoc(id)), user);
  }

  async getImage(user: RsActor, id: string, attId: string) {
    this.require(SupplierReturnStatementsService.canView(user));
    const doc = await this.loadDoc(id);
    if (!ATT_ID_RE.test(attId) || !(doc.lines || []).some((l: any) => (l.attachments || []).some((a: any) => a.id === attId))) throw new NotFoundException('الصورة غير موجودة');
    const img: any = await this.images.findOne({ _id: attId as any, statementId: String(doc._id) });
    if (!img) throw new NotFoundException('الصورة غير موجودة');
    if (img.data) return { data: 'data:image/jpeg;base64,' + img.data };
    const cfg = await this.r2();
    if (!cfg || !String(img.imageKey || '').startsWith(RS_IMAGE_PREFIX)) throw new ServiceUnavailableException('تعذّر تحميل الصورة');
    const r = await r2GetObjectBuffer(cfg, img.imageKey);
    if (!r.ok) throw new ServiceUnavailableException('تعذّر تحميل الصورة من التخزين السحابي');
    return { data: 'data:image/jpeg;base64,' + r.body.toString('base64') };
  }

  async removeImage(user: RsActor, id: string, attId: string) {
    const doc = await this.loadDoc(id);
    this.require(this.canEditDoc(user, doc));
    if (doc.status === 'closed') throw new ConflictException('البيان مغلق — أعد فتحه لحذف الصور');
    const line = (doc.lines || []).find((l: any) => (l.attachments || []).some((a: any) => a.id === attId));
    if (!line) throw new NotFoundException('الصورة غير موجودة');
    const now = new Date(), by = this.actorName(user);
    const res = await this.statements.findOneAndUpdate(
      { _id: doc._id, 'lines.lineId': line.lineId },
      {
        $pull: { 'lines.$.attachments': { id: attId } } as any,
        $push: { history: { at: now, by, byId: user.userId, action: 'photo-removed', lineId: line.lineId } } as any,
        $set: { updatedAt: now, updatedBy: by },
      },
      { returnDocument: 'after' },
    );
    await this.dropImage(String(doc._id), attId);
    const updated: any = (res as any)?.value !== undefined ? (res as any).value : res;
    return this.present(updated || (await this.loadDoc(id)), user);
  }

  private async dropImage(statementId: string, attId: string) {
    try {
      const img: any = await this.images.findOne({ _id: attId as any, statementId });
      if (!img) return;
      if (img.imageKey) {
        const cfg = await this.r2();
        if (cfg) { const r = await r2DeleteObject(cfg, img.imageKey); if (!r.ok) this.logger.warn('Could not delete a return-statement photo from R2'); }
      }
      await this.images.deleteOne({ _id: attId as any, statementId });
    } catch { this.logger.warn('Could not remove a return-statement photo'); }
  }

  /** Records a print/export in the statement's history (who sent which copy, when). */
  async recordPrint(user: RsActor, id: string, kind: string) {
    this.require(SupplierReturnStatementsService.can(user, RS_PERMS.export));
    const doc = await this.loadDoc(id);
    const now = new Date(), by = this.actorName(user);
    await this.statements.updateOne(
      { _id: doc._id },
      { $push: { history: { at: now, by, byId: user.userId, action: kind === 'pdf' ? 'exported' : 'printed' } } as any },
    );
    return { ok: true };
  }
}
