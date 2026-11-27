import { smtpHostFor, smtpPassFor } from '../../src/shared/smtp-config.util';

describe('smtp-config — server picked from the sending address', () => {
  it('no-reply@soulia.store goes through Hostinger', () => {
    expect(smtpHostFor('no-reply@soulia.store')).toBe('smtp.hostinger.com');
  });
  it('a Gmail account keeps smtp.gmail.com', () => {
    expect(smtpHostFor('souliaalerts@gmail.com')).toBe('smtp.gmail.com');
    expect(smtpHostFor('X@GoogleMail.com')).toBe('smtp.gmail.com');
  });
  it('an explicit SMTP_HOST always wins', () => {
    expect(smtpHostFor('no-reply@soulia.store', ' mail.example.com ')).toBe('mail.example.com');
  });
  it('removes spaces only from a Gmail App Password', () => {
    expect(smtpPassFor('a@gmail.com', 'abcd efgh ijkl mnop')).toBe('abcdefghijklmnop');
    expect(smtpPassFor('no-reply@soulia.store', ' pa ss ')).toBe('pa ss');
  });
});
