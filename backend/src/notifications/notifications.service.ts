import { BadRequestException, ForbiddenException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Cron } from '@nestjs/schedule';
import { Connection } from 'mongoose';
import { createHash, randomUUID } from 'crypto';

export const TYPES = ['deposit', 'comment', 'order', 'deliveryProblem', 'delivered', 'mention'] as const;
export type NotificationType = typeof TYPES[number];
export const DEFAULTS = { enabled: false, deposit: true, comment: true, order: true, deliveryProblem: true, delivered: true, mention: true };
const TITLES = { deposit: 'عربون جديد', comment: 'تعليق جديد', order: 'طلب جديد', deliveryProblem: 'مشكلة في التسليم', delivered: 'تم تسليم الطلب', mention: 'إشارة جديدة إليك' };
const EN_TITLES = { deposit: 'New Deposit', comment: 'New Comment', order: 'New Order', deliveryProblem: 'Delivery Issue', delivered: 'Order Delivered', mention: 'You Were Mentioned' };
export interface NotificationDetails { actorName?: string; amount?: number; pendingApproval?: boolean; vaultName?: string; commentId?: string | number; receiptId?: string; depositId?: string; commentText?: string; followupComment?: boolean; orderTotal?: number; deliveryStatus?: string; }
function cleanText(value: string | undefined, length: number) {
  return String(value || '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, length);
}
export function notificationBody(type: NotificationType, ref: string, details: NotificationDetails = {}, language: 'ar' | 'en' = 'ar') {
  const reference = cleanText(ref.replace(/^#+/, ''), 24);
  const actor = cleanText(details.actorName, 36) || (language === 'en' ? 'A team member' : 'أحد الموظفين');
  const orderLabel = language === 'en' ? (reference ? `Order #${reference}` : 'Order') : (reference ? `الطلب #${reference}` : 'الطلب');
  if (type === 'comment') {
    const prefix = details.followupComment ? `${actor} · ${orderLabel}` : language === 'en' ? `${actor} commented on ${orderLabel}` : `${actor} علّق على ${orderLabel}`;
    const text = cleanText(details.commentText, 10000);
    if (!text) return prefix;
    const limit = Math.min(80, 160 - prefix.length - 4);
    let excerpt = text;
    if (excerpt.length > limit) {
      excerpt = '';
      for (const char of text) { if (excerpt.length + char.length > limit - 1) break; excerpt += char; }
      excerpt = excerpt.trimEnd() + '…';
    }
    return `${prefix}: "${excerpt}"`;
  }
  if (type === 'order') {
    const amount = Number.isFinite(details.orderTotal) && details.orderTotal! >= 0 ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(details.orderTotal!) : '';
    return `${orderLabel}${amount ? language === 'en' ? ` · EGP ${amount}` : ` · ${amount} ج.م.` : ''} · ${language === 'en' ? 'New Order Received' : 'تم استلام طلب جديد'}`;
  }
  if (type === 'deliveryProblem') return `${orderLabel} · ${details.deliveryStatus === 'RETURNED' ? language === 'en' ? 'Returned Before Delivery' : 'مرتجع قبل التسليم' : language === 'en' ? 'Delivery Failed' : 'فشل التسليم'} · ${language === 'en' ? 'Action Required' : 'مطلوب إجراء'}`;
  if (type === 'delivered') return `${orderLabel} · ${language === 'en' ? 'Successfully Delivered' : 'تم التسليم بنجاح'}`;
  if (language === 'en') {
    const order = reference ? `order #${reference}` : 'the order';
    if (type === 'mention') return `${actor} mentioned you in a comment on ${order}.`;
    if (type === 'deposit' && Number.isFinite(details.amount) && details.amount! > 0) {
      const amount = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(details.amount!);
      const vault = cleanText(details.vaultName, 32) || 'Unspecified vault';
      const name = ({ 'كاش': 'Cash', 'فودافون كاش': 'Vodafone Cash', 'تحويل بنكي': 'Bank Transfer', 'Instapay': 'InstaPay', 'instapay': 'InstaPay' } as Record<string, string>)[vault] || vault;
      return `${actor} added EGP ${amount} · ${name}${reference ? ' · #' + reference : ''}${details.pendingApproval === true ? ' · Review Required' : ''}`;
    }
    return '';
  }
  if (type === 'mention') return `إشارة من ${actor} إليك في تعليق على ${reference ? `الطلب رقم ${reference}` : 'الطلب'}.`;
  if (type === 'deposit' && Number.isFinite(details.amount) && details.amount! > 0) {
    const amount = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(details.amount!);
    const vault = cleanText(details.vaultName, 32) || 'خزنة غير محددة';
    return `${actor} أضاف ${amount} ج.م. · ${vault}${reference ? ' · #' + reference : ''}${details.pendingApproval === true ? ' · مطلوب مراجعة' : ''}`;
  }
  return '';
}
// Only browser-operated push providers. Never make HTTP requests to arbitrary subscription URLs.
const PROVIDERS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com', 'wns.windows.com', 'notify.windows.com'];
export function validateSubscription(value: any) {
  let url: URL;
  try { url = new URL(value?.endpoint); } catch { throw new BadRequestException('Invalid subscription'); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || value.endpoint.length > 2048 ||
      !PROVIDERS.some(host => url.hostname === host || url.hostname.endsWith('.' + host))) throw new BadRequestException('Unsupported push provider');
  const keys = value.keys;
  if (!keys || !/^[A-Za-z0-9_-]{87}=?$/.test(keys.p256dh) || Buffer.from(keys.p256dh, 'base64url').length !== 65 ||
      !/^[A-Za-z0-9_-]{22}={0,2}$/.test(keys.auth) || Buffer.from(keys.auth, 'base64url').length !== 16) throw new BadRequestException('Invalid subscription keys');
  return { endpoint: value.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}
export function validatePreferences(value: any) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length ||
      Object.keys(value).some(key => key === 'language' ? !['ar', 'en'].includes(value[key]) : !Object.prototype.hasOwnProperty.call(DEFAULTS, key) || typeof value[key] !== 'boolean')) throw new BadRequestException('Invalid preferences');
  return value;
}
export function eligible(user: any, preferences: any, type: NotificationType) {
  return ['admin', 'staff', 'viewer'].includes(user?.role) && (type === 'mention' || user.role === 'admin') && user.isActive !== false && preferences?.enabled === true && preferences[type] === true;
}

@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);
  private running = false;
  private push: any;
  constructor(@InjectConnection() private readonly connection: Connection) {}
  private get accounts() { return this.connection.collection('notificationaccounts'); }
  private get jobs() { return this.connection.collection('notificationjobs'); }
  get configured() { return !!this.push; }
  async onModuleInit() {
    await this.accounts.createIndex({ userId: 1 }, { unique: true });
    await this.accounts.createIndex({ 'subscriptions.endpoint': 1 }, { unique: true, sparse: true });
    await this.jobs.createIndex({ eventId: 1, userId: 1, endpoint: 1 }, { unique: true });
    await this.jobs.createIndex({ nextAt: 1, attempts: 1 });
    await this.jobs.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT) {
      this.push = require('web-push');
      this.push.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
    }
  }
  authorize(user: any) {
    if (!['admin', 'staff', 'viewer'].includes(user?.role) || user.isActive === false) throw new ForbiddenException('Notifications require an active account');
  }
  async settings(user: any) {
    this.authorize(user);
    const account: any = await this.accounts.findOne({ userId: user.userId });
    return { preferences: { ...DEFAULTS, ...account?.preferences }, configured: this.configured,
      publicKey: this.configured ? process.env.VAPID_PUBLIC_KEY : null, devices: (account?.subscriptions || []).length,
      language: account?.language || null,
      allowedTypes: user.role === 'admin' ? [...TYPES] : ['mention'] };
  }
  async preferences(user: any, body: any) {
    this.authorize(user); validatePreferences(body);
    if (user.role !== 'admin' && Object.keys(body).some(key => !['enabled', 'mention', 'language'].includes(key))) throw new ForbiddenException('Only administrators can manage business notifications');
    const set = Object.fromEntries(Object.entries(body).map(([key, value]) => [key === 'language' ? key : 'preferences.' + key, value]));
    await this.accounts.updateOne({ userId: user.userId }, { $set: set, $setOnInsert: { userId: user.userId } }, { upsert: true });
    return this.settings(user);
  }
  async subscribe(user: any, body: any) {
    this.authorize(user);
    if (!this.configured) throw new BadRequestException('Push is not configured');
    const subscription = validateSubscription(body);
    // A shared browser must have just one owner, including after account changes.
    await this.accounts.updateMany({}, { $pull: { subscriptions: { endpoint: subscription.endpoint } } } as any);
    const account: any = await this.accounts.findOne({ userId: user.userId });
    if ((account?.subscriptions || []).length >= 20) throw new BadRequestException('Device limit reached');
    await this.accounts.updateOne({ userId: user.userId }, { $addToSet: { subscriptions: subscription }, $setOnInsert: { userId: user.userId } } as any, { upsert: true });
    return { success: true };
  }
  async unsubscribe(user: any, body: any) {
    this.authorize(user);
    if (typeof body?.endpoint !== 'string' || body.endpoint.length > 2048) throw new BadRequestException('Invalid endpoint');
    await this.accounts.updateOne({ userId: user.userId }, { $pull: { subscriptions: { endpoint: body.endpoint } } } as any);
    return { success: true };
  }
  async test(user: any) {
    this.authorize(user);
    const settings = await this.settings(user);
    if (!settings.configured || !settings.preferences.enabled || !settings.devices) throw new BadRequestException('Enable notifications on this device first');
    await this.enqueue(user.role === 'admin' ? 'order' : 'mention', 'test:' + randomUUID(), 'اختبار الإشعارات', '', user.userId);
    return { queued: true };
  }
  // Safe to await after business commit: failures cannot change the business result.
  async enqueue(type: NotificationType, eventId: string, ref: string, recordId = '', onlyUser?: string, deliveryStatus?: string, details: NotificationDetails = {}) {
    try {
      if (!this.configured) return;
      if (type === 'mention' && !onlyUser) return;
      const users = await this.connection.collection('users').find({ ...(type === 'mention' ? {} : { role: 'admin' }), isActive: { $ne: false } }).toArray();
      for (const user of users) {
        const userId = String(user._id);
        if (onlyUser && userId !== onlyUser) continue;
        const account: any = await this.accounts.findOne({ userId });
        const test = eventId.startsWith('test:') && !!onlyUser;
        if (!eligible(user, { ...DEFAULTS, ...account?.preferences, ...(test ? { [type]: true } : {}) }, type)) continue;
        const reference = String(ref || '').replace(/[^\p{L}\p{N}# _-]/gu, '').slice(0, 40);
        const language = account?.language === 'en' ? 'en' : 'ar';
        const titles = language === 'en' ? EN_TITLES : TITLES;
        const followupComment = details.followupComment || recordId.startsWith('followup:');
        const body = test ? (language === 'en' ? 'SOULIA notifications are working.' : 'تم تفعيل إشعارات SOULIA بنجاح.') : notificationBody(type, reference, { ...details, followupComment, deliveryStatus }, language) || (reference ? '#' + reference : titles[type]);
        const target = new URLSearchParams({ pushRecord: recordId, pushType: type });
        const event = type === 'comment' ? details.commentId : details.receiptId || details.depositId;
        if (event != null) target.set('pushEvent', String(event));
        const title = type === 'comment' && followupComment ? (language === 'en' ? 'New Follow-up' : 'تعليق متابعة جديد') : titles[type];
        const payload = JSON.stringify({ title: test ? (language === 'en' ? 'SOULIA test notification' : 'إشعار SOULIA تجريبي') : `${title} · SOULIA`, body, timestamp: Date.now(), lang: language, dir: language === 'en' ? 'ltr' : 'rtl',
          url: recordId ? '/?' + target.toString() : '/', tag: createHash('sha256').update(eventId).digest('hex') });
        for (const subscription of account?.subscriptions || []) {
          await this.jobs.updateOne({ eventId, userId, endpoint: subscription.endpoint }, { $setOnInsert: {
            eventId, userId, endpoint: subscription.endpoint, type, payload, attempts: 0, done: false,
            nextAt: new Date(), expiresAt: new Date(Date.now() + 30 * 86400000),
          } }, { upsert: true });
        }
      }
    } catch { this.logger.warn('Notification enqueue failed'); }
  }
  @Cron('*/10 * * * * *')
  async dispatch() {
    if (!this.push || this.running) return;
    this.running = true;
    try {
      for (let i = 0; i < 20; i++) {
        const job: any = await this.jobs.findOneAndUpdate({ done: false, attempts: { $lt: 3 }, nextAt: { $lte: new Date() } },
          { $set: { nextAt: new Date(Date.now() + 60000) }, $inc: { attempts: 1 } }, { returnDocument: 'after' });
        if (!job) break;
        const user = await this.connection.collection('users').findOne({ _id: new (require('mongoose').Types.ObjectId)(job.userId) });
        const account: any = await this.accounts.findOne({ userId: job.userId });
        const subscription = account?.subscriptions?.find((s: any) => s.endpoint === job.endpoint);
        const test = job.eventId?.startsWith('test:');
        if (!subscription || !eligible(user, { ...DEFAULTS, ...account?.preferences, ...(test ? { [job.type]: true } : {}) }, job.type)) {
          await this.jobs.updateOne({ _id: job._id }, { $set: { done: true } }); continue;
        }
        try {
          validateSubscription(subscription);
          await this.push.sendNotification(subscription, job.payload, { TTL: 3600, timeout: 10000 });
          await this.jobs.updateOne({ _id: job._id }, { $set: { done: true } });
        } catch (error: any) {
          const expired = [404, 410].includes(error.statusCode);
          if (expired) await this.accounts.updateOne({ userId: job.userId }, { $pull: { subscriptions: { endpoint: job.endpoint } } } as any);
          await this.jobs.updateOne({ _id: job._id }, { $set: { done: expired || job.attempts >= 3, nextAt: new Date(Date.now() + job.attempts * 60000) } });
          this.logger.warn(`Push delivery failed (${Number(error.statusCode) || 'network'})`);
        }
      }
    } catch { this.logger.warn('Notification worker failed'); }
    finally { this.running = false; }
  }
}
