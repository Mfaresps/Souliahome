/**
 * Announcement categories — single source of truth.
 *
 * ⚠ `code` is the stored value (`announcements.category`). Never rename one; add a new
 * code instead so historical rows keep resolving to a label. `emoji`/`ar`/`en` are
 * display-only. `frontend/public/announcements.js` carries a hand-kept mirror
 * (`ANN_CATEGORIES`) — the server validates every submitted code against THIS copy.
 */
export const ANNOUNCEMENT_CATEGORIES = [
  { code: 'announcement', emoji: '📢', ar: 'إعلان عام', en: 'Announcement' },
  { code: 'important', emoji: '⚠️', ar: 'تنبيه مهم', en: 'Important Notice' },
  { code: 'holiday', emoji: '🎉', ar: 'تهنئة بمناسبة', en: 'Holiday Greeting' },
  { code: 'work-update', emoji: '📋', ar: 'تحديث بخصوص العمل', en: 'Work Update' },
  { code: 'appreciation', emoji: '🏆', ar: 'شكر وتقدير', en: 'Appreciation' },
  { code: 'motivation', emoji: '🎯', ar: 'رسالة تحفيزية', en: 'Motivation' },
  { code: 'reminder', emoji: '📌', ar: 'تذكير', en: 'Reminder' },
  { code: 'custom', emoji: '✏️', ar: 'رسالة مخصصة', en: 'Custom Message' },
] as const;

export type AnnouncementCategory = typeof ANNOUNCEMENT_CATEGORIES[number]['code'];

export function announcementCategory(code: string | undefined) {
  return ANNOUNCEMENT_CATEGORIES.find(c => c.code === code) || ANNOUNCEMENT_CATEGORIES[0];
}

/** Default message limit; admins can change it within [MIN, HARD_MAX]. */
export const ANNOUNCEMENT_DEFAULT_MAX = 500;
export const ANNOUNCEMENT_MIN_MAX = 50;
/** Absolute ceiling regardless of configuration — bounds the stored document. */
export const ANNOUNCEMENT_HARD_MAX = 2000;
/** One announcement is addressed to at most this many people. */
export const ANNOUNCEMENT_MAX_RECIPIENTS = 500;

export const ANNOUNCEMENT_ROLES = ['admin', 'staff', 'viewer'];
