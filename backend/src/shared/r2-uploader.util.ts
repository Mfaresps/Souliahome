/**
 * رافع ملفات إلى Cloudflare R2 عبر بروتوكول S3 — بلا أي حزمة خارجية.
 * ---------------------------------------------------------------------------
 * لماذا توقيع يدوي بدل @aws-sdk/client-s3؟
 *
 * الحزمة تضيف ~15 ميجا و عشرات التبعيات لأجل عمليتين فقط (PUT و GET/list).
 * نفس الاختيار الذي اتُّخذ في `testBostaApiKey`: استُخدم `https` مباشرة بدل
 * عميل HTTP كامل. التوقيع هنا هو AWS Signature V4 القياسي، و R2 يقبله كما هو.
 *
 * ⚠ المفاتيح لا تُمرَّر عبر عنوان URL ولا تُسجَّل في اللوج أبداً. كل ما يظهر في
 * اللوج هو اسم الملف وحجمه ونتيجة العملية.
 */
import * as https from 'https';
import * as crypto from 'crypto';

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

const SERVICE = 's3';
const REGION = 'auto';

function sha256Hex(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmac(key: string | Buffer, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data).digest();
}

/**
 * ⚠ كل جزء من المسار يُرمَّز على حدة والشرطة المائلة تبقى كما هي.
 * `encodeURIComponent` على المسار كاملاً يحوّل «/» إلى «%2F» فيصبح المفتاح
 * اسماً واحداً طويلاً بدل مجلد — والتوقيع يُحسب على المسار المرمَّز نفسه،
 * فأي اختلاف هنا ينتج 403 SignatureDoesNotMatch لا 404.
 */
function encodePath(key: string): string {
  return key
    .split('/')
    .map((seg) => encodeURIComponent(seg).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()))
    .join('/');
}

