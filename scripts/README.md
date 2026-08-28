# النسخ الاحتياطي السحابي — دليل الربط

نسخة يومية من قاعدة البيانات تُرفع إلى Cloudflare R2، ويُحتفظ بآخر **14** نسخة.

القياس على بيانات هذا النظام: النسخة **2.1 ميجا** بعد الضغط (91٪ توفير)، أي أن
الـ 14 نسخة تشغل ~30 ميجا من أصل 10 جيجا مجانية.

---

## قبل البدء

على السيرفر:

```bash
rclone version    # إن لم يكن مثبتاً:  curl https://rclone.org/install.sh | sudo bash
docker ps         # يجب أن يظهر soulia-mongodb
```

---

## ١. ربط rclone بـ R2  (مرة واحدة)

```bash
rclone config
```

| السؤال | الإجابة |
|---|---|
| `n/s/q>` | `n` |
| `name>` | `r2` |
| `Storage>` | `s3` |
| `provider>` | `Cloudflare` |
| `env_auth>` | `1` |
| `access_key_id>` | من لوحة R2 |
| `secret_access_key>` | من لوحة R2 |
| `region>` | `auto` |
| `endpoint>` | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` |
| الباقي | Enter |

ثم:

```bash
chmod 600 ~/.config/rclone/rclone.conf
```

> ⚠ هذا هو المكان **الوحيد** الذي تعيش فيه مفاتيح R2. لا تضعها في
> `docker-compose.yml` ولا في الواجهة الأمامية — `index.html` يُرسل كاملاً
> لمتصفح كل مستخدم، فأي مفتاح فيه منشور فعلياً.

**اختبار الربط:**

```bash
rclone lsd r2:
echo test | rclone rcat r2:soulia-backups/_t.txt
rclone ls r2:soulia-backups
rclone deletefile r2:soulia-backups/_t.txt
```

---

## ٢. إعداد السكريبت

```bash
cd /path/to/Souliahome
cp scripts/cloud-backup.env.example scripts/cloud-backup.env
chmod 600 scripts/cloud-backup.env
nano scripts/cloud-backup.env        # ← ضع MONGO_PASS
chmod +x scripts/cloud-backup.sh scripts/cloud-restore.sh
sudo mkdir -p /var/backups/soulia && sudo chown "$USER" /var/backups/soulia
```

`MONGO_PASS` هي نفسها الموجودة في `docker-compose.yml` تحت
`MONGO_INITDB_ROOT_PASSWORD`.

**تجربة بلا رفع أو حذف:**

```bash
DRY_RUN=1 ./scripts/cloud-backup.sh
```

**تشغيل حقيقي:**

```bash
./scripts/cloud-backup.sh
```

---

## ٣. الجدولة اليومية

```bash
crontab -e
```

أضف (٣ صباحاً يومياً):

```cron
0 3 * * * cd /path/to/Souliahome && ./scripts/cloud-backup.sh >> /var/backups/soulia/cron.log 2>&1
```

> استبدل `/path/to/Souliahome` بالمسار الفعلي (`pwd`).

تأكد: `crontab -l`

---

## ٤. ربط اللوحة  (اختياري)

الواجهة تقرأ ملف الحالة من `/var/backups/soulia/last-run.json`. لكي يراه
الـ backend داخل الحاوية، أضف في `docker-compose.yml` تحت `backend:`

```yaml
    environment:
      CLOUD_BACKUP_STATE: /cloud-state/last-run.json
    volumes:
      - backend-backups:/app/backups
      - /var/backups/soulia:/cloud-state:ro      # ro = قراءة فقط
```

ثم `docker compose up -d backend`.

بعدها تظهر البطاقة في **الإعدادات → البيانات** (للمدير فقط) وتعرض حالة آخر
نسخة وحجمها وعددها على السحابة.

بدون هذه الخطوة يعمل النسخ كاملاً، وتعرض البطاقة «غير مُفعّل» فقط.

---

## الاسترجاع

```bash
./scripts/cloud-restore.sh                              # عرض النسخ المتاحة
./scripts/cloud-restore.sh <اسم-الملف> --test           # تجربة آمنة
./scripts/cloud-restore.sh <اسم-الملف>                  # استرجاع حقيقي
```

`--test` يسترجع إلى قاعدة `soulia_restore_test` ويطبع عدد السجلات في كل
مجموعة. **قاعدة البيانات الحيّة لا تُمسّ.**

الاسترجاع الحقيقي يطلب كتابة `YES`، ويأخذ نسخة أمان من الوضع الحالي قبل
الكتابة.

> ### 🔴 جرّب الاسترجاع مرة شهرياً
> نسخة لم يجرّبها أحد ليست نسخة. `--test` آمن تماماً — شغّله وتأكد أن الأعداد
> منطقية. اكتشاف نسخة تالفة يوم الحاجة إليها هو أسوأ وقت ممكن.

---

## عند وجود مشكلة

| العَرَض | السبب |
|---|---|
| `تعذّر الاتصال بـ r2` | `rclone config` لم يُضبط، أو الاسم ليس `r2` |
| `فشل mongodump` | كلمة سر خاطئة في `.env`، أو الحاوية متوقفة |
| `النسخة صغيرة بشكل غير طبيعي` | فشل الاتصال بقاعدة البيانات — السكريبت رفض رفعها عمداً |
| البطاقة «غير مُفعّل» | السكريبت لم يُشغَّل بعد، أو الخطوة ٤ ناقصة |
| البطاقة «النسخ متأخر» | مضى >36 ساعة على آخر نجاح — راجع `crontab -l` والسجل |

السجل: `/var/backups/soulia/cloud-backup.log`

---

## ملاحظات على التصميم

**لماذا بالعدد لا بالعمر؟** `rclone delete --min-age 14d` يحذف بالعمر: لو
توقّف النسخ 15 يوماً يمحو **كل شيء** — بالضبط عند الحاجة إليه. و`rclone sync`
يجعل السحابة مطابقة للمحلي، فمجلد محلي فارغ يمحو السحابة. الترتيب هنا أبجدي
وهو نفسه الترتيب الزمني لأن الطابع الزمني ISO داخل الاسم.

**الحذف بعد الرفع فقط.** لو فشل الرفع لا يُحذف شيء — وإلا فليلة فاشلة تطرد
نسخة سليمة دون أن تضع بديلاً.

**فحص الحجم.** dump أصغر من 10 كيلوبايت يعني فشلاً في الاتصال؛ رفعه يستهلك
نسخة من الـ 14 ويطرد نسخة صحيحة.

**التحقق بعد الرفع.** خروج `rclone copy` بنجاح ليس دليلاً كافياً — السكريبت
يسأل السحابة عن الملف فعلياً قبل أن يحذف أي شيء.
