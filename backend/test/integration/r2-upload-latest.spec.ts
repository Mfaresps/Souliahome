import { SettingsService } from '../../src/settings/settings.service';

export {};

/**
 * يحرس `uploadLatestToR2` — زر «ارفع آخر نسخة الآن».
 *
 * ⚠ الخطأ الذي وُجدت هذه الاختبارات لمنعه: `getBackupList()` تعيد **المصفوفة
 * نفسها**، لا `{ backups: [...] }`. قراءة `list?.backups` كانت تعطي undefined
 * دائماً، فيردّ الزر «لا توجد نسخة محلية لرفعها» بينما على القرص ثماني نسخ.
 *
 * فشلٌ صامت من أسوأ نوع: الرسالة معقولة تماماً، ولا شيء يوحي بأن الشيفرة هي
 * المخطئة لا البيانات.
 */
describe('uploadLatestToR2 — اختيار النسخة', () => {
  /** أقل ما يلزم لإنشاء الخدمة دون قاعدة بيانات. */
  function makeService(backups: Array<{ filename: string; date: string }>) {
    const svc = Object.create(SettingsService.prototype) as SettingsService;
    (svc as any).logger = { log() {}, warn() {}, error() {} };
    (svc as any).getBackupList = async () => backups;
    const uploaded: string[] = [];
    (svc as any).uploadBackupToR2 = async (f: string) => {
      uploaded.push(f);
      return { success: true, message: 'ok:' + f };
    };
    return { svc, uploaded };
  }

  const ROWS = [
    { filename: 'backup_auto_2026-08-26T03-00-00.json', date: '2026-08-26' },
    { filename: 'backup_auto_2026-08-28T03-00-00.json', date: '2026-08-28' },
    { filename: 'backup_2026-08-27T14-07-30.json', date: '2026-08-27' },
  ];

  it('⚠ يقرأ المصفوفة مباشرة — لا list.backups (الخطأ الأصلي)', async () => {
    const { svc, uploaded } = makeService(ROWS);
    const res = await svc.uploadLatestToR2();
    expect(res.success).toBe(true);
    expect(uploaded).toHaveLength(1);
  });

  it('يختار الأحدث زمنياً لا الأول في السجل', async () => {
    const { svc, uploaded } = makeService(ROWS);
    await svc.uploadLatestToR2();
    // 08-28 هي الأحدث رغم أنها ليست أول صف في المصفوفة.
    expect(uploaded[0]).toBe('backup_auto_2026-08-28T03-00-00.json');
  });

  it('يحترم اسم ملف مُمرَّراً صراحةً', async () => {
    const { svc, uploaded } = makeService(ROWS);
    await svc.uploadLatestToR2('backup_2026-08-27T14-07-30.json');
    expect(uploaded[0]).toBe('backup_2026-08-27T14-07-30.json');
  });

  it('قائمة فارغة تعطي رسالة واضحة ولا ترفع شيئاً', async () => {
    const { svc, uploaded } = makeService([]);
    const res = await svc.uploadLatestToR2();
    expect(res.success).toBe(false);
    expect(res.message).toContain('لا توجد نسخة محلية');
    expect(uploaded).toHaveLength(0);
  });

  it('⚠ يرفض اجتياز المسار — الاسم يأتي من الواجهة', async () => {
    const { svc, uploaded } = makeService(ROWS);
    for (const bad of ['../secrets.json', 'sub/dir.json', '..\\\\win.json']) {
      const res = await svc.uploadLatestToR2(bad);
      expect(res.success).toBe(false);
      expect(res.message).toContain('غير صالح');
    }
    expect(uploaded).toHaveLength(0);
  });
});
