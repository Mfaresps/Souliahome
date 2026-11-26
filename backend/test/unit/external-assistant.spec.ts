import 'reflect-metadata';
import {
  MAIL_MAX_ATTEMPTS, REPLY_LIMITS, cleanChatId, cleanQuestion, mailBody, mailSubject, nextRetryDelayMin, safeUrl, validateReply,
} from '../../src/assistant/external-assistant.util';
import { API_SCOPE_CODES, normalizeScopes } from '../../src/public-api/api-key.util';
import { readFileSync } from 'fs';
import { join } from 'path';
import { AssistantService } from '../../src/assistant/assistant.service';

export {};
const base = { chatId: 'chat_abcdef123', messageId: 'xm_abcdefghijkl' };
const table = (cols: number, rows: number, cell = 'x') => ({ caption: 'c', columns: Array.from({ length: cols }, (_, i) => 'h' + i), rows: Array.from({ length: rows }, () => Array.from({ length: cols }, () => cell)) });

describe('External assistant — the email', () => {
  it('has the subject [ERP-CHAT] <chatId> and a JSON body with exactly the six fields, in order', () => {
    expect(mailSubject('chat_x1y2z3')).toBe('[ERP-CHAT] chat_x1y2z3');
    const body = mailBody({ chatId: 'chat_x1y2z3', messageId: 'xm_1', userName: 'منى', userRole: 'staff', question: 'كم أوردر اتلغى؟', createdAt: '2026-11-26T10:00:00.000Z', ...({ extra: 'no' } as any) });
    const parsed = JSON.parse(body);
    expect(Object.keys(parsed)).toEqual(['chatId', 'messageId', 'userName', 'userRole', 'question', 'createdAt']);
    expect(parsed.question).toBe('كم أوردر اتلغى؟');
  });

  it('retries on a schedule and gives up after the last attempt', () => {
    expect(nextRetryDelayMin(1)).toBe(1);
    expect(nextRetryDelayMin(2)).toBe(2);
    expect(nextRetryDelayMin(MAIL_MAX_ATTEMPTS - 1)).not.toBeNull();
    expect(nextRetryDelayMin(MAIL_MAX_ATTEMPTS)).toBeNull();
  });

  it('cleans the chat id and the question', () => {
    expect(cleanChatId('chat_ok-123')).toBe('chat_ok-123');
    expect(cleanChatId('a b')).toBe('');
    expect(cleanChatId('<script>')).toBe('');
    expect(cleanQuestion('  سؤال‮مقلوب\n\n\n\nسطر  ')).toBe('سؤال مقلوب\n\nسطر');
    expect(cleanQuestion('x'.repeat(5000)).length).toBe(1000);
  });
});

