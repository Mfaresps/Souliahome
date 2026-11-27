import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';

/**
 * Security emails (sign-in codes, password reset, alerts) — Nov 27, 2026.
 *
 * Uses the same SMTP account as the external assistant (souliaalerts): SMTP_HOST / SMTP_PORT /
 * SMTP_USER / SMTP_PASS from the server environment, never from the browser or Mongo. Sender =
 * SECURITY_MAIL_FROM, else ASSISTANT_MAIL_FROM, else SMTP_USER. One message, one recipient, sent
 * at once: a sign-in code is useless after its 10 minutes, so there is no retry queue — a failure
 * is reported to the person, who can use Google Authenticator or try again.
 */
export interface SecurityMail { to: string; subject: string; text: string; html?: string; fromName?: string }

/**
 * Fixed subjects (owner, Nov 27, 2026 — so Gmail does not file them as spam): one plain phrase per
 * kind of message, never a code, a username or a number in it. Bodies are 2–4 short lines with no
 * links. ⚠ Add a new security email here; do not write a subject at the call site.
 */
export const MAIL_SUBJECT = {
  signInCode: 'رمز التحقق لتسجيل الدخول',
  resetCode: 'رمز استعادة كلمة المرور',
  stepUpCode: 'رمز تأكيد الهوية',
  emailCode: 'رمز تأكيد البريد الإلكتروني',
  approvalCode: 'رمز الموافقة على طلب',
  newDevice: 'تسجيل دخول من جهاز جديد',
  failedLogins: 'محاولات دخول غير ناجحة',
  wrongCodes: 'تنبيه أمان على الحساب',
  passwordChanged: 'تغيير كلمة المرور',
  systemPinChanged: 'تغيير الرقم السري للنظام',
  emailConfirmed: 'تأكيد البريد الإلكتروني',
  emailChanged: 'تغيير البريد الإلكتروني',
  emailRemoved: 'حذف بريد التحقق',
  totpDisabled: 'إيقاف تطبيق المصادقة',
} as const;

export const MAIL_FOOTER = 'رسالة آلية من SOULIA، يُرجى عدم الرد عليها.';
export interface SecurityMailTransport { send(m: SecurityMail & { from: string }): Promise<void> }

@Injectable()
export class SecurityMailerService {
  private readonly logger = new Logger(SecurityMailerService.name);
  private transport: nodemailer.Transporter | null = null;
  /** Tests replace the SMTP transport. */
  private override: SecurityMailTransport | null = null;

  useTransport(t: SecurityMailTransport | null) { this.override = t; }

  private cfg() {
    const env = process.env;
    const user = String(env.SMTP_USER || '').trim();
    const pass = String(env.SMTP_PASS || '').replace(/\s+/g, '');
    const port = Number(env.SMTP_PORT) || 465;
    return {
      host: String(env.SMTP_HOST || 'smtp.gmail.com').trim(),
      port, secure: port === 465, user, pass,
      from: String(env.SECURITY_MAIL_FROM || env.ASSISTANT_MAIL_FROM || user).trim(),
    };
  }

  configured(): boolean {
    if (this.override) return true;
    const c = this.cfg();
    return !!(c.user && c.pass && c.from);
  }

  describe() {
    const c = this.cfg();
    return { configured: this.configured(), from: c.from };
  }

  async send(m: SecurityMail): Promise<void> {
    const c = this.cfg();
    if (this.override) return this.override.send({ ...m, from: c.from || 'test@soulia.local' });
    if (!this.configured()) {
      const e: any = new Error('SMTP_NOT_CONFIGURED');
      e.code = 'SMTP_NOT_CONFIGURED';
      throw e;
    }
    if (!this.transport) {
      this.transport = nodemailer.createTransport({
        host: c.host, port: c.port, secure: c.secure,
        auth: { user: c.user, pass: c.pass },
        connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
      });
    }
    try {
      await this.transport.sendMail({
        // One sender name for every security message; `Auto-Submitted` marks it as machine-sent.
        from: { name: m.fromName || 'SOULIA', address: c.from },
        to: m.to, subject: m.subject, text: m.text, ...(m.html ? { html: m.html } : {}),
        headers: { 'Auto-Submitted': 'auto-generated' },
      });
    } catch (e) {
      try { this.transport?.close(); } catch { /* ignore */ }
      this.transport = null;
      this.logger.warn(`security mail failed: ${(e as Error)?.message}`);
      throw e;
    }
  }

  /** Never throws — for notices whose failure must not change the action. */
  async sendQuietly(m: SecurityMail): Promise<boolean> {
    try { await this.send(m); return true; } catch { return false; }
  }
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

/**
 * A short, plain, right-to-left email: title, the code (if any), a few lines, one footer line.
 * No links, no images, no colours beyond black/grey — the plain-text part says exactly the same.
 * Empty lines are dropped.
 */
export function securityMailBody(opts: { title: string; lines: string[]; code?: string; footer?: string }): { text: string; html: string } {
  const lines = (opts.lines || []).map((l) => String(l ?? '').trim()).filter(Boolean);
  const footer = MAIL_FOOTER;
  const text = [opts.title, '', ...(opts.code ? [`الرمز: ${opts.code}`, ''] : []), ...lines, '', footer].join('\n');
  const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${esc(opts.title)}</title></head>
<body style="margin:0;padding:24px;background:#ffffff;font-family:Tahoma,Arial,sans-serif;color:#1f2933;direction:rtl;text-align:right">
<div style="max-width:480px">
<p style="margin:0 0 16px;font-size:16px;font-weight:bold">${esc(opts.title)}</p>
${opts.code ? `<p dir="ltr" style="margin:0 0 16px;font-size:28px;font-weight:bold;letter-spacing:6px;text-align:right;font-family:Consolas,monospace">${esc(opts.code)}</p>` : ''}
${lines.map((l) => `<p style="margin:0 0 6px;font-size:14px;line-height:1.7">${esc(l)}</p>`).join('\n')}
<p style="margin:20px 0 0;font-size:12px;color:#6b7280">${esc(footer)}</p>
</div></body></html>`;
  return { text, html };
}
