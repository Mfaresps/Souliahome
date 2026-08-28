/**
 * اختبارات رافع Cloudflare R2.
 *
 * ⚠ تستورد الدوال المشحونة نفسها من `src/shared/r2-uploader.util` ولا تنسخها.
 * نسخة محلية كانت ستستمر في النجاح بعد كسر الأصل — وهو بالضبط ما يفعله
 * `returns.spec.ts` خطأً.
 *
 * التوقيع لا يُختبر بمقارنة نص ثابت: كل طلب يحمل طابعاً زمنياً، فالتوقيع يتغيّر
 * كل ثانية. المُختبَر هو ما ينتج 403 صامتاً عند كسره: ترتيب الترويسات، ترميز
 * المسار، ترتيب معاملات الاستعلام، وحساسية التوقيع للمفتاح.
 */
import { EventEmitter } from 'events';

// jest.mock يعترض الوحدة عند التحميل — الطريقة الوحيدة هنا، لأن فضاء أسماء
// 'https' للقراءة فقط تحت ts-jest فلا الإسناد المباشر ولا jest.spyOn ينجح.
jest.mock('https', () => ({ request: jest.fn() }));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const https = require('https');
import * as crypto from 'crypto';
import {
  R2Config,
  r2PutObject,
  r2ListObjects,
  r2DeleteObject,
  r2GetObject,
  r2TestConnection,
  normalizeR2AccountId,
} from '../../src/shared/r2-uploader.util';

export {};

const CFG: R2Config = {
  accountId: 'acct123',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  bucket: 'soulia-backups',
};