describe('External assistant — validating a reply', () => {
  it('accepts a full reply and stores numbers in cells as text', () => {
    const v = validateReply({ ...base, title: 'مبيعات', summary: 'ملخص', tables: [{ caption: 'أعلى', columns: ['المنتج', 'القطع'], rows: [['Bow', 12], ['Rug']] }], sourceLinks: [{ label: 'تقرير', url: 'https://example.com/a' }] });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.reply.tables[0].rows).toEqual([['Bow', '12'], ['Rug', '']]);
    expect(v.reply.sourceLinks[0].url).toBe('https://example.com/a');
  });

  it('refuses a missing id, an empty reply and malformed parts (REPLY_INVALID)', () => {
    const code = (b: any) => { const v: any = validateReply(b); return v.ok ? 'OK' : v.error.code; };
    expect(code({ messageId: base.messageId, title: 't' })).toBe('REPLY_INVALID');
    expect(code({ chatId: base.chatId, title: 't' })).toBe('REPLY_INVALID');
    expect(code({ ...base })).toBe('REPLY_INVALID');
    expect(code({ ...base, title: { a: 1 } })).toBe('REPLY_INVALID');
    expect(code({ ...base, tables: [{ columns: [], rows: [] }] })).toBe('REPLY_INVALID');
    expect(code({ ...base, tables: [{ columns: ['a'], rows: [['1', '2']] }] })).toBe('REPLY_INVALID');
    expect(code({ ...base, title: 't', sourceLinks: [{ label: 'x', url: 'javascript:alert(1)' }] })).toBe('REPLY_INVALID');
    expect(code({ ...base, title: 't', sourceLinks: [{ label: 'x', url: 'data:text/html,hi' }] })).toBe('REPLY_INVALID');
    expect(safeUrl('ftp://x')).toBe('');
  });

  it('refuses anything over a limit with REPLY_TOO_LARGE, never a cut-down reply', () => {
    const code = (b: any) => { const v: any = validateReply(b); return v.ok ? 'OK' : v.error.code; };
    expect(code({ ...base, title: 'x'.repeat(REPLY_LIMITS.title + 1) })).toBe('REPLY_TOO_LARGE');
    expect(code({ ...base, summary: 'x'.repeat(REPLY_LIMITS.summary + 1) })).toBe('REPLY_TOO_LARGE');
    expect(code({ ...base, tables: Array.from({ length: REPLY_LIMITS.tables + 1 }, () => table(1, 1)) })).toBe('REPLY_TOO_LARGE');
    expect(code({ ...base, tables: [table(REPLY_LIMITS.columns + 1, 1)] })).toBe('REPLY_TOO_LARGE');
    expect(code({ ...base, tables: [table(1, REPLY_LIMITS.rowsPerTable + 1)] })).toBe('REPLY_TOO_LARGE');
    expect(code({ ...base, tables: [table(1, 1, 'x'.repeat(REPLY_LIMITS.cell + 1))] })).toBe('REPLY_TOO_LARGE');
    // 4 tables × 200 rows × 4 columns = 3,200 cells > 3,000 (each table within its own limits).
    expect(code({ ...base, tables: Array.from({ length: 4 }, () => table(4, 200, '1')) })).toBe('REPLY_TOO_LARGE');
    expect(code({ ...base, sourceLinks: Array.from({ length: REPLY_LIMITS.links + 1 }, () => ({ label: 'a', url: 'https://a.b' })) })).toBe('REPLY_TOO_LARGE');
    // Under every count limit but over the byte cap (Express refuses > 100 KB before the code runs).
    expect(code({ ...base, tables: [table(10, 30, 'x'.repeat(400))] })).toBe('REPLY_TOO_LARGE');
    expect(code({ ...base, tables: [table(REPLY_LIMITS.columns, 20, '1')] })).toBe('OK');
  });
});

describe('External assistant — the API key section', () => {
  it('adds assistant-write as its own section, implying nothing else', () => {
    expect(API_SCOPE_CODES).toContain('assistant-write');
    expect(normalizeScopes(['assistant-write'])).toEqual(['assistant-write']);
  });

  it('guards POST /v1/assistant/replies with assistant-write', () => {
    // Read from the source: loading the controller would type-check every service it imports.
    const src = readFileSync(join(__dirname, '../../src/public-api/public-api.controller.ts'), 'utf8');
    expect(src).toMatch(/@ApiScopeRequired\('assistant-write'\) @Post\('assistant\/replies'\)/);
  });
});

describe('System assistant — never answers an external question', () => {
  it('refuses target = external before reading anything', async () => {
    const svc = new AssistantService(null as any, null as any, null as any, null as any, null as any, null as any);
    await expect(svc.ask({ userId: 'u1' }, { question: 'مبيعات اليوم', target: 'external' })).rejects.toMatchObject({ response: { code: 'WRONG_TARGET' } });
  });
});

describe('mail failure reason (shown to admins)', () => {
  const { mailErrorText, mailFailureKind } = require('../../src/assistant/external-assistant.util');
  it('writes the error code once', () => {
    expect(mailErrorText({ code: 'SMTP_NOT_CONFIGURED', message: 'SMTP_NOT_CONFIGURED: set SMTP_USER' })).toBe('SMTP_NOT_CONFIGURED: set SMTP_USER');
    expect(mailErrorText({ code: 'EAUTH', message: 'Invalid login: 535-5.7.8' })).toBe('EAUTH: Invalid login: 535-5.7.8');
  });
  it('classifies the four kinds', () => {
    expect(mailFailureKind('SMTP_NOT_CONFIGURED: SMTP_NOT_CONFIGURED: set SMTP_USER')).toBe('not-configured');
    expect(mailFailureKind('EAUTH: Invalid login: 535-5.7.8 Username and Password not accepted')).toBe('auth');
    expect(mailFailureKind('ETIMEDOUT: Connection timeout')).toBe('network');
    expect(mailFailureKind('ESOCKET: connect ECONNREFUSED 1.2.3.4:465')).toBe('network');
    expect(mailFailureKind('EENVELOPE: No recipients defined')).toBe('other');
    expect(mailFailureKind('')).toBe('');
  });
});
