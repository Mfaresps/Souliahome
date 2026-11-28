import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

/**
 * Account invitations by email (Nov 28, 2026) — pure rules, no database.
 *
 * An admin enters an address and a role; the employee opens the link, fills in their own name,
 * username, phone, password and photo, and the account is created on the role the admin chose.
 */

/** A link lives 72 hours from its last send, and is used once. */
export const INVITE_TTL_MS = 72 * 3600_000;
/** Re-sending the same invitation: 60 s apart, 5 an hour. */
export const INVITE_RESEND_GAP_MS = 60_000;
export const INVITE_RESENDS_PER_HOUR = 5;
/** New invitations per admin per hour. */
export const INVITES_PER_ADMIN_HOUR = 20;

export const INVITE_TOKEN_RE = /^[A-Za-z0-9_-]{24}$/;

/** 18 random bytes → 24 url-safe characters (the short link). */
export function newInviteToken(): string {
  return randomBytes(18).toString('base64url');
}

export function inviteTokenHash(token: string): string {
  return createHash('sha256').update('soulia-invite:' + String(token || '')).digest('hex');
}

/**
 * The token is kept encrypted (AES-256-GCM, key from JWT_SECRET) so the admin can copy the
 * link again from the pending list; the lookup uses the hash only.
 */
function key(secret: string) { return createHash('sha256').update('soulia-invite-key:' + secret).digest(); }

export function sealInviteToken(token: string, secret: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(secret), iv);
  const enc = Buffer.concat([c.update(token, 'utf8'), c.final()]);
  return [iv.toString('base64url'), c.getAuthTag().toString('base64url'), enc.toString('base64url')].join('.');
}

export function openInviteToken(sealed: string, secret: string): string {
  try {
    const [iv, tag, enc] = String(sealed || '').split('.');
    const d = createDecipheriv('aes-256-gcm', key(secret), Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(enc, 'base64url')), d.final()]).toString('utf8');
  } catch { return ''; }
}

/** The site the link points to: APP_PUBLIC_URL, else the admin's own page origin (validated). */
export function cleanOrigin(raw: unknown, envUrl?: string): string {
  const pick = String(envUrl || '').trim() || String(raw || '').trim();
  const m = /^(https?:\/\/[a-z0-9.-]+(?::\d{1,5})?)\/?$/i.exec(pick);
  return m ? m[1].toLowerCase() : '';
}

export function inviteLink(origin: string, token: string): string {
  return `${origin}/join/${token}`;
}

export type InviteState = 'pending' | 'expired' | 'accepted' | 'cancelled';

export function inviteState(doc: { status?: string; expiresAt?: Date | string | null }, now = new Date()): InviteState {
  if (doc.status === 'accepted') return 'accepted';
  if (doc.status === 'cancelled') return 'cancelled';
  if (!doc.expiresAt || new Date(doc.expiresAt).getTime() <= now.getTime()) return 'expired';
  return 'pending';
}

// ─── Phone ─────────────────────────────────────────────────────────────────

const toLatinDigits = (s: string) => String(s || '')
  .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
  .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));

