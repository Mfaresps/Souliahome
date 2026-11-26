import mongoose, { Connection, Types } from 'mongoose';
import { ExternalAssistantService } from '../../src/assistant/external-assistant.service';
import { EXTERNAL_COLLECTION, MAIL_MAX_ATTEMPTS } from '../../src/assistant/external-assistant.util';
import { MailMessage } from '../../src/assistant/external-mailer';

export {};
const dbName = `soulia_test_extasst_${process.pid}_${Date.now()}`;
let connection: Connection;
let service: ExternalAssistantService;
const emitted: { userId: string; event: string; payload: any }[] = [];
const presence: any = { emitToUser: (userId: string, event: string, payload: any) => { emitted.push({ userId, event, payload }); return true; } };

/** A fake SMTP sender: records every mail; `fail` makes the next sends throw. */
const sent: MailMessage[] = [];
let fail = 0;
let delayMs = 0;
const fakeMailer = {
  async send(m: MailMessage) {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (fail > 0) { fail--; const e: any = new Error('connect ECONNREFUSED'); e.code = 'ECONNECTION'; throw e; }
    sent.push(m); return { id: '<' + sent.length + '@test>' };
  },
  describe: () => ({ from: 'erp@test', to: 'souliaalerts@gmail.com', configured: true }),
};

const mona = { userId: new Types.ObjectId().toString(), name: 'منى', username: 'mona', role: 'staff' };
const omar = { userId: new Types.ObjectId().toString(), name: 'Omar', username: 'omar', role: 'admin' };
const col = () => connection.collection(EXTERNAL_COLLECTION);
const ask = (who = mona, extra: any = {}) => service.ask(who, { target: 'external', chatId: 'chat_test123', question: 'كم أوردر اتلغى الأسبوع ده؟', ...extra });
const key = { _id: new Types.ObjectId(), name: 'Instinct' };

beforeAll(async () => {
  connection = await mongoose.createConnection(`mongodb://localhost:27017/${dbName}`, { serverSelectionTimeoutMS: 3000 }).asPromise();
  service = new ExternalAssistantService(connection, presence);
  service.mailer = fakeMailer;
  await service.onModuleInit();
  // The token says "staff"; the account record is the source of name and role.
  await connection.collection('users').insertOne({ _id: new Types.ObjectId(mona.userId), name: 'منى أحمد', username: 'mona', role: 'staff' });
}, 15000);
afterAll(async () => {
  if (connection) {
    if (!/^soulia_test_extasst_\d+_\d+$/.test(connection.name)) throw new Error('Unsafe scratch database');
    await connection.dropDatabase(); await connection.close();
  }
});
beforeEach(async () => { sent.length = 0; emitted.length = 0; fail = 0; delayMs = 0; await col().deleteMany({}); });

