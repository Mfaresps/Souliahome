# نظام الاسترجاع والاستبدال - وثيقة شاملة
## Returns & Exchanges System - Comprehensive Documentation

---

## 📋 جدول المحتويات

1. [نظرة عامة](#overview)
2. [قواعد العمل الأساسية](#business-rules)
3. [تدفق العمليات](#workflows)
4. [تكامل المحاسبة](#accounting-integration)
5. [معالجة الأخطاء](#error-handling)
6. [الفحوصات الأمنية](#security-checks)
7. [أمثلة تطبيقية](#examples)

---

## <a name="overview"></a>1️⃣ نظرة عامة

### الهدف
ضمان معالجة **آمنة ودقيقة** لطلبات الاسترجاع والاستبدال مع تحديث تلقائي لـ:
- المخزن (Inventory)
- السجلات (Transactions)
- الخزنة (Treasury/Vault)

### النطاق الزمني
**14 يوماً** من تاريخ الفاتورة الأصلية

---

## <a name="business-rules"></a>2️⃣ قواعد العمل الأساسية

### أنواع الطلبات
```
1. الاسترجاع (Return)
   - العميل يرجع المنتج كاملاً
   - الشركة تردّ الفلوس

2. الاستبدال (Exchange)
   - العميل يرجع منتج A
   - يأخذ منتج B بدلاً منه
   - قد يكون فرق سعر (زيادة أو نقص)
```

### التحقق من الصلاحية
```javascript
const isEligible = {
  withinWindow: (daysFromSale <= 14),
  orderCompleted: (originalTx.payStatus === 'مكتمل'),
  notReturnedBefore: (noExistingApprovedReturn),
  itemsFromOriginalOrder: (allReturnItemsExistInOriginal),
};
```

---

## <a name="workflows"></a>3️⃣ تدفق العمليات

### A. طلب الاسترجاع البسيط (Simple Return)

#### المرحلة 1: إنشاء الطلب (معلق)
```
[POST] /returns
{
  "originalTransactionId": "64a5c3b2d4e1f8g9h0i1j2k3",
  "originalRef": "#INV-2025-001",
  "client": "أحمد محمد",
  "phone": "01001234567",
  "items": [
    {
      "code": "SKU-001",
      "name": "تي شيرت أحمر",
      "qty": 1,
      "price": 150,
      "total": 150
    }
  ],
  "requestKind": "return",
  "reason": "تلف الشحنة",
  "reasonDetails": "الملابس وصلت ممزقة",
  "vaultRefundAccount": "كاش"
}
```

**التحقق (Validations):**
- ✅ الفاتورة موجودة وغير ملغاة
- ✅ ضمن فترة 14 يوم
- ✅ الأصناف موجودة في الفاتورة الأصلية
- ✅ لم يتم طلب استرجاع هذه الأصناف مسبقاً

**النتيجة:**
```json
{
  "_id": "67b8e2c1f4a5d6g7h8i9j0k1",
  "status": "معلق",
  "total": 150,
  "createdAt": "2025-04-07T14:30:00Z"
}
```

---

#### المرحلة 2: الموافقة (معتمد)
```
[POST] /returns/{id}/approve
{
  "approvedBy": "admin_user_id"
}
```

**الفحوصات الحرجة (CRITICAL CHECKS):**
```javascript
// 1️⃣ تأكد من رصيد الخزنة
await vaultService.assertSufficientBalance(
  vaultAccount: 'كاش',
  amount: 150  // قيمة الاسترجاع
);
// إذا فشل → رفض الموافقة + رسالة: "الخزنة غير كافية"

// 2️⃣ تحقق من توافق الأصناف
await validationService.validateReturnItemsAgainstOriginal(
  originalTxId,
  returnItems
);
// إذا فشل → منع الموافقة + رسالة: "الأصناف غير متطابقة"

// 3️⃣ تأكد من عدم الازدواج
await validationService.validateNoDoubleReturn(
  originalTxId,
  returnItems
);
// إذا فشل → منع الموافقة + رسالة: "تم استرجاع هذه الأصناف مسبقاً"
```

**ما يحدث تلقائياً:**
```
1. حفظ الموافقة
   - status: "معتمد"
   - approvedBy: user_id
   - approvedAt: now()

2. إنشاء معاملة مرتجع
   [CREATE Transaction]
   {
     type: "مرتجع",
     ref: "INV-2025-001-RET",
     items: [{SKU-001, qty: 1, price: 150}],
     itemsTotal: 150,
     payMethod: "كاش",
     depMethod: "كاش",
     payStatus: "مكتمل",
     notes: "استرجاع من العميل: أحمد محمد",
     linkedReturnId: "67b8e2c1f4a5d6g7h8i9j0k1"
   }

3. تحديث المخزن (تلقائي)
   TransactionsService يكتشف type="مرتجع" ويفعّل:
   - getAvailableStock(SKU-001): 
     = openingBalance + purchases + returns - sales
     = 0 + 10 + 1 - 2
     = 9 ✅

4. تحديث الخزنة (تلقائي)
   ExpensesService.createApproved() ينشئ:
   {
     type: "رد أموال",
     amount: -150,
     method: "كاش",
     notes: "رد استرجاع: INV-2025-001-RET",
     linkedTransactionId: "return_tx_id",
     approvedAt: now()
   }
   → vaultService.addSystemEntry(-150, "كاش")
   → خزنة "كاش" تنقص ب 150
```

**النتيجة النهائية:**
- ✅ العميل سيحصل على 150 ج استسترجاع
- ✅ المنتج عاد للمخزن
- ✅ الخزنة محدثة
- ✅ جميع المعاملات موثقة برقم مرجع واحد

---

### B. طلب الاستبدال (Exchange Request)

#### المرحلة 1: إنشاء الطلب
```
[POST] /returns
{
  "originalTransactionId": "64a5c3b2d4e1f8g9h0i1j2k3",
  "originalRef": "#INV-2025-001",
  "client": "أحمد محمد",
  "items": [
    {
      "code": "SKU-001",
      "name": "تي شيرت أحمر",
      "qty": 1,
      "price": 150,
      "total": 150
    }
  ],
  "requestKind": "exchange",
  "exchangeItems": [
    {
      "code": "SKU-002",
      "name": "تي شيرت أزرق",
      "qty": 1,
      "price": 180,
      "total": 180
    }
  ],
  "reason": "رغبة العميل بصنف آخر"
}
```

**الحساب:**
```
priceDifference = returnItemsTotal - exchangeTotal
                = 150 - 180
                = -30

الفرق سالب → العميل يدفع 30 ج إضافية
```

---

#### المرحلة 2: الموافقة

**الفحوصات الإضافية للاستبدال:**
```javascript
// بالإضافة إلى فحوصات الاسترجاع:

// 4️⃣ تحقق من توفر المنتج البديل
await validationService.validateExchangeInventoryAvailability(
  exchangeItems: [{SKU-002, qty: 1}]
);
// إذا كان الكم غير متاح → رفض + رسالة: "المنتج غير متوفر"

// 5️⃣ إذا كان هناك فرق سعر (سالب = دين)
if (priceDifference < 0) {
  // تحقق من أن بيانات العميل موجودة للمتابعة
  if (!ret.phone || !ret.client) {
    throw new Error("بيانات العميل ناقصة للمتابعة");
  }
}
```

**ما يحدث تلقائياً:**
```
1. حفظ الموافقة
   status: "معتمد"

2. إنشاء معاملة مرتجع
   [CREATE Return Transaction]
   {
     type: "مرتجع",
     ref: "INV-2025-001-RET",
     items: [{SKU-001, qty: 1}],
     itemsTotal: 150,
     payStatus: "مكتمل"
   }
   → المخزن: SKU-001 يزيد ب 1

3. إنشاء معاملة استبدال (مبيعات)
   [CREATE Sale Transaction]
   {
     type: "مبيعات",
     ref: "INV-2025-001-EXC",
     items: [{SKU-002, qty: 1}],
     itemsTotal: 180,
     payMethod: "آجل",  // (لأن هناك دين)
     payStatus: "معلق",
     remaining: 30,  // الفرق المستحق
     notes: "استبدال: SKU-001 → SKU-002"
   }
   → المخزن: SKU-002 ينقص ب 1

4. إنشاء فاتورة دين (إذا لزم)
   [CREATE Pending Invoice]
   {
     client: "أحمد محمد",
     phone: "01001234567",
     total: 30,
     notes: "دين استبدال: INV-2025-001-EXC",
     linkedReturnId: "return_id"
   }
   → يتابع مع العميل للدفع

5. تحديث الخزنة (إذا عكس - فرق موجب)
   إذا كان priceDifference > 0 (المرتجع أغلى):
   → ينشئ رد نقود كما في الاسترجاع البسيط
```

---

## <a name="accounting-integration"></a>4️⃣ تكامل المحاسبة

### مسار تحديث البيانات الثلاثية

```
┌─────────────────────────────────────────────┐
│       طلب الاسترجاع/الاستبدال                │
│       Return/Exchange Request               │
└──────────────────┬──────────────────────────┘
                   │
        ┌──────────┴──────────┐
        │                     │
        ▼                     ▼
┌──────────────────┐  ┌──────────────────┐
│  الفحوصات الأمنية │  │ الفحوصات المحاسبية │
│  Security       │  │  Accounting      │
│  Validations    │  │  Validations     │
└────────┬─────────┘  └─────────┬────────┘
         │                     │
    أصناف متطابقة           خزنة كافية
    عدم ازدواج            بيانات كاملة
    ضمن فترة 14 يوم      معاملات متسقة
         │                     │
         └──────────┬──────────┘
                    ▼
           ┌─────────────────┐
           │  الموافقة آمنة   │
           │  Safe Approval  │
           └────────┬────────┘
                    │
        ┌───────────┼───────────┐
        │           │           │
        ▼           ▼           ▼
┌─────────────┐ ┌──────────┐ ┌─────────┐
│ المخزن      │ │المعاملات │ │ الخزنة  │
│ Inventory   │ │Tx Records│ │ Vault   │
│             │ │          │ │         │
│SKU-001 +1   │ │2 records │ │-150/-30 │
│SKU-002 -1   │ │ linked   │ │         │
└─────────────┘ │with REF  │ └─────────┘
                └──────────┘
                
كل عملية:
1. تُنفذ ذرياً (Atomic)
2. ترتبط برقم مرجع موحد
3. قابلة للتدقيق (Auditable)
4. قابلة للعكس (Reversible)
```

### أرقام المراجع الموحدة
```
النموذج:
{originalRef}-{TYPE}-{TIMESTAMP}

أمثلة:
INV-2025-001-RET        ← استرجاع بسيط
INV-2025-001-EXC        ← استبدال
INV-2025-001-DIFF+30    ← فرق سعر إضافي
INV-2025-001-REFUND-150 ← رد نقود
```

---

## <a name="error-handling"></a>5️⃣ معالجة الأخطاء

### الأخطاء الحرجة (Critical)
```
❌ الخزنة غير كافية
   → الموافقة ترفع + رسالة واضحة
   → الإداري يضيف رصيد أولاً

❌ أصناف غير متطابقة
   → منع المعالجة + إرجاع الأصناف الخاطئة
   → لا تُسجل معاملات

❌ استرجاع مكرر
   → منع معالجة الطلب الثاني
   → إرشاد لاستئناف الطلب الأول
```

### الأخطاء التحذيرية (Warning)
```
⚠️ المنتج البديل غير متاح
   → تحويل الطلب لـ "pending" بدلاً من الرفض
   → تعيين تنبيه تلقائي للمستودع

⚠️ فرق سعر كبير (>1000 ج)
   → تحتاج موافقة مراجع إضافي
   → تسجيل ملاحظة من الإداري

⚠️ قريب من نهاية فترة الـ 14 يوم
   → تنبيه "آخر فرصة"
```

---

## <a name="security-checks"></a>6️⃣ الفحوصات الأمنية

### 1️⃣ التحقق من الهوية
```javascript
// فقط الإداريين يمكنهم الموافقة
if (currentUser.role !== 'admin') {
  throw new ForbiddenException('صلاحيات غير كافية');
}
```

### 2️⃣ منع الاحتيال
```javascript
// تحقق من أن الأصناف المسترجعة من الفاتورة الفعلية
await validationService.validateReturnItemsAgainstOriginal(
  originalTxId,
  requestedItems
);

// منع إرجاع نفس العنصر مرتين
await validationService.validateNoDoubleReturn(
  originalTxId,
  requestedItems
);
```

### 3️⃣ التدقيق الكامل (Full Audit)
```json
{
  "returnRequestId": "67b8e2c1f4a5d6g7h8i9j0k1",
  "status": "معتمد",
  "auditTrail": [
    {
      "action": "created",
      "by": "customer_api",
      "timestamp": "2025-04-07T10:00:00Z",
      "details": "طلب استرجاع تم إنشاؤه"
    },
    {
      "action": "approved",
      "by": "admin_user_123",
      "timestamp": "2025-04-07T14:30:00Z",
      "details": "تمت الموافقة + فحوصات نجحت",
      "checks": {
        "vaultBalanceOk": true,
        "itemsValidated": true,
        "noDoubleReturn": true,
        "inventoryChecked": true
      }
    }
  ],
  "linkedTransactions": [
    "tx_return_id",
    "tx_exchange_id",
    "expense_refund_id"
  ]
}
```

---

## <a name="examples"></a>7️⃣ أمثلة تطبيقية

### مثال 1: استرجاع بسيط - رد نقود كامل
```json
الفاتورة الأصلية:
- SKU-001: تي شيرت أحمر × 1 @ 150 ج = 150 ج
- التاريخ: 2025-04-01
- الحالة: مكتملة ومدفوعة

طلب الاسترجاع:
- السبب: تلف الشحنة
- الأصناف: SKU-001
- المبلغ: 150 ج

عند الموافقة:
✅ معاملة مرتجع: INV-2025-0001-RET
   - Type: مرتجع
   - المخزن: SKU-001 تزداد ب 1
   
✅ رد النقود: تلقائي
   - الخزنة (كاش): تنقص ب 150 ج
   - سجل: "رد استرجاع INV-2025-0001"

النتيجة:
- العميل يستقبل 150 ج ✓
- المخزن محدث ✓
- الخزنة محدثة ✓
```

### مثال 2: استبدال مع فرق سعر
```json
الفاتورة الأصلية:
- SKU-001: جوال Samsung A12 × 1 @ 3000 ج

طلب الاستبدال:
- المرتجع: SKU-001 (3000 ج)
- البديل: SKU-002 جوال Samsung A13 (3500 ج)
- الفرق: 3500 - 3000 = +500 ج (العميل يدفع إضافي)

عند الموافقة:
✅ معاملة مرتجع:
   - SKU-001 يعود للمخزن
   
✅ معاملة استبدال (مبيعات):
   - SKU-002 ينقص من المخزن
   - حالة: "معلق" (بانتظار الدفع)
   - المبلغ المستحق: 500 ج

✅ فاتورة دين:
   - العميل "أحمد محمد"
   - يستحق دفع: 500 ج
   - تُرسل لـ WhatsApp/SMS للمتابعة

النتيجة:
- العميل قبل الجوال الجديد ✓
- الجوال القديم في المخزن ✓
- 500 ج معلقة للدفع ✓
- جميع المعاملات موثقة ✓
```

---

## 📊 جدول التلخيص

| العملية | الفحوصات | النتيجة |
|--------|---------|--------|
| **إنشاء طلب** | • 14 يوم<br>• فاتورة موجودة<br>• عدم ازدواج | معلق - قيد المراجعة |
| **موافقة استرجاع** | • خزنة كافية<br>• أصناف متطابقة<br>• فحص أمني | معتمد + معاملات + رد نقود |
| **موافقة استبدال** | • كل ما سبق<br>• تقافر المنتج البديل | معتمد + معاملتي رجوع وبيع |
| **فرق سعر موجب** | • خزنة للرد | معتمد + رد الفرق |
| **فرق سعر سالب** | • بيانات العميل | معتمد + فاتورة دين معلقة |

---

## 🔐 الضمانات

✅ **عدم وجود أخطاء محاسبية**
- كل معاملة تؤثر على 3 أماكن معاً (مخزن + تعاملات + خزنة)
- كل معاملة لها رقم مرجع موحد

✅ **عدم وجود ازدواج**
- لا يمكن استرجاع نفس العنصر مرتين
- لا يمكن الموافقة مرتين على نفس الطلب

✅ **القدرة على المراجعة**
- تدقيق كامل لكل عملية
- تسجيل من قام بكل إجراء
- ربط معاملات بأرقام مراجع

✅ **الأمان**
- فقط الإداريين يوافقون
- التحقق من صحة الأصناف
- فحص الخزنة قبل الرد

---

**آخر تحديث:** 2025-04-07
**الإصدار:** 1.0
**الحالة:** Ready for Production ✅
