import type { NotificationDetails, NotificationType } from './notifications.service';

// A shared mapping keeps the same event recognizable in both notification languages.
const TITLES = {
  performance: ['⭐', 'نقاط مكتسبة', 'Points Earned'],
  announcement: ['📢', 'إعلان من SOULIA', 'SOULIA Announcement'],
  deposit: ['💰', 'عربون جديد', 'New Deposit'],
  comment: ['💬', 'تعليق جديد', 'New Comment'],
  followup: ['📌', 'متابعة جديدة', 'New Follow-up'],
  order: ['🛍️', 'طلب جديد', 'New Order'],
  deliveryProblem: ['🚨', 'مشكلة في التسليم', 'Delivery Issue'],
  delivered: ['📦', 'تم تسليم الطلب', 'Order Delivered'],
  mention: ['💬', 'إشارة جديدة إليك', 'You Were Mentioned'],
  otp: ['🔐', 'مطلوب التحقق بكود OTP', 'OTP Verification Required'],
  approval: ['⏳', 'مطلوب موافقة', 'Approval Required'],
  shopifyChange: ['🛒', 'تم تحديث طلب شوبيفاي', 'Shopify Order Updated'],
  security: ['🛡️', 'تنبيه أمان', 'Security Alert'],
} satisfies Record<NotificationType, readonly string[]>;

export function notificationTitle(type: NotificationType, details: NotificationDetails = {}, language: 'ar' | 'en' = 'ar', test = false) {
  let title: readonly string[] = TITLES[type];
  if (test) title = ['🔔', 'إشعار SOULIA تجريبي', 'SOULIA test notification'];
  // Already names SOULIA — the « · SOULIA» suffix would print the brand twice.
  else if (type === 'announcement') return `${TITLES.announcement[0]} ${TITLES.announcement[language === 'en' ? 2 : 1]}`;
  else if (type === 'performance') title = details.weekly ? ['📊', 'ملخص الأداء الأسبوعي', 'Weekly Performance Summary'] : (details.pointDelta || 0) < 0 ? ['⚠️', 'نقاط مخصومة', 'Points Deducted'] : ['⭐', 'نقاط مكتسبة', 'Points Earned'];
  else if (type === 'order' && details.assignedToYou) title = ['🛍️', 'طلب جديد مُسند إليك', 'New Order Assigned'];
  else if (type === 'comment' && details.followupComment) title = ['📌', 'تعليق متابعة جديد', 'New Follow-up'];
  else if (type === 'security' && details.actionKey === 'failed_login') title = ['❌', 'محاولة تسجيل دخول فاشلة', 'Failed Login Attempt'];
  else if (type === 'approval') {
    if (details.status === 'approved') title = ['✅', 'تمت الموافقة على الطلب', 'Request Approved'];
    else if (details.status === 'rejected') title = ['🚫', 'تم رفض الطلب', 'Request Rejected'];
    else if (details.status === 'modified') title = details.actionKey === 'edit-tx'
      ? ['🔄', 'تم تعديل المعاملة', 'Transaction Modified']
      : ['✏️', 'تم تعديل السجل', 'Record Modified'];
    else if (details.status === 'pending' && ['edit-tx', 'product'].includes(details.actionKey || '')) title = ['✏️', 'طلب تعديل', 'Modification Request'];
  }
  return `${title[0]} ${title[language === 'en' ? 2 : 1]}${test ? '' : ' · SOULIA'}`;
}