describe('Sending a question to the external assistant', () => {
  it('stores target = external, mails it at once with the agreed subject and JSON, and waits for the reply', async () => {
    const r: any = await ask();
    expect(r.messageId).toMatch(/^xm_/);
    expect(r.status).toBe('awaiting');
    expect(r.mail.status).toBe('sent');
    const row: any = await col().findOne({ _id: r.messageId });
    expect(row.target).toBe('external');
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe('[ERP-CHAT] chat_test123');
    const body = JSON.parse(sent[0].text);
    expect(body).toEqual({ chatId: 'chat_test123', messageId: r.messageId, userName: 'منى أحمد', userRole: 'staff', question: 'كم أوردر اتلغى الأسبوع ده؟', createdAt: new Date(row.createdAt).toISOString() });
    expect(sent[0].headers).toMatchObject({ 'X-Soulia-Message-Id': r.messageId });
  });

  it('refuses a question that is not addressed to the external assistant', async () => {
    await expect(service.ask(mona, { target: 'system', chatId: 'chat_test123', question: 'x' })).rejects.toMatchObject({ response: { code: 'WRONG_TARGET' } });
    await expect(service.ask(mona, { chatId: 'chat_test123', question: 'x' })).rejects.toMatchObject({ response: { code: 'WRONG_TARGET' } });
    expect(await col().countDocuments()).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('sends once for a repeated request key (a retry after a lost answer)', async () => {
    const a: any = await ask(mona, { requestKey: 'rk_same_key_123' });
    const b: any = await ask(mona, { requestKey: 'rk_same_key_123' });
    expect(b.messageId).toBe(a.messageId);
    expect(await col().countDocuments()).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it('keeps a failed send queued, still awaiting its reply, and retries only when due', async () => {
    fail = 1;
    const r: any = await ask();
    expect(r.status).toBe('awaiting');
    expect(r.mail.status).toBe('failed');
    expect(r.mail.attempts).toBe(1);
    const row: any = await col().findOne({ _id: r.messageId });
    expect(row.mail.lastError).toMatch(/ECONNREFUSED/);
    expect(row.mail.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    expect((await service.retryDue()).tried).toBe(0); // not due yet
    await col().updateOne({ _id: r.messageId } as any, { $set: { 'mail.nextAttemptAt': new Date(Date.now() - 1000) } });
    expect(await service.retryDue()).toEqual({ tried: 1, sent: 1 });
    const after: any = await col().findOne({ _id: r.messageId });
    expect(after.mail.status).toBe('sent');
    expect(after.mail.attempts).toBe(2);
    expect(after.status).toBe('awaiting');
    expect(sent).toHaveLength(1);
  });

  it('gives up after the last attempt and never mails again', async () => {
    fail = 100;
    const r: any = await ask();
    for (let i = 1; i < MAIL_MAX_ATTEMPTS; i++) {
      await col().updateOne({ _id: r.messageId } as any, { $set: { 'mail.nextAttemptAt': new Date(Date.now() - 1000) } });
      await service.retryDue();
    }
    const row: any = await col().findOne({ _id: r.messageId });
    expect(row.mail.attempts).toBe(MAIL_MAX_ATTEMPTS);
    expect(row.mail.status).toBe('gave-up');
    expect(row.status).toBe('awaiting');
    fail = 0;
    expect((await service.retryDue()).tried).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('mails once when the request and two workers race for the same message', async () => {
    fail = 1;
    const r: any = await ask();
    await col().updateOne({ _id: r.messageId } as any, { $set: { 'mail.nextAttemptAt': new Date(Date.now() - 1000) } });
    delayMs = 50;
    const results = await Promise.all([service.deliver(r.messageId), service.deliver(r.messageId), service.retryDue()]);
    expect(sent).toHaveLength(1);
    expect(results.filter((x) => x === true).length + (results[2] as any).sent).toBe(1);
  });
});

describe('The external assistant\'s reply', () => {
  const reply = (r: any, extra: any = {}) => ({ chatId: 'chat_test123', messageId: r.messageId, title: 'إلغاءات الأسبوع', summary: '7 أوردرات', tables: [{ caption: 'الأسباب', columns: ['السبب', 'العدد'], rows: [['لا يرد', 4], ['غير متوفر', 3]] }], sourceLinks: [{ label: 'التقرير', url: 'https://example.com/r' }], ...extra });

  it('is stored once, closes «awaiting», and pings only the employee who asked', async () => {
    const r: any = await ask();
    const res = await service.receiveReply(reply(r), key);
    expect(res).toMatchObject({ ok: true, messageId: r.messageId, chatId: 'chat_test123' });
    const row: any = await col().findOne({ _id: r.messageId });
    expect(row.status).toBe('answered');
    expect(row.reply.tables[0].rows[0]).toEqual(['لا يرد', '4']);
    expect(row.repliedBy).toEqual({ keyId: String(key._id), keyName: 'Instinct' });
    expect(emitted).toEqual([{ userId: mona.userId, event: 'assistant:external-reply', payload: { messageId: r.messageId, chatId: 'chat_test123' } }]);

    const mine: any = await service.listMine(mona, { ids: r.messageId });
    expect(mine.items[0].status).toBe('answered');
    expect(mine.items[0].reply.title).toBe('إلغاءات الأسبوع');
    // Another employee never reads it.
    expect((await service.listMine(omar, { ids: r.messageId })).items).toHaveLength(0);
    expect((await service.listMine(omar, { chatId: 'chat_test123' })).items).toHaveLength(0);
  });

  it('answers 409 ALREADY_REPLIED to a second reply and keeps the first', async () => {
    const r: any = await ask();
    await service.receiveReply(reply(r), key);
    await expect(service.receiveReply(reply(r, { title: 'ثاني' }), key)).rejects.toMatchObject({ status: 409, response: { code: 'ALREADY_REPLIED' } });
    expect(((await col().findOne({ _id: r.messageId })) as any).reply.title).toBe('إلغاءات الأسبوع');
  });

  it('answers 404 MESSAGE_NOT_FOUND for an unknown message or a chat id that does not match', async () => {
    const r: any = await ask();
    await expect(service.receiveReply(reply({ messageId: 'xm_doesnotexist1' }), key)).rejects.toMatchObject({ status: 404, response: { code: 'MESSAGE_NOT_FOUND' } });
    await expect(service.receiveReply(reply(r, { chatId: 'chat_other99' }), key)).rejects.toMatchObject({ status: 404, response: { code: 'MESSAGE_NOT_FOUND' } });
    expect(((await col().findOne({ _id: r.messageId })) as any).status).toBe('awaiting');
  });

  it('refuses an oversized reply with 400 REPLY_TOO_LARGE and leaves the question awaiting', async () => {
    const r: any = await ask();
    const big = { caption: '', columns: ['a'], rows: Array.from({ length: 201 }, () => ['x']) };
    await expect(service.receiveReply(reply(r, { tables: [big] }), key)).rejects.toMatchObject({ status: 400, response: { code: 'REPLY_TOO_LARGE' } });
    expect(((await col().findOne({ _id: r.messageId })) as any).status).toBe('awaiting');
  });
});
