import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as ExcelJS from 'exceljs';
import { KnowledgeFolder, KnowledgeFolderDocument } from './schemas/knowledge-folder.schema';
import { KnowledgeCard, KnowledgeCardDocument, CardType } from './schemas/knowledge-card.schema';
import {
  KnowledgeAuditLog,
  KnowledgeAuditLogDocument,
} from './schemas/knowledge-audit-log.schema';
import {
  KnowledgeImportLog,
  KnowledgeImportLogDocument,
} from './schemas/knowledge-import-log.schema';
import {
  ConfirmImportDto,
  DuplicateCardPreview,
  ImportPreviewError,
  ImportPreviewResult,
  ParsedCardRow,
  ParsedFolderRow,
} from './dto/import-export.dto';

interface Actor {
  userId?: string;
  username?: string;
  name?: string;
}

const CARD_TYPES: CardType[] = ['response', 'policy', 'procedure', 'warning'];

const FOLDER_COLUMNS: Partial<ExcelJS.Column>[] = [
  { header: 'الاسم', key: 'name', width: 26 },
  { header: 'الوصف', key: 'description', width: 34 },
  { header: 'الأيقونة', key: 'icon', width: 16 },
  { header: 'الترتيب', key: 'order', width: 10 },
  { header: 'مفعّل', key: 'isActive', width: 10 },
  { header: 'تاريخ الإنشاء', key: 'createdAt', width: 18 },
];

const CARD_COLUMNS: Partial<ExcelJS.Column>[] = [
  { header: 'الفولدر', key: 'folderName', width: 22 },
  { header: 'العنوان', key: 'title', width: 26 },
  { header: 'النوع', key: 'cardType', width: 12 },
  { header: 'السيناريو', key: 'scenario', width: 28 },
  { header: 'سؤال العميل', key: 'customerQuestion', width: 30 },
  { header: 'الرد', key: 'response', width: 40 },
  { header: 'ملاحظات داخلية', key: 'internalNotes', width: 30 },
  { header: 'الوسوم', key: 'tags', width: 24 },
  { header: 'مفعّلة', key: 'isActive', width: 10 },
  { header: 'مرات النسخ', key: 'copyCount', width: 12 },
];

function styleHeader(ws: ExcelJS.Worksheet): void {
  const row = ws.getRow(1);
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF16A34A' } };
  row.alignment = { vertical: 'middle', horizontal: 'center' };
  row.height = 22;
}

function boolAr(v: boolean): string {
  return v ? 'نعم' : 'لا';
}

function parseBoolAr(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  const s = String(v ?? '').trim();
  return !['لا', 'no', 'false', '0', ''].includes(s.toLowerCase());
}

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    const obj = v as unknown as Record<string, unknown>;
    if ('text' in obj) return String(obj.text ?? '');
    if ('richText' in obj) {
      return (obj.richText as Array<{ text: string }>).map((r) => r.text).join('');
    }
  }
  return String(v).trim();
}

@Injectable()
export class PlaybookImportExportService {
  constructor(
    @InjectModel(KnowledgeFolder.name)
    private readonly folderModel: Model<KnowledgeFolderDocument>,
    @InjectModel(KnowledgeCard.name)
    private readonly cardModel: Model<KnowledgeCardDocument>,
    @InjectModel(KnowledgeAuditLog.name)
    private readonly auditModel: Model<KnowledgeAuditLogDocument>,
    @InjectModel(KnowledgeImportLog.name)
    private readonly importLogModel: Model<KnowledgeImportLogDocument>,
  ) {}

  // ── Export ──

  async buildExportJson(): Promise<Record<string, unknown>> {
    const folders = await this.folderModel.find().sort({ order: 1, createdAt: 1 }).lean().exec();
    const cards = await this.cardModel.find().sort({ createdAt: -1 }).lean().exec();
    return {
      exportedAt: new Date().toISOString(),
      folders,
      cards,
    };
  }