/** يبني ترويسة Authorization بصيغة AWS SigV4. */
function signRequest(opts: {
  cfg: R2Config;
  method: string;
  canonicalUri: string;
  canonicalQuery: string;
  payloadHash: string;
  host: string;
  extraHeaders?: Record<string, string>;
}): Record<string, string> {
  const { cfg, method, canonicalUri, canonicalQuery, payloadHash, host, extraHeaders = {} } = opts;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20260828T221500Z
  const dateStamp = amzDate.slice(0, 8);

  const headers: Record<string, string> = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...extraHeaders,
  };

  // التوقيع يتطلب ترتيباً أبجدياً صارماً للأسماء بحروف صغيرة.
  const sortedNames = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort();
  const canonicalHeaders = sortedNames.map((h) => `${h}:${String(headers[h]).trim()}\n`).join('');
  const signedHeaders = sortedNames.join(';');

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${cfg.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, SERVICE);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  headers['Authorization'] =
    `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return headers;
}

interface R2Response {
  status: number;
  body: string;
}

function request(
  opts: { host: string; path: string; method: string; headers: Record<string, string> },
  payload?: Buffer,
): Promise<R2Response> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: opts.host,
        path: opts.path,
        method: opts.method,
        headers: opts.headers,
        timeout: 120000,
      },
      (res) => {
        let body = '';
        res.on('data', (c) => {
          body += c;
        });
        res.on('end', () => resolve({ status: res.statusCode || 0, body }));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('انتهت مهلة الاتصال بـ R2'));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/** رسالة الخطأ من R2 تأتي XML — هذا يستخرج <Message> منها لتصلح للعرض. */
function extractError(body: string, status: number): string {
  const m = /<Message>([\s\S]*?)<\/Message>/.exec(body || '');
  const code = /<Code>([\s\S]*?)<\/Code>/.exec(body || '');
  if (m) return `${code ? code[1] + ': ' : ''}${m[1]}`;
  return `HTTP ${status}`;
}

/**
 * يستخرج معرّف الحساب من أي شكل يلصقه المستخدم.
 *
 * ⚠ لوحة Cloudflare تعرض العنوان كاملاً، فمن الطبيعي تماماً أن يُنسخ كما هو.
 * وبما أن `hostFor` تضيف اللاحقة بنفسها، كان لصق الرابط الكامل ينتج
 * «...cloudflarestorage.com.r2.cloudflarestorage.com» ويفشل بـ ENOTFOUND —
 * رسالة تبدو كعطل شبكة بينما السبب حقل قَبِل قيمة صحيحة بصيغة أخرى.
 *
 * يقبل الثلاثة:
 *   253dd...0942
 *   253dd...0942.r2.cloudflarestorage.com
 *   https://253dd...0942.r2.cloudflarestorage.com/
 */
export function normalizeR2AccountId(raw: string): string {
  let v = (raw || '').trim();
  if (!v) return '';
  v = v.replace(/^https?:\/\//i, '');   // البروتوكول
  v = v.replace(/\/.*$/, '');            // أي مسار بعد المضيف
  v = v.replace(/\.r2\.cloudflarestorage\.com\.?$/i, ''); // اللاحقة
  return v.trim();
}

function hostFor(cfg: R2Config): string {
  return `${normalizeR2AccountId(cfg.accountId)}.r2.cloudflarestorage.com`;
}

/** يرفع ملفاً واحداً. يعيد رسالة الخطأ عند الفشل بدل رميه. */
export async function r2PutObject(
  cfg: R2Config,
  key: string,
  body: Buffer,
): Promise<{ ok: boolean; message: string }> {
  try {
    const host = hostFor(cfg);
    const canonicalUri = `/${encodePath(cfg.bucket)}/${encodePath(key)}`;
    const payloadHash = sha256Hex(body);

    const headers = signRequest({
      cfg,
      method: 'PUT',
      canonicalUri,
      canonicalQuery: '',
      payloadHash,
      host,
      extraHeaders: {
        'content-length': String(body.length),
        'content-type': 'application/json',
      },
    });

    const res = await request({ host, path: canonicalUri, method: 'PUT', headers }, body);
    if (res.status >= 200 && res.status < 300) return { ok: true, message: 'تم الرفع' };
    return { ok: false, message: extractError(res.body, res.status) };
  } catch (e: any) {
    return { ok: false, message: e?.message || 'خطأ غير معروف' };
  }
}

export interface R2Object {
  key: string;
  size: number;
  lastModified: string;
}

/**
 * يسرد محتويات مجلد. `prefix` هو المجلد داخل الـ bucket.
 * ⚠ يتعامل مع الترقيم (continuation token): bucket فيه أكثر من 1000 ملف يعيد
 * الصفحة الأولى فقط بدونه، فتُحسب النسخ ناقصة ويُتخذ قرار حذف خاطئ بناءً عليها.
 */
export async function r2ListObjects(
  cfg: R2Config,
  prefix: string,
): Promise<{ ok: boolean; message: string; objects: R2Object[] }> {
  const objects: R2Object[] = [];
  let token = '';

  try {
    const host = hostFor(cfg);
    const canonicalUri = `/${encodePath(cfg.bucket)}`;

    for (let page = 0; page < 20; page++) {
      // المعاملات يجب أن تكون مرتبة أبجدياً في الاستعلام القانوني.
      const params: [string, string][] = [
        ['list-type', '2'],
        ['max-keys', '1000'],
        ['prefix', prefix],
      ];
      if (token) params.push(['continuation-token', token]);
      params.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      const canonicalQuery = params
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');

      const payloadHash = sha256Hex('');
      const headers = signRequest({
        cfg,
        method: 'GET',
        canonicalUri,
        canonicalQuery,
        payloadHash,
        host,
      });

      const res = await request({
        host,
        path: `${canonicalUri}?${canonicalQuery}`,
        method: 'GET',
        headers,
      });

      if (res.status < 200 || res.status >= 300) {
        return { ok: false, message: extractError(res.body, res.status), objects: [] };
      }

      const re = /<Contents>([\s\S]*?)<\/Contents>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(res.body)) !== null) {
        const chunk = m[1];
        const key = /<Key>([\s\S]*?)<\/Key>/.exec(chunk)?.[1] || '';
        const size = Number(/<Size>(\d+)<\/Size>/.exec(chunk)?.[1] || 0);
        const lastModified = /<LastModified>([\s\S]*?)<\/LastModified>/.exec(chunk)?.[1] || '';
        if (key) objects.push({ key, size, lastModified });
      }

      const truncated = /<IsTruncated>true<\/IsTruncated>/.test(res.body);
      const next = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(res.body)?.[1];
      if (!truncated || !next) break;
      token = next;
    }

    return { ok: true, message: 'تم', objects };
  } catch (e: any) {
    return { ok: false, message: e?.message || 'خطأ غير معروف', objects: [] };
  }
}

/** يحذف ملفاً واحداً. */
export async function r2DeleteObject(
  cfg: R2Config,
  key: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    const host = hostFor(cfg);
    const canonicalUri = `/${encodePath(cfg.bucket)}/${encodePath(key)}`;
    const payloadHash = sha256Hex('');

    const headers = signRequest({
      cfg,
      method: 'DELETE',
      canonicalUri,
      canonicalQuery: '',
      payloadHash,
      host,
    });

    const res = await request({ host, path: canonicalUri, method: 'DELETE', headers });
    // R2 يعيد 204 على الحذف الناجح، و 204 أيضاً لملف غير موجود.
    if (res.status >= 200 && res.status < 300) return { ok: true, message: 'تم الحذف' };
    return { ok: false, message: extractError(res.body, res.status) };
  } catch (e: any) {
    return { ok: false, message: e?.message || 'خطأ غير معروف' };
  }
}

/** ينزّل ملفاً. يُستخدم للاسترجاع من السحابة. */
export async function r2GetObject(
  cfg: R2Config,
  key: string,
): Promise<{ ok: boolean; message: string; body: string }> {
  try {
    const host = hostFor(cfg);
    const canonicalUri = `/${encodePath(cfg.bucket)}/${encodePath(key)}`;
    const payloadHash = sha256Hex('');

    const headers = signRequest({
      cfg,
      method: 'GET',
      canonicalUri,
      canonicalQuery: '',
      payloadHash,
      host,
    });

    const res = await request({ host, path: canonicalUri, method: 'GET', headers });
    if (res.status >= 200 && res.status < 300) return { ok: true, message: 'تم', body: res.body };
    return { ok: false, message: extractError(res.body, res.status), body: '' };
  } catch (e: any) {
    return { ok: false, message: e?.message || 'خطأ غير معروف', body: '' };
  }
}

/**
 * اختبار الاتصال — يكتب ملفاً صغيراً ثم يقرؤه ثم يحذفه.
 *
 * ⚠ الكتابة الفعلية مقصودة: مفتاح بصلاحية «قراءة فقط» ينجح في السرد ويفشل في
 * الرفع. اختبارٌ يسرد فقط كان سيقول «ناجح» ثم تفشل أول نسخة ليلية صامتةً.
 */
export async function r2TestConnection(
  cfg: R2Config,
): Promise<{ ok: boolean; message: string }> {
  const key = '_soulia_conn_test.txt';
  const payload = Buffer.from(`soulia connectivity test ${new Date().toISOString()}`, 'utf8');

  const put = await r2PutObject(cfg, key, payload);
  if (!put.ok) {
    if (/AccessDenied|Forbidden|SignatureDoesNotMatch/i.test(put.message)) {
      return {
        ok: false,
        message: `فشل الاتصال — تأكد من صحة المفاتيح وأن صلاحية التوكن «Object Read & Write»: ${put.message}`,
      };
    }
    if (/NoSuchBucket/i.test(put.message)) {
      return { ok: false, message: `الـ bucket «${cfg.bucket}» غير موجود — أنشئه من لوحة R2 أولاً` };
    }
    return { ok: false, message: `فشل الاتصال: ${put.message}` };
  }

  const get = await r2GetObject(cfg, key);
  await r2DeleteObject(cfg, key); // التنظيف يجري في الحالتين

  if (!get.ok) return { ok: false, message: `الرفع نجح لكن القراءة فشلت: ${get.message}` };
  return { ok: true, message: 'الاتصال بـ Cloudflare R2 ناجح ✅ (كتابة وقراءة وحذف)' };
}
