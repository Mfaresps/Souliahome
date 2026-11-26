import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleInit, Optional } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Cron } from '@nestjs/schedule';
import { Connection, Types } from 'mongoose';
import { PresenceGateway } from '../auth/presence.gateway';
import {
  EXTERNAL_COLLECTION, MAIL_MAX_ATTEMPTS, cleanChatId, cleanQuestion, mailBody, mailSubject,
  newMessageId, nextRetryDelayMin, validateReply,
} from './external-assistant.util';
import { MailSender, SmtpMailSender } from './external-mailer';

export interface ExternalAsker { userId?: string; username?: string; name?: string; role?: string }

/** A sending claim older than this is taken again (the process died mid-send). */
const STALE_SEND_MS = 5 * 60_000;

/**
 * «المساعد الخارجي (Instinct)» inside the SOULIA chat.
 *
 * A question with target = 'external' is stored here and emailed; the external assistant answers it
 * through POST /api/v1/assistant/replies. Rules:
 *  • The system's own assistant never sees these rows, and nothing here answers a 'system' question.
 *  • A row is only ever moved by its own events: mail pending → sending → sent | failed (retried) |
 *    gave-up; status awaiting → answered (once — a second reply is 409).
 *  • Every send is claimed atomically, so two workers (or the request and the cron) never mail twice.
 */
