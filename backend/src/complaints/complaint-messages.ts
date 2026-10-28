import { BadRequestException } from '@nestjs/common';

export const MESSAGE_TOKENS = ['customerName','complaintNo','invoiceRef','resolution','customerMessage'];
export const DEFAULT_COMPLAINT_MESSAGES = {
  registered: {
    ar: 'أهلًا {customerName}،\nتم تسجيل شكواك برقم {complaintNo}.\nالفاتورة: {invoiceRef}.\nفريق خدمة العملاء سيراجع المشكلة ويتابع معك خطوات الحل. شكرًا لإبلاغنا.',
    en: 'Hello {customerName},\nYour complaint {complaintNo}, invoice {invoiceRef}, has been registered.\nOur customer care team will review the issue and follow up with you. Thank you for letting us know.',
  },
  update: {
    ar: 'أهلًا {customerName}،\nنتابع شكواك رقم {complaintNo}، الفاتورة {invoiceRef}.\nما زلنا نعمل على معالجة المشكلة وسنوافيك بالتحديث عند توفره.',
    en: 'Hello {customerName},\nWe are following up on complaint {complaintNo}, invoice {invoiceRef}.\nWe are working on the issue and will keep you updated.',
  },
  confirmation: {
    ar: 'أهلًا {customerName}،\nاكتمل تنفيذ الإجراء المتفق عليه لشكواك رقم {complaintNo}: {resolution}.\nهل انتهت المشكلة معك؟ نرجو تأكيدك، أو إبلاغنا بأي مشكلة ما زالت قائمة لنستكمل المتابعة.',
    en: 'Hello {customerName},\nThe agreed action for complaint {complaintNo} has been completed: {resolution}.\nHas this resolved your issue? Please confirm, or tell us about any remaining problem so we can follow up.',
  },
  resolved: {
    ar: 'أهلًا {customerName}،\nاكتمل تنفيذ الحل المتفق عليه لشكواك رقم {complaintNo}، الفاتورة {invoiceRef}.\nالحل: {resolution}.\n{customerMessage}\nشكرًا لتعاونك. إذا ظهرت مشكلة أخرى، تواصل معنا مع ذكر رقم الشكوى لنستكمل مساعدتك.',
    en: 'Hello {customerName},\nComplaint {complaintNo}, invoice {invoiceRef}, has been resolved.\nResolution: {resolution}.\n{customerMessage}\nThank you for your cooperation. If another issue arises, contact us with your complaint number so we can help.',
  },
  closed: {
    ar: 'أهلًا {customerName}،\nبخصوص شكواك رقم {complaintNo}، الفاتورة {invoiceRef}:\nحالة الملف: {resolution}.\n{customerMessage}\nيمكنك التواصل معنا مع ذكر رقم الشكوى لأي استفسار أو معلومات إضافية.',
    en: 'Hello {customerName},\nRegarding complaint {complaintNo}, invoice {invoiceRef}:\nCase outcome: {resolution}.\n{customerMessage}\nPlease contact us with your complaint number for questions or additional information.',
  },
};

export function validateComplaintMessages(input: any) {
  const keys = Object.keys(DEFAULT_COMPLAINT_MESSAGES);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== keys.length) throw new BadRequestException('قوالب الرسائل غير صالحة');
  const result: any = {};
  for (const key of keys) {
    const pair = input[key];
    if (!pair || typeof pair !== 'object' || Object.keys(pair).sort().join(',') !== 'ar,en') throw new BadRequestException('يلزم نص عربي وإنجليزي لكل قالب');
    result[key] = {};
    for (const lang of ['ar','en']) {
      const value = pair[lang];
      if (typeof value !== 'string' || !value.trim() || value.length > 3000) throw new BadRequestException('اكتب رسالة من 1 إلى 3000 حرف');
      const literal = value.replace(/\{([a-zA-Z]+)\}/g, (token, name) => {
        if (!MESSAGE_TOKENS.includes(name)) throw new BadRequestException(`متغير غير مسموح: ${token}`);
        return '';
      });
      if (/[{}]/.test(literal)) throw new BadRequestException('راجع صيغة متغيرات الرسالة');
      result[key][lang] = value.trim();
    }
  }
  return result;
}

export function renderComplaintMessage(template: string, values: Record<string,string>) {
  // One pass: customer-provided values are never interpreted as template tokens.
  return template.replace(/\{([a-zA-Z]+)\}/g, (_, key) => values[key] || '').replace(/\n{3,}/g,'\n\n').trim();
}
