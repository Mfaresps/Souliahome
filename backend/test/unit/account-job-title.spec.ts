import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from 'vm';

const html = readFileSync(resolve(__dirname, '../../../frontend/public/index.html'), 'utf8');
function source(name: string) {
  const start = html.indexOf(`function ${name}(`);
  return html.slice(start, html.indexOf('\n}', start) + 2);
}
function fixture() {
  const stored = new Map([['token', 'token'], ['user', JSON.stringify({ name: 'Malak', role: 'staff', jobTitle: 'Staff' })]]);
  const env: any = { currentLang: 'en', currentUser: null,
    localStorage: { getItem: (key: string) => stored.get(key), setItem: (key: string, value: string) => stored.set(key, value) },
    api: jest.fn().mockResolvedValue({ name: 'Malak', role: 'staff', jobTitle: 'Customer Service Agent' }),
    JOB_TITLE_MAP: { 'Customer Service Agent': { ar: 'موظف خدمة عملاء' } },
  };
  runInNewContext(source('jobTitleLabel') + '\n' + source('userTitleLabel') + '\nasync ' + source('checkAuth'), env);
  return { env, stored };
}
it('refreshes a cached job title from the authenticated account and persists it', async () => {
  const { env, stored } = fixture();
  expect(await env.checkAuth()).toBe(true);
  expect(env.userTitleLabel(env.currentUser)).toBe('Customer Service Agent');
  expect(JSON.parse(stored.get('user')!).jobTitle).toBe('Customer Service Agent');
  expect(env.currentUser.role).toBe('staff');
  env.currentLang = 'ar';
  expect(env.userTitleLabel(env.currentUser)).toBe('موظف خدمة عملاء');
});
it('removes a cleared job title without replacing it with a permission role', async () => {
  const { env } = fixture();
  env.api.mockResolvedValue({ role: 'staff', jobTitle: '' });
  await env.checkAuth();
  expect(env.userTitleLabel(env.currentUser)).toBe('');
  expect(env.userTitleLabel({ role: 'admin' })).toBe('');
  expect(env.userTitleLabel({ role: 'staff', jobTitle: '  منسق طلبات  ' })).toBe('منسق طلبات');
});
