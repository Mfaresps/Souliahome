import {
  cleanOrigin, cleanPhone, cleanUsername, inviteLink, inviteState, inviteTokenHash, newInviteToken, openInviteToken,
  sealInviteToken, suggestUsername, usernameBase, INVITE_TOKEN_RE,
} from '../../src/invitations/invitation.util';
import { accountCreatedMailContent, inviteMailContent, INVITE_SUBJECT } from '../../src/invitations/invite-mail.util';

describe('invitations — rules', () => {
  it('accepts Egyptian mobiles in every usual form and refuses the rest', () => {
    expect(cleanPhone('01012345678').phone).toBe('01012345678');
    expect(cleanPhone('+20 101 234 5678').phone).toBe('01012345678');
    expect(cleanPhone('٠١١٢٣٤٥٦٧٨٩').phone).toBe('01123456789');
    expect(cleanPhone('1512345678').phone).toBe('01512345678');
    expect(cleanPhone('01312345678').problem).toBeTruthy();
    expect(cleanPhone('0101234567').problem).toBeTruthy();
    expect(cleanPhone('').problem).toBeTruthy();
  });

  it('builds a username from an Arabic or English name', () => {
    expect(usernameBase('محمد علي حسن')).toBe('mohamed.ali');
    expect(usernameBase('عبد الرحمن خالد')).toBe('abdelrahman.khaled');
    expect(usernameBase('Sara Adel Mahmoud')).toBe('sara.adel');
    expect(usernameBase('رضوى')).toMatch(/^[a-z][a-z0-9.]{2,}$/);
    expect(cleanUsername(usernameBase('٣٣')).problem).toBe('');
  });

  it('suggests the next free username', async () => {
    const taken = new Set(['mohamed.ali', 'mohamed.ali2']);
    expect(await suggestUsername('محمد علي', async (u) => taken.has(u))).toBe('mohamed.ali3');
  });

  it('validates usernames', () => {
    expect(cleanUsername('Mohamed.Ali').username).toBe('mohamed.ali');
    expect(cleanUsername('ab').problem).toBeTruthy();
    expect(cleanUsername('محمد').problem).toBeTruthy();
    expect(cleanUsername('mo..ali').problem).toBeTruthy();
    expect(cleanUsername('admin').problem).toBeTruthy();
  });

  it('keeps the token sealed, opens it with the same secret only', () => {
    const t = newInviteToken();
    expect(INVITE_TOKEN_RE.test(t)).toBe(true);
    const sealed = sealInviteToken(t, 's1');
    expect(sealed).not.toContain(t);
    expect(openInviteToken(sealed, 's1')).toBe(t);
    expect(openInviteToken(sealed, 's2')).toBe('');
    expect(inviteTokenHash(t)).toHaveLength(64);
  });

  it('builds a short link on a clean origin', () => {
    expect(cleanOrigin('https://admin.soulia.store/')).toBe('https://admin.soulia.store');
    expect(cleanOrigin('javascript:alert(1)')).toBe('');
    expect(cleanOrigin('https://evil.com/path')).toBe('');
    expect(cleanOrigin('http://localhost:8080', 'https://admin.soulia.store')).toBe('https://admin.soulia.store');
    expect(inviteLink('https://admin.soulia.store', 'abc')).toBe('https://admin.soulia.store/join/abc');
  });

  it('states an invitation', () => {
    const now = new Date('2026-11-28T12:00:00Z');
    expect(inviteState({ status: 'pending', expiresAt: new Date('2026-11-29T12:00:00Z') }, now)).toBe('pending');
    expect(inviteState({ status: 'pending', expiresAt: new Date('2026-11-28T11:00:00Z') }, now)).toBe('expired');
    expect(inviteState({ status: 'accepted' }, now)).toBe('accepted');
    expect(inviteState({ status: 'cancelled' }, now)).toBe('cancelled');
  });
});

describe('invitations — emails', () => {
  const link = 'https://admin.soulia.store/join/AbCdEfGhIjKlMnOpQrStUvWx';

  it('invite: fixed subject, role, one button carrying the link, the link in the text part', () => {
    const m = inviteMailContent({ inviterName: 'أحمد فارس', roleName: 'خدمة العملاء', jobTitle: 'Customer Service', link, expiresAt: new Date('2026-12-01T20:30:00Z') });
    expect(INVITE_SUBJECT.invite).toBe('دعوة لإنشاء حسابك في SOULIA');
    expect(m.html).toContain(`href="${link}"`);
    expect(m.html).toContain('إنشاء حسابي');
    expect(m.html).toContain('خدمة العملاء');
    expect(m.html).toContain('دعاك أحمد فارس');
    expect(m.text).toContain(link);
    expect(m.html.split(link).length - 1).toBe(1); // the link appears once: in the button
    expect(m.html + m.text).not.toContain('مرحبًا');
  });

  it('invite: job title row is dropped when empty, and HTML is escaped', () => {
    const m = inviteMailContent({ inviterName: '<b>x</b>', roleName: 'r', link, expiresAt: new Date() });
    expect(m.html).not.toContain('المسمى الوظيفي');
    expect(m.html).not.toContain('<b>x</b>');
  });

  it('account created: username and role, login button', () => {
    const m = accountCreatedMailContent({ name: 'محمد علي', username: 'mohamed.ali', roleName: 'المخزن', loginUrl: 'https://admin.soulia.store/', at: new Date() });
    expect(m.html).toContain('mohamed.ali');
    expect(m.html).toContain('href="https://admin.soulia.store/"');
    expect(m.text).toContain('اسم المستخدم: mohamed.ali');
  });
});