/** An Egyptian mobile number: 01[0125] + 8 digits. «+20» / «0020» / «20» prefixes are accepted. */
export function cleanPhone(raw: unknown): { phone: string; problem: string } {
  let d = toLatinDigits(String(raw ?? '')).replace(/[\s\-().]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  if (d.startsWith('0020')) d = d.slice(4);
  if (/^20\d{10}$/.test(d)) d = d.slice(2);
  if (/^1[0125]\d{8}$/.test(d)) d = '0' + d;
  if (!d) return { phone: '', problem: 'أدخل رقم الهاتف.' };
  if (!/^01[0125]\d{8}$/.test(d)) return { phone: '', problem: 'رقم الهاتف غير صحيح. أدخل رقم محمول مصريًا من 11 رقمًا يبدأ بـ 010 أو 011 أو 012 أو 015.' };
  return { phone: d, problem: '' };
}

// ─── Name & username ───────────────────────────────────────────────────────

export function cleanName(raw: unknown): { name: string; problem: string } {
  const name = String(raw ?? '').replace(/[\u0000-\u001f\u007f\u202A-\u202E\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim();
  if (name.length < 3) return { name: '', problem: 'أدخل اسمك الكامل.' };
  if (name.length > 60) return { name: '', problem: 'الاسم طويل جدًا (60 حرفًا على الأكثر).' };
  if (!/[\p{L}]/u.test(name)) return { name: '', problem: 'أدخل اسمك الكامل بالحروف.' };
  return { name, problem: '' };
}

export const USERNAME_RE = /^[a-z][a-z0-9._]{2,29}$/;

export function cleanUsername(raw: unknown): { username: string; problem: string } {
  const u = String(raw ?? '').trim().toLowerCase();
  if (!u) return { username: '', problem: 'أدخل اسم المستخدم.' };
  if (!USERNAME_RE.test(u) || /[._]{2}/.test(u) || /[._]$/.test(u)) {
    return { username: '', problem: 'اسم المستخدم من 3 إلى 30 حرفًا: حروف إنجليزية صغيرة وأرقام و«.» أو «_»، ويبدأ بحرف.' };
  }
  if (['admin', 'root', 'system', 'soulia', 'support'].includes(u)) return { username: '', problem: 'اسم المستخدم هذا محجوز. اختر اسمًا آخر.' };
  return { username: u, problem: '' };
}

/** Common names written the usual Egyptian way, before letter-by-letter transliteration. */
const KNOWN: Record<string, string> = {
  'محمد': 'mohamed', 'أحمد': 'ahmed', 'احمد': 'ahmed', 'محمود': 'mahmoud', 'مصطفى': 'mostafa', 'مصطفي': 'mostafa',
  'علي': 'ali', 'على': 'ali', 'عمر': 'omar', 'عمرو': 'amr', 'حسن': 'hassan', 'حسين': 'hussein', 'إبراهيم': 'ibrahim',
  'ابراهيم': 'ibrahim', 'خالد': 'khaled', 'يوسف': 'youssef', 'يوسيف': 'youssef', 'كريم': 'karim', 'طارق': 'tarek',
  'عبدالله': 'abdallah', 'عبد': 'abd', 'الله': 'allah', 'عبدالرحمن': 'abdelrahman', 'الرحمن': 'rahman', 'إسلام': 'eslam',
  'اسلام': 'eslam', 'مينا': 'mina', 'بيتر': 'peter', 'مايكل': 'michael', 'جرجس': 'girgis', 'شريف': 'sherif',
  'هشام': 'hesham', 'وليد': 'walid', 'سامح': 'sameh', 'سامي': 'sami', 'فارس': 'fares', 'زياد': 'ziad', 'آدم': 'adam',
  'ادم': 'adam', 'نور': 'nour', 'مريم': 'mariam', 'فاطمة': 'fatma', 'فاطمه': 'fatma', 'سارة': 'sara', 'ساره': 'sara',
  'آية': 'aya', 'اية': 'aya', 'ايه': 'aya', 'منة': 'menna', 'منه': 'menna', 'هبة': 'heba', 'هبه': 'heba', 'رنا': 'rana',
  'دينا': 'dina', 'ياسمين': 'yasmin', 'شيماء': 'shaimaa', 'إسراء': 'esraa', 'اسراء': 'esraa', 'رحمة': 'rahma',
  'رحمه': 'rahma', 'سلمى': 'salma', 'سلمي': 'salma', 'ملك': 'malak', 'هند': 'hend', 'نادية': 'nadia', 'منى': 'mona',
  'مني': 'mona', 'أمل': 'amal', 'امل': 'amal', 'ندى': 'nada', 'ندي': 'nada', 'جنى': 'gana', 'جني': 'gana',
  'حبيبة': 'habiba', 'حبيبه': 'habiba', 'مروة': 'marwa', 'مروه': 'marwa', 'ريم': 'reem', 'جنة': 'ganna', 'جنه': 'ganna',
  'السيد': 'elsayed', 'سيد': 'sayed', 'عادل': 'adel', 'عماد': 'emad', 'أشرف': 'ashraf', 'اشرف': 'ashraf', 'ياسر': 'yasser',
  'حمدي': 'hamdy', 'رامي': 'ramy', 'باسم': 'basem', 'تامر': 'tamer', 'أيمن': 'ayman', 'ايمن': 'ayman', 'مجدي': 'magdy',
};

const LETTERS: Record<string, string> = {
  'ا': 'a', 'أ': 'a', 'إ': 'e', 'آ': 'a', 'ء': '', 'ؤ': 'o', 'ئ': 'e', 'ب': 'b', 'ت': 't', 'ث': 'th', 'ج': 'g', 'ح': 'h',
  'خ': 'kh', 'د': 'd', 'ذ': 'z', 'ر': 'r', 'ز': 'z', 'س': 's', 'ش': 'sh', 'ص': 's', 'ض': 'd', 'ط': 't', 'ظ': 'z',
  'ع': 'a', 'غ': 'gh', 'ف': 'f', 'ق': 'k', 'ك': 'k', 'ل': 'l', 'م': 'm', 'ن': 'n', 'ه': 'h', 'ة': 'a', 'و': 'o',
  'ي': 'y', 'ى': 'a',
};

function translitWord(word: string): string {
  const w = word.replace(/[ً-ْـ]/g, '');
  if (KNOWN[w]) return KNOWN[w];
  if (/^[a-z0-9]+$/i.test(w)) return w.toLowerCase();
  let out = '';
  for (const ch of w) {
    if (LETTERS[ch] !== undefined) out += LETTERS[ch];
    else if (/[a-z0-9]/i.test(ch)) out += ch.toLowerCase();
  }
  return out.replace(/(.)\1{2,}/g, '$1$1');
}

/** «محمد علي حسن» → «mohamed.ali»; «Sara Adel» → «sara.adel». Never empty. */
export function usernameBase(name: string): string {
  const words = String(name || '').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  // «عبد الله» / «عبد الرحمن» are one name.
  const joined: string[] = [];
  for (let i = 0; i < words.length; i++) {
    if ((words[i] === 'عبد' || words[i] === 'عبدال') && words[i + 1]) { joined.push('عبد' + words[i + 1].replace(/^ال/, 'ال')); i++; }
    else joined.push(words[i]);
  }
  const parts = joined.map(translitWord).filter((p) => p.length >= 2);
  let base = parts.slice(0, 2).join('.').replace(/[^a-z0-9.]/g, '').slice(0, 24);
  if (!/^[a-z]/.test(base)) base = 'user' + (base ? '.' + base : '');
  base = base.replace(/\.+$/, '');
  return base.length >= 3 ? base : 'user';
}

/** The first free username from the name: base, base2, base3 … (`taken` reads the database). */
export async function suggestUsername(name: string, taken: (u: string) => Promise<boolean>): Promise<string> {
  const base = usernameBase(name);
  if (!(await taken(base)) && !cleanUsername(base).problem) return base;
  for (let n = 2; n < 100; n++) {
    const u = base.slice(0, 27) + n;
    if (!(await taken(u)) && !cleanUsername(u).problem) return u;
  }
  return base.slice(0, 20) + randomBytes(3).toString('hex');
}