  async buildExportExcel(): Promise<Buffer> {
    const folders = await this.folderModel.find().sort({ order: 1, createdAt: 1 }).lean().exec();
    const cards = await this.cardModel.find().sort({ createdAt: -1 }).lean().exec();
    const folderNameMap = new Map(folders.map((f) => [String(f._id), f.name]));

    const wb = new ExcelJS.Workbook();
    wb.creator = 'SOULIA';
    wb.created = new Date();

    const foldersSheet = wb.addWorksheet('Folders', { views: [{ rightToLeft: true }] });
    foldersSheet.columns = FOLDER_COLUMNS;
    styleHeader(foldersSheet);
    folders.forEach((f) =>
      foldersSheet.addRow({
        name: f.name,
        description: f.description || '',
        icon: f.icon || '',
        order: f.order || 0,
        isActive: boolAr(f.isActive !== false),
        createdAt: (f as any).createdAt ? new Date((f as any).createdAt).toISOString().slice(0, 10) : '',
      }),
    );

    const cardsSheet = wb.addWorksheet('Cards', { views: [{ rightToLeft: true }] });
    cardsSheet.columns = CARD_COLUMNS;
    styleHeader(cardsSheet);
    cards.forEach((c) =>
      cardsSheet.addRow({
        folderName: folderNameMap.get(String(c.folderId)) || '',
        title: c.title,
        cardType: c.cardType || 'response',
        scenario: c.scenario || '',
        customerQuestion: c.customerQuestion || '',
        response: c.response,
        internalNotes: c.internalNotes || '',
        tags: (c.tags || []).join(', '),
        isActive: boolAr(c.isActive !== false),
        copyCount: c.copyCount || 0,
      }),
    );

    const buffer = await wb.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  async buildImportTemplate(): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'SOULIA';
    wb.created = new Date();

    const foldersSheet = wb.addWorksheet('Folders', { views: [{ rightToLeft: true }] });
    foldersSheet.columns = FOLDER_COLUMNS;
    styleHeader(foldersSheet);
    const exampleFolderRow = foldersSheet.addRow({
      name: 'الشحن والتوصيل',
      description: 'أسئلة وسياسات متعلقة بالشحن',
      icon: 'truck',
      order: 0,
      isActive: 'نعم',
      createdAt: '',
    });
    exampleFolderRow.font = { italic: true, color: { argb: 'FF9CA3AF' } };

    const cardsSheet = wb.addWorksheet('Cards', { views: [{ rightToLeft: true }] });
    cardsSheet.columns = CARD_COLUMNS;
    styleHeader(cardsSheet);
    const exampleCardRow = cardsSheet.addRow({
      folderName: 'الشحن والتوصيل',
      title: 'تأخر الشحنة',
      cardType: 'response',
      scenario: 'عندما يسأل العميل عن سبب تأخر شحنته',
      customerQuestion: 'ليه الأوردر بتاعي اتأخر؟',
      response: 'نعتذر عن التأخير، جاري متابعة الشحنة مع شركة الشحن وسنوافيك بالتحديث خلال 24 ساعة.',
      internalNotes: 'تحقق من حالة الشحنة على بوسطة قبل الرد',
      tags: 'شحن, تأخير',
      isActive: 'نعم',
      copyCount: 0,
    });
    exampleCardRow.font = { italic: true, color: { argb: 'FF9CA3AF' } };

    const buffer = await wb.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  // ── Import: preview ──

  async previewImport(fileBuffer: Buffer): Promise<ImportPreviewResult> {
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(fileBuffer as any);
    } catch {
      throw new BadRequestException('تعذر قراءة ملف Excel — تأكد من صيغة الملف');
    }

    const errors: ImportPreviewError[] = [];
    const parsedFolders = this.parseFoldersSheet(wb.getWorksheet('Folders'), errors);
    const parsedCards = this.parseCardsSheet(wb.getWorksheet('Cards'), errors);

    return this.diffAgainstExisting(parsedFolders, parsedCards, errors);
  }

