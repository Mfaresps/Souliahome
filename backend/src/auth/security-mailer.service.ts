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
export interface SecurityMail { to: string; subject: string; text: string; html?: string }
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
        from: { name: 'SOULIA Security', address: c.from },
        to: m.to, subject: m.subject, text: m.text, ...(m.html ? { html: m.html } : {}),
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

/** A plain, right-to-left email body: title, lines, an optional code in large digits. */
export function securityMailBody(opts: { title: string; lines: string[]; code?: string; footer?: string }): { text: string; html: string } {
  const text = [opts.title, '', ...(opts.code ? [`الرمز: ${opts.code}`, ''] : []), ...opts.lines, '', opts.footer || 'SOULIA — رسالة أمان آلية، لا ترد عليها.'].join('\n');
  const html = `<!doctype html><html lang="ar" dir="rtl"><body style="margin:0;background:#f4f6f5;font-family:Tahoma,Arial,sans-serif;color:#1a2e22">
<div style="max-width:520px;margin:24px auto;background:#fff;border:1px solid #dde6e0;border-radius:12px;padding:24px">
<div style="font-weight:700;font-size:16px;margin-bottom:14px">${esc(opts.title)}</div>
${opts.code ? `<div dir="ltr" style="font-size:30px;font-weight:700;letter-spacing:8px;text-align:center;background:#f0fdf4;border-radius:10px;padding:14px 0;margin-bottom:16px;font-family:Consolas,monospace">${esc(opts.code)}</div>` : ''}
${opts.lines.map((l) => `<div style="font-size:14px;line-height:1.8">${esc(l)}</div>`).join('')}
<div style="font-size:12px;color:#6b8c78;margin-top:18px;border-top:1px solid #eef2ef;padding-top:12px">${esc(opts.footer || 'SOULIA — رسالة أمان آلية، لا ترد عليها.')}</div>
</div></body></html>`;
  return { text, html };
}
