import { randomBytes } from 'crypto';

/**
 * The bridge between «مساعد SOULIA» and the external assistant (Instinct) — pure rules, no I/O.
 *
 * Two kinds of message live in one chat and must never mix:
 *  • target = 'system'   → answered by the system's own assistant (POST /assistant/ask). Never emailed.
 *  • target = 'external' → emailed to the external assistant; its answer comes back through
 *                          POST /api/v1/assistant/replies. The system's assistant never answers it.
 * A message sent to the wrong side is never moved automatically — the employee re-sends it.
 */
export const ASSISTANT_TARGETS = ['system', 'external'] as const;
export type AssistantTarget = (typeof ASSISTANT_TARGETS)[number];

export const EXTERNAL_COLLECTION = 'assistantexternalmessages';
export const DEFAULT_EXTERNAL_MAIL_TO = 'souliaalerts@gmail.com';
export const MAX_EXTERNAL_QUESTION = 1000;

/** Mail retries: after the first try, then waits (minutes) before each later attempt. */
export const MAIL_RETRY_MINUTES = [1, 2, 5, 10, 30, 60, 120];
export const MAIL_MAX_ATTEMPTS = MAIL_RETRY_MINUTES.length + 1;

/** Reply size limits (a reply is drawn inside a 420px chat panel). */
export const REPLY_LIMITS = {
  title: 200,
  summary: 6000,
  tables: 5,
  caption: 200,
  columns: 12,
  rowsPerTable: 200,
  cell: 500,
  cellsTotal: 3000,
  links: 10,
  linkLabel: 160,
  url: 2000,
  /** The whole body as JSON. ⚠ Express refuses any JSON body over 100 KB with a bare 413 before
   *  this code runs — this cap keeps a large reply on the coded REPLY_TOO_LARGE path below that. */
  bytes: 90_000,
};

export function newChatId(): string { return 'chat_' + randomBytes(9).toString('base64url'); }
export function newMessageId(): string { return 'xm_' + randomBytes(12).toString('base64url'); }

/** A chat id from the browser: letters, digits, `_` and `-` only, 6–64 chars. */
export function cleanChatId(v: unknown): string {
  const s = String(v ?? '').trim();
  return /^[A-Za-z0-9_-]{6,64}$/.test(s) ? s : '';
}

/** Question text: no control or bidi-override characters, line breaks kept, trimmed, capped. */
export function cleanQuestion(v: unknown, max = MAX_EXTERNAL_QUESTION): string {
  return String(v ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f\u202A-\u202E\u2066-\u2069]/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

/** The JSON body of the email — exactly these fields, in this order. */
export interface ExternalMailPayload { chatId: string; messageId: string; userName: string; userRole: string; question: string; createdAt: string }

export function mailSubject(chatId: string): string { return `[ERP-CHAT] ${chatId}`; }
export function mailBody(p: ExternalMailPayload): string {
  return JSON.stringify({ chatId: p.chatId, messageId: p.messageId, userName: p.userName, userRole: p.userRole, question: p.question, createdAt: p.createdAt }, null, 2);
}

/** Minutes to wait before the next attempt after `attempts` failed tries; null = give up. */
export function nextRetryDelayMin(attempts: number): number | null {
  if (attempts >= MAIL_MAX_ATTEMPTS) return null;
  return MAIL_RETRY_MINUTES[Math.max(0, attempts - 1)] ?? null;
}

export interface ReplyTable { caption: string; columns: string[]; rows: string[][] }
export interface ReplyLink { label: string; url: string }
export interface CleanReply { chatId: string; messageId: string; title: string; summary: string; tables: ReplyTable[]; sourceLinks: ReplyLink[] }
export interface ReplyError { code: 'REPLY_INVALID' | 'REPLY_TOO_LARGE'; message: string }

const text = (v: unknown) => (v == null ? '' : typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : null);
const tidy = (s: string) => s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f\u202A-\u202E\u2066-\u2069]/g, ' ').trim();

/** Only http(s) links — a `javascript:` URL in a chat answer would run on a click. */
export function safeUrl(v: unknown): string {
  const s = String(v ?? '').trim();
  if (!s || s.length > REPLY_LIMITS.url) return '';
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : '';
  } catch { return ''; }
}

/**
 * Validates a reply body. Too large → REPLY_TOO_LARGE (never truncated silently: a cut table would
 * read as the whole answer). Malformed → REPLY_INVALID. Everything stored is plain text.
 */
