import { otpMailContent, otpMailTime } from '../../src/discount-otp/otp-mail.util';
import { DiscountOtpService } from '../../src/discount-otp/discount-otp.service';
import { MAIL_SUBJECT, securityMailBody } from '../../src/auth/security-mailer.service';

export {};

const base = {
  otp: '4821', requestedById: 'u-staff', requestedByName: 'Reem',
  createdAt: '2026-11-27T08:00:00.000Z', expiresAt: '2026-11-27T08:10:00.000Z',
};

describe('otpMailContent', () => {
  it('builds a formal message carrying the code for a record edit', () => {
    const c = otpMailContent({ ...base, kind: 'record-edit', editTxId: 'product:abc', txRef: 'Bow dining', requestReason: 'سعر البيع: 650 ← 600' })!;
    expect(c.code).toBe('4821');
    expect(c.subject).toBe('رمز الموافقة على طلب');
    expect(c.lines).toContain('نوع الطلب: تعديل بيانات');
    expect(c.lines).toContain('مقدّم الطلب: Reem');
    expect(c.lines).toContain('الصنف: Bow dining');
    expect(c.lines.some(l => l.startsWith('التعديلات: سعر البيع'))).toBe(true);
    expect(c.lines.join('\n')).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });

  it('states the discount amount and invoice', () => {
    const c = otpMailContent({ ...base, kind: 'discount', client: 'Mona', txRef: '3148', discountAmount: 350, thresholdAtRequest: 200 })!;
    expect(c.lines).toContain('رقم الفاتورة: #3148');
    expect(c.lines).toContain('قيمة الخصم: EGP 350.00');
    expect(c.lines).toContain('الحد المسموح: EGP 200.00');
  });

  it('sends nothing for edit-tx (approved by a button, no code to relay)', () => {
    expect(otpMailContent({ ...base, kind: 'edit-tx' })).toBeNull();
  });

  it('writes Cairo time with Latin digits', () => {
    expect(otpMailTime('2026-11-27T08:10:00.000Z')).toMatch(/^27\/11\/2026 · 10:10/);
  });
});

describe('security mail format (Gmail)', () => {
  it('every subject is a fixed phrase: no digits, links or «SOULIA —»', () => {
    for (const s of Object.values(MAIL_SUBJECT)) {
      expect(s).not.toMatch(/[0-9٠-٩]|https?:|www\.|SOULIA —/);
      expect(s.length).toBeLessThanOrEqual(40);
    }
  });

  it('the body is short and has no links', () => {
    const b = securityMailBody({ title: MAIL_SUBJECT.signInCode, code: '123456', lines: ['الحساب: admin', '', 'سطر'] });
    expect(b.html).not.toMatch(/<a\s|https?:|<img/i);
    expect(b.text).not.toMatch(/https?:/);
    expect(b.text.split('\n').filter(Boolean)).toHaveLength(5);
  });
});

describe('DiscountOtpService email copy', () => {
  function build(users: any[]) {
    const sent: any[] = [];
    const model: any = { create: async (v: any) => ({ ...v, _id: 'otp1', toObject() { return { ...v, _id: 'otp1' }; } }) };
    const svc: any = new DiscountOtpService(model, {} as any, {} as any, { findAll: async () => users } as any, {} as any, {} as any);
    svc.mailer = { configured: () => true, sendQuietly: async (m: any) => { sent.push(m); return true; } };
    return { svc, sent };
  }
  const flush = () => new Promise(r => setTimeout(r, 0));

  it('emails every verified admin, never the requester, once per address', async () => {
    const { svc, sent } = build([
      { _id: 'a1', role: 'admin', securityEmail: 'Owner@X.com', securityEmailVerifiedAt: new Date() },
      { _id: 'a2', role: 'admin', securityEmail: 'owner@x.com', securityEmailVerifiedAt: new Date() },
      { _id: 'a3', role: 'admin', securityEmail: 'unverified@x.com', securityEmailVerifiedAt: null },
      { _id: 'u-staff', role: 'admin', securityEmail: 'self@x.com', securityEmailVerifiedAt: new Date() },
      { _id: 's1', role: 'staff', securityEmail: 'staff@x.com', securityEmailVerifiedAt: new Date() },
    ]);
    await svc.createOtpDocument({ ...base, kind: 'export-excel', client: 'سجل المعاملات' });
    await flush(); await flush();
    expect(sent.map(m => m.to)).toEqual(['owner@x.com']);
    expect(sent[0].text).toContain('4821');
    expect(sent[0].html).toContain('4821');
  });

  it('sends nothing for edit-tx', async () => {
    const { svc, sent } = build([{ _id: 'a1', role: 'admin', securityEmail: 'o@x.com', securityEmailVerifiedAt: new Date() }]);
    await svc.createOtpDocument({ ...base, kind: 'edit-tx' });
    await flush(); await flush();
    expect(sent).toHaveLength(0);
  });
});
