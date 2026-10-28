import type { NotificationDetails, NotificationType } from './notifications.service';

// A shared mapping keeps the same event recognizable in both notification languages.
const TITLES = {
  performance: ['⭐', 'نقاط مكتسبة', 'Points Earned'],
  announcement: ['📢', 'إعلان', 'Announcement'],
  deposit: ['💰', 'عربون جديد', 'New Deposit'],
  comment: ['💬', 'تعليق جديد', 'New Comment'],
  followup: ['📌', 'متابعة جديدة', 'New Follow-up'],
  order: ['🛍️', 'طلب جديد', 'New Order'],
  orderEdit: ['✏️', 'قرار تعديل الطلب', 'Order Edit Decision'],
  deliveryProblem: ['🚨', 'مشكلة في التسليم', 'Delivery Issue'],
  deliveryPostponed: ['🗓️', 'تأجيل الاستلام بطلب العميل', 'Delivery Postponed by Customer'],
  delivered: ['📦', 'تم تسليم الطلب', 'Order Delivered'],
  mention: ['💬', 'إشارة جديدة إليك', 'You Were Mentioned'],
  otp: ['🔐', 'مطلوب التحقق بكود OTP', 'OTP Verification Required'],
  approval: ['⏳', 'مطلوب موافقة', 'Approval Required'],
  shopifyChange: ['🛒', 'تم تحديث طلب شوبيفاي', 'Shopify Order Updated'],
  security: ['🛡️', 'تنبيه أمان', 'Security Alert'],
} satisfies Record<NotificationType, readonly string[]>;

export function notificationTitle(type: NotificationType, details: NotificationDetails = {}, language: 'ar' | 'en' = 'ar', test = false) {
  let title: readonly string[] = TITLES[type];
  if (test) title = ['🔔', 'إشعار تجريبي', 'Test notification'];
  else if (details.afterSalesAction) {
    const actions: Record<string, [string, string]> = {
      'carrier-status': ['تحديث حالة شحنة الاسترجاع / الاستبدال', 'Return / exchange carrier status updated'],
      requested: ['طلب استرجاع / استبدال جديد', 'New return / exchange request'],
      approved: ['اعتماد الاسترجاع / الاستبدال', 'Return / exchange approved'],
      cancelled: ['إلغاء الاسترجاع / الاستبدال', 'Return / exchange cancelled'],
      'shipment-requested': ['طلب شحنة الاسترجاع / الاستبدال', 'Return / exchange shipment requested'],
      'shipment-created': ['إنشاء بوليصة الاسترجاع / الاستبدال', 'Return / exchange waybill created'],
      'shipment-linked': ['ربط بوليصة الاسترجاع / الاستبدال', 'Return / exchange waybill linked'],
      'received-and-inspected': ['استلام وفحص المرتجع', 'Return received and inspected'],
      'replacement-delivered': ['تسليم البديل للعميل', 'Replacement delivered'],
      'settlement:refund': ['تسجيل رد مبلغ للعميل', 'Customer refund recorded'],
      'settlement:collection': ['تسجيل تحصيل فرق الاستبدال', 'Exchange collection recorded'],
      'settlement:carrier': ['تسجيل تسوية شركة الشحن', 'Carrier settlement recorded'],
      exception: ['مشكلة في الاسترجاع / الاستبدال', 'Return / exchange issue'],
      'exception-resolved': ['معالجة مشكلة الاسترجاع / الاستبدال', 'Return / exchange issue resolved'],
    };
    const label = actions[details.afterSalesAction] || ['تحديث الاسترجاع / الاستبدال', 'Return / exchange updated'];
    title = ['📦', ...label];
  }
  else if (type === 'announcement' && details.releaseVersion) title = ['🚀', 'تم رفع نسخة جديدة', 'New Version Is Live'];
  else if (type === 'performance') title = details.weekly ? ['📊', 'ملخص الأداء الأسبوعي', 'Weekly Performance Summary'] : (details.pointDelta || 0) < 0 ? ['⚠️', 'نقاط مخصومة', 'Points Deducted'] : ['⭐', 'نقاط مكتسبة', 'Points Earned'];
  else if (type === 'order' && details.assignedToYou) title = ['🛍️', 'طلب جديد مُسند إليك', 'New Order Assigned'];
  else if (type === 'orderEdit') title = details.status === 'approved' ? ['✅', 'تم قبول تعديل الطلب', 'Order Edit Approved'] : ['🚫', 'تم رفض تعديل الطلب', 'Order Edit Rejected'];
  else if (type === 'followup' && details.actionKey === 'followup-scheduled') title = ['🗓️', 'تم تحديد موعد المتابعة', 'Follow-up Scheduled'];
  else if (type === 'followup' && details.actionKey === 'followup-due') title = ['⏰', 'حان موعد المتابعة', 'Follow-up Due'];
  else if (type === 'comment' && details.followupComment) title = ['📌', 'تعليق متابعة جديد', 'New Follow-up'];
  else if (type === 'security' && details.actionKey === 'failed_login') title = ['❌', 'محاولة تسجيل دخول فاشلة', 'Failed Login Attempt'];
  else if (type === 'approval') {
    if (details.status === 'approved' && details.actionKey === 'order') title = ['📦', 'جارٍ تحضير الطلب للشحن', 'Order is being prepared for shipment'];
    else if (details.status === 'approved') title = ['✅', 'تمت الموافقة على الطلب', 'Request Approved'];
    else if (details.status === 'rejected') title = ['🚫', 'تم رفض الطلب', 'Request Rejected'];
    else if (details.status === 'modified') title = details.actionKey === 'edit-tx'
      ? ['🔄', 'تم تعديل المعاملة', 'Transaction Modified']
      : ['✏️', 'تم تعديل السجل', 'Record Modified'];
    else if (details.status === 'pending' && ['edit-tx', 'edit-shopify', 'product'].includes(details.actionKey || '')) title = ['✏️', 'طلب تعديل', 'Modification Request'];
  }
  return `${title[0]} ${title[language === 'en' ? 2 : 1]}`;
}

// Old inbox entries and queued pushes retain the title generated when created.
export function unbrandedNotificationTitle(title: string) {
  return String(title || '').replace(/إعلان من SOULIA/gi, 'إعلان')
    .replace(/\s*·\s*SOULIA\b/gi, '').replace(/\bSOULIA\s*/gi, '')
    .replace(/test notification/i, 'Test notification').replace(/\s{2,}/g, ' ').trim();
}

export function unbrandedNotificationBody(body: string) {
  return body === 'SOULIA notifications are working.' ? 'Notifications are working.'
    : body === 'تم تفعيل إشعارات SOULIA بنجاح.' ? 'تم تفعيل الإشعارات بنجاح.' : body;
}
