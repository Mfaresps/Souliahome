import { ANNOUNCEMENT_CATEGORIES } from '../announcements/announcement.constants';
import { previousPerformanceWeek } from './performance-notifications';
import { ADMIN_TYPES, actionLabel, FIELD_LABELS } from './admin-events';
import { notificationTitle } from './notification-titles';
import { BadRequestException, ForbiddenException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Cron } from '@nestjs/schedule';
import { Connection, Types } from 'mongoose';
import { createHash, randomUUID } from 'crypto';

export const TYPES = ['deposit', 'comment', 'followup', 'order', 'orderEdit', 'deliveryProblem', 'delivered', 'mention', 'otp', 'approval', 'shopifyChange', 'security', 'performance', 'announcement'] as const;
export type NotificationType = typeof TYPES[number];
export const DEFAULTS = { performance: true, otp: true, approval: true, shopifyChange: true, security: true, enabled: false, deposit: true, comment: true, followup: true, order: true, orderEdit: true, deliveryProblem: true, delivered: true, mention: true };
const TITLES = { orderEdit: 'قرار تعديل الطلب', announcement: 'إعلان من SOULIA', performance: 'نقاط الأداء', otp: 'طلب OTP', approval: 'التعديلات والموافقات', shopifyChange: 'تعديل طلب شوبيفاي', security: 'تنبيه أمان', deposit: 'عربون جديد', comment: 'تعليق جديد', followup: 'متابعة جديدة', order: 'طلب جديد', deliveryProblem: 'مشكلة في التسليم', delivered: 'تم تسليم الطلب', mention: 'إشارة جديدة إليك' };
const EN_TITLES = { orderEdit: 'Order Edit Decision', announcement: 'SOULIA Announcement', performance: 'Performance points', otp: 'OTP Request', approval: 'Modifications & Approvals', shopifyChange: 'Shopify Order Changed', security: 'Security Alert', deposit: 'New Deposit', comment: 'New Comment', followup: 'New Follow-up', order: 'New Order', deliveryProblem: 'Delivery Issue', delivered: 'Order Delivered', mention: 'You Were Mentioned' };
export const STAFF_TYPES = TYPES.filter(type => !(ADMIN_TYPES as readonly string[]).includes(type));
export interface NotificationDetails { editRequestId?: string; releaseVersion?: string; announcementText?: string; announcementCategory?: string; pointDelta?: number; pointReason?: string; weekly?: boolean; balance?: number; earned?: number; deducted?: number; assignedUserId?: string; assignedToYou?: boolean; actionKey?: string; status?: 'pending' | 'approved' | 'rejected' | 'modified'; changedFields?: string[]; expiresAt?: string; actorUserId?: string; actorName?: string; amount?: number; pendingApproval?: boolean; vaultName?: string; commentId?: string | number; receiptId?: string; depositId?: string; commentText?: string; followupComment?: boolean; orderTotal?: number; itemCount?: number; deliveryStatus?: string; }
function cleanText(value: string | undefined, length: number) {
  return String(value || '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, length);
}
export function notificationBody(type: NotificationType, ref: string, details: NotificationDetails = {}, language: 'ar' | 'en' = 'ar') {
  const reference = cleanText(ref.replace(/^#+/, ''), 24);
  const actor = cleanText(details.actorName, 36) || (language === 'en' ? 'A team member' : 'أحد الموظفين');
  const orderLabel = language === 'en' ? (reference ? `Order #${reference}` : 'Order') : (reference ? `الطلب #${reference}` : 'الطلب');
  if (type === 'announcement') {
    if (details.releaseVersion) {
      const version = cleanText(details.releaseVersion, 64);
      return language === 'en' ? `Version ${version} is now live. Refresh the app to use the latest update.` : `تم رفع النسخة ${version} على اللايف بنجاح. حدّث الصفحة لاستخدام آخر تحديث.`;
    }
    // Body = the message itself; a non-generic category leads with its own label.
    const category = ANNOUNCEMENT_CATEGORIES.find(c => c.code === details.announcementCategory);
    const prefix = category && category.code !== 'announcement' ? `${category.emoji} ${language === 'en' ? category.en : category.ar} · ` : '';
    const text = cleanText(details.announcementText, 10000);
    if (!text) return '';
    const limit = 158 - prefix.length;
    let excerpt = text;
    if (excerpt.length > limit) {
      excerpt = '';
      for (const char of text) { if (excerpt.length + char.length > limit - 1) break; excerpt += char; }
      excerpt = excerpt.trimEnd() + '…';
    }
    return prefix + excerpt;
  }
  if (type === 'performance') {
    if (details.weekly) return language === 'en' ? `Current balance: ${details.balance ?? 0} points · Earned this week: +${details.earned ?? 0} · Deducted: -${details.deducted ?? 0}` : `رصيد نقاطك الحالي: ${details.balance ?? 0} نقطة. نقاط مكتسبة هذا الأسبوع: +${details.earned ?? 0}. نقاط مخصومة: -${details.deducted ?? 0}.`;
    const delta = Number(details.pointDelta || 0);
    const amount = (delta > 0 ? '+' : '-') + Math.abs(delta);
    const base = language === 'en' ? `${delta > 0 ? 'Added' : 'Deducted'} ${amount} points${reference ? ' · #' + reference : ''}.` : `تم ${delta > 0 ? 'إضافة' : 'خصم'} ${amount} نقاط ${delta > 0 ? 'إلى' : 'من'} رصيدك${reference ? ' · #' + reference : ''}.`;
    const reason = cleanText(details.pointReason, Math.max(0, 150 - base.length - 10));
    return base + (reason ? (language === 'en' ? ' Reason: ' : ' السبب: ') + reason : '');
  }
  if (type === 'otp' || type === 'approval' || type === 'security') {
    // Requests without a business reference fall back to a MongoDB record ID.
    // Keep that ID for navigation, but do not present it as an order/product number.
    const displayReference = /^[a-f\d]{24}$/i.test(ref.replace(/^#+/, '').trim()) ? '' : reference;
    if (type === 'approval' && details.actionKey === 'order' && details.status === 'approved') {
      const order = language === 'en' ? (displayReference ? `Order #${displayReference}` : 'Order') : (displayReference ? `الطلب #${displayReference}` : 'الطلب');
      return language === 'en'
        ? `${order} is being prepared for shipment · ${actor}`
        : `${order} قيد التحضير للشحن · ${actor}`;
    }
    const action = actionLabel(details.actionKey, language);
    const statuses = { pending: ['بانتظار الموافقة', 'Pending approval'], approved: ['تمت الموافقة', 'Approved'], rejected: ['مرفوض', 'Rejected'], modified: ['تم التعديل', 'Modified'] };
    const status = details.status && statuses[details.status]?.[language === 'en' ? 1 : 0];
    const discount = details.actionKey === 'discount' && Number.isFinite(details.amount)
      ? language === 'en' ? `Discount: EGP ${details.amount}` : `الخصم: ${details.amount} ج.م.` : '';
    return [actor, action, displayReference ? '#' + displayReference : '', discount, type === 'otp' ? 'OTP: {OTP}' : status || ''].filter(Boolean).join(' · ');
  }
  if (type === 'shopifyChange') return orderLabel + ' · ' + (details.changedFields || []).map(key => FIELD_LABELS[key]?.[language === 'en' ? 1 : 0]).filter(Boolean).join(', ');
  if (type === 'orderEdit') return `${orderLabel} · ${language === 'en' ? details.status === 'approved' ? 'Edit approved' : 'Edit rejected' : details.status === 'approved' ? 'تم قبول التعديل' : 'تم رفض التعديل'} · ${actor}`;
  if (type === 'followup') return `${orderLabel} · ${language === 'en' ? 'New Follow-up' : 'متابعة جديدة'}`;
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
    const status = details.assignedToYou ? language === 'en' ? 'Assigned to You' : 'مُسند إليك' : language === 'en' ? 'New Order Received' : 'تم استلام طلب جديد';
    const count = details.itemCount;
    const items = Number.isInteger(count) && count! >= 0 ? language === 'en' ? `${count} ${count === 1 ? 'item' : 'items'}` : `عدد القطع: ${count}` : '';
    return `${orderLabel}${amount ? language === 'en' ? ` · EGP ${amount}` : ` · ${amount} ج.م.` : ''}${items ? ` · ${items}` : ''} · ${status}`;
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
// Management announcements follow the master switch only: they have no per-type
// preference, so `PATCH /notifications/preferences {announcement:false}` is rejected as an
// unknown key, and any value stored before this rule is ignored here.
export const MANDATORY_TYPES = ['announcement'] as const;
export function eligible(user: any, preferences: any, type: NotificationType) {
  return ['admin', 'staff', 'viewer'].includes(user?.role) && (!(ADMIN_TYPES as readonly string[]).includes(type) || user.role === 'admin') && user.isActive !== false && preferences?.enabled === true && ((MANDATORY_TYPES as readonly string[]).includes(type) || preferences[type] === true);
}

@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);
  private running = false;
  private push: any;
  private publicKey?: string;
  private configurationIssue = '';
  constructor(@InjectConnection() private readonly connection: Connection) {}
  private get accounts() { return this.connection.collection('notificationaccounts'); }
  private get jobs() { return this.connection.collection('notificationjobs'); }
  private get inbox() { return this.connection.collection('notificationinbox'); }
  get configured() { return !!this.push; }
  async onModuleInit() {
    await this.accounts.createIndex({ userId: 1 }, { unique: true });
    await this.accounts.createIndex({ 'subscriptions.endpoint': 1 }, { unique: true, sparse: true });
    await this.jobs.createIndex({ eventId: 1, userId: 1, endpoint: 1 }, { unique: true });
    await this.jobs.createIndex({ nextAt: 1, attempts: 1 });
    await this.jobs.createIndex({ done: 1, nextAt: 1, attempts: 1 });
    await this.jobs.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await this.inbox.createIndex({ userId: 1, eventId: 1 }, { unique: true });
    await this.inbox.createIndex({ userId: 1, createdAt: -1, _id: -1 });
    await this.connection.collection('notificationreadstates').createIndex({ userId: 1, notificationId: 1 }, { unique: true });
    try {
      const points = this.connection.collection('notificationpointchanges');
      await points.createIndex({ sourceLogId: 1 });
      await points.createIndex({ createdAt: 1 });
    } catch { this.logger.warn('Point notification indexes could not be initialized'); }
    const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
    const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
    if (!!publicKey !== !!privateKey) { this.configurationIssue = 'incomplete_keys'; this.logger.warn('Push configuration has an incomplete VAPID key pair'); return; }
    try {
      const push = require('web-push');
      let keys = { publicKey, privateKey };
      if (!publicKey) {
        // One stable server-only pair, retained across container replacements.
        const config = this.connection.collection('notificationconfig');
        let saved: any = await config.findOne({ _id: 'vapid' as any });
        if (!saved) {
          const generated = push.generateVAPIDKeys();
          try { await config.updateOne({ _id: 'vapid' as any }, { $setOnInsert: { ...generated, createdAt: new Date() } }, { upsert: true }); }
          catch (error) { if (error.code !== 11000) throw error; }
          saved = await config.findOne({ _id: 'vapid' as any });
        }
        if (!saved?.publicKey || !saved?.privateKey) throw new Error('Push configuration is unavailable');
        keys = saved;
      }
      push.setVapidDetails(process.env.VAPID_SUBJECT?.trim() || 'https://admin.soulia.store', keys.publicKey, keys.privateKey);
      this.publicKey = keys.publicKey;
      this.push = push;
      this.configurationIssue = '';
    } catch {
      this.configurationIssue = 'setup_failed';
      this.logger.warn('Push setup failed; verify server configuration and database access');
    }
  }
  authorize(user: any) {
    if (!['admin', 'staff', 'viewer'].includes(user?.role) || user.isActive === false) throw new ForbiddenException('Notifications require an active account');
  }
  private async employeeLanguage(): Promise<'ar' | 'en'> {
    try { const config: any = await this.connection.collection('notificationconfig').findOne({ _id: 'employee-language' as any }); return config?.language === 'en' ? 'en' : 'ar'; }
    catch { return 'ar'; }
  }
  async settings(user: any) {
    this.authorize(user);
    const account: any = await this.accounts.findOne({ userId: user.userId });
    return { preferences: { ...DEFAULTS, ...account?.preferences }, configured: this.configured,
      publicKey: this.configured ? this.publicKey || process.env.VAPID_PUBLIC_KEY : null, devices: (account?.subscriptions || []).length,
      configurationIssue: this.configurationIssue || null,
      language: user.role === 'admin' ? account?.language || null : await this.employeeLanguage(),
      employeeLanguage: await this.employeeLanguage(), languageManaged: user.role !== 'admin',
      allowedTypes: user.role === 'admin' ? [...TYPES] : [...STAFF_TYPES] };
  }
  async preferences(user: any, body: any) {
    this.authorize(user);
    if (body?.employeeLanguage !== undefined) {
      if (user.role !== 'admin') throw new ForbiddenException('Only admins can choose employee notification language');
      if (!['ar', 'en'].includes(body.employeeLanguage) || Object.keys(body).length !== 1) throw new BadRequestException('Invalid employee language');
      await this.connection.collection('notificationconfig').updateOne({ _id: 'employee-language' as any }, { $set: { language: body.employeeLanguage } }, { upsert: true });
      return this.settings(user);
    }
    if (user.role !== 'admin' && body?.language !== undefined) throw new ForbiddenException('Employee notification language is managed by the administrator');
    validatePreferences(body);
    if (user.role !== 'admin' && Object.keys(body).some(key => !['enabled', 'language', ...STAFF_TYPES].includes(key))) throw new ForbiddenException('These notifications are administrator-only');
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
  async history(user: any, before = '') {
    const userId = String(user.userId || user.sub || user._id || '');
    const scope: any = { userId, ...(user.role !== 'admin' ? { type: { $nin: [...ADMIN_TYPES] } } : {}) };
    const query: any = { ...scope };
    if (before) {
      if (!/^[a-f0-9]{64}$/.test(before)) throw new BadRequestException('Invalid notification cursor');
      const cursor = await this.inbox.findOne({ userId, _id: before as any });
      if (!cursor) throw new BadRequestException('Notification unavailable');
      query.$or = [{ createdAt: { $lt: cursor.createdAt } }, { createdAt: cursor.createdAt, _id: { $lt: cursor._id } }];
    }
    const rows = await this.inbox.find(query).sort({ createdAt: -1, _id: -1 }).limit(51).toArray();
    const items: any[] = rows.slice(0, 50);
    const unread = await this.inbox.countDocuments({ ...scope, readAt: null });
    const actorIds = [...new Set(items.map(item => item.actorUserId).filter(id => /^[a-f\d]{24}$/i.test(String(id))))];
    const actorNames = [...new Set(items.filter(item => !item.actorUserId && item.actorName).map(item => item.actorName))];
    const actors = actorIds.length || actorNames.length ? await this.connection.collection('users').find({ $or: [
      { _id: { $in: actorIds.map(id => new Types.ObjectId(String(id))) } },
      { name: { $in: actorNames } }, { username: { $in: actorNames } },
    ] }, { projection: { _id: 1, name: 1, username: 1, avatar: 1 } }).toArray() : [];
    return { items: items.map(item => {
      const matches = actors.filter(actor => item.actorUserId ? String(actor._id) === String(item.actorUserId) : actor.name === item.actorName || actor.username === item.actorName);
      const actor = matches.length === 1 ? matches[0] : null;
      return { ...item, actorUserId: item.actorUserId || (actor ? String(actor._id) : ''), actorAvatar: actor?.avatar || '' };
    }), unread, next: rows.length > 50 ? String(items[items.length - 1]._id) : '' };
  }
  async readState(user: any) {
    this.authorize(user);
    const rows = await this.connection.collection('notificationreadstates').find({ userId: String(user.userId || user.sub || user._id || '') }).sort({ readAt: -1 }).limit(10000).toArray();
    return { ids: rows.map(row => row.notificationId) };
  }
  async saveReadState(user: any, body: any) {
    this.authorize(user);
    if (!Array.isArray(body?.ids) || !body.ids.length || body.ids.length > 100 || body.ids.some((id: unknown) => typeof id !== 'string' || !id.trim() || id.length > 160 || /[\p{Cc}\p{Cf}]/u.test(id))) throw new BadRequestException('Invalid notification IDs');
    const userId = String(user.userId || user.sub || user._id || '');
    await this.connection.collection('notificationreadstates').bulkWrite([...new Set<string>(body.ids)].map(notificationId => ({ updateOne: {
      filter: { userId, notificationId }, update: { $setOnInsert: { userId, notificationId, readAt: new Date() } }, upsert: true,
    } })));
    return { success: true };
  }
  async markAllRead(user: any, body: any) {
    this.authorize(user);
    const timestamp = typeof body?.before === 'string' ? Date.parse(body.before) : NaN;
    const ids = body?.ids;
    if (!Number.isFinite(timestamp) || !Array.isArray(ids) || ids.length > 10000 || ids.some((id: unknown) => typeof id !== 'string' || !id.trim() || id.length > 160 || /[\p{Cc}\p{Cf}]/u.test(id))) throw new BadRequestException('Invalid notification read state');
    const before = new Date(Math.min(timestamp, Date.now()));
    const userId = String(user.userId || user.sub || user._id || '');
    const scope = { userId, ...(user.role !== 'admin' ? { type: { $nin: [...ADMIN_TYPES] } } : {}) };
    if (ids.length) await this.connection.collection('notificationreadstates').bulkWrite([...new Set<string>(ids)].map(notificationId => ({ updateOne: {
      filter: { userId, notificationId }, update: { $setOnInsert: { userId, notificationId, readAt: new Date() } }, upsert: true,
    } })));
    await this.inbox.updateMany({ ...scope, readAt: null, createdAt: { $lte: before } }, { $set: { readAt: new Date() } });
    const recipients: any[] = [{ targetUserId: userId }];
    if (user.username) recipients.push({ targetUsername: String(user.username).toLowerCase() });
    await this.connection.collection('mentions').updateMany({ $or: recipients, read: false, createdAt: { $lte: before } }, { $set: { read: true } });
    const unread = await this.inbox.countDocuments({ ...scope, readAt: null });
    return { success: true, before: before.toISOString(), unread };
  }
  async markHistoryRead(user: any, id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new BadRequestException('Invalid notification ID');
    const userId = String(user.userId || user.sub || user._id || '');
    const row = await this.inbox.findOne({ _id: id as any, userId });
    await this.inbox.updateOne({ _id: id as any, userId }, { $set: { readAt: new Date() } });
    if (row && /^mention:[a-f\d]{24}$/i.test(row.recordId || '')) await this.connection.collection('mentions').updateOne({ _id: new Types.ObjectId(row.recordId.slice(8)), targetUserId: userId }, { $set: { read: true } });
    return { success: true };
  }
  async markMentionRead(userId: string, mentionId: string) {
    await this.inbox.updateMany({ userId, recordId: 'mention:' + mentionId }, { $set: { readAt: new Date() } });
  }
  async enqueue(type: NotificationType, eventId: string, ref: string, recordId = '', onlyUser?: string | string[], deliveryStatus?: string, details: NotificationDetails = {}) {
    try {
      if (['mention', 'performance', 'orderEdit'].includes(type) && !onlyUser) return;
      if (type === 'performance' && !details.weekly && (!Number.isFinite(details.pointDelta) || details.pointDelta === 0)) return;
      const employeeLanguage = await this.employeeLanguage();
      if (type === 'otp' && (!/^otp:[a-f0-9]{24}$/.test(recordId) || !(Date.parse(details.expiresAt || '') > Date.now()))) return;
      const users = await this.connection.collection('users').find({ role: { $in: (ADMIN_TYPES as readonly string[]).includes(type) ? ['admin'] : ['admin', 'staff', 'viewer'] }, isActive: { $ne: false } }).toArray();
      const eventTimestamp = Date.now();
      const queued = await Promise.allSettled(users.map(async user => {
        const userId = String(user._id);
        // Exclude the account that performed the action, across all its devices.
        if ((type === 'comment' || type === 'followup') && details.actorUserId && userId === String(details.actorUserId)) return;
        // An announcement names several recipients; every other event names at most one.
        if (onlyUser && (Array.isArray(onlyUser) ? !onlyUser.includes(userId) : userId !== onlyUser)) return;
        const account: any = await this.accounts.findOne({ userId });
        const test = eventId.startsWith('test:') && !!onlyUser;
        const reference = String(ref || '').replace(/[^\p{L}\p{N}# _-]/gu, '').slice(0, 40);
        const language = user.role === 'admin' ? account?.language === 'en' ? 'en' : 'ar' : employeeLanguage;
        const titles = language === 'en' ? EN_TITLES : TITLES;
        const followupComment = details.followupComment || recordId.startsWith('followup:');
        // Personalize this one recipient inside the same event, without a second broadcast.
        // Administrators always receive the ordinary new-order notification.
        const recipientDetails = { ...details, followupComment, deliveryStatus,
          assignedToYou: type === 'order' && user.role === 'staff' && !!details.assignedUserId && details.assignedUserId === userId };
        const body = test ? (language === 'en' ? 'SOULIA notifications are working.' : 'تم تفعيل إشعارات SOULIA بنجاح.') : notificationBody(type, reference, recipientDetails, language) || (reference ? '#' + reference : titles[type]);
        const target = new URLSearchParams({ pushRecord: recordId, pushType: type });
        const inboxId = createHash('sha256').update(JSON.stringify([userId, eventId])).digest('hex');
        if (!test) target.set('pushNotification', inboxId);
        const event = type === 'comment' ? details.commentId : details.receiptId || details.depositId || details.editRequestId;
        if (event != null) target.set('pushEvent', String(event));
        const title = notificationTitle(type, recipientDetails, language, test);
        const payload = JSON.stringify({ title, body, timestamp: eventTimestamp, lang: language, dir: language === 'en' ? 'ltr' : 'rtl',
          url: recordId ? '/?' + target.toString() : '/', tag: createHash('sha256').update(eventId).digest('hex') });
        if (!test) {
          try {
            await this.inbox.updateOne({ _id: inboxId as any, userId }, { $setOnInsert: {
              eventId, userId, type, title, body, ref: reference, recordId, event: event == null ? '' : String(event),
              actorUserId: details.actorUserId || '', actorName: details.actorName || '', commentText: details.commentText || '',
              url: recordId ? '/?' + target.toString() : '/', createdAt: new Date(eventTimestamp), readAt: null,
            } }, { upsert: true });
          } catch { this.logger.warn('Notification history could not be recorded'); }
        }
        if (!this.configured || !eligible(user, { ...DEFAULTS, ...account?.preferences, ...(test ? { [type]: true } : {}) }, type)) return;
        for (const subscription of account?.subscriptions || []) {
          await this.jobs.updateOne({ eventId, userId, endpoint: subscription.endpoint }, { $setOnInsert: {
            eventId, userId, endpoint: subscription.endpoint, type, payload, ...(type === 'otp' ? { otpId: recordId.slice(4) } : {}), attempts: 0, done: false,
            nextAt: new Date(eventTimestamp), expiresAt: type === 'otp' ? new Date(details.expiresAt!) : new Date(eventTimestamp + 30 * 86400000),
          } }, { upsert: true });
        }
      }));
      if (queued.some(result => result.status === 'rejected')) this.logger.warn('Some notification recipients could not be queued');
    } catch { this.logger.warn('Notification enqueue failed'); }
  }
  async recordPointChange(eventId: string, employeeId: string, delta: number, reason: string, ref = '', previous?: any) {
    try {
      const changes = this.connection.collection('notificationpointchanges');
      if (!Number.isFinite(delta)) return;
      // Keep gross earned/deducted totals when the scoring system replaces or deletes a row.
      if (previous?._id && previous.points && !await changes.findOne({ sourceLogId: String(previous._id) })) {
        await changes.updateOne({ _id: ('baseline:' + previous._id) as any }, { $setOnInsert: {
          employeeId: previous.employeeId, delta: previous.points, sourceLogId: String(previous._id), createdAt: new Date(previous.createdAt),
        } }, { upsert: true });
      }
      const recorded = await changes.updateOne({ _id: (eventId + ':' + employeeId) as any }, { $setOnInsert: {
        employeeId, delta, sourceLogId: eventId.slice(0, 24), createdAt: new Date(),
      } }, { upsert: true });
      if (delta === 0 || !recorded.upsertedCount) return;
      await this.enqueue('performance', 'performance:' + eventId + ':' + employeeId, ref, 'performance:' + employeeId, employeeId, undefined, { pointDelta: delta, pointReason: reason });
    } catch { this.logger.warn('Point notification could not be recorded'); }
  }
  @Cron('0 0 9 * * 0', { timeZone: 'Africa/Cairo' })
  async weeklyPerformanceSummary(now = new Date()) {
    try {
      if (!this.configured) return;
      const week = previousPerformanceWeek(now);
      const currentWeekLogs = await this.connection.collection('employeeperformancelogs').find({ createdAt: { $gte: week.start, $lt: week.end } }).project({ _id: 1 }).toArray();
      const changes = await this.connection.collection('notificationpointchanges').find({ $or: [
        { createdAt: { $gte: week.start, $lt: week.end } }, { sourceLogId: { $in: currentWeekLogs.map(log => String(log._id)) } },
      ] }).toArray();
      const tracked = changes.map(change => change.sourceLogId).filter(id => /^[a-f0-9]{24}$/.test(id)).map(id => new (require('mongoose').Types.ObjectId)(id));
      const rows = await this.connection.collection('employeeperformancelogs').aggregate([
        { $group: { _id: '$employeeId', balance: { $sum: '$points' },
          earned: { $sum: { $cond: [{ $and: [{ $not: [{ $in: ['$_id', tracked] }] }, { $gte: ['$createdAt', week.start] }, { $lt: ['$createdAt', week.end] }, { $gt: ['$points', 0] }] }, '$points', 0] } },
          deducted: { $sum: { $cond: [{ $and: [{ $not: [{ $in: ['$_id', tracked] }] }, { $gte: ['$createdAt', week.start] }, { $lt: ['$createdAt', week.end] }, { $lt: ['$points', 0] }] }, { $multiply: ['$points', -1] }, 0] } } } },
      ]).toArray();
      const totals = new Map(rows.map(row => [String(row._id), row]));
      for (const change of changes) {
        if (!(change.createdAt >= week.start && change.createdAt < week.end)) continue;
        const id = String(change.employeeId);
        const total: any = totals.get(id) || { balance: 0, earned: 0, deducted: 0 };
        total.earned += Math.max(0, change.delta); total.deducted += Math.max(0, -change.delta);
        totals.set(id, total);
      }
      const employees = await this.connection.collection('users').find({ role: 'staff', isActive: { $ne: false } }).toArray();
      await Promise.allSettled(employees.map(user => {
        const id = String(user._id), total: any = totals.get(id);
        return this.enqueue('performance', 'performance:week:' + week.key + ':' + id, '', 'performance:' + id, id, undefined,
          { weekly: true, balance: total?.balance || 0, earned: total?.earned || 0, deducted: total?.deducted || 0 });
      }));
    } catch { this.logger.warn('Weekly performance notifications could not be queued'); }
  }
  @Cron('* * * * * *')
  async dispatch() {
    if (!this.push || this.running) return;
    this.running = true;
    try {
      const pending: any[] = [];
      for (let i = 0; i < 50; i++) {
        const job: any = await this.jobs.findOneAndUpdate({ done: false, attempts: { $lt: 3 }, nextAt: { $lte: new Date() } },
          { $set: { nextAt: new Date(Date.now() + 60000) }, $inc: { attempts: 1 } }, { returnDocument: 'after' });
        if (!job) break;
        pending.push(job);
      }
      const sent = await Promise.allSettled(pending.map(job => this.dispatchJob(job)));
      if (sent.some(result => result.status === 'rejected')) this.logger.warn('Some notification jobs could not be processed');
    } catch { this.logger.warn('Notification worker failed'); }
    finally { this.running = false; }
  }

  private async dispatchJob(job: any) {
        const user = await this.connection.collection('users').findOne({ _id: new (require('mongoose').Types.ObjectId)(job.userId) });
        const account: any = await this.accounts.findOne({ userId: job.userId });
        const subscription = account?.subscriptions?.find((s: any) => s.endpoint === job.endpoint);
        const test = job.eventId?.startsWith('test:');
        if (!subscription || !eligible(user, { ...DEFAULTS, ...account?.preferences, ...(test ? { [job.type]: true } : {}) }, job.type)) {
          await this.jobs.updateOne({ _id: job._id }, { $set: { done: true } }); return;
        }
        try {
          validateSubscription(subscription);
          let payload = job.payload, ttl = 3600;
          if (job.type === 'otp') {
            const otp = /^[a-f0-9]{24}$/.test(job.otpId || '') ? await this.connection.collection('discountotps').findOne({ _id: new (require('mongoose').Types.ObjectId)(job.otpId) }) : null;
            ttl = Math.min(3600, Math.floor((Date.parse(otp?.expiresAt || '') - Date.now()) / 1000));
            if (!otp || otp.status !== 'unused' || ['approved', 'rejected'].includes(otp.editStatus) || !(ttl > 0) || !/^\d{4,10}$/.test(otp.otp || '')) {
              await this.jobs.updateOne({ _id: job._id }, { $set: { done: true }, $unset: { payload: '' } }); return;
            }
            const data = JSON.parse(payload);
            data.body = data.body.replace(/OTP: \{OTP\}$/, 'OTP: ' + otp.otp);
            payload = JSON.stringify(data);
          }
          await this.push.sendNotification(subscription, payload, { TTL: ttl, timeout: 10000 });
          await this.jobs.updateOne({ _id: job._id }, { $set: { done: true } });
        } catch (error: any) {
          const expired = [404, 410].includes(error.statusCode);
          if (expired) await this.accounts.updateOne({ userId: job.userId }, { $pull: { subscriptions: { endpoint: job.endpoint } } } as any);
          await this.jobs.updateOne({ _id: job._id }, { $set: { done: expired || job.attempts >= 3, nextAt: new Date(Date.now() + job.attempts * 60000) } });
          this.logger.warn(`Push delivery failed (${Number(error.statusCode) || 'network'})`);
        }
  }
}
