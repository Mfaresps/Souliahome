import { MAIL_FOOTER } from '../auth/security-mailer.service';

/**
 * The two invitation emails (Nov 28, 2026, owner-approved wording, formal MSA, no greeting line).
 *
 * ⚠ The ONLY security-style emails with a link: the button is the whole point of an invitation.
 * The link points to this site's own domain and is not printed in the HTML body (the button
 * carries it); the plain-text part must carry it, or a text-only mail client has nothing to open.
 */
export const INVITE_SUBJECT = {
  invite: 'دعوة لإنشاء حسابك في SOULIA',
  created: 'تم إنشاء حسابك في SOULIA',
} as const;

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

export interface InfoRow { label: string; value: string }

export function buttonMailBody(opts: {
  title: string; intro: string[]; rows?: InfoRow[]; before?: string; button: { label: string; url: string }; after?: string[];
}): { text: string; html: string } {
  const rows = (opts.rows || []).filter((r) => String(r.value || '').trim());
  const intro = opts.intro.filter(Boolean);
  const after = (opts.after || []).filter(Boolean);
  const text = [
    opts.title, '',
    ...intro, '',
    ...rows.map((r) => `${r.label}: ${r.value}`), ...(rows.length ? [''] : []),
    ...(opts.before ? [opts.before] : []),
    `${opts.button.label}: ${opts.button.url}`, '',
    ...after, ...(after.length ? [''] : []),
    MAIL_FOOTER,
  ].join('\n');
  const p = (s: string, extra = '') => `<p style="margin:0 0 8px;font-size:15px;line-height:1.8;color:#1f2933${extra}">${esc(s)}</p>`;
  const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(opts.title)}</title></head>
<body style="margin:0;padding:0;background:#f4f6f5">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f5"><tr><td style="padding:28px 12px">
<table role="presentation" align="center" width="100%" cellpadding="0" cellspacing="0" style="width:100%;max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e3e8e5;border-radius:12px;border-top:4px solid #1f6b45">
<tr><td dir="rtl" style="padding:28px 28px 8px;font-family:Tahoma,Arial,sans-serif;text-align:right;direction:rtl">
<p style="margin:0 0 4px;font-size:13px;font-weight:bold;letter-spacing:2px;color:#1f6b45;font-family:Arial,sans-serif">SOULIA</p>
<p style="margin:0 0 18px;font-size:20px;font-weight:bold;color:#14201a">${esc(opts.title)}</p>
${intro.map((s) => p(s)).join('\n')}
${rows.length ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:14px 0 18px;width:100%;background:#f6f8f7;border-radius:8px">
${rows.map((r) => `<tr><td style="padding:9px 14px;font-size:13px;color:#5b6b63;width:110px;font-family:Tahoma,Arial,sans-serif">${esc(r.label)}</td><td style="padding:9px 14px;font-size:15px;font-weight:bold;color:#14201a;font-family:Tahoma,Arial,sans-serif"><bdi>${esc(r.value)}</bdi></td></tr>`).join('\n')}
</table>` : ''}
${opts.before ? p(opts.before) : ''}
</td></tr>
<tr><td align="center" style="padding:10px 28px 22px">
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td align="center" bgcolor="#1f6b45" style="border-radius:10px">
<a href="${esc(opts.button.url)}" target="_blank" style="display:inline-block;padding:16px 46px;font-size:18px;font-weight:bold;color:#ffffff;text-decoration:none;font-family:Tahoma,Arial,sans-serif;border-radius:10px">${esc(opts.button.label)}</a>
</td></tr></table>
</td></tr>
<tr><td dir="rtl" style="padding:0 28px 26px;font-family:Tahoma,Arial,sans-serif;text-align:right;direction:rtl">
${after.map((s) => p(s, ';font-size:13px;color:#5b6b63')).join('\n')}
<p style="margin:16px 0 0;padding-top:14px;border-top:1px solid #eef1ef;font-size:12px;color:#8a978f">${esc(MAIL_FOOTER)}</p>
</td></tr>
</table>
</td></tr></table>
</body></html>`;
  return { text, html };
}

const cairo = (d: Date) => new Intl.DateTimeFormat('ar-EG-u-nu-latn', {
  timeZone: 'Africa/Cairo', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit',
}).format(d);

export function inviteMailContent(i: { inviterName: string; roleName: string; jobTitle?: string; link: string; expiresAt: Date }) {
  return buttonMailBody({
    title: 'دعوة للانضمام إلى فريق العمل',
    intro: [`دعاك ${i.inviterName || 'مدير النظام'} للانضمام إلى نظام SOULIA.`],
    rows: [{ label: 'الدور', value: i.roleName }, { label: 'المسمى الوظيفي', value: i.jobTitle || '' }],
    before: 'لإنشاء حسابك، اضغط الزر أدناه ثم أكمل بياناتك.',
    button: { label: 'إنشاء حسابي', url: i.link },
    after: [
      `تنتهي صلاحية هذه الدعوة ${cairo(i.expiresAt)} بتوقيت القاهرة، ولا تُستخدم إلا مرة واحدة.`,
      'إذا لم تكن تتوقع هذه الدعوة، فتجاهل هذه الرسالة ولن يُنشأ أي حساب.',
    ],
  });
}

export function accountCreatedMailContent(i: { name: string; username: string; roleName: string; loginUrl: string; at: Date }) {
  return buttonMailBody({
    title: 'تم إنشاء حسابك بنجاح',
    intro: [`أُنشئ حسابك في نظام SOULIA في ${cairo(i.at)} بتوقيت القاهرة، ويمكنك الآن تسجيل الدخول.`],
    rows: [{ label: 'الاسم', value: i.name }, { label: 'اسم المستخدم', value: i.username }, { label: 'الدور', value: i.roleName }],
    button: { label: 'تسجيل الدخول', url: i.loginUrl },
    after: [
      'احتفظ بكلمة المرور لنفسك ولا تشاركها مع أحد. إذا نسيتها، فاطلب من مدير النظام إعادة تعيينها.',
      'إذا لم تُنشئ هذا الحساب، فتواصل مع مدير النظام فورًا.',
    ],
  });
}