interface Captured {
  hostname: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

let captured: Captured[] = [];
let nextStatus = 200;
let nextBody = '';
let spy: jest.Mock;

/**
 * يعترض https.request فيلتقط ما كان سيُرسل فعلياً دون أي اتصال بالشبكة.
 * ⚠ jest.spyOn وليس إسناداً مباشراً: فضاء أسماء الوحدة للقراءة فقط تحت ts-jest،
 * والإسناد يرمي "Cannot set property request".
 */
function installMock(): void {
  spy = https.request as jest.Mock;
  spy.mockImplementation(((opts: any, cb: any) => {
    const rec: Captured = {
      hostname: opts.hostname,
      path: opts.path,
      method: opts.method,
      headers: opts.headers || {},
      body: '',
    };
    captured.push(rec);

    const req: any = new EventEmitter();
    req.write = (chunk: any) => {
      rec.body += chunk.toString();
    };
    req.destroy = () => undefined;
    req.end = () => {
      setImmediate(() => {
        const res: any = new EventEmitter();
        res.statusCode = nextStatus;
        cb(res);
        if (nextBody) res.emit('data', nextBody);
        res.emit('end');
      });
    };
    return req;
  }) as any);
}

beforeEach(() => {
  captured = [];
  nextStatus = 200;
  nextBody = '';
  installMock();
});

afterEach(() => {
  spy.mockReset();
});

function authOf(rec: Captured): string {
  return rec.headers['Authorization'] || '';
}

function sigOf(rec: Captured): string {
  return /Signature=([0-9a-f]+)/.exec(authOf(rec))?.[1] || '';
}

// ───────────────────────────────────────────────────────────────────────────
describe('r2PutObject — الرفع', () => {
  it('يستهدف نقطة R2 المرتبطة بالحساب', async () => {
    await r2PutObject(CFG, 'backups/a.json', Buffer.from('{}'));
    expect(captured[0].hostname).toBe('acct123.r2.cloudflarestorage.com');
    expect(captured[0].method).toBe('PUT');
  });

  it('يبني المسار /bucket/key ويُبقي الشرطات المائلة كما هي', async () => {
    await r2PutObject(CFG, 'backups/backup_auto_2026-08-28.json', Buffer.from('{}'));
    expect(captured[0].path).toBe('/soulia-backups/backups/backup_auto_2026-08-28.json');
  });

  it('⚠ لا يحوّل «/» إلى %2F — وإلا صار المفتاح اسماً واحداً والتوقيع خاطئاً', async () => {
    await r2PutObject(CFG, 'backups/x.json', Buffer.from('{}'));
    expect(captured[0].path).not.toContain('%2F');
  });

  it('يرسل بصمة المحتوى الصحيحة', async () => {
    const body = Buffer.from('{"hello":"world"}');
    await r2PutObject(CFG, 'k.json', body);
    const expected = crypto.createHash('sha256').update(body).digest('hex');
    expect(captured[0].headers['x-amz-content-sha256']).toBe(expected);
  });

  it('يرسل الجسم كما هو دون تعديل', async () => {
    await r2PutObject(CFG, 'k.json', Buffer.from('{"a":1}'));
    expect(captured[0].body).toBe('{"a":1}');
    expect(captured[0].headers['content-length']).toBe('7');
  });

  it('يعيد ok عند 2xx', async () => {
    nextStatus = 200;
    const res = await r2PutObject(CFG, 'k.json', Buffer.from('{}'));
    expect(res.ok).toBe(true);
  });

  it('يعيد فشلاً مع رسالة R2 عند الخطأ بدل رمي استثناء', async () => {
    nextStatus = 403;
    nextBody = '<Error><Code>AccessDenied</Code><Message>ممنوع</Message></Error>';
    const res = await r2PutObject(CFG, 'k.json', Buffer.from('{}'));
    expect(res.ok).toBe(false);
    expect(res.message).toContain('AccessDenied');
  });

  it('لا يرمي عند انقطاع الشبكة — يعيد كائن نتيجة', async () => {
    spy.mockImplementation((() => {
      const req: any = new EventEmitter();
      req.write = () => undefined;
      req.destroy = () => undefined;
      req.end = () => setImmediate(() => req.emit('error', new Error('ECONNRESET')));
      return req;
    }) as any);
    const res = await r2PutObject(CFG, 'k.json', Buffer.from('{}'));
    expect(res.ok).toBe(false);
    expect(res.message).toContain('ECONNRESET');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('التوقيع (SigV4)', () => {
  it('يستخدم خوارزمية AWS4-HMAC-SHA256 ونطاق auto/s3', async () => {
    await r2PutObject(CFG, 'k.json', Buffer.from('{}'));
    const auth = authOf(captured[0]);
    expect(auth.startsWith('AWS4-HMAC-SHA256 ')).toBe(true);
    expect(auth).toContain('Credential=AKIDEXAMPLE/');
    expect(auth).toContain('/auto/s3/aws4_request');
  });

  it('⚠ SignedHeaders مرتبة أبجدياً وبحروف صغيرة — الترتيب جزء من التوقيع', async () => {
    await r2PutObject(CFG, 'k.json', Buffer.from('{}'));
    const names = /SignedHeaders=([^,]+)/.exec(authOf(captured[0]))![1].split(';');
    expect(names).toEqual([...names].sort());
    expect(names.every((n) => n === n.toLowerCase())).toBe(true);
  });

  it('كل ترويسة موقَّعة مُرسَلة فعلاً', async () => {
    await r2PutObject(CFG, 'k.json', Buffer.from('{}'));
    const rec = captured[0];
    const names = /SignedHeaders=([^,]+)/.exec(authOf(rec))![1].split(';');
    const sent = Object.keys(rec.headers).map((h) => h.toLowerCase());
    for (const n of names) expect(sent).toContain(n);
  });

  it('التوقيع 64 خانة ست عشرية', async () => {
    await r2PutObject(CFG, 'k.json', Buffer.from('{}'));
    expect(sigOf(captured[0])).toMatch(/^[0-9a-f]{64}$/);
  });

  it('⚠ السر لا يظهر في أي ترويسة — وإلا لتسرّب في اللوج', async () => {
    await r2PutObject(CFG, 'k.json', Buffer.from('{}'));
    expect(JSON.stringify(captured[0].headers)).not.toContain(CFG.secretAccessKey);
  });

  it('سر مختلف ينتج توقيعاً مختلفاً', async () => {
    await r2DeleteObject(CFG, 'same.json');
    await r2DeleteObject({ ...CFG, secretAccessKey: 'OTHER' }, 'same.json');
    expect(sigOf(captured[0])).not.toBe(sigOf(captured[1]));
  });

  it('مفتاح مختلف ينتج توقيعاً مختلفاً', async () => {
    await r2DeleteObject(CFG, 'a.json');
    await r2DeleteObject(CFG, 'b.json');
    expect(sigOf(captured[0])).not.toBe(sigOf(captured[1]));
  });

  it('اشتقاق مفتاح التوقيع يطابق مثال AWS الرسمي', () => {
    // من وثائق AWS: "Examples of how to derive a signing key for SigV4"
    const hmac = (k: string | Buffer, d: string) =>
      crypto.createHmac('sha256', k).update(d).digest();
    const kDate = hmac('AWS4wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20150830');
    const kRegion = hmac(kDate, 'us-east-1');
    const kService = hmac(kRegion, 'iam');
    const kSigning = hmac(kService, 'aws4_request');
    expect(kSigning.toString('hex')).toBe(
      'c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9',
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('r2ListObjects — السرد', () => {
  const twoItems =
    '<ListBucketResult>' +
    '<Contents><Key>backups/a.json</Key><Size>120</Size><LastModified>2026-08-01T03:00:00.000Z</LastModified></Contents>' +
    '<Contents><Key>backups/b.json</Key><Size>340</Size><LastModified>2026-08-02T03:00:00.000Z</LastModified></Contents>' +
    '</ListBucketResult>';

  it('يستخدم ListObjectsV2 ويمرر البادئة', async () => {
    nextBody = twoItems;
    await r2ListObjects(CFG, 'backups/');
    expect(captured[0].method).toBe('GET');
    expect(captured[0].path).toContain('list-type=2');
    expect(captured[0].path).toContain('prefix=backups%2F');
  });

  it('⚠ معاملات الاستعلام مرتبة أبجدياً — الترتيب جزء من التوقيع', async () => {
    nextBody = twoItems;
    await r2ListObjects(CFG, 'backups/');
    const names = captured[0].path.split('?')[1].split('&').map((kv) => kv.split('=')[0]);
    expect(names).toEqual([...names].sort());
  });

  it('يستخرج المفتاح والحجم والتاريخ', async () => {
    nextBody = twoItems;
    const res = await r2ListObjects(CFG, 'backups/');
    expect(res.ok).toBe(true);
    expect(res.objects).toHaveLength(2);
    expect(res.objects[0]).toEqual({
      key: 'backups/a.json',
      size: 120,
      lastModified: '2026-08-01T03:00:00.000Z',
    });
  });

  it('قائمة فارغة تعيد ok مع صفر عناصر — ليست خطأً', async () => {
    nextBody = '<ListBucketResult></ListBucketResult>';
    const res = await r2ListObjects(CFG, 'backups/');
    expect(res.ok).toBe(true);
    expect(res.objects).toHaveLength(0);
  });

  it('يعيد فشلاً عند خطأ HTTP', async () => {
    nextStatus = 500;
    nextBody = '<Error><Code>InternalError</Code><Message>عطل</Message></Error>';
    const res = await r2ListObjects(CFG, 'backups/');
    expect(res.ok).toBe(false);
    expect(res.objects).toHaveLength(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('r2DeleteObject / r2GetObject', () => {
  it('الحذف يستخدم DELETE على مسار الملف', async () => {
    nextStatus = 204;
    const res = await r2DeleteObject(CFG, 'backups/old.json');
    expect(captured[0].method).toBe('DELETE');
    expect(captured[0].path).toBe('/soulia-backups/backups/old.json');
    expect(res.ok).toBe(true);
  });

  it('التنزيل يعيد الجسم', async () => {
    nextBody = '{"restored":true}';
    const res = await r2GetObject(CFG, 'backups/a.json');
    expect(res.ok).toBe(true);
    expect(res.body).toBe('{"restored":true}');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('r2TestConnection — اختبار الاتصال', () => {
  it('⚠ يكتب فعلياً، لا يكتفي بالسرد — مفتاح للقراءة فقط ينجح في السرد ويفشل في الرفع', async () => {
    nextStatus = 200;
    nextBody = 'test';
    await r2TestConnection(CFG);
    expect(captured.some((c) => c.method === 'PUT')).toBe(true);
  });

  it('ينظّف بعده — يحذف ملف الاختبار', async () => {
    nextStatus = 200;
    nextBody = 'test';
    await r2TestConnection(CFG);
    expect(captured.some((c) => c.method === 'DELETE')).toBe(true);
  });

  it('يشرح خطأ الصلاحية بدل عرض رمز خام', async () => {
    nextStatus = 403;
    nextBody = '<Error><Code>AccessDenied</Code><Message>no</Message></Error>';
    const res = await r2TestConnection(CFG);
    expect(res.ok).toBe(false);
    expect(res.message).toContain('Object Read & Write');
  });

  it('يسمّي الـ bucket المفقود بدل رسالة عامة', async () => {
    nextStatus = 404;
    nextBody = '<Error><Code>NoSuchBucket</Code><Message>missing</Message></Error>';
    const res = await r2TestConnection(CFG);
    expect(res.ok).toBe(false);
    expect(res.message).toContain('soulia-backups');
  });

  it('ينجح عند اكتمال الكتابة والقراءة', async () => {
    nextStatus = 200;
    nextBody = 'soulia connectivity test';
    const res = await r2TestConnection(CFG);
    expect(res.ok).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('normalizeR2AccountId — الحقل يقبل ما تعرضه لوحة Cloudflare', () => {
  const ID = '253dd513cc37630978a505bdc4090942';

  it('المعرّف وحده يمر كما هو', () => {
    expect(normalizeR2AccountId(ID)).toBe(ID);
  });

  it('⚠ الرابط الكامل — هذا ما لُصق فعلياً وأنتج ENOTFOUND', () => {
    expect(normalizeR2AccountId('https://' + ID + '.r2.cloudflarestorage.com')).toBe(ID);
  });

  it('المضيف بلا بروتوكول', () => {
    expect(normalizeR2AccountId(ID + '.r2.cloudflarestorage.com')).toBe(ID);
  });

  it('رابط بشرطة مائلة في آخره', () => {
    expect(normalizeR2AccountId('https://' + ID + '.r2.cloudflarestorage.com/')).toBe(ID);
  });

  it('رابط بمسار بعده', () => {
    expect(normalizeR2AccountId('https://' + ID + '.r2.cloudflarestorage.com/soulia-backups')).toBe(ID);
  });

  it('http وليس https', () => {
    expect(normalizeR2AccountId('http://' + ID + '.r2.cloudflarestorage.com')).toBe(ID);
  });

  it('مسافات حول القيمة', () => {
    expect(normalizeR2AccountId('  ' + ID + '  ')).toBe(ID);
  });

  it('حروف كبيرة في اللاحقة', () => {
    expect(normalizeR2AccountId(ID + '.R2.CloudflareStorage.COM')).toBe(ID);
  });

  it('فارغ يبقى فارغاً', () => {
    expect(normalizeR2AccountId('')).toBe('');
    expect(normalizeR2AccountId('   ')).toBe('');
  });

  it('⚠ المضيف الناتج لا يكرر اللاحقة مهما كان شكل المدخل', async () => {
    for (const form of [ID, ID + '.r2.cloudflarestorage.com', 'https://' + ID + '.r2.cloudflarestorage.com/']) {
      captured = [];
      await r2DeleteObject({ ...CFG, accountId: form }, 'k.json');
      expect(captured[0].hostname).toBe(ID + '.r2.cloudflarestorage.com');
    }
  });
});
