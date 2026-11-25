import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Cron } from '@nestjs/schedule';
import { Connection } from 'mongoose';
import { ObjectId } from 'mongodb';
import { createHmac, randomBytes } from 'crypto';
import {
  API_SCOPES, generateApiKey, hashApiKey, ipAllowed, normalizeIpList, normalizeRateLimit, normalizeScopes,
  RateWindow, DEFAULT_RATE_LIMIT,
} from './api-key.util';
import { SettingsService } from '../settings/settings.service';
import { mentionView } from './public-api.view';

/**
 * External API keys — storage, authentication, request log, the global stop and the mention
 * webhook. Raw collections (no Mongoose schema), like announcements:
 *   apikeys          one row per key; only the SHA-256 of the key is stored
 *   apirequestlogs   one row per request (kept 90 days by a TTL index)
 *   apiconfig        `_id: 'global'` — the master switch
 *
 * ⚠ The plain key exists only in the response to create/rotate. Never log it, never store it.
 */
export type ApiKeyDoc = {
  _id: ObjectId;
  name: string;
  keyHash: string;
  prefix: string;
  scopes: string[];
  status: 'active' | 'paused' | 'revoked';
  linkedUserId: string;
  linkedUserName: string;
  rateLimit: number;
  ipAllowlist: string[];
  phoneAccess: 'detail' | 'masked' | 'full';
  expiresAt: Date | null;
  webhookUrl: string;
  webhookSecret: string;
  webhookCursor: Date | null;
  webhookLastAt: Date | null;
  webhookLastError: string;
  lastUsedAt: Date | null;
  lastUsedIp: string;
  createdAt: Date;
  createdBy: string;
  history: { at: Date; by: string; action: string; detail?: string }[];
};

export type ApiActor = { userId: string; name: string };

const LOG_TTL_DAYS = 90;