/** Exactly one of `reply` / `error` is set. */
export interface ReplyCheck { ok: boolean; reply?: CleanReply; error?: ReplyError }
export function validateReply(body: any): ReplyCheck {
  const bad = (message: string): ReplyCheck => ({ ok: false, error: { code: 'REPLY_INVALID', message } });
  const big = (message: string): ReplyCheck => ({ ok: false, error: { code: 'REPLY_TOO_LARGE', message } });
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('Body must be a JSON object');
  let size = 0;
  try { size = Buffer.byteLength(JSON.stringify(body), 'utf8'); } catch { return bad('Body is not valid JSON'); }
  if (size > REPLY_LIMITS.bytes) return big(`The reply is larger than ${REPLY_LIMITS.bytes} bytes`);
  const chatId = cleanChatId(body.chatId);
  const messageId = String(body.messageId ?? '').trim();
  if (!chatId) return bad('chatId is required');
  if (!/^xm_[A-Za-z0-9_-]{6,40}$/.test(messageId)) return bad('messageId is required');

  const title = text(body.title); const summary = text(body.summary);
  if (title === null) return bad('title must be text');
  if (summary === null) return bad('summary must be text');
  if (title.length > REPLY_LIMITS.title) return big(`title is longer than ${REPLY_LIMITS.title} characters`);
  if (summary.length > REPLY_LIMITS.summary) return big(`summary is longer than ${REPLY_LIMITS.summary} characters`);

  const rawTables = body.tables == null ? [] : body.tables;
  if (!Array.isArray(rawTables)) return bad('tables must be an array');
  if (rawTables.length > REPLY_LIMITS.tables) return big(`at most ${REPLY_LIMITS.tables} tables`);
  const tables: ReplyTable[] = [];
  let cells = 0;
  for (let i = 0; i < rawTables.length; i++) {
    const t = rawTables[i];
    if (!t || typeof t !== 'object') return bad(`tables[${i}] must be an object`);
    const caption = text(t.caption);
    if (caption === null) return bad(`tables[${i}].caption must be text`);
    if (caption.length > REPLY_LIMITS.caption) return big(`tables[${i}].caption is too long`);
    if (!Array.isArray(t.columns) || !t.columns.length) return bad(`tables[${i}].columns must be a non-empty array`);
    if (t.columns.length > REPLY_LIMITS.columns) return big(`tables[${i}] has more than ${REPLY_LIMITS.columns} columns`);
    const columns: string[] = [];
    for (const c of t.columns) {
      const s = text(c);
      if (s === null) return bad(`tables[${i}].columns must hold text`);
      if (s.length > REPLY_LIMITS.cell) return big(`tables[${i}] has a column name that is too long`);
      columns.push(tidy(s));
    }
    const rawRows = t.rows == null ? [] : t.rows;
    if (!Array.isArray(rawRows)) return bad(`tables[${i}].rows must be an array`);
    if (rawRows.length > REPLY_LIMITS.rowsPerTable) return big(`tables[${i}] has more than ${REPLY_LIMITS.rowsPerTable} rows`);
    const rows: string[][] = [];
    for (let r = 0; r < rawRows.length; r++) {
      const row = rawRows[r];
      if (!Array.isArray(row)) return bad(`tables[${i}].rows[${r}] must be an array`);
      if (row.length > columns.length) return bad(`tables[${i}].rows[${r}] has more cells than columns`);
      const out: string[] = [];
      for (const c of row) {
        const s = text(c);
        if (s === null) return bad(`tables[${i}].rows[${r}] must hold text or numbers`);
        if (s.length > REPLY_LIMITS.cell) return big(`tables[${i}].rows[${r}] has a cell longer than ${REPLY_LIMITS.cell} characters`);
        out.push(tidy(s));
      }
      while (out.length < columns.length) out.push('');
      cells += out.length;
      if (cells > REPLY_LIMITS.cellsTotal) return big(`more than ${REPLY_LIMITS.cellsTotal} table cells in total`);
      rows.push(out);
    }
    tables.push({ caption: tidy(caption), columns, rows });
  }

  const rawLinks = body.sourceLinks == null ? [] : body.sourceLinks;
  if (!Array.isArray(rawLinks)) return bad('sourceLinks must be an array');
  if (rawLinks.length > REPLY_LIMITS.links) return big(`at most ${REPLY_LIMITS.links} sourceLinks`);
  const sourceLinks: ReplyLink[] = [];
  for (let i = 0; i < rawLinks.length; i++) {
    const l = rawLinks[i];
    if (!l || typeof l !== 'object') return bad(`sourceLinks[${i}] must be an object`);
    const url = safeUrl(l.url);
    if (!url) return bad(`sourceLinks[${i}].url must be an http(s) URL`);
    const label = text(l.label);
    if (label === null) return bad(`sourceLinks[${i}].label must be text`);
    if (label.length > REPLY_LIMITS.linkLabel) return big(`sourceLinks[${i}].label is too long`);
    sourceLinks.push({ label: tidy(label) || url, url });
  }

  const cleanTitle = tidy(title); const cleanSummary = tidy(summary);
  if (!cleanTitle && !cleanSummary && !tables.length && !sourceLinks.length) return bad('The reply is empty');
  return { ok: true, reply: { chatId, messageId, title: cleanTitle, summary: cleanSummary, tables, sourceLinks } };
}