@Injectable()
export class ExternalAssistantService implements OnModuleInit {
  private readonly logger = new Logger('ExternalAssistant');
  /** Replaced in tests. */
  mailer: MailSender = new SmtpMailSender();

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @Optional() private readonly presence?: PresenceGateway,
  ) {}

  private get col() { return this.connection.collection(EXTERNAL_COLLECTION); }

  async onModuleInit() {
    try {
      await this.col.createIndex({ userId: 1, chatId: 1, createdAt: 1 });
      await this.col.createIndex({ 'mail.status': 1, 'mail.nextAttemptAt': 1 });
      await this.col.createIndex(
        { userId: 1, requestKey: 1 },
        { unique: true, partialFilterExpression: { requestKey: { $type: 'string' } }, name: 'external_request_key_unique' },
      );
    } catch (e: any) {
      this.logger.warn(`index setup: ${e?.message || e}`);
    }
  }

  /** Where the questions go (shown to admins; never the SMTP password). */
  mailInfo() { return this.mailer.describe(); }

  // ── Sending a question ───────────────────────────────────────────────────────────────────────
  async ask(user: ExternalAsker, body: any) {
    if (body?.target !== 'external') {
      throw new BadRequestException({ code: 'WRONG_TARGET', message: 'هذا المسار للمساعد الخارجي فقط — أسئلة النظام تُرسل إلى مساعد SOULIA' });
    }
    const chatId = cleanChatId(body?.chatId);
    if (!chatId) throw new BadRequestException({ code: 'CHAT_ID_REQUIRED', message: 'معرّف المحادثة غير صالح' });
    const question = cleanQuestion(body?.question);
    if (!question) throw new BadRequestException({ code: 'QUESTION_REQUIRED', message: 'اكتب سؤالًا' });
    const userId = String(user?.userId || '');
    if (!userId) throw new BadRequestException('تعذّر تحديد المستخدم');
    const requestKey = typeof body?.requestKey === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(body.requestKey) ? body.requestKey : undefined;

    if (requestKey) {
      const prev = await this.col.findOne({ userId, requestKey });
      if (prev) return this.view(prev);
    }

    const who = await this.asker(user);
    const now = new Date();
    const doc: any = {
      _id: newMessageId(),
      chatId,
      target: 'external',
      userId,
      userName: who.name,
      userRole: who.role,
      question,
      createdAt: now,
      status: 'awaiting',
      mail: { status: 'pending', attempts: 0, nextAttemptAt: now, log: [] },
      ...(requestKey ? { requestKey } : {}),
    };
    try {
      await this.col.insertOne(doc);
    } catch (e: any) {
      if (e?.code === 11000 && requestKey) {
        const prev = await this.col.findOne({ userId, requestKey });
        if (prev) return this.view(prev);
      }
      throw e;
    }
    // Sent at once; a failure stays queued for the retry worker and the row still awaits its reply.
    await this.deliver(String(doc._id));
    return this.view(await this.col.findOne({ _id: doc._id } as any));
  }

  private async asker(user: ExternalAsker): Promise<{ name: string; role: string }> {
    let row: any = null;
    try {
      if (user?.userId && Types.ObjectId.isValid(String(user.userId))) {
        row = await this.connection.collection('users').findOne(
          { _id: new Types.ObjectId(String(user.userId)) },
          { projection: { name: 1, username: 1, role: 1 } },
        );
      }
    } catch { /* fall back to the token */ }
    return {
      name: String(row?.name || row?.username || user?.name || user?.username || ''),
      role: String(row?.role || user?.role || ''),
    };
  }

  /** Claims one message for sending and mails it. Returns false when someone else holds it. */
  async deliver(id: string): Promise<boolean> {
    const now = new Date();
    const claimed: any = await this.col.findOneAndUpdate(
      {
        _id: id as any,
        $or: [
          { 'mail.status': { $in: ['pending', 'failed'] }, 'mail.nextAttemptAt': { $lte: now } },
          { 'mail.status': 'sending', 'mail.claimedAt': { $lt: new Date(now.getTime() - STALE_SEND_MS) } },
        ],
      },
      { $set: { 'mail.status': 'sending', 'mail.claimedAt': now }, $inc: { 'mail.attempts': 1 } },
      { returnDocument: 'after' },
    );
    const doc = claimed && (claimed.value !== undefined ? claimed.value : claimed);
    if (!doc || !doc._id) return false;
    const attempts = Number(doc.mail?.attempts) || 1;
    try {
      const r = await this.mailer.send({
        subject: mailSubject(doc.chatId),
        text: mailBody({
          chatId: doc.chatId, messageId: String(doc._id), userName: doc.userName || '', userRole: doc.userRole || '',
          question: doc.question, createdAt: new Date(doc.createdAt).toISOString(),
        }),
        headers: { 'X-Soulia-Chat-Id': doc.chatId, 'X-Soulia-Message-Id': String(doc._id) },
      });
      await this.col.updateOne({ _id: doc._id, 'mail.status': 'sending' }, {
        $set: { 'mail.status': 'sent', 'mail.sentAt': new Date(), 'mail.smtpId': r.id, 'mail.lastError': null },
        $unset: { 'mail.claimedAt': '' },
        $push: { 'mail.log': { $each: [{ at: new Date(), ok: true }], $slice: -10 } } as any,
      });
      return true;
    } catch (e: any) {
      const error = String(e?.code || '') + (e?.code ? ': ' : '') + String(e?.message || e).slice(0, 300);
      const wait = nextRetryDelayMin(attempts);
      this.logger.warn(`mail for ${doc._id} failed (attempt ${attempts}/${MAIL_MAX_ATTEMPTS}): ${error}`);
      await this.col.updateOne({ _id: doc._id, 'mail.status': 'sending' }, {
        $set: {
          'mail.status': wait == null ? 'gave-up' : 'failed',
          'mail.lastError': error,
          'mail.nextAttemptAt': wait == null ? null : new Date(Date.now() + wait * 60_000),
        },
        $unset: { 'mail.claimedAt': '' },
        $push: { 'mail.log': { $each: [{ at: new Date(), ok: false, error }], $slice: -10 } } as any,
      });
      return false;
    }
  }

  /** Retries due sends (and sends left half-way by a restart). */
  @Cron('*/30 * * * * *', { name: 'external-assistant-mail-retry' })
  async retryDue(limit = 20) {
    const now = new Date();
    const due = await this.col.find(
      {
        $or: [
          { 'mail.status': { $in: ['pending', 'failed'] }, 'mail.nextAttemptAt': { $lte: now } },
          { 'mail.status': 'sending', 'mail.claimedAt': { $lt: new Date(now.getTime() - STALE_SEND_MS) } },
        ],
      },
      { projection: { _id: 1 }, sort: { createdAt: 1 }, limit },
    ).toArray();
    let sent = 0;
    for (const d of due) if (await this.deliver(String(d._id))) sent++;
    return { tried: due.length, sent };
  }

  // ── Reading (the asker only) ─────────────────────────────────────────────────────────────────
  async listMine(user: ExternalAsker, q: { chatId?: string; ids?: string }) {
    const userId = String(user?.userId || '');
    const filter: any = { userId };
    const chatId = cleanChatId(q?.chatId);
    if (chatId) filter.chatId = chatId;
    const ids = String(q?.ids || '').split(',').map((s) => s.trim()).filter((s) => /^xm_[A-Za-z0-9_-]{6,40}$/.test(s)).slice(0, 100);
    if (ids.length) filter._id = { $in: ids };
    if (!chatId && !ids.length) return { items: [] };
    const rows = await this.col.find(filter, { sort: { createdAt: 1 }, limit: 100 }).toArray();
    return { items: rows.map((r) => this.view(r)) };
  }

  view(r: any) {
    if (!r) return null;
    return {
      messageId: String(r._id),
      chatId: r.chatId,
      target: 'external',
      question: r.question,
      createdAt: r.createdAt,
      status: r.status === 'answered' ? 'answered' : 'awaiting',
      mail: {
        status: r.mail?.status || 'pending',
        attempts: Number(r.mail?.attempts) || 0,
        sentAt: r.mail?.sentAt || null,
        nextAttemptAt: r.mail?.nextAttemptAt || null,
      },
      reply: r.reply || null,
      repliedAt: r.repliedAt || null,
    };
  }

  // ── The external assistant's answer (POST /api/v1/assistant/replies) ─────────────────────────
  async receiveReply(body: any, apiKey: { _id?: any; name?: string } | null) {
    const v = validateReply(body);
    if (!v.ok || !v.reply) throw new BadRequestException({ code: v.error?.code || 'REPLY_INVALID', message: v.error?.message || 'Invalid reply' });
    const reply = v.reply;
    const doc: any = await this.col.findOne({ _id: reply.messageId as any });
    if (!doc || doc.chatId !== reply.chatId) {
      throw new NotFoundException({ code: 'MESSAGE_NOT_FOUND', message: 'No external question with this chatId and messageId' });
    }
    const at = new Date();
    const stored = { title: reply.title, summary: reply.summary, tables: reply.tables, sourceLinks: reply.sourceLinks };
    const r = await this.col.updateOne(
      { _id: doc._id, reply: { $exists: false } },
      { $set: { reply: stored, status: 'answered', repliedAt: at, repliedBy: { keyId: apiKey?._id ? String(apiKey._id) : '', keyName: apiKey?.name || '' } } },
    );
    if (r.matchedCount !== 1) {
      const now: any = await this.col.findOne({ _id: doc._id }, { projection: { repliedAt: 1 } });
      throw new ConflictException({ code: 'ALREADY_REPLIED', message: 'This message already has a reply', repliedAt: now?.repliedAt || null });
    }
    try { this.presence?.emitToUser(String(doc.userId), 'assistant:external-reply', { messageId: String(doc._id), chatId: doc.chatId }); } catch { /* offline */ }
    return { ok: true, messageId: String(doc._id), chatId: doc.chatId, repliedAt: at };
  }
}
