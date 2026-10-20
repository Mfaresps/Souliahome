import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from 'vm';

const html = readFileSync(resolve(__dirname, '../../../frontend/public/index.html'), 'utf8');
const source = html.slice(html.indexOf('function createHeaderRefreshController()'), html.indexOf('async function api(path, options = {})'));

function fixture() {
  const classes = new Set<string>();
  const added: string[] = [];
  const element = { classList: {
    add: (...names: string[]) => names.forEach(name => { classes.add(name); added.push(name); }),
    remove: (...names: string[]) => names.forEach(name => classes.delete(name)),
    toggle: (name: string, state: boolean) => state ? classes.add(name) : classes.delete(name),
  }, setAttribute: jest.fn() };
  const context: any = { document: { getElementById: (id: string) => id === 'header-loadbar' ? element : id === 'app' ? { style: { display: 'block' } } : null }, t: () => 'Refreshing', setTimeout, clearTimeout };
  runInNewContext(source, context);
  return { controller: context.createHeaderRefreshController(), context, classes, added };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

it('ignores ordinary API polling and hides a fast refresh without flashing', async () => {
  const { controller, classes } = fixture();
  controller.trackRequest()();
  await jest.advanceTimersByTimeAsync(500);
  expect(classes.size).toBe(0);
  const end = controller.begin();
  const finish = controller.trackRequest();
  await jest.advanceTimersByTimeAsync(60);
  finish(); end();
  await jest.advanceTimersByTimeAsync(500);
  expect(classes.size).toBe(0);
});

it('keeps a single indicator until every request settles and merges adjacent refreshes', async () => {
  const { controller, classes, added } = fixture();
  const end = controller.begin(), first = controller.trackRequest(), last = controller.trackRequest();
  await jest.advanceTimersByTimeAsync(180);
  expect(classes.has('active')).toBe(true);
  first(); end();
  await jest.advanceTimersByTimeAsync(300);
  expect(classes.has('active')).toBe(true);
  last();
  await jest.advanceTimersByTimeAsync(60);
  const endNext = controller.begin(), finishNext = controller.trackRequest();
  await jest.advanceTimersByTimeAsync(100);
  finishNext(); endNext();
  expect(added.filter(name => name === 'active')).toHaveLength(1);
  await jest.advanceTimersByTimeAsync(120);
  expect(classes.has('active')).toBe(false);
  await jest.advanceTimersByTimeAsync(140);
  expect(classes.size).toBe(0);
});

it('deduplicates repeated refresh clicks', async () => {
  const { context } = fixture();
  let release: () => void = () => {};
  const work = jest.fn(() => new Promise<void>(resolve => { release = resolve; }));
  const first = context.withHeaderRefresh('orders', work);
  const second = context.withHeaderRefresh('orders', work);
  expect(first).toBe(second);
  await jest.advanceTimersByTimeAsync(0);
  expect(work).toHaveBeenCalledTimes(1);
  release();
  await jest.advanceTimersByTimeAsync(5);
  await first;
});

it('waits for response body parsing before finishing a refresh', async () => {
  const { context, classes } = fixture();
  let release: (value: string) => void = () => {};
  context.localStorage = { getItem: () => null };
  context.FormData = class {};
  context.API_BASE = '/api';
  context.fetch = async () => ({ ok: true, text: () => new Promise<string>(resolve => { release = resolve; }) });
  const apiSource = html.slice(html.indexOf('async function api(path, options = {})'), html.indexOf('function _apiUploadWithProgress'));
  runInNewContext(apiSource, context);
  const refresh = context.withHeaderRefresh('orders', () => context.api('/orders'));
  await jest.advanceTimersByTimeAsync(200);
  expect(classes.has('active')).toBe(true);
  release('{"loaded":true}');
  await jest.advanceTimersByTimeAsync(5);
  await expect(refresh).resolves.toEqual({ loaded: true });
});

it('releases a failed refresh and can show the next refresh normally', async () => {
  const { controller, classes } = fixture();
  const end = controller.begin(), finish = controller.trackRequest();
  await jest.advanceTimersByTimeAsync(180);
  finish(true); finish(true); end(); end(); // Completion callbacks are idempotent.
  await jest.advanceTimersByTimeAsync(120);
  expect(classes.has('is-error')).toBe(true);
  await jest.advanceTimersByTimeAsync(140);
  const endNext = controller.begin();
  await jest.advanceTimersByTimeAsync(180);
  expect(classes.has('active')).toBe(true);
  expect(classes.has('is-error')).toBe(false);
  endNext();
});