  async previewImportFromJson(fileBuffer: Buffer): Promise<ImportPreviewResult> {
    let raw: unknown;
    try {
      raw = JSON.parse(fileBuffer.toString('utf-8'));
    } catch {
      throw new BadRequestException('تعذر قراءة ملف JSON — تأكد من صيغة الملف');
    }
    const data = raw as Record<string, unknown>;
    const foldersIn = Array.isArray(data?.folders) ? (data.folders as Record<string, unknown>[]) : null;
    const cardsIn = Array.isArray(data?.cards) ? (data.cards as Record<string, unknown>[]) : null;
    if (!foldersIn || !cardsIn) {
      throw new BadRequestException('ملف JSON غير صالح — يجب أن يحتوي على folders و cards');
    }

    const errors: ImportPreviewError[] = [];
    const folderIdToName = new Map<string, string>();
    const parsedFolders: ParsedFolderRow[] = [];
    foldersIn.forEach((f, idx) => {
      const row = idx + 2;
      const name = String(f?.name ?? '').trim();
      if (!name) {
        errors.push({ row, message: 'اسم الفولدر مفقود في نسخة JSON' });
        return;
      }
      const id = f?._id != null ? String(f._id) : '';
      if (id) folderIdToName.set(id, name);
      parsedFolders.push({
        row,
        name,
        description: String(f?.description ?? ''),
        icon: String(f?.icon ?? 'folder') || 'folder',
        order: Number(f?.order) || 0,
        isActive: f?.isActive !== false,
      });
    });

    const parsedCards: ParsedCardRow[] = [];
    cardsIn.forEach((c, idx) => {
      const row = idx + 2;
      const folderId = c?.folderId != null ? String(c.folderId) : '';
      const folderName = folderIdToName.get(folderId) || '';
      const title = String(c?.title ?? '').trim();
      const response = String(c?.response ?? '').trim();
      if (!folderName || !title || !response) {
        errors.push({ row, message: 'الفولدر والعنوان والرد حقول مطلوبة' });
        return;
      }
      let cardType = (c?.cardType as CardType) || 'response';
      if (!CARD_TYPES.includes(cardType)) {
        errors.push({ row, message: `نوع البطاقة "${cardType}" غير صالح` });
        cardType = 'response';
      }
      const tagsRaw = c?.tags;
      const tags = Array.isArray(tagsRaw)
        ? tagsRaw.map((t) => String(t).trim()).filter(Boolean)
        : [];
      parsedCards.push({
        row,
        folderName,
        title,
        cardType,
        scenario: String(c?.scenario ?? ''),
        customerQuestion: String(c?.customerQuestion ?? ''),
        response,
        internalNotes: String(c?.internalNotes ?? ''),
        tags,
        isActive: c?.isActive !== false,
      });
    });

    return this.diffAgainstExisting(parsedFolders, parsedCards, errors);
  }