@Injectable()
export class ApiKeysService implements OnModuleInit {
  private readonly logger = new Logger(ApiKeysService.name);
  private readonly rate = new RateWindow();
  private readonly lastUseWrite = new Map<string, number>();
  private globalCache: { at: number; enabled: boolean } | null = null;
  private webhookRunning = false;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly settings: SettingsService,
  ) {}

  private get keys() { return this.connection.db!.collection<ApiKeyDoc>('apikeys'); }
  private get logs() { return this.connection.db!.collection('apirequestlogs'); }
  private get config() { return this.connection.db!.collection<{ _id: string; enabled: boolean; changedAt?: Date; changedBy?: string }>('apiconfig'); }

  async onModuleInit() {
    try {
      await this.keys.createIndex({ keyHash: 1 }, { unique: true });
      await this.logs.createIndex({ at: 1 }, { expireAfterSeconds: LOG_TTL_DAYS * 86400 });
      await this.logs.createIndex({ keyId: 1, at: -1 });
    } catch (e: any) {
      this.logger.warn(`API key indexes: ${e.message}`);
    }
  }

  // ── Master switch ─────────────────────────────────────────────────────────────────────────────
  async isEnabled(): Promise<boolean> {
    // Read at most once a second: the stop must take effect at once, the guard runs on every call.
    if (this.globalCache && Date.now() - this.globalCache.at < 1000) return this.globalCache.enabled;
    const doc = await this.config.findOne({ _id: 'global' });
    const enabled = doc ? doc.enabled !== false : true;
    this.globalCache = { at: Date.now(), enabled };
    return enabled;
  }

  async setEnabled(enabled: boolean, actor: ApiActor) {
    await this.config.updateOne({ _id: 'global' }, { $set: { enabled: !!enabled, changedAt: new Date(), changedBy: actor.name } }, { upsert: true });
    this.globalCache = null;
    return { enabled: !!enabled };
  }

  // ── PIN for sensitive changes ─────────────────────────────────────────────────────────────────
  private async requirePin(pin: unknown) {
    const ok = await this.settings.verifyVaultPassword(String(pin ?? ''));
    if (!ok) throw new ForbiddenException('الرقم السري للنظام غير صحيح');
  }

  // ── Admin views ───────────────────────────────────────────────────────────────────────────────
  private present(k: ApiKeyDoc, extra: Record<string, unknown> = {}) {
    return {
      id: String(k._id),
      name: k.name,
      prefix: k.prefix,
      scopes: k.scopes || [],
      status: k.status,
      linkedUserId: k.linkedUserId || '',
      linkedUserName: k.linkedUserName || '',
      rateLimit: k.rateLimit || DEFAULT_RATE_LIMIT,
      ipAllowlist: k.ipAllowlist || [],
      phoneAccess: k.phoneAccess || 'detail',
      expiresAt: k.expiresAt || null,
      expired: !!(k.expiresAt && new Date(k.expiresAt).getTime() <= Date.now()),
      webhookUrl: k.webhookUrl || '',
      webhookSecretSet: !!k.webhookSecret,
      webhookLastAt: k.webhookLastAt || null,
      webhookLastError: k.webhookLastError || '',
      lastUsedAt: k.lastUsedAt || null,
      lastUsedIp: k.lastUsedIp || '',
      createdAt: k.createdAt,
      createdBy: k.createdBy || '',
      history: (k.history || []).slice(-30).reverse(),
      requestsLastMinute: this.rate.count(String(k._id)),
      ...extra,
    };
  }

  async overview() {
    const [list, enabled, since] = [await this.keys.find({}).sort({ createdAt: -1 }).toArray(), await this.isEnabled(), new Date(Date.now() - 864e5)];
    const stats = await this.logs.aggregate([
      { $match: { at: { $gte: since } } },
      { $group: { _id: '$keyId', total: { $sum: 1 }, errors: { $sum: { $cond: [{ $gte: ['$status', 400] }, 1, 0] } }, writes: { $sum: { $cond: [{ $eq: ['$method', 'POST'] }, 1, 0] } }, avgMs: { $avg: '$ms' } } },
    ]).toArray();
    const byKey = new Map(stats.map((s: any) => [String(s._id || ''), s]));
    const unknown = byKey.get('') as any;
    return {
      enabled,
      scopes: API_SCOPES,
      keys: list.map((k) => {
        const s: any = byKey.get(String(k._id)) || {};
        return this.present(k, { last24h: { total: s.total || 0, errors: s.errors || 0, writes: s.writes || 0, avgMs: Math.round(s.avgMs || 0) } });
      }),
      rejectedUnknown24h: unknown?.total || 0,
    };
  }

  private async linkedUser(userId: unknown): Promise<{ id: string; name: string }> {
    const id = String(userId || '').trim();
    if (!id) throw new BadRequestException('اختر حساب المستخدم الذي يكتب به التكامل');
    if (!ObjectId.isValid(id)) throw new BadRequestException('حساب المستخدم غير صالح');
    const u: any = await this.connection.db!.collection('users').findOne({ _id: new ObjectId(id) }, { projection: { name: 1, username: 1, isActive: 1 } });
    if (!u) throw new BadRequestException('حساب المستخدم غير موجود');
    if (u.isActive === false) throw new BadRequestException('حساب المستخدم معطّل');
    return { id, name: String(u.name || u.username || '') };
  }

  private cleanName(v: unknown): string {
    const s = String(v ?? '').replace(/[\u0000-\u001f‪-‮⁦-⁩]/g, '').trim().slice(0, 60);
    if (!s) throw new BadRequestException('اسم المفتاح مطلوب');
    return s;
  }

  private cleanExpiry(v: unknown): Date | null {
    if (v === null || v === undefined || v === '') return null;
    const d = new Date(String(v));
    if (Number.isNaN(d.getTime())) throw new BadRequestException('تاريخ الانتهاء غير صالح');
    if (d.getTime() <= Date.now()) throw new BadRequestException('تاريخ الانتهاء يجب أن يكون في المستقبل');
    return d;
  }

  private cleanWebhookUrl(v: unknown): string {
    const s = String(v ?? '').trim();
    if (!s) return '';
    let u: URL;
    try { u = new URL(s); } catch { throw new BadRequestException('رابط الـ Webhook غير صالح'); }
    const local = ['localhost', '127.0.0.1', '::1'].includes(u.hostname);
    if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new BadRequestException('رابط الـ Webhook يجب أن يبدأ بـ https://');
    return u.toString().slice(0, 500);
  }

  private cleanPhoneAccess(v: unknown): 'detail' | 'masked' | 'full' {
    return v === 'masked' || v === 'full' ? v : 'detail';
  }

  async create(body: any, actor: ApiActor) {
    await this.requirePin(body?.pin);
    const user = await this.linkedUser(body?.linkedUserId);
    const scopes = normalizeScopes(body?.scopes);
    if (!scopes.length) throw new BadRequestException('اختر قسمًا واحدًا على الأقل');
    const { key, hash, prefix } = generateApiKey();
    const webhookUrl = this.cleanWebhookUrl(body?.webhookUrl);
    const webhookSecret = webhookUrl ? 'whsec_' + randomBytes(24).toString('base64url') : '';
    const now = new Date();
    const doc: Omit<ApiKeyDoc, '_id'> = {
      name: this.cleanName(body?.name),
      keyHash: hash,
      prefix,
      scopes,
      status: 'active',
      linkedUserId: user.id,
      linkedUserName: user.name,
      rateLimit: normalizeRateLimit(body?.rateLimit),
      ipAllowlist: normalizeIpList(body?.ipAllowlist),
      phoneAccess: this.cleanPhoneAccess(body?.phoneAccess),
      expiresAt: this.cleanExpiry(body?.expiresAt),
      webhookUrl,
      webhookSecret,
      webhookCursor: webhookUrl ? now : null,
      webhookLastAt: null,
      webhookLastError: '',
      lastUsedAt: null,
      lastUsedIp: '',
      createdAt: now,
      createdBy: actor.name,
      history: [{ at: now, by: actor.name, action: 'created', detail: scopes.join(', ') }],
    };
    const res = await this.keys.insertOne(doc as any);
    const saved = await this.keys.findOne({ _id: res.insertedId });
    return { key, webhookSecret: webhookSecret || undefined, item: this.present(saved!) };
  }

  private async load(id: string): Promise<ApiKeyDoc> {
    if (!ObjectId.isValid(id)) throw new NotFoundException('المفتاح غير موجود');
    const k = await this.keys.findOne({ _id: new ObjectId(id) });
    if (!k) throw new NotFoundException('المفتاح غير موجود');
    return k;
  }

  async update(id: string, body: any, actor: ApiActor) {
    const k = await this.load(id);
    if (k.status === 'revoked') throw new BadRequestException('المفتاح ملغي ولا يمكن تعديله');
    const set: Record<string, unknown> = {};
    const changed: string[] = [];
    if (body?.name !== undefined) { set.name = this.cleanName(body.name); changed.push('name'); }
    if (body?.scopes !== undefined) {
      const scopes = normalizeScopes(body.scopes);
      if (!scopes.length) throw new BadRequestException('اختر قسمًا واحدًا على الأقل');
      set.scopes = scopes; changed.push('scopes:' + scopes.join('|'));
    }
    if (body?.rateLimit !== undefined) { set.rateLimit = normalizeRateLimit(body.rateLimit); changed.push('rateLimit:' + set.rateLimit); }
    if (body?.phoneAccess !== undefined) { set.phoneAccess = this.cleanPhoneAccess(body.phoneAccess); changed.push('phoneAccess:' + set.phoneAccess); }
    // Widening who can reach the key, who it writes as, and where it sends data need the PIN.
    const sensitive = body?.ipAllowlist !== undefined || body?.linkedUserId !== undefined || body?.expiresAt !== undefined || body?.webhookUrl !== undefined;
    if (sensitive) await this.requirePin(body?.pin);
    if (body?.ipAllowlist !== undefined) { set.ipAllowlist = normalizeIpList(body.ipAllowlist); changed.push('ipAllowlist'); }
    if (body?.expiresAt !== undefined) { set.expiresAt = this.cleanExpiry(body.expiresAt); changed.push('expiresAt'); }
    if (body?.linkedUserId !== undefined) {
      const user = await this.linkedUser(body.linkedUserId);
      set.linkedUserId = user.id; set.linkedUserName = user.name; changed.push('linkedUser:' + user.name);
    }
    let webhookSecret: string | undefined;
    if (body?.webhookUrl !== undefined) {
      const url = this.cleanWebhookUrl(body.webhookUrl);
      set.webhookUrl = url;
      if (!url) { set.webhookSecret = ''; set.webhookCursor = null; }
      else if (url !== k.webhookUrl || !k.webhookSecret) {
        webhookSecret = 'whsec_' + randomBytes(24).toString('base64url');
        set.webhookSecret = webhookSecret; set.webhookCursor = new Date(); set.webhookLastError = '';
      }
      changed.push('webhook');
    }
    if (!changed.length) return { item: this.present(k) };
    await this.keys.updateOne({ _id: k._id }, { $set: set, $push: { history: { at: new Date(), by: actor.name, action: 'updated', detail: changed.join(', ') } } } as any);
    return { item: this.present(await this.load(id)), webhookSecret };
  }

  async setPaused(id: string, paused: boolean, actor: ApiActor) {
    const k = await this.load(id);
    if (k.status === 'revoked') throw new BadRequestException('المفتاح ملغي');
    const status = paused ? 'paused' : 'active';
    if (k.status !== status) {
      await this.keys.updateOne({ _id: k._id, status: { $ne: 'revoked' } }, { $set: { status }, $push: { history: { at: new Date(), by: actor.name, action: paused ? 'paused' : 'resumed' } } } as any);
    }
    return { item: this.present(await this.load(id)) };
  }

  async rotate(id: string, pin: unknown, actor: ApiActor) {
    await this.requirePin(pin);
    const k = await this.load(id);
    if (k.status === 'revoked') throw new BadRequestException('المفتاح ملغي — أنشئ مفتاحًا جديدًا');
    const { key, hash, prefix } = generateApiKey();
    // One write: the old hash stops working the moment the new one is stored.
    await this.keys.updateOne({ _id: k._id }, { $set: { keyHash: hash, prefix }, $push: { history: { at: new Date(), by: actor.name, action: 'rotated' } } } as any);
    return { key, item: this.present(await this.load(id)) };
  }

  async revoke(id: string, pin: unknown, actor: ApiActor) {
    await this.requirePin(pin);
    const k = await this.load(id);
    if (k.status !== 'revoked') {
      // The hash is replaced too, so a revoked key can never match again even if its status were edited.
      await this.keys.updateOne({ _id: k._id }, { $set: { status: 'revoked', keyHash: 'revoked:' + String(k._id) + ':' + randomBytes(8).toString('hex') }, $push: { history: { at: new Date(), by: actor.name, action: 'revoked' } } } as any);
    }
    return { item: this.present(await this.load(id)) };
  }

  async requestLog(q: any) {
    const filter: Record<string, unknown> = {};
    if (q?.keyId) filter.keyId = String(q.keyId);
    if (q?.result === 'errors') filter.status = { $gte: 400 };
    else if (q?.result === 'ok') filter.status = { $lt: 400 };
    if (q?.method === 'POST' || q?.method === 'GET') filter.method = q.method;
    if (q?.path) filter.path = { $regex: String(q.path).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 60), $options: 'i' };
    const limit = Math.min(200, Math.max(1, Number(q?.limit) || 50));
    const page = Math.max(1, Number(q?.page) || 1);
    const [rows, total] = await Promise.all([
      this.logs.find(filter).sort({ at: -1 }).skip((page - 1) * limit).limit(limit).toArray(),
      this.logs.countDocuments(filter),
    ]);
    return { total, page, limit, rows: rows.map((r: any) => ({ ...r, _id: String(r._id) })) };
  }

  // ── Authentication (used by the guard) ────────────────────────────────────────────────────────
  async authenticate(rawKey: string, ip: string, scope: string | undefined): Promise<ApiKeyDoc> {
    let found: ApiKeyDoc | null = null;
    const fail = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) => {
      const err = new HttpException({ statusCode: status, code, message, ...extra }, status);
      // A refusal of a known key (paused, IP, scope, rate) is logged under that key.
      if (found) (err as any).apiKey = found;
      return err;
    };
    if (!(await this.isEnabled())) throw fail(HttpStatus.SERVICE_UNAVAILABLE, 'API_DISABLED', 'الوصول عبر API متوقف من لوحة الإدارة');
    if (!rawKey) throw fail(HttpStatus.UNAUTHORIZED, 'API_KEY_MISSING', 'مفتاح API مطلوب في الهيدر X-API-Key');
    const k = await this.keys.findOne({ keyHash: hashApiKey(rawKey) });
    if (!k) throw fail(HttpStatus.UNAUTHORIZED, 'API_KEY_INVALID', 'مفتاح API غير صحيح');
    found = k;
    if (k.status === 'revoked') throw fail(HttpStatus.UNAUTHORIZED, 'API_KEY_REVOKED', 'مفتاح API ملغي');
    if (k.status === 'paused') throw fail(HttpStatus.FORBIDDEN, 'API_KEY_PAUSED', 'مفتاح API موقوف مؤقتًا من لوحة الإدارة');
    if (k.expiresAt && new Date(k.expiresAt).getTime() <= Date.now()) throw fail(HttpStatus.UNAUTHORIZED, 'API_KEY_EXPIRED', 'انتهت صلاحية مفتاح API');
    if (!ipAllowed(ip, k.ipAllowlist)) throw fail(HttpStatus.FORBIDDEN, 'IP_NOT_ALLOWED', 'عنوان IP غير مسموح لهذا المفتاح');
    if (scope && !(k.scopes || []).includes(scope)) throw fail(HttpStatus.FORBIDDEN, 'SCOPE_NOT_ALLOWED', `هذا المفتاح لا يملك صلاحية «${scope}»`, { scope });
    const wait = this.rate.take(String(k._id), k.rateLimit || DEFAULT_RATE_LIMIT);
    if (wait) throw fail(HttpStatus.TOO_MANY_REQUESTS, 'RATE_LIMITED', `تجاوزت حد الطلبات (${k.rateLimit}/دقيقة)`, { retryAfter: wait });
    const last = this.lastUseWrite.get(String(k._id)) || 0;
    if (Date.now() - last > 30_000) {
      this.lastUseWrite.set(String(k._id), Date.now());
      this.keys.updateOne({ _id: k._id }, { $set: { lastUsedAt: new Date(), lastUsedIp: ip } }).catch(() => null);
    }
    return k;
  }

  /** Best effort — a log failure never fails the request. */
  record(row: { keyId: string; keyName: string; prefix: string; method: string; path: string; query: string; status: number; ms: number; ip: string; ua: string; code?: string; scope?: string; detail?: string }) {
    this.logs.insertOne({ ...row, at: new Date() }).catch((e) => this.logger.warn(`API log write failed: ${e.message}`));
  }

  // ── Mention webhook ───────────────────────────────────────────────────────────────────────────
  @Cron('*/15 * * * * *', { name: 'api-mention-webhook' })
  async deliverWebhooks() {
    if (this.webhookRunning) return;
    this.webhookRunning = true;
    try {
      if (!(await this.isEnabled())) return;
      const list = await this.keys.find({ status: 'active', webhookUrl: { $gt: '' }, scopes: 'mentions', linkedUserId: { $gt: '' } } as any).toArray();
      for (const k of list) {
        if (k.expiresAt && new Date(k.expiresAt).getTime() <= Date.now()) continue;
        await this.deliverFor(k).catch((e) => this.logger.warn(`Webhook ${k.name}: ${e.message}`));
      }
    } finally {
      this.webhookRunning = false;
    }
  }

  private async deliverFor(k: ApiKeyDoc) {
    const cursor = k.webhookCursor ? new Date(k.webhookCursor) : new Date();
    const rows = await this.connection.db!.collection('mentions')
      .find({ targetUserId: k.linkedUserId, createdAt: { $gt: cursor } })
      .sort({ createdAt: 1 }).limit(20).toArray();
    for (const m of rows) {
      const createdAt = new Date((m as any).createdAt);
      const data = await mentionView(this.connection.db!, m);
      const body = JSON.stringify({ event: 'mention.created', id: String(m._id), at: createdAt.toISOString(), data });
      const ok = await this.post(k, body, String(m._id));
      // A delivery that keeps failing for a day is skipped, so one dead event never blocks the rest.
      if (!ok && Date.now() - createdAt.getTime() < 864e5) return;
      await this.keys.updateOne({ _id: k._id }, { $set: { webhookCursor: createdAt, ...(ok ? { webhookLastAt: new Date(), webhookLastError: '' } : {}) } });
    }
  }

  private async post(k: ApiKeyDoc, body: string, eventId: string): Promise<boolean> {
    const started = Date.now();
    const signature = 'sha256=' + createHmac('sha256', k.webhookSecret).update(body).digest('hex');
    let status = 0; let error = '';
    try {
      const res = await fetch(k.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Soulia-Signature': signature, 'X-Soulia-Event-Id': eventId, 'User-Agent': 'Soulia-Webhook/1' },
        body,
        signal: AbortSignal.timeout(8000),
      });
      status = res.status;
      if (!res.ok) error = `HTTP ${res.status}`;
    } catch (e: any) {
      error = String(e?.message || e).slice(0, 200);
    }
    this.record({ keyId: String(k._id), keyName: k.name, prefix: k.prefix, method: 'WEBHOOK', path: 'mention.created', query: eventId, status: status || 599, ms: Date.now() - started, ip: '', ua: '', code: error ? 'WEBHOOK_FAILED' : undefined, detail: error || undefined });
    if (error) await this.keys.updateOne({ _id: k._id }, { $set: { webhookLastError: error } }).catch(() => null);
    return !error;
  }

  async testWebhook(id: string) {
    const k = await this.load(id);
    if (!k.webhookUrl || !k.webhookSecret) throw new BadRequestException('لا يوجد رابط Webhook لهذا المفتاح');
    const body = JSON.stringify({ event: 'ping', id: 'ping-' + Date.now(), at: new Date().toISOString(), data: { message: 'Soulia webhook test' } });
    const ok = await this.post(k, body, 'ping');
    const fresh = await this.load(id);
    return { ok, error: ok ? '' : fresh.webhookLastError };
  }
}
