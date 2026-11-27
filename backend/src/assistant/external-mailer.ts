import * as nodemailer from 'nodemailer';
import { DEFAULT_EXTERNAL_MAIL_TO } from './external-assistant.util';
import { smtpHostFor, smtpPassFor } from '../shared/smtp-config.util';

/**
 * Sends the external assistant's question email over SMTP.
 *
 * Configured from the server environment (never from the browser, never stored in Mongo):
 *   SMTP_HOST (default: picked from SMTP_USER — smtp.gmail.com for Gmail, else smtp.hostinger.com)
 *   SMTP_PORT (default 465; 465 = TLS, 587 = STARTTLS)
 *   SMTP_USER · SMTP_PASS (Gmail: an App Password; no-reply@soulia.store: the mailbox password)
 *   ASSISTANT_MAIL_FROM — the fixed sender address (default: SMTP_USER)
 *   ASSISTANT_MAIL_TO   — the external assistant's inbox (default souliaalerts@gmail.com)
 * Missing SMTP_USER/SMTP_PASS → every send fails with SMTP_NOT_CONFIGURED and the message keeps
 * retrying on the normal schedule, so setting the variables later still delivers it.
 */
export interface MailMessage { subject: string; text: string; headers?: Record<string, string> }
export interface MailResult { id: string }
export interface MailSender { send(m: MailMessage): Promise<MailResult>; describe(): { from: string; to: string; configured: boolean } }

export class SmtpMailSender implements MailSender {
  private transport: nodemailer.Transporter | null = null;

  private cfg() {
    const env = process.env;
    const user = String(env.SMTP_USER || '').trim();
    const pass = smtpPassFor(user, env.SMTP_PASS);
    const port = Number(env.SMTP_PORT) || 465;
    return {
      host: smtpHostFor(user, env.SMTP_HOST),
      port,
      secure: port === 465,
      user,
      pass,
      from: String(env.ASSISTANT_MAIL_FROM || user).trim(),
      to: String(env.ASSISTANT_MAIL_TO || DEFAULT_EXTERNAL_MAIL_TO).trim(),
    };
  }

  describe() {
    const c = this.cfg();
    return { from: c.from, to: c.to, configured: !!(c.user && c.pass && c.from) };
  }

  async send(m: MailMessage): Promise<MailResult> {
    const c = this.cfg();
    if (!c.user || !c.pass || !c.from) {
      const e: any = new Error('SMTP_NOT_CONFIGURED: set SMTP_USER and SMTP_PASS on the server');
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
      const info = await this.transport.sendMail({
        from: { name: 'SOULIA ERP', address: c.from },
        to: c.to,
        subject: m.subject,
        text: m.text,
        headers: m.headers,
      });
      return { id: String(info?.messageId || '') };
    } catch (e) {
      // A broken connection or rejected login: build a fresh transport next time.
      try { this.transport?.close(); } catch { /* ignore */ }
      this.transport = null;
      throw e;
    }
  }
}