  private async diffAgainstExisting(
    parsedFolders: ParsedFolderRow[],
    parsedCards: ParsedCardRow[],
    errors: ImportPreviewError[],
  ): Promise<ImportPreviewResult> {
    const existingFolders = await this.folderModel.find().lean().exec();
    const existingFolderByName = new Map(
      existingFolders.map((f) => [f.name.trim().toLowerCase(), f]),
    );

    const newFolders: ParsedFolderRow[] = [];
    const seenNewFolderNames = new Set<string>();
    for (const f of parsedFolders) {
      const key = f.name.trim().toLowerCase();
      if (existingFolderByName.has(key) || seenNewFolderNames.has(key)) continue;
      seenNewFolderNames.add(key);
      newFolders.push(f);
    }

    const existingCards = await this.cardModel.find().lean().exec();
    const folderIdToName = new Map(existingFolders.map((f) => [String(f._id), f.name]));
    const existingCardByFolderTitle = new Map<string, (typeof existingCards)[number]>();
    for (const c of existingCards) {
      const folderName = folderIdToName.get(String(c.folderId)) || '';
      const key = `${folderName.trim().toLowerCase()}::${c.title.trim().toLowerCase()}`;
      existingCardByFolderTitle.set(key, c);
    }

    const newCards: ParsedCardRow[] = [];
    const duplicateCards: DuplicateCardPreview[] = [];
    const allKnownFolderNames = new Set<string>([
      ...existingFolders.map((f) => f.name.trim().toLowerCase()),
      ...newFolders.map((f) => f.name.trim().toLowerCase()),
    ]);

    for (const c of parsedCards) {
      const folderKey = c.folderName.trim().toLowerCase();
      if (!allKnownFolderNames.has(folderKey)) {
        errors.push({
          row: c.row,
          message: `الفولدر "${c.folderName}" غير موجود في شيت Folders`,
        });
        continue;
      }
      const cardKey = `${folderKey}::${c.title.trim().toLowerCase()}`;
      const existing = existingCardByFolderTitle.get(cardKey);
      if (existing) {
        duplicateCards.push({
          key: `${existing._id}::${c.row}`,
          existingId: String(existing._id),
          folderName: c.folderName,
          existing: {
            row: c.row,
            folderName: c.folderName,
            title: existing.title,
            cardType: existing.cardType,
            scenario: existing.scenario || '',
            customerQuestion: existing.customerQuestion || '',
            response: existing.response,
            internalNotes: existing.internalNotes || '',
            tags: existing.tags || [],
            isActive: existing.isActive !== false,
          },
          incoming: c,
        });
      } else {
        newCards.push(c);
      }
    }

    return { newFolders, newCards, duplicateCards, errors };
  }

  private parseFoldersSheet(
    ws: ExcelJS.Worksheet | undefined,
    errors: ImportPreviewError[],
  ): ParsedFolderRow[] {
    if (!ws) return [];
    const out: ParsedFolderRow[] = [];
    ws.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const name = cellText(row.getCell('name').value);
      if (!name) return;
      const order = Number(cellText(row.getCell('order').value)) || 0;
      out.push({
        row: rowNumber,
        name,
        description: cellText(row.getCell('description').value),
        icon: cellText(row.getCell('icon').value) || 'folder',
        order,
        isActive: parseBoolAr(cellText(row.getCell('isActive').value)),
      });
    });
    return out;
  }

  private parseCardsSheet(
    ws: ExcelJS.Worksheet | undefined,
    errors: ImportPreviewError[],
  ): ParsedCardRow[] {
    if (!ws) return [];
    const out: ParsedCardRow[] = [];
    ws.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const folderName = cellText(row.getCell('folderName').value);
      const title = cellText(row.getCell('title').value);
      const response = cellText(row.getCell('response').value);
      if (!folderName && !title && !response) return; // skip fully blank rows

      if (!folderName || !title || !response) {
        errors.push({
          row: rowNumber,
          message: 'الفولدر والعنوان والرد حقول مطلوبة',
        });
        return;
      }
      let cardType = (cellText(row.getCell('cardType').value) || 'response') as CardType;
      if (!CARD_TYPES.includes(cardType)) {
        errors.push({ row: rowNumber, message: `نوع البطاقة "${cardType}" غير صالح` });
        cardType = 'response';
      }
      const tags = cellText(row.getCell('tags').value)
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      out.push({
        row: rowNumber,
        folderName,
        title,
        cardType,
        scenario: cellText(row.getCell('scenario').value),
        customerQuestion: cellText(row.getCell('customerQuestion').value),
        response,
        internalNotes: cellText(row.getCell('internalNotes').value),
        tags,
        isActive: parseBoolAr(cellText(row.getCell('isActive').value)),
      });
    });
    return out;
  }

  // ── Import: confirm ──

  async confirmImport(dto: ConfirmImportDto, actor: Actor): Promise<{
    createdFolders: number;
    createdCards: number;
    updatedCards: number;
    skippedDuplicates: number;
    errors: ImportPreviewError[];
  }> {
    const actorName = actor.name || actor.username || '';
    let createdFolders = 0;
    let createdCards = 0;
    let updatedCards = 0;
    let skippedDuplicates = 0;

    const folderNameToId = new Map<string, string>();
    const existingFolders = await this.folderModel.find().lean().exec();
    existingFolders.forEach((f) => folderNameToId.set(f.name.trim().toLowerCase(), String(f._id)));

    for (const f of dto.newFolders || []) {
      const key = f.name.trim().toLowerCase();
      if (folderNameToId.has(key)) continue; // already exists (race since preview)
      const folder = await this.folderModel.create({
        name: f.name,
        description: f.description || '',
        icon: f.icon || 'folder',
        order: f.order || 0,
        isActive: f.isActive !== false,
        createdBy: actorName,
        updatedBy: actorName,
      });
      folderNameToId.set(key, String(folder._id));
      createdFolders++;
      await this.logAudit('folder', String(folder._id), 'created', actor, `استيراد: أنشأ فولدر: ${folder.name}`);
    }

    for (const c of dto.newCards || []) {
      const folderId = folderNameToId.get(c.folderName.trim().toLowerCase());
      if (!folderId) continue;
      const card = await this.cardModel.create({
        folderId,
        title: c.title,
        scenario: c.scenario || '',
        customerQuestion: c.customerQuestion || '',
        response: c.response,
        internalNotes: c.internalNotes || '',
        cardType: c.cardType || 'response',
        tags: c.tags || [],
        isActive: c.isActive !== false,
        createdBy: actorName,
        updatedBy: actorName,
      });
      createdCards++;
      await this.logAudit('card', String(card._id), 'created', actor, `استيراد: أنشأ بطاقة: ${card.title}`);
    }

    for (const dup of dto.duplicateCards || []) {
      const decision = dto.decisions?.[dup.key] || 'skip';
      if (decision === 'skip') {
        skippedDuplicates++;
        continue;
      }
      if (decision === 'update') {
        const card = await this.cardModel.findById(dup.existingId).exec();
        if (!card) continue;
        const incoming = dup.incoming;
        Object.assign(card, {
          title: incoming.title,
          scenario: incoming.scenario || '',
          customerQuestion: incoming.customerQuestion || '',
          response: incoming.response,
          internalNotes: incoming.internalNotes || '',
          cardType: incoming.cardType || 'response',
          tags: incoming.tags || [],
          isActive: incoming.isActive !== false,
          updatedBy: actorName,
        });
        await card.save();
        updatedCards++;
        await this.logAudit('card', String(card._id), 'updated', actor, `استيراد: عدّل بطاقة: ${card.title}`);
        continue;
      }
      if (decision === 'duplicate') {
        const folderId = folderNameToId.get(dup.folderName.trim().toLowerCase());
        if (!folderId) continue;
        const incoming = dup.incoming;
        const card = await this.cardModel.create({
          folderId,
          title: incoming.title,
          scenario: incoming.scenario || '',
          customerQuestion: incoming.customerQuestion || '',
          response: incoming.response,
          internalNotes: incoming.internalNotes || '',
          cardType: incoming.cardType || 'response',
          tags: incoming.tags || [],
          isActive: incoming.isActive !== false,
          createdBy: actorName,
          updatedBy: actorName,
        });
        createdCards++;
        await this.logAudit('card', String(card._id), 'created', actor, `استيراد: أنشأ بطاقة (نسخة): ${card.title}`);
      }
    }

    const errors = dto.errors || [];
    await this.importLogModel.create({
      userId: actor.userId || '',
      username: actorName,
      filename: dto.filename,
      createdFolders,
      createdCards,
      updatedCards,
      skippedDuplicates,
      errors,
    });

    return { createdFolders, createdCards, updatedCards, skippedDuplicates, errors };
  }

  async getImportHistory(limit = 30, skip = 0): Promise<KnowledgeImportLogDocument[]> {
    return this.importLogModel
      .find()
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .exec();
  }

  private async logAudit(
    entityType: 'folder' | 'card',
    entityId: string,
    action: 'created' | 'updated' | 'deleted',
    actor: Actor,
    summary: string,
  ): Promise<void> {
    await this.auditModel.create({
      entityType,
      entityId,
      action,
      userId: actor.userId || '',
      username: actor.name || actor.username || '',
      summary,
    });
  }
}
