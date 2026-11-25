(function () {
  'use strict';
  const groups = [
    ['dashboard','Dashboard','الرئيسية',['dashboard','reports-kpis','reports-charts']],
    ['orders','Orders','الطلبات',['shopify-orders','transaction','shopify-prepare-ship','shopify-reassign','shopify-cancel','shopify-cancel-request','shopify-edit-direct','shopify-bundle-discount-override','shopify-deposit-upload','shopify-deposit-no-image','shopify-deposit-no-image-otp']],
    ['pickup','Preparation & shipping','التجهيز والشحن',['pickup-orders','pickup-orders-prepare','pickup-orders-move','pickup-orders-cancel','pickup-orders-bosta','pickup-orders-bosta-cancel','delivery-issues-follow','delivery-issues-close','delivery-manual-confirm','delivery-view-audit']],
    ['inventory','Inventory','المخزون',['inventory','inventory-log-browse','products','products-cost-view','products-supplier-view','products-analytics','products-specs-view','products-specs-manage','products-edit-otp','products-edit','products-price-sell','products-create','products-delete','products-sku-manage','inventory-units-view','inventory-units-register','inventory-units-receive','inventory-units-allocate','inventory-units-condition','inventory-units-reconcile','inventory-units-reconcile-approve','inventory-units-print','inventory-units-manual-select','categories-view','categories-create','categories-edit-otp','categories-edit','categories-delete','categories-assign-products','categories-link-suppliers']],
    ['promotions','Promotions','العروض والخصومات',['promotions-view','promotions-offers','promotions-codes','promotions-bundles','promotions-tags','promotions-audit']],
    ['movement','Movement','الحركات',['movements','movements-filters','movements-browse','movements-collections','approvals','approvals-history','approvals-otp-log','carrier-import','carrier-settle-view','carrier-settle-run','carrier-settle-approve','carrier-settle-reverse']],
    ['cash','Cash Register','الخزنة',['vault','sales-collect','expenses','reports','reports-discounts','reports-orderaudit','reports-cancellations','reports-shipping','reports-export','data-export']],
    ['suppliers','Suppliers','الموردون',['suppliers','suppliers-create','suppliers-edit','suppliers-delete','purchase-view','purchase-create','purchase-edit-price','suppliers-tab-invoices','suppliers-tab-pos','suppliers-tab-sreturns','suppliers-tab-payments','suppliers-tab-ledger','suppliers-tab-activity','suppliers-pay','suppliers-deposit','suppliers-ledger-adjust','suppliers-write-off','suppliers-reverse','suppliers-returns','suppliers-rs-view','suppliers-rs-create','suppliers-rs-edit','suppliers-rs-status','suppliers-rs-delete','suppliers-rs-export']],
    ['employees','Employees','الموظفون',['users']],
    ['customer-service','Customer Service','خدمة العملاء',['clients','clients-browse','customers-phone-view','complaints','csp-view','csp-create','csp-edit','csp-delete','csp-manage-folders','csp-analytics','csp-export','csp-import']],
    ['settings','Settings','الإعدادات',['settings']],
  ];
  const restrictedRows = {
    orders:[['Confirm Orders','تأكيد الطلبات','Approve'],['Export Orders','تصدير الطلبات','Export']],
    inventory:[['Adjust Stock','تسوية المخزون','Edit'],['View Stock History','عرض سجل المخزون','View','inventory']],
    movement:[['Create Movements','إنشاء حركات','Create'],['Edit Movements','تعديل الحركات','Edit'],['Approve Movements','اعتماد الحركات','Approve']],
    cash:[['Add Transactions','إضافة عمليات للخزنة','Create'],['Edit Transactions','تعديل عمليات الخزنة','Edit'],['Delete Transactions','حذف عمليات الخزنة','Delete']],
    employees:[['View Employees','عرض الموظفين','View'],['Create Employees','إنشاء موظفين','Create'],['Edit Employees','تعديل الموظفين','Edit'],['Manage Roles & Permissions','إدارة الأدوار والصلاحيات','Approve']],
    settings:[['Edit Settings','تعديل الإعدادات','Edit'],['Manage Integrations','إدارة التكاملات','Edit']],
  };
  const specialNames = {
    dashboard:['View Dashboard','عرض الرئيسية'], 'reports-kpis':['View Analytics','عرض مؤشرات الأداء'],
    'shopify-orders':['View Orders','عرض طلبات شوبيفاي'], transaction:['Create Transactions / Orders','إنشاء معاملات وطلبات'],
    'shopify-edit-direct':['Edit Orders','تعديل الطلبات'], 'shopify-bundle-discount-override':['Discount on Shopify bundles (exception)','خصم على باقات Shopify (استثناء)'], 'shopify-cancel':['Cancel Orders','إلغاء الطلبات'],
    'shopify-deposit-no-image':['Add Deposit Without Image (direct)','إضافة عربون بدون صورة (مباشرة)'],
    'shopify-deposit-no-image-otp':['Add Deposit Without Image (manager OTP)','إضافة عربون بدون صورة (بكود OTP)'],
    'pickup-orders':['View preparation orders','عرض طلبات التجهيز'],
    inventory:['View Inventory','عرض المخزون'], products:['View Products','عرض الأصناف'],
    'products-create':['Add Products','إضافة أصناف'], 'products-edit':['Edit Products','تعديل الأصناف'], 'products-delete':['Delete Products','حذف الأصناف'],
    movements:['View Movements','عرض الحركات'],
    vault:['View Cash Register','عرض الخزنة'], suppliers:['View Suppliers','عرض الموردين'],
    'suppliers-create':['Create Suppliers','إنشاء موردين'], 'suppliers-edit':['Edit Suppliers','تعديل الموردين'], 'suppliers-delete':['Delete Suppliers','حذف الموردين'],
    users:['Manage Users','إدارة المستخدمين'],
    settings:['View Settings','عرض الإعدادات'], reports:['View Financial Reports','عرض التقارير'],
    'promotions-view':['Open Promotions','فتح صفحة العروض والخصومات'], 'promotions-offers':['Manage Price Offers','إدارة عروض الأسعار'],
    'promotions-codes':['Manage Discount Codes','إدارة أكواد الخصم'], 'promotions-bundles':['Manage Smart Bundles','إدارة باقات الخصم'],
    'suppliers-rs-view':['View Return Statements','عرض بيانات المرتجعات'], 'suppliers-rs-create':['Create Return Statements','إنشاء بيان مرتجع'],
    'suppliers-rs-edit':['Edit Return Statements','تعديل بيانات المرتجعات'], 'suppliers-rs-status':['Change Statement Status','تغيير حالة بيان المرتجع'],
    'suppliers-rs-delete':['Delete Return Statements','حذف بيانات المرتجعات'], 'suppliers-rs-export':['Print / Export Statements','طباعة وتصدير بيانات المرتجعات'],
    'promotions-tags':['Manage Tags','إدارة التاجات'], 'promotions-audit':['View Promotions Audit Log','عرض سجل مراجعة العروض'],
  };
  /* One entry per permission: [Arabic name, English name, action, Arabic details, English details].
     The details say what the permission allows AND where it stops — shown by the ⓘ on each row.
     Arabic is Modern Standard Arabic. A key missing here falls back to PERMS_AR (index.html). */
  const catalog = {
    // ── الرئيسية
    dashboard:['عرض الصفحة الرئيسية','View dashboard','view','فتح الصفحة الرئيسية بملخص اليوم والطلبات والتنبيهات. لا تعرض الأرباح ولا أرصدة الخزنة؛ فهي للمدير فقط.','Opens the home page with today’s summary, orders and alerts. Profit and cash balances stay admin-only.'],
    'reports-kpis':['التقارير: مؤشرات الأداء','Reports: KPIs','view','عرض بطاقات المؤشرات في صفحة التقارير (المبيعات، متوسط الفاتورة، المرتجعات…). تمنح «فتح صفحة التقارير» تلقائيًا.','Shows the KPI cards on the reports page. Grants “Open reports” automatically.'],
    'reports-charts':['التقارير: المبيعات والمشتريات','Reports: sales & purchases','view','عرض تبويب المبيعات والمشتريات ورسومه البيانية. تمنح «فتح صفحة التقارير» تلقائيًا.','Shows the sales & purchases tab and its charts. Grants “Open reports” automatically.'],
    // ── الطلبات
    'shopify-orders':['عرض طلبات Shopify','View Shopify orders','view','فتح صفحة طلبات Shopify وعرض تفاصيل الطلب والتعليقات والمتابعات. لا تسمح بتأكيد الطلب أو تعديله أو إلغائه.','Opens the Shopify orders page with order details, comments and follow-ups. Does not allow confirming, editing or cancelling.'],
    transaction:['إنشاء معاملة جديدة','Create transactions','create','فتح صفحة «معاملة جديدة» وإنشاء فواتير المبيعات وطلبات المرتجعات. إنشاء فاتورة شراء يحتاج صلاحية «إنشاء فاتورة شراء».','Opens “New transaction” to create sales invoices and return requests. Purchase invoices need “Create purchase invoice”.'],
    'pickup-orders':['عرض طلبات التجهيز','View preparation orders','view','عرض لوحة التجهيز والشحن بكل أعمدتها (معلّق، قيد التجهيز، جاهز للشحن، تم الشحن)، وفتح الكروت والطلبات والفواتير، وإضافة التعليقات. لا تسمح بأي نقل أو تعديل.','Shows the preparation board (pending, preparing, ready, shipped); opens cards, orders and invoices; adds comments. No moving or changing.'],
    'pickup-orders-prepare':['تحضير الطلبات','Prepare orders','edit','فتح مساحة التحضير، ومسح القطع أو «التجهيز بدون مسح»، واعتماد «تحضير هذا الطلب»، والإقرار بتعديل طلب أثناء تجهيزه. لا تنقل الكارت ولا ترسل إلى بوسطة.','Opens the prep workspace: scan pieces or “prepare without scan”, approve “prepare this order”, acknowledge an order edited mid-preparation. Does not move the card or send to Bosta.'],
    'pickup-orders-move':['نقل الكروت وتنظيمها','Move & organise cards','edit','نقل الطلبات من «المعلّق» إلى «قيد التجهيز» (إنشاء مجموعة)، والنقل بين المجموعات ودمجها وتقسيمها، والنقل إلى «جاهز للشحن» والإرجاع إلى التجهيز، وتعديل تاريخ الشحنة، وإضافة الوسوم. لا تُلغي الكارت ولا تتعامل مع بوسطة.','Moves orders from Pending into a prep group, between groups (merge, split), to Ready and back to Preparing; edits the run date; adds tags. Does not cancel a card or touch Bosta.'],
    'pickup-orders-cancel':['إلغاء الكارت','Cancel cards','cancel','إرجاع طلب أو مجموعة كاملة من «قيد التجهيز» أو «جاهز للشحن» إلى «المعلّق» فيختفي الكارت، وحذف عملية شحن لم تُستلم. لا تُلغي الطلب نفسه (يتم ذلك من سجل المعاملات) ولا تُلغي شحنة بوسطة.','Sends an order or a whole group from Preparing/Ready back to Pending (the card disappears) and removes an uncollected run. Does not cancel the order itself or a Bosta shipment.'],
    'pickup-orders-bosta':['طلب بوسطة للشحن','Request Bosta shipping','edit','إرسال الطلب إلى بوسطة، وطباعة بوليصة الشحن وإعادة طباعتها، وإنشاء طلب استلام أو إضافة طلبات إليه أو ضمها له، وتأكيد تحصيل المبلغ. لا تُلغي شحنة مُرسلة.','Sends orders to Bosta, prints and reprints the label, creates a pickup request or adds/joins orders to it, confirms the COD collection. Does not cancel a sent shipment.'],
    'pickup-orders-bosta-cancel':['إلغاء شحنة بوسطة','Cancel a Bosta shipment','cancel','إلغاء شحنة سبق إرسالها إلى بوسطة قبل أن يستلمها المندوب. صلاحية حساسة؛ تُمنح لمن يدير الشحن فقط.','Cancels a shipment already sent to Bosta, before the courier collects it. Sensitive — for whoever runs shipping.'],
    'shopify-prepare-ship':['تأكيد طلبات Shopify وشحنها','Confirm & ship Shopify orders','approve','تأكيد طلب Shopify وتحويله إلى فاتورة مبيعات (يُخصم المخزون ويُسجَّل العربون)، ثم إرساله إلى بوسطة. تمنح «عرض طلبات Shopify» تلقائيًا.','Confirms a Shopify order into a sales invoice (stock deducted, deposit booked) and sends it to Bosta. Grants “View Shopify orders”.'],
    'shopify-reassign':['إسناد طلبات Shopify للموظفين','Reassign Shopify orders','assign','تغيير الموظف المسؤول عن الطلب، فرديًا أو لعدة طلبات معًا. يصل إشعار للموظف الجديد والسابق.','Changes the employee responsible for an order, one or many at once. The new and previous assignee are notified.'],
    'shopify-cancel':['إلغاء طلبات Shopify مباشرة','Cancel Shopify orders','cancel','إلغاء طلب Shopify غير مؤكد فورًا دون موافقة، مع اختيار سبب الإلغاء. لا أثر على المخزون أو الخزنة، ويمكن استرجاعه. الطلب المؤكد يُلغى من سجل المعاملات.','Cancels an unconfirmed Shopify order at once, with a reason. No effect on stock or cash; it can be restored. Confirmed orders are cancelled from Transactions.'],
    'shopify-cancel-request':['طلب إلغاء طلب Shopify','Request a Shopify cancellation','cancel','تقديم طلب إلغاء بسبب محدد، ويبقى الطلب قائمًا حتى يعتمده المدير من صفحة «الموافقات». إذا مُنحت معها صلاحية الإلغاء المباشر فهي الغالبة.','Files a cancellation request with a reason; the order stays live until a manager approves it in Approvals. Direct cancel wins if both are granted.'],
    'shopify-edit-direct':['تعديل طلبات Shopify دون موافقة','Edit Shopify orders directly','edit','حفظ تعديل الطلب (الأصناف والكميات والخصم والعنوان) فورًا دون انتظار موافقة المدير. حد الخصم المسموح يظل مطبقًا. بدونها يُرسل التعديل طلبًا للمدير.','Saves order edits (items, quantities, discount, address) without waiting for approval. The discount limit still applies. Without it, edits go to a manager as a request.'],
    'shopify-bundle-discount-override':['خصم على باقات Shopify (استثناء)','Discount on Shopify bundles (exception)','override','السماح بخصم يتجاوز قيمة الأصناف خارج الباقة، بشرط كتابة سبب (5 أحرف على الأقل) يُحفظ في سجل الطلب. بدونها يُرفض الخصم على أجزاء الباقة.','Allows a discount beyond the items outside an intact bundle, with a written reason (5+ characters) kept on the order. Without it such a discount is refused.'],
    'shopify-deposit-upload':['رفع إيصال تحويل العربون','Upload deposit receipt','upload','رفع صورة إيصال تحويل العربون على الطلب. لا يدخل المبلغ الخزنة إلا بعد اعتماد المدير.','Uploads a deposit transfer receipt on an order. The money enters the vault only after a manager approves it.'],
    'shopify-deposit-no-image':['عربون بدون صورة تحويل (مباشر)','Deposit without receipt (direct)','money','تسجيل عربون بالمبلغ والخزنة دون صورة تحويل ودون كود مدير. يبقى معلّقًا حتى يعتمده المدير، والاعتماد هو ما يحرّك الخزنة.','Records a deposit (amount + vault) without a receipt image or manager code. It stays pending until a manager approves it.'],
    'shopify-deposit-no-image-otp':['عربون بدون صورة تحويل (بكود المدير)','Deposit without receipt (manager code)','money','مثل السابقة، لكنها تحتاج كود OTP من المدير مرتبطًا بالطلب والمبلغ والخزنة، ويُستخدم مرة واحدة. يمكن إلغاء شرط الكود من الإعدادات ← الأمان.','Same as above but needs a one-time manager OTP bound to the order, amount and vault. The code can be waived in Settings → Security.'],
    'delivery-manual-confirm':['تأكيد التسليم يدويًا','Confirm delivery manually','approve','تسجيل الطلب «تم التسليم» دون حالة من شركة الشحن — من الفاتورة أو من التحديد الجماعي في سجل المعاملات — والتراجع عن ذلك. يُسجَّل اسم المنفّذ ووقته.','Marks orders delivered without a carrier status — from the invoice or the bulk selection in Transactions — and undoes it. Who and when are recorded.'],
    'delivery-view-audit':['عرض سجل تأكيد التسليم','View delivery audit','view','عرض من أكّد تسليم كل طلب يدويًا ومتى. للاطلاع فقط.','Shows who confirmed each manual delivery and when. Read only.'],
    'delivery-issues-follow':['متابعة مشاكل التوصيل','Follow up delivery issues','edit','في طلب أعادته شركة الشحن: «لم تصل بعد» و«إعادة الشحن». لا تُقفل المشكلة ولا تُعيد المخزون أو المبلغ.','On an order the courier returned: “Not yet” and “Ship again”. Does not close the issue, restock or refund.'],
    'delivery-issues-close':['إقفال مشاكل التوصيل','Close delivery issues','money','«استلمت الشحنة»: تأكيد وصول المرتجع إلى المخزن، فتعود البضاعة إلى المخزون ويُرد المبلغ المستحق وتُقفل المشكلة. صلاحية حساسة.','“I received it”: confirms the returned parcel reached the warehouse — stock comes back, what is owed is refunded, the issue closes. Sensitive.'],
    // ── المخزون
    inventory:['عرض المخزن','View inventory','view','فتح صفحة المخزن والأرصدة (صالح للبيع، محجوز، يحتاج مراجعة، وارد) وسجل حركة المخزون. أسعار الشراء وقيمة المخزون لا تظهر إلا للمدير ومن يملك «تعديل سعر الشراء».','Opens inventory with balances and the stock movement log. Purchase prices and stock value show only for admins and “Edit purchase price”.'],
    products:['عرض الأصناف','View products','view','فتح قائمة الأصناف وصفحة كل صنف بسعر البيع والمخزون والمواصفات. لا يُرسَل سعر الشراء ولا التكلفة لمن لا يملك «رؤية سعر الشراء والتكلفة»، ولا تسمح بأي تعديل.','Opens the product list and pages with sale price, stock and specs. The purchase price and cost are not even sent without “See purchase price & cost”. No editing.'],
    'products-create':['إضافة أصناف','Add products','create','إضافة صنف جديد أو نسخ صنف قائم. تمنح «عرض الأصناف» و«إدارة أكواد SKU» تلقائيًا.','Adds a new product or duplicates one. Grants “View products” and “Manage SKUs”.'],
    'products-edit':['تعديل الأصناف مباشرة','Edit products directly','edit','حفظ تعديل بيانات الصنف ومواصفاته وصوره فورًا دون كود. لا تشمل الأسعار: سعر البيع يحتاج «تعديل سعر البيع»، وسعر الشراء يحتاج «تعديل سعر الشراء». كود SKU القائم لا يتغيّر.','Saves product details, specs and photos at once, without a code. Prices are separate: sale price needs “Edit sale price”, purchase price “Edit purchase price”. An existing SKU never changes.'],
    'products-edit-otp':['تعديل الأصناف بكود المدير','Edit products with a manager code','edit','تعديل بيانات الصنف ومواصفاته وصوره، ويحتاج كل حفظ إلى كود من المدير صادر لهذا الصنف ولهذه الحقول، ويُستخدم مرة واحدة. لا تشمل تغيير الأسعار.','Edits product details, specs and photos; every save needs a manager code issued for this product and these fields, used once. Does not change prices.'],
    'products-price-sell':['تعديل سعر البيع','Edit sale price','edit','تغيير سعر البيع على بطاقة الصنف وفي التعديل الجماعي. يسري على المبيعات الجديدة فقط؛ الفواتير السابقة تحتفظ بسعرها.','Changes the sale price on the product card and in bulk edit. Applies to new sales only; past invoices keep their price.'],
    'products-specs-view':['عرض نماذج التصنيع','View tech packs','view','فتح تبويب «نماذج التصنيع» في الأصناف وطباعة النماذج المحفوظة. بدونها لا يُعرض التبويب ولا تُرسَل النماذج.','Opens the “Tech Packs” tab on the products page and prints saved sheets. Without it the tab is hidden and the sheets are not sent.'],
    'products-specs-manage':['إنشاء وتعديل نماذج التصنيع','Create & edit tech packs','edit','إنشاء نموذج تصنيع جديد وتعديله وحذفه. الموظف يحذف نماذجه فقط، والمدير يحذف أي نموذج. تشمل عرض النماذج.','Create, edit and delete tech packs. Staff delete their own; an admin deletes any. Includes viewing them.'],
    'approvals-history':['سجل التعديلات (Hub)','Edit history (Hub)','view','تبويب «سجل التعديلات» في الموافقات: كل تعديل وإلغاء على الحركات، ومن قام به.','The “Edit history” tab on approvals: every edit and cancellation of transactions and who made it.'],
    'approvals-otp-log':['سجل عمليات التحقق','Verification log','view','تبويب «سجل عمليات التحقق» في الموافقات: أكواد المدير المطلوبة والمستخدمة والمرفوضة.','The “Verification log” tab on approvals: manager codes requested, used and refused.'],
    'products-supplier-view':['رؤية مورد الصنف وبياناته','See product suppliers','view','رؤية اسم مورد كل صنف في الأصناف والمخزن والبحث، وقائمة الموردين. بدونها لا يُرسَل اسم المورد ولا بياناته إطلاقًا، ولا يمكن تغيير مورد الصنف. تُمنح تلقائيًا رؤيةُ المورد لمن يملك صلاحيات الموردين أو المشتريات.','Shows each product’s supplier on products, inventory and search, and the supplier list. Without it the supplier is not sent at all and cannot be changed. Supplier and purchase permissions include it.'],
    'products-analytics':['كارت المنتج الذكي','Smart product card','view','البحث عن منتج وفتح كارته الذكي: المبيعات والمشتريات والمرتجعات لكل صنف، وتبويب «الأداء» في صفحة الصنف. الأرقام المالية والمورد تتبع صلاحياتها.','Product search and its smart card: sales, purchases and returns per product, and the “Performance” tab on the product page. Money figures and the supplier follow their own permissions.'],
    'products-cost-view':['رؤية سعر الشراء والتكلفة','See purchase price & cost','view','رؤية سعر الشراء ومتوسط التكلفة وهامش الربح وقيمة المخزون على الأصناف والمخزن. للاطلاع فقط؛ التعديل يحتاج «تعديل سعر الشراء».','Shows purchase price, average cost, margin and stock value on products and inventory. Read only; editing needs “Edit purchase price”.'],
    'products-delete':['حذف الأصناف','Delete products','delete','حذف صنف نهائيًا. صلاحية حساسة؛ يُفضَّل إيقاف الصنف بدل حذفه.','Deletes a product permanently. Sensitive — prefer deactivating it.'],
    'products-sku-manage':['إدارة أكواد SKU','Manage SKUs','edit','إنشاء أكواد SKU واستيرادها من Excel وحذفها. لا تسمح بتغيير كود صنف قائم.','Creates, imports (Excel) and deletes SKUs. Never changes an existing product’s code.'],
    'inventory-units-view':['الباركود: عرض القطع والبحث','Units: view & search','view','البحث عن أي قطعة بالباركود أو الكود، وعرض حالتها وتاريخها ومورّدها.','Searches any piece by barcode or code and shows its status, history and supplier.'],
    'inventory-units-register':['الباركود: تسجيل القطع','Units: register pieces','create','تسجيل القطع الموجودة فعليًا في المخزن وإصدار باركود لها.','Registers physical pieces in stock and issues their barcodes.'],
    'inventory-units-receive':['الباركود: استلام قطع المشتريات','Units: receive purchases','create','استلام قطع فاتورة الشراء وربط ملصقات QR المطبوعة مسبقًا بها.','Receives a purchase invoice’s pieces and links pre-printed QR labels.'],
    'inventory-units-allocate':['الباركود: حجز القطع وتجهيزها','Units: allocate & pick','edit','حجز القطع للطلبات، ومسحها أثناء التحضير، و«التجهيز بدون مسح»، والإفراج عنها.','Reserves pieces for orders, scans them while picking, “prepare without scan”, and releases them.'],
    'inventory-units-condition':['الباركود: حالة القطعة وفحصها','Units: condition & inspection','edit','فحص القطعة وتغيير حالتها (سليمة، تالفة، مفقودة، قيد الفحص) وتسجيل حيازتها. لا تخصم المخزون؛ الخصم يتم بتسوية المخزون.','Inspects pieces and changes their condition (sound, damaged, lost, inspection). Does not deduct stock — a stock adjustment does.'],
    'inventory-units-reconcile':['الباركود: الجرد وتوثيق الفروق','Units: stocktake','edit','إجراء الجرد بالمسح وتوثيق الفروق بالأدلة. لا يعتمد النتيجة بنفسه.','Runs a scanned stocktake and documents differences with evidence. Does not approve it.'],
    'inventory-units-reconcile-approve':['الباركود: اعتماد أدلة الجرد','Units: approve stocktake','approve','مراجعة أدلة الجرد واعتمادها أو رفضها.','Reviews stocktake evidence and approves or rejects it.'],
    'inventory-units-print':['الباركود: طباعة الملصقات','Units: print labels','print','طباعة ملصقات الباركود وإعادة طباعتها، مع تسجيل عدد مرات الطباعة.','Prints and reprints barcode labels; each print is counted.'],
    'inventory-units-manual-select':['الباركود: اختيار القطعة يدويًا','Units: manual select','override','اختيار القطعة من قائمة بدل مسحها، مع تأكيد يُسجَّل في سجل التدقيق.','Picks a piece from a list instead of scanning it, with a confirmation kept in the audit log.'],
    'categories-view':['التصنيفات: عرض','Categories: view','view','فتح صفحة التصنيفات والمجموعات وملف كل منها.','Opens categories, collections and their profiles.'],
    'categories-create':['التصنيفات: إضافة','Categories: add','create','إضافة تصنيف أو مجموعة جديدة.','Adds a category or collection.'],
    'categories-edit':['التصنيفات: تعديل مباشر','Categories: edit directly','edit','تعديل اسم التصنيف أو المجموعة وبياناتها وحفظه فورًا دون كود.','Edits a category or collection and saves at once, without a code.'],
    'categories-edit-otp':['التصنيفات: تعديل بكود المدير','Categories: edit with a manager code','edit','تعديل التصنيف أو المجموعة، ويحتاج كل حفظ إلى كود من المدير صادر لهذا السجل ولهذه الحقول.','Edits a category or collection; every save needs a manager code issued for that record and those fields.'],
    'categories-delete':['التصنيفات: حذف','Categories: delete','delete','حذف تصنيف أو مجموعة. لا تُحذف الأصناف المرتبطة بها.','Deletes a category or collection. Linked products are not deleted.'],
    'categories-assign-products':['التصنيفات: ربط الأصناف','Categories: assign products','edit','إضافة الأصناف إلى المجموعات وإزالتها منها.','Adds products to collections and removes them.'],
    'categories-link-suppliers':['التصنيفات: ربط الموردين','Categories: link suppliers','edit','ربط الموردين بالمجموعات وفك الربط.','Links suppliers to collections and unlinks them.'],
    // ── العروض والخصومات
    'promotions-view':['العروض والخصومات: فتح الصفحة','Promotions: open page','view','فتح صفحة العروض والخصومات للاطلاع فقط؛ تظهر الأزرار معطّلة دون صلاحية كل قسم.','Opens the promotions page read-only; actions stay disabled without each area’s permission.'],
    'promotions-offers':['إدارة عروض الأسعار','Manage price offers','edit','إنشاء عروض الأسعار وتعديلها وإيقافها، ورفع العرض عن سطر فاتورة. العرض يسري على المبيعات الجديدة فقط.','Creates, edits and stops price offers, and removes an offer from an invoice line. Applies to new sales only.'],
    'promotions-codes':['إدارة أكواد الخصم','Manage discount codes','edit','إنشاء أكواد الخصم وتعديلها وتفعيلها وإيقافها وحذفها.','Creates, edits, enables, disables and deletes discount codes.'],
    'promotions-bundles':['إدارة الباقات الذكية','Manage smart bundles','edit','إنشاء باقات الخصم الذكية وتعديلها وإيقافها.','Creates, edits and disables smart bundles.'],
    'promotions-tags':['إدارة الوسوم (TAGs)','Manage tags','edit','تعديل الوسوم وألوانها وحذفها. إضافة وسم على الطلب متاحة للجميع.','Edits, recolours and deletes tags. Tagging an order is open to everyone.'],
    'promotions-audit':['سجل مراجعة العروض','Promotions audit log','view','عرض سجل كل تغيير على العروض والأكواد والباقات: من نفّذه ومتى.','Shows every change to offers, codes and bundles: who and when.'],
    // ── الحركات
    movements:['عرض سجل المعاملات','View transactions','view','فتح سجل المعاملات وفتح الفواتير وطباعتها. التعديل والتحصيل والإلغاء تحكمها قواعد كل فاتورة وصلاحياتها.','Opens the transactions log; open and print invoices. Editing, collecting and cancelling follow each invoice’s rules.'],
    'movements-filters':['فلاتر وترتيب سجل المعاملات','Transactions filters & sorting','view','استخدام فلتر التاريخ، وتغيير الترتيب، والفلاتر المتقدمة (الموظف، طريقة الدفع، الحالة، بوسطة، المبلغ، الخصم)، وفلتر الوسوم، والفحص الجماعي للمراجع. بدونها يعمل البحث وتبويبات النوع فقط، ويُعرض السجل بالأحدث أولًا. يطبّق الخادم القيد نفسه.','Use the date filter, change sorting, advanced filters (employee, method, status, Bosta, amount, discount), the TAG filter and the bulk reference check. Without it only search and the type tabs work, newest first. The server applies the same limit.'],
    'inventory-log-browse':['تصفح سجل حركة المخزون كاملًا','Browse the full stock movement log','view','تصفّح كل صفحات سجل حركة المخزون دون حد. بدونها تُعرض أول 5 صفحات (20 صفًا في الصفحة)، ويُتجاهل البحث الأقصر من 3 أحرف، ويُوقف التقليب 15 دقيقة بعد 30 صفحة في الساعة مع إبلاغ المدير. يمكن للموظف طلب تصفح مؤقت يوافق عليه المدير.','Browses every page of the stock movement log. Without it: first 5 pages (20 rows each), searches under 3 characters ignored, paging paused 15 minutes after 30 pages an hour (admins notified). An employee can ask a manager for temporary access.'],
    'movements-collections':['سجل التحصيلات','Collections log','view','فتح تبويب «سجل التحصيلات» في سجل المعاملات: كل عمليات تحصيل العملاء وسداد الموردين ومبالغها. بدونها لا يظهر التبويب.','Opens the «Collections log» tab in the transactions log: every customer collection and supplier payment with its amount. Without it the tab is hidden.'],
    'movements-browse':['تصفح سجل المعاملات كاملًا','Browse the full transactions log','view','تصفّح كل صفحات سجل المعاملات دون حد. بدونها تُعرض أول 5 صفحات، ويُتجاهل البحث الأقصر من 3 أحرف، ويُفحص 20 رقمًا كحد أقصى، ويُوقف التقليب 15 دقيقة بعد 30 صفحة في الساعة مع إبلاغ المدير. يمكن للموظف طلب تصفح مؤقت يوافق عليه المدير.','Browses every page of the transactions log. Without it: first 5 pages, searches under 3 characters ignored, 20 references per check, paging paused 15 minutes after 30 pages an hour (admins notified). An employee can ask a manager for temporary access.'],
    approvals:['صفحة الموافقات','Approvals page','approve','فتح صفحة الموافقات ومتابعة الطلبات المعلّقة (مصاريف، مرتجعات، إلغاءات). القرارات المالية الحساسة تبقى للمدير.','Opens Approvals and its pending requests (expenses, returns, cancellations). Sensitive financial decisions stay admin-only.'],
    'carrier-import':['التحصيل من كشف شركة الشحن','Collect from carrier statement','money','رفع كشف شركة الشحن (Excel) وتحصيل الطلبات الواردة فيه إلى الخزنة.','Uploads a carrier statement (Excel) and collects its orders into the vault.'],
    'carrier-settle-view':['تسويات بوسطة: عرض','Bosta settlements: view','view','عرض تبويب تسويات بوسطة وكشف حساب بوسطة. للاطلاع فقط.','Shows the Bosta settlements and Bosta statement tabs. Read only.'],
    'carrier-settle-run':['تسويات بوسطة: تنفيذ التسوية','Bosta settlements: run','money','جلب السعر الحقيقي من بوسطة وتسوية الطلبات المحددة؛ يدخل صافي المبلغ إلى الخزنة.','Fetches Bosta’s real fee and settles selected orders; the net enters the vault.'],
    'carrier-settle-approve':['تسويات بوسطة: اعتماد وتحويلات','Bosta settlements: approve','approve','اعتماد التسويات المحالة للمراجعة، وتسجيل تحويلات بوسطة ورسومها.','Approves settlements held for review and records Bosta transfers and fees.'],
    'carrier-settle-reverse':['تسويات بوسطة: التراجع','Bosta settlements: reverse','money','إلغاء تسوية مسجّلة وإرجاع أثرها على الخزنة. صلاحية حساسة.','Reverses a booked settlement and its vault entries. Sensitive.'],
    // ── الخزنة والتقارير
    vault:['عرض الخزنة','View cash register','view','فتح صفحة الخزنة وسجل حركاتها بعد إدخال الرقم السري. التسوية اليدوية وإجماليات الوارد والصادر للمدير فقط.','Opens the vault and its log after the system PIN. Manual entries and in/out totals stay admin-only.'],
    'sales-collect':['تحصيل المبلغ من العميل','Collect payment from customers','money','تسجيل تحصيل المتبقي على فاتورة مبيعات (كاش، فودافون كاش، Instapay، تحويل بنكي)، فيدخل المبلغ إلى الخزنة المختارة. لا تشمل سداد الموردين (له صلاحيته) ولا التراجع عن تحصيل (للمدير). صلاحية حساسة.','Records collection of what is left on a sales invoice (cash, Vodafone Cash, Instapay, bank transfer); the money enters the chosen vault. Not supplier payments (own permission) or undoing a collection (admin). Sensitive.'],
    expenses:['المصاريف','Expenses','create','تسجيل المصاريف وعرضها وإرفاق صورها. لا يُخصم المصروف من الخزنة إلا بعد اعتماده.','Records and views expenses with attachments. An expense leaves the vault only once approved.'],
    reports:['فتح صفحة التقارير','Open reports','view','فتح صفحة التقارير؛ يظهر فيها فقط ما مُنح من تبويبات. الأرباح للمدير فقط.','Opens the reports page; only the granted tabs appear. Profit stays admin-only.'],
    'reports-discounts':['التقارير: أكواد الخصم والعروض','Reports: discounts','view','عرض تبويب أكواد الخصم وأداء عروض الأسعار والباقات.','Shows discount codes, price offers and bundle performance.'],
    'reports-orderaudit':['التقارير: تحليل الطلبات','Reports: order analysis','view','عرض تبويب تحليل الطلبات والشحن لكل طلب.','Shows the order analysis tab.'],
    'reports-cancellations':['التقارير: الإلغاءات','Reports: cancellations','view','عرض تبويب الإلغاءات وأسبابها وقيمتها.','Shows cancellations, their reasons and value.'],
    'reports-shipping':['التقارير: الشحن','Reports: shipping','view','عرض تحليل تكاليف الشحن لكل شركة.','Shows shipping cost analysis per carrier.'],
    'reports-export':['التقارير: التصدير','Reports: export','export','تصدير التقارير إلى Excel أو PDF. غير المدير يحتاج كود موافقة لكل تصدير.','Exports reports to Excel or PDF. Non-admins need an approval code each time.'],
    'data-export':['تصدير Excel وطباعة التقارير','Excel export & report printing','export','تصدير أي جدول إلى Excel أو CSV، وطباعة التقارير والقوائم (تحليل المخزون، قائمة الأصناف، أمر الشراء، المرتجع، المصروف، تقرير الأداء) دون كود. بدونها يطلب كل تصدير أو طباعة كود المدير. طباعة الفاتورة وبوليصة الشحن وملصقات الباركود متاحة للجميع.','Exports any table to Excel/CSV and prints reports and lists without a code. Without it every export or report print needs a manager code. Invoices, shipping labels and barcode labels are always printable.'],
    // ── الموردون
    suppliers:['عرض الموردين','View suppliers','view','فتح قائمة الموردين وملف كل مورد. التبويبات المالية داخل الملف تحتاج صلاحياتها.','Opens the supplier list and profiles. Financial tabs need their own permissions.'],
    'suppliers-create':['إضافة موردين','Add suppliers','create','إضافة مورد جديد. تمنح «عرض الموردين» تلقائيًا.','Adds a supplier. Grants “View suppliers”.'],
    'suppliers-edit':['تعديل الموردين','Edit suppliers','edit','تعديل بيانات المورد، ويظهر اسمه الجديد على أصنافه.','Edits supplier details; the new name follows on products.'],
    'suppliers-delete':['حذف الموردين','Delete suppliers','delete','حذف مورد. صلاحية حساسة.','Deletes a supplier. Sensitive.'],
    'purchase-view':['عرض فواتير وأوامر الشراء','View purchases','view','عرض فواتير الشراء وأوامر الشراء. أسعار الشراء تُخفى دون «تعديل سعر الشراء».','Shows purchase invoices and orders. Purchase prices stay hidden without “Edit purchase price”.'],
    'purchase-create':['إنشاء فاتورة شراء','Create purchase invoice','create','إنشاء فواتير الشراء وأوامر الشراء واستلام البضاعة. يُخصم العربون من الخزنة المختارة.','Creates purchase invoices and orders and receives goods. The deposit leaves the chosen vault.'],
    'purchase-edit-price':['تعديل سعر الشراء','Edit purchase price','edit','تعديل سعر الشراء على الصنف وأسعار الموردين ومتوسط التكلفة. تمنح «رؤية سعر الشراء والتكلفة» تلقائيًا.','Edits the purchase price, supplier prices and average cost. Grants “See purchase price & cost”.'],
    'suppliers-tab-invoices':['حساب المورد: الفواتير','Supplier: invoices','view','عرض تبويب فواتير المورد.','Shows the supplier’s invoices tab.'],
    'suppliers-tab-pos':['حساب المورد: أوامر الشراء','Supplier: purchase orders','view','عرض تبويب أوامر الشراء.','Shows the purchase orders tab.'],
    'suppliers-tab-sreturns':['حساب المورد: المرتجعات','Supplier: returns','view','عرض تبويب مرتجعات الموردين.','Shows the supplier returns tab.'],
    'suppliers-tab-payments':['حساب المورد: سجل المدفوعات','Supplier: payments','view','عرض كل ما دُفع للمورد وطريقته.','Shows every payment made to the supplier.'],
    'suppliers-tab-ledger':['حساب المورد: سجل المديونية','Supplier: debt ledger','view','عرض سجل مديونية المورد ورصيده.','Shows the supplier’s debt ledger and balance.'],
    'suppliers-tab-activity':['حساب المورد: سجل النشاط','Supplier: activity','view','عرض سجل التغييرات على المورد.','Shows the supplier’s change log.'],
    'suppliers-pay':['سداد دفعة للمورد','Pay a supplier','money','دفع مبلغ للمورد من خزنة مختارة على فاتورة أو أكثر. المبلغ يخرج من الخزنة فورًا. صلاحية حساسة.','Pays a supplier from a chosen vault, on one or more invoices. Cash leaves the vault at once. Sensitive.'],
    'suppliers-deposit':['دفعة مقدمة / خصم على حساب المورد','Supplier advance / credit','money','تسجيل دفعة مقدمة للمورد أو خصم على حسابه. صلاحية حساسة.','Records an advance to the supplier or a credit on the account. Sensitive.'],
    'suppliers-ledger-adjust':['تسوية سجل المديونية','Adjust debt ledger','money','إضافة قيد تسوية يدوي على مديونية المورد مع سبب. لا يحرّك الخزنة. صلاحية حساسة.','Adds a manual adjustment to the supplier’s debt, with a reason. No vault movement. Sensitive.'],
    'suppliers-write-off':['إقفال متبقي الفاتورة','Write off invoice balance','money','إقفال المتبقي على فاتورة شراء دون دفع؛ لا يخرج أي مبلغ من الخزنة. صلاحية حساسة.','Closes a purchase invoice’s balance without paying; nothing leaves the vault. Sensitive.'],
    'suppliers-reverse':['التراجع عن دفعة للمورد','Reverse a supplier payment','money','إلغاء دفعة مسجّلة وإرجاع مبلغها إلى خزنتها. صلاحية حساسة.','Reverses a recorded payment back into its vault. Sensitive.'],
    'suppliers-returns':['إدارة مرتجعات الموردين','Manage supplier returns','edit','إنشاء مرتجع للمورد وإكماله (يخرج المخزون ويُسوّى الحساب). الاعتماد يبقى للمدير.','Creates and completes supplier returns (stock out, account settled). Approval stays admin-only.'],
    'suppliers-rs-view':['بيانات المرتجعات: عرض','Return statements: view','view','عرض بيانات المرتجعات (توثيق فقط، لا أثر لها على المخزون أو الحساب).','Shows return statements (documentation only — no stock or ledger effect).'],
    'suppliers-rs-create':['بيانات المرتجعات: إنشاء','Return statements: create','create','إنشاء بيان مرتجع بالأصناف والأسباب والصور، وتعديل مسوّداته الخاصة.','Creates a return statement with items, reasons and photos; edits own drafts.'],
    'suppliers-rs-edit':['بيانات المرتجعات: تعديل','Return statements: edit','edit','تعديل أي بيان مرتجع غير مغلق.','Edits any statement that is not closed.'],
    'suppliers-rs-status':['بيانات المرتجعات: تغيير الحالة','Return statements: status','approve','تغيير حالة البيان (مسودة، أُرسل، استُلم، حُلّ، مغلق).','Changes a statement’s status (draft → sent → received → resolved → closed).'],
    'suppliers-rs-delete':['بيانات المرتجعات: حذف','Return statements: delete','delete','حذف بيان مرتجع (يبقى في السجل).','Deletes a statement (kept in history).'],
    'suppliers-rs-export':['بيانات المرتجعات: طباعة وتصدير','Return statements: print','print','طباعة البيان أو حفظه PDF وتنزيل صوره.','Prints a statement or saves it as PDF and downloads its photos.'],
    // ── الموظفون والإعدادات
    users:['إدارة المستخدمين','Manage users','restricted','إنشاء الحسابات وتعديلها وتعطيلها. محصورة في مدير النظام بسياسة الخادم، ولا تُفوَّض لدور.','Creates, edits and disables accounts. Admin-only by server policy; cannot be delegated.'],
    settings:['الإعدادات','Settings','restricted','تعديل إعدادات النظام والتكاملات. محصورة في مدير النظام بسياسة الخادم، ولا تُفوَّض لدور.','System settings and integrations. Admin-only by server policy; cannot be delegated.'],
    // ── خدمة العملاء
    clients:['عرض العملاء','View customers','view','فتح صفحة العملاء وسجل مشترياتهم.','Opens customers and their purchase history.'],
    'clients-browse':['تصفح قائمة العملاء كاملة','Browse the full client list','view','تصفّح كل صفحات قائمة العملاء. بدونها يرى الموظف الصفحة الأولى فقط، ويصل إلى أي عميل بالبحث باسمه أو هاتفه؛ تقليب الصفحات يُظهر نافذة القفل مع «طلب صلاحية التصفح» من المدير. تحمي بيانات العملاء من النسخ الجماعي.','Browses every page of the client list. Without it an employee sees page 1 only and reaches a client by searching name or phone; other pages show a privacy notice. Protects client data from bulk copying.'],
    'customers-phone-view':['رؤية أرقام العملاء في القوائم','See client phones in lists','view','عرض أرقام هواتف العملاء كاملة في قائمة العملاء وسجل المعاملات. بدونها تظهر مخفية جزئيًا (010•••••678)، وتبقى كاملة في صفحة الفاتورة وملف العميل.','Shows full client phone numbers in the client list and the transactions log. Without it they are partly hidden (010•••••678); the invoice and client profile still show them in full.'],
    complaints:['الشكاوى والمتابعات','Complaints & follow-ups','edit','فتح شكاوى العملاء والمتابعات وإدارتها، ورؤية متابعات كل الموظفين. بدونها يرى الموظف المتابعات المسندة إليه فقط.','Opens and manages complaints and follow-ups for everyone. Without it an employee sees only follow-ups assigned to them.'],
    'csp-view':['دليل خدمة العملاء: عرض','CS guide: view','view','عرض بطاقات الردود في دليل خدمة العملاء ونسخها.','Shows and copies reply cards in the CS guide.'],
    'csp-create':['دليل خدمة العملاء: إضافة','CS guide: add','create','إضافة بطاقات ردود جديدة.','Adds reply cards.'],
    'csp-edit':['دليل خدمة العملاء: تعديل','CS guide: edit','edit','تعديل بطاقات الردود.','Edits reply cards.'],
    'csp-delete':['دليل خدمة العملاء: حذف','CS guide: delete','delete','حذف بطاقات الردود.','Deletes reply cards.'],
    'csp-manage-folders':['دليل خدمة العملاء: المجلدات','CS guide: folders','edit','إنشاء المجلدات وترتيبها وحذفها.','Creates, orders and deletes folders.'],
    'csp-analytics':['دليل خدمة العملاء: الإحصائيات','CS guide: analytics','view','عرض إحصائيات استخدام البطاقات.','Shows card usage statistics.'],
    'csp-export':['دليل خدمة العملاء: تصدير','CS guide: export','export','تصدير البطاقات إلى ملف.','Exports cards to a file.'],
    'csp-import':['دليل خدمة العملاء: استيراد','CS guide: import','create','استيراد بطاقات من ملف.','Imports cards from a file.'],
  };
  const ACTIONS = { view:['View','عرض'], create:['Create','إنشاء'], edit:['Edit','تعديل'], delete:['Delete','حذف'], approve:['Approve','اعتماد'],
    export:['Export','تصدير'], cancel:['Cancel','إلغاء'], money:['Money','حركة مالية'], print:['Print','طباعة'], upload:['Upload','رفع'],
    assign:['Assign','إسناد'], override:['Exception','استثناء'], restricted:['Restricted','مقيّدة'] };
  const sensitive = new Set(['sales-collect','clients-browse','data-export','products-supplier-view','pickup-orders-bosta-cancel','delivery-issues-close','products-cost-view','products-price-sell','users','settings','vault','shopify-cancel','shopify-edit-direct','shopify-bundle-discount-override','shopify-deposit-no-image','products-delete','suppliers-delete','suppliers-pay','suppliers-deposit','suppliers-ledger-adjust','suppliers-write-off','suppliers-reverse','carrier-settle-run','carrier-settle-approve','carrier-settle-reverse']);
  const viewerAllowed = new Set(['dashboard','inventory','products','movements','clients','suppliers','complaints','reports','reports-kpis','reports-charts','reports-discounts','reports-orderaudit','reports-cancellations','reports-shipping','categories-view','pickup-orders','shopify-orders','csp-view','purchase-view','inventory-units-view','suppliers-tab-invoices','suppliers-tab-pos','suppliers-tab-sreturns','suppliers-tab-payments','suppliers-tab-ledger','suppliers-tab-activity','carrier-settle-view','delivery-view-audit','promotions-view','suppliers-rs-view']);
  const builtInAr = {
    'super-admin':['المدير الرئيسي','الحساب الرئيسي المحمي مع وصول كامل للنظام.'],
    admin:['مدير النظام','وصول إداري كامل لكل النظام.'], manager:['مدير عمليات','العمليات والطلبات والمخزون والموافقات.'],
    accountant:['محاسب','السجلات المالية والموردون والتقارير.'], sales:['مبيعات','الطلبات والعملاء ومعلومات الأصناف.'],
    warehouse:['المخزن','المخزون والوحدات وتجهيز الطلبات.'],
    'customer-service':['خدمة العملاء','حالات العملاء والطلبات والمتابعات.'], viewer:['مشاهد','عرض البيانات والتقارير فقط.'],
    fulfillment:['تجهيز وشحن','تجهيز الطلبات والشحن والتسليم.'], cashier:['أمين خزنة','الخزنة والمصاريف.'],
    purchasing:['مشتريات وموردون','الموردون وفواتير الشراء ومرتجعات الموردين.'], marketing:['تسويق ومحتوى','الأصناف والمجموعات وتقارير المبيعات.'],
  };
  const ui = { roles:[], unassigned:[], selected:'super-admin', draft:new Set(), original:new Set(), canManage:false,
    loaded:false, loading:null, saving:false, search:'', expanded:new Set(['dashboard','orders','pickup','inventory']), users:null };
  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const en = () => typeof currentLang !== 'undefined' && currentLang === 'en';
  const tr = (english, arabic) => en() ? english : arabic;
  const role = () => ui.roles.find(item => item.slug === ui.selected);
  const count = value => new Intl.NumberFormat(en() ? 'en' : 'ar-EG-u-nu-latn').format(value);
  const date = value => value ? new Intl.DateTimeFormat(en() ? 'en' : 'ar-EG-u-nu-latn', {dateStyle:'medium'}).format(new Date(value)) : '—';
  const name = key => (catalog[key] && catalog[key][en() ? 1 : 0]) || specialNames[key]?.[en() ? 0 : 1] || (en() ? key.replace(/-/g,' ').replace(/\b\w/g,char => char.toUpperCase()) : (typeof PERMS_AR !== 'undefined' && PERMS_AR[key]) || key);
  const info = key => catalog[key] ? catalog[key][en() ? 4 : 3] : '';
  const action = key => catalog[key] ? tr(...ACTIONS[catalog[key][2]] || ACTIONS.view) : /-view$|^dashboard$|^inventory$|^products$|^movements$|^vault$|^suppliers$|^reports$|^shopify-orders$|^pickup-orders$/.test(key) ? tr('View','عرض')
    : /-create$|-register$|-receive$/.test(key) ? tr('Create','إنشاء')
    : /-edit$|-allocate$|-condition$|-reassign$|-prepare-ship$|-adjust$/.test(key) ? tr('Edit','تعديل')
    : /-delete$/.test(key) ? tr('Delete','حذف')
    : /-approve$|^approvals$|-confirm$/.test(key) ? tr('Approve','اعتماد')
    : /-export$/.test(key) ? tr('Export','تصدير') : tr('Run','تنفيذ');
  const dirty = () => ui.draft.size !== ui.original.size || [...ui.draft].some(key => !ui.original.has(key));
  const status = (message, error=false) => { const el=$('#rbac-status'); if (!el) return; el.textContent=message; el.dataset.error=String(error); if (error&&!ui.loaded) { const retry=document.createElement('button'); retry.type='button'; retry.id='rbac-retry'; retry.className='rbac-secondary'; retry.textContent=tr('Retry','إعادة المحاولة'); retry.style.marginInlineStart='12px'; el.append(retry); } };
  const canEdit = () => ui.canManage && role() && !role().locked;
  const editablePermission = key => !['users','settings'].includes(key) && (role()?.baseRole !== 'viewer' || viewerAllowed.has(key));
  const avatar = user => {
    const src = typeof sanitizeUrl === 'function' ? sanitizeUrl(user.avatar) : '';
    return src ? `<span class="rbac-avatar"><img src="${esc(src)}" alt=""></span>` : `<span class="rbac-avatar">${esc((user.name || user.username || '?').slice(0,2).toUpperCase())}</span>`;
  };
  const label = (english, arabic) => tr(english, arabic);
  const roleName = item => en() ? item.name : builtInAr[item.slug]?.[0] || item.name;
  const tierName = tier => tier === 'admin' ? tr('System admin','مدير النظام') : tier === 'viewer' ? tr('Viewer','مشاهد') : tr('Staff','موظف');
  const roleDescription = item => en() ? item.description : builtInAr[item.slug]?.[1] || item.description;
  function reconcile(changedKey, checked) {
    const PICKUP_ACTIONS = ['pickup-orders-prepare','pickup-orders-move','pickup-orders-cancel','pickup-orders-bosta','pickup-orders-bosta-cancel'];
    if (changedKey==='pickup-orders' && !checked) PICKUP_ACTIONS.forEach(key => ui.draft.delete(key));
    if (changedKey==='shopify-orders' && !checked) ui.draft.delete('shopify-prepare-ship');
    if (PICKUP_ACTIONS.some(key => ui.draft.has(key))) ui.draft.add('pickup-orders');
    if (ui.draft.has('shopify-prepare-ship')) ui.draft.add('shopify-orders');
    if (['products-create','products-edit','products-delete','products-edit-otp','products-price-sell','products-cost-view'].some(key=>ui.draft.has(key))) ui.draft.add('products');
    if (ui.draft.has('purchase-edit-price')) ui.draft.add('products-cost-view');
    if (['products-supplier-view','products-analytics'].some(key=>ui.draft.has(key))) ui.draft.add('products');
    if (ui.draft.has('products-specs-manage')) ui.draft.add('products-specs-view');
    if (ui.draft.has('products-specs-view')) ui.draft.add('products');
    if (changedKey==='products-specs-view' && !checked) ui.draft.delete('products-specs-manage');
    if (ui.draft.has('approvals-history')||ui.draft.has('approvals-otp-log')) ui.draft.add('approvals');
    if (changedKey==='approvals' && !checked) { ui.draft.delete('approvals-history'); ui.draft.delete('approvals-otp-log'); }
    if (ui.draft.has('clients-browse')) ui.draft.add('clients');
    if (ui.draft.has('movements-filters')) ui.draft.add('movements');
    if (ui.draft.has('movements-browse')) ui.draft.add('movements');
    if (ui.draft.has('movements-collections')) ui.draft.add('movements');
    if (ui.draft.has('inventory-log-browse')) ui.draft.add('inventory');
    if (changedKey==='inventory' && !checked) ui.draft.delete('inventory-log-browse');
    if (changedKey==='movements' && !checked) ui.draft.delete('movements-collections');
    if (changedKey==='movements' && !checked) ui.draft.delete('movements-browse');
    if (changedKey==='movements' && !checked) ui.draft.delete('movements-filters');
    if (changedKey==='clients' && !checked) ui.draft.delete('clients-browse');
    if (changedKey==='products-cost-view' && !checked) ui.draft.delete('purchase-edit-price');
    if (ui.draft.has('categories-edit-otp')) ui.draft.add('categories-view');
    if (ui.draft.has('products-create')||ui.draft.has('products-delete')) ui.draft.add('products-sku-manage');
    if (['suppliers-create','suppliers-edit','suppliers-delete'].some(key=>ui.draft.has(key))) ui.draft.add('suppliers');
    if ([...ui.draft].some(key=>key.startsWith('reports-'))) ui.draft.add('reports');
  }

  function renderChrome() {
    const labels = { pageTitle:['Roles & Permissions','الأدوار والصلاحيات'], pageSubtitle:['Manage user roles and control system access.','إدارة أدوار المستخدمين والتحكم في الوصول للنظام.'],
      users:['Users','المستخدمون'], create:['Create New Role','إنشاء دور جديد'], roles:['Roles','الأدوار'] };
    Object.entries(labels).forEach(([key,pair]) => document.querySelectorAll(`[data-rbac="${key}"]`).forEach(el => el.textContent=pair[en()?0:1]));
    $('#rbac-root').dir = en() ? 'ltr' : 'rtl';
    $('#rbac-create').hidden = !ui.canManage;
    const refresh=$('#rbac-refresh'); refresh.title=label('Refresh roles','تحديث الأدوار'); refresh.setAttribute('aria-label',refresh.title);
  }

  function renderSidebar() {
    $('#rbac-role-count').textContent = count(ui.roles.length);
    $('#rbac-role-list').innerHTML = ui.roles.map(item => `<div class="rbac-role-item ${item.slug===ui.selected?'is-selected':''}">
      <button type="button" class="rbac-role-select" data-role="${esc(item.slug)}" aria-current="${item.slug===ui.selected?'true':'false'}"><strong>${esc(roleName(item))}</strong><small>${esc(roleDescription(item) || '—')}</small><span class="rbac-role-users">${count(item.users?.length || 0)} ${label('users','مستخدمين')} · ${esc(tierName(item.baseRole))}</span></button>
      <details class="rbac-role-menu"><summary aria-label="${label('Role actions','إجراءات الدور')}">⋯</summary><div class="rbac-menu-popover"><button data-role="${esc(item.slug)}">${label('View details','عرض التفاصيل')}</button>${ui.canManage&&!item.locked?`<button data-edit="${esc(item.slug)}">${label('Edit details','تعديل التفاصيل')}</button>${!item.system?`<button class="is-danger" data-delete="${esc(item.slug)}">${label('Delete role','حذف الدور')}</button>`:''}`:''}</div></details>
    </div>`).join('');
    if (matchMedia('(max-width: 900px)').matches) requestAnimationFrame(() => {
      $('#rbac-role-list .is-selected')?.scrollIntoView({block:'nearest',inline:'center'});
    });
  }

  function renderMatrix() {
    const editable = canEdit();
    const search = ui.search.trim().toLowerCase();
    const visible = groups.map(([key,english,arabic,keys]) => {
      const title = label(english,arabic);
      const matches = keys.filter(perm => !search || title.toLowerCase().includes(search) || perm.toLowerCase().includes(search) || name(perm).toLowerCase().includes(search) || info(perm).toLowerCase().includes(search));
      const staticMatch=(restrictedRows[key]||[]).some(row => row[en()?0:1].toLowerCase().includes(search));
      return matches.length || (search && staticMatch) ? {key,title,keys:matches} : null;
    }).filter(Boolean);
    const allKeys = groups.flatMap(group => group[3]).filter(editablePermission);
    const allChecked = allKeys.every(key => ui.draft.has(key));
    return `<section class="rbac-detail-card"><div class="rbac-section-head"><div><h3>${label('Permission matrix','مصفوفة الصلاحيات')}</h3><p>${label('Only capabilities enforced by SOULIA are editable.','الصلاحيات المفعّلة في SOULIA فقط قابلة للتعديل.')}</p></div>
      <div class="rbac-section-actions"><input class="rbac-search" id="rbac-search" type="search" value="${esc(ui.search)}" placeholder="${label('Search permissions…','ابحث عن صلاحية…')}" aria-label="${label('Search permissions','البحث في الصلاحيات')}"><button class="rbac-quiet" id="rbac-expand-all">${ui.expanded.size===groups.length?label('Collapse all','طي الكل'):label('Expand all','توسيع الكل')}</button>
      <label class="rbac-select-all"><input id="rbac-all" type="checkbox" ${allChecked?'checked':''} ${editable?'':'disabled'}> ${label('Select all','تحديد الكل')}</label></div></div>
      <div class="rbac-perm-header"><span>${label('Permission','الصلاحية')}</span><span>${label('Action','الإجراء')}</span><span>${label('Grant','منح')}</span></div>
      ${visible.map(group => { const grantable=group.keys.filter(editablePermission), selected=grantable.filter(key => ui.draft.has(key)).length;
        return `<section class="rbac-module ${ui.expanded.has(group.key)||search?'is-open':''}" data-module="${esc(group.key)}"><div class="rbac-module-head"><button type="button" class="rbac-module-toggle" data-expand="${esc(group.key)}" aria-expanded="${ui.expanded.has(group.key)||!!search}"><span class="rbac-chevron">›</span><span class="rbac-module-title">${esc(group.title)}</span><span class="rbac-module-count">${count(selected)} / ${count(grantable.length)}</span></button><label class="rbac-select-all" title="${label('Select all in module','تحديد كل صلاحيات القسم')}"><input type="checkbox" data-module-all="${esc(group.key)}" ${grantable.length&&selected===grantable.length?'checked':''} ${editable&&grantable.length?'':'disabled'} aria-label="${label('Select all','تحديد الكل')} ${esc(group.title)}"></label></div><div class="rbac-module-body">${group.keys.map(key => `<label class="rbac-perm-row ${role()?.locked?'is-inherited':''} ${!editablePermission(key)?'is-restricted':''}" title="${!editablePermission(key)?label('Restricted by server policy','مقيّدة بسياسة الخادم'):''}"><span class="rbac-perm-name"><span class="rbac-perm-title"><strong>${esc(name(key))}</strong>${info(key)?`<button type="button" class="rbac-info" data-info="${esc(key)}" aria-label="${esc(label('About this permission','تفاصيل الصلاحية'))}: ${esc(name(key))}" aria-expanded="false"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.5h.01"/></svg></button>`:''}</span><small>${esc(key)}</small></span><span class="rbac-action-tag">${!editablePermission(key)?label('Restricted','مقيّدة'):esc(action(key))}</span><input type="checkbox" data-perm="${esc(key)}" ${ui.draft.has(key)?'checked':''} ${editable&&editablePermission(key)?'':'disabled'} aria-label="${esc(name(key))}"></label>`).join('')}${(restrictedRows[group.key]||[]).filter(row=>!search||group.title.toLowerCase().includes(search)||row[en()?0:1].toLowerCase().includes(search)).map(row=>{const inherited=!!row[3],granted=inherited?ui.draft.has(row[3]):role()?.slug==='super-admin'||(role()?.slug==='admin'&&row[0]!=='Manage Roles & Permissions'&&row[0]!=='Export Orders');return `<div class="rbac-perm-row ${inherited?'is-inherited':'is-restricted'}"><span class="rbac-perm-name"><strong>${esc(label(row[0],row[1]))}</strong><small>${inherited?label('Inherited from module access','موروثة من صلاحية القسم'):label('System policy · not delegated','سياسة النظام · غير قابلة للتفويض')}</small></span><span class="rbac-action-tag">${inherited?label('Inherited','موروثة'):label('Restricted','مقيّدة')}</span><input type="checkbox" disabled ${granted?'checked':''} aria-label="${esc(label(row[0],row[1]))}"></div>`;}).join('')}</div></section>`;
      }).join('') || `<div class="rbac-empty">${label('No matching permissions.','لا توجد صلاحيات مطابقة.')}</div>`}
      <div class="rbac-note">${role()?.locked ? label('Inherited: this protected administrator role has full access by system policy.','موروثة: هذا الدور الإداري المحمي يملك وصولًا كاملًا بسياسة النظام.') : label('Restricted actions without a server permission are intentionally unavailable here.','الإجراءات التي لا تملك صلاحية معتمدة في الخادم غير متاحة هنا.')}</div></section>`;
  }

  function renderUsers() {
    const item=role(), editable=ui.canManage && item?.slug!=='super-admin';
    return `<section class="rbac-detail-card"><div class="rbac-section-head"><div><h3>${label('Assigned users','المستخدمون المعينون')}</h3><p>${count(item.users?.length||0)} ${label('accounts','حسابات')}</p></div>${editable?`<button class="rbac-secondary" data-assign="${esc(item.slug)}">＋ ${label('Assign user','تعيين مستخدم')}</button>`:''}</div>
      ${item.users?.length ? `<div style="overflow-x:auto"><table class="rbac-users-table"><thead><tr><th>${label('Employee','الموظف')}</th><th>${label('Status','الحالة')}</th><th>${label('Assigned','التعيين')}</th><th></th></tr></thead><tbody>${item.users.map(user => `<tr><td><span class="rbac-person">${avatar(user)}<span><strong>${esc(user.name)}</strong><small>${user.email?esc(user.email):'@'+esc(user.username)}</small></span></span></td><td><span class="rbac-status-pill ${user.isActive?'is-active':''}">${user.isActive?label('Active','نشط'):label('Inactive','معطّل')}</span></td><td>${date(user.assignedAt)}</td><td>${editable?`<button class="rbac-quiet" data-unassign="${esc(user.id)}">${label('Remove','إزالة')}</button>`:''}</td></tr>`).join('')}</tbody></table></div>` : `<div class="rbac-empty">${label('No users are assigned to this role.','لم يُعيَّن أي مستخدم لهذا الدور.')}</div>`}</section>`;
  }

  function renderDetail() {
    const item=role();
    if (!item) { $('#rbac-detail').innerHTML=`<div class="rbac-empty">${label('Select a role.','اختر دورًا.')}</div>`; return; }
    const editable=ui.canManage&&!item.locked;
    $('#rbac-detail').innerHTML=`<section class="rbac-detail-card"><div class="rbac-detail-head"><div><p class="rbac-kicker">${item.locked?label('Protected role','دور محمي'):item.system?label('System role','دور أساسي'):label('Custom role','دور مخصص')}</p><h2>${esc(roleName(item))}</h2><p>${esc(roleDescription(item) || '—')}</p></div>${editable?`<div class="rbac-detail-actions"><button class="rbac-secondary" data-edit="${esc(item.slug)}">${label('Edit role','تعديل الدور')}</button>${!item.system?`<button class="rbac-danger" data-delete="${esc(item.slug)}">${label('Delete','حذف')}</button>`:''}</div>`:''}</div>
      <div class="rbac-meta"><div><small>${label('Assigned users','المستخدمون')}</small><strong>${count(item.users?.length||0)}</strong></div><div><small>${label('Created','تاريخ الإنشاء')}</small><strong>${date(item.createdAt)}</strong></div><div><small>${label('Last updated','آخر تحديث')}</small><strong>${date(item.updatedAt)}</strong></div></div></section>
      ${renderMatrix()}${renderUsers()}<div class="rbac-savebar"><span class="${dirty()?'rbac-unsaved':'rbac-saved'}">${dirty()?label('● Unsaved changes','● تغييرات غير محفوظة'):label('All changes saved','كل التغييرات محفوظة')}</span><div class="rbac-savebar-actions"><button class="rbac-secondary" id="rbac-discard" ${dirty()?'':'disabled'}>${label('Discard','تجاهل')}</button><button class="rbac-primary" id="rbac-save" ${dirty()&&!ui.saving?'':'disabled'}>${ui.saving?label('Saving…','جارٍ الحفظ…'):label('Save Changes','حفظ التغييرات')}</button></div></div>`;
    $('#rbac-detail').querySelectorAll('[data-module-all]').forEach(input => { const keys=groups.find(group=>group[0]===input.dataset.moduleAll)?.[3].filter(editablePermission)||[]; input.indeterminate=keys.some(key=>ui.draft.has(key))&&!keys.every(key=>ui.draft.has(key)); });
    const allKeys=groups.flatMap(group=>group[3]).filter(editablePermission), all=$('#rbac-all');
    if (all) all.indeterminate=allKeys.some(key=>ui.draft.has(key))&&!allKeys.every(key=>ui.draft.has(key));
  }

  function syncGrantUI() {
    const detail=$('#rbac-detail');
    detail.querySelectorAll('[data-perm]').forEach(input => { input.checked=ui.draft.has(input.dataset.perm); });
    detail.querySelectorAll('.rbac-module').forEach(module => {
      const keys=[...module.querySelectorAll('[data-perm]:not(:disabled)')].map(input=>input.dataset.perm);
      const selected=keys.filter(key=>ui.draft.has(key)).length;
      const master=module.querySelector('[data-module-all]');
      master.checked=keys.length>0&&selected===keys.length;
      master.indeterminate=selected>0&&selected<keys.length;
      module.querySelector('.rbac-module-count').textContent=`${count(selected)} / ${count(keys.length)}`;
    });
    const keys=groups.flatMap(group=>group[3]).filter(editablePermission);
    const selected=keys.filter(key=>ui.draft.has(key)).length, all=$('#rbac-all');
    all.checked=keys.length>0&&selected===keys.length; all.indeterminate=selected>0&&selected<keys.length;
    const changed=dirty(), mark=detail.querySelector('.rbac-unsaved,.rbac-saved');
    mark.className=changed?'rbac-unsaved':'rbac-saved';
    mark.textContent=changed?label('● Unsaved changes','● تغييرات غير محفوظة'):label('All changes saved','كل التغييرات محفوظة');
    $('#rbac-discard').disabled=!changed; $('#rbac-save').disabled=!changed||ui.saving;
  }

  function renderLegacy() {
    let box=$('#rbac-legacy');
    if (!box) { box=document.createElement('div'); box.id='rbac-legacy'; $('#rbac-layout').before(box); }
    // Disabled accounts are left as they are by the move, so they are not counted here.
    const list=(ui.unassigned||[]).filter(user=>user.isActive!==false);
    box.hidden=!list.length;
    box.innerHTML=list.length?`<div class="rbac-legacy"><span><strong>${count(list.length)} ${label('accounts have no role','حساب بدون دور')}</strong> — ${label('they still hold permissions set one by one, before roles existed. Move them onto roles so every account is managed here.','ما زالت تحمل صلاحيات مُنحت لكل حساب على حدة قبل اعتماد الأدوار. انقلها إلى أدوار لتُدار جميع الحسابات من هنا.')}</span><button type="button" class="rbac-secondary" id="rbac-migrate">${label('Review and move','مراجعة ونقل')}</button></div>`:'';
  }
  function render() { renderChrome(); renderSidebar(); renderLegacy(); renderDetail(); $('#rbac-layout').hidden=false; }
  function select(slug) {
    if (dirty() && !confirm(label('Discard unsaved permission changes?','تجاهل تغييرات الصلاحيات غير المحفوظة؟'))) return;
    ui.selected=slug; const item=role(); ui.original=new Set(item?.perms||[]); ui.draft=new Set(item?.perms||[]); ui.search=''; render();
  }
  async function refresh(keepSelection=true) {
    if (ui.loading) return ui.loading;
    status(label('Loading roles…','جارٍ تحميل الأدوار…'));
    ui.loading=api('/roles').then(result => {
      ui.roles=result.roles||[]; ui.unassigned=result.unassigned||[]; ui.canManage=!!result.canManage; ui.loaded=true;
      if (!keepSelection || !ui.roles.some(item => item.slug===ui.selected)) ui.selected=ui.roles[0]?.slug;
      const item=role(); ui.original=new Set(item?.perms||[]); ui.draft=new Set(item?.perms||[]);
      status(''); render();
    }).catch(error => { status(error.message||label('Unable to load roles.','تعذر تحميل الأدوار.'),true); $('#rbac-layout').hidden=true; throw error; }).finally(() => { ui.loading=null; });
    return ui.loading;
  }
  window.rbacOpen = () => { if (!ui.loaded) refresh().catch(() => {}); else render(); };
  /** Keeps the Users page (and the user window) in step after an assignment or a role edit. */
  async function syncAccounts() {
    try { if (typeof users !== 'undefined') { users = await api('/users'); if (typeof renderUsers === 'function') renderUsers(); } } catch (_) {}
  }
  /** Shared surface for the user window and the Users table: they SHOW a role, never edit one. */
  window.SouliaRBAC = {
    ensure: () => ui.loaded ? Promise.resolve(ui.roles) : refresh().then(() => ui.roles),
    reload: () => refresh().then(() => ui.roles),
    roles: () => ui.roles,
    find: slug => ui.roles.find(item => item.slug === slug) || null,
    slugOf: account => account?.username === 'admin' ? 'super-admin' : account?.role === 'admin' ? 'admin' : (account?.roleId || ''),
    roleName, roleDescription, tierName, permName: key => name(key), permInfo: key => info(key),
    groups: () => groups.map(([key,english,arabic,keys]) => ({ key, title: label(english,arabic), keys })),
    open: slug => {
      if (typeof navigateTo === 'function') navigateTo('roles');
      const go = () => { if (!ui.roles.some(item => item.slug === slug)) return; ui.selected = slug; const item = role(); ui.original = new Set(item?.perms||[]); ui.draft = new Set(item?.perms||[]); render(); };
      ui.loaded ? go() : refresh().then(go).catch(() => {});
    },
  };
  const dialog = document.createElement('dialog'); dialog.className='rbac-dialog'; dialog.id='rbac-dialog'; document.body.append(dialog);
  function showDialog(content) { dialog.innerHTML=`<div class="rbac-dialog-inner">${content}</div>`; dialog.showModal(); }
  function closeDialog() { dialog.close(); dialog.innerHTML=''; }
  function confirmDialog(title, detail, onYes, danger=false) {
    showDialog(`<h3>${esc(title)}</h3><p>${esc(detail)}</p><div class="rbac-dialog-actions"><button class="rbac-secondary" data-close>${label('Cancel','إلغاء')}</button><button class="${danger?'rbac-danger':'rbac-primary'}" id="rbac-confirm">${danger?label('Delete','حذف'):label('Confirm','تأكيد')}</button></div>`);
    $('#rbac-confirm').onclick=async () => { const button=$('#rbac-confirm'); button.disabled=true; try { await onYes(); closeDialog(); } catch(error) { button.disabled=false; dialog.querySelector('p').textContent=error.message; } };
  }
  async function save() {
    const item=role(); if (!canEdit() || !dirty() || ui.saving) return;
    const changed=[...new Set([...ui.original,...ui.draft])].filter(key => ui.original.has(key)!==ui.draft.has(key));
    const persist=async () => { ui.saving=true; renderDetail(); try { await api('/roles/'+encodeURIComponent(item.slug),{method:'PATCH',body:JSON.stringify({perms:[...ui.draft]})}); await refresh(); syncAccounts(); status(label('Role permissions saved.','تم حفظ صلاحيات الدور.')); } catch(error) { status(error.message,true); throw error; } finally { ui.saving=false; renderDetail(); } };
    // A role edit changes access for everyone on it, so it names them before saving.
    const holders=(item.users||[]).map(user=>user.name||user.username);
    if (changed.some(key => sensitive.has(key)) || holders.length) confirmDialog(
      changed.some(key => sensitive.has(key)) ? label('Confirm sensitive access change','تأكيد تغيير صلاحيات حساسة') : label('Update this role','تحديث الدور'),
      holders.length ? `${count(holders.length)} ${label('accounts get the new access now: ','حسابًا ستُطبَّق عليها الصلاحيات الجديدة فورًا: ')}${holders.join('، ')}` : label('This updates access for every user assigned to this role.','سيُحدّث هذا وصول كل مستخدم معيّن لهذا الدور.'),
      persist);
    else await persist().catch(() => {});
  }
  function form(item) {
    const creating=!item;
    showDialog(`<h3>${creating?label('Create new role','إنشاء دور جديد'):label('Edit role','تعديل الدور')}</h3><p>${label('Use a clear name and describe the responsibility.','اختر اسمًا واضحًا ووصفًا للمسؤولية.')}</p>
      <form id="rbac-form"><label>${label('Role name','اسم الدور')}<input name="name" required minlength="2" maxlength="60" value="${esc(item?.name||'')}"></label><label>${label('Description','الوصف')}<textarea name="description" maxlength="240">${esc(item?.description||'')}</textarea></label><label>${label('Access tier','مستوى الوصول')}<select name="baseRole"><option value="staff" ${item?.baseRole==='staff'?'selected':''}>${label('Staff','موظف')}</option><option value="viewer" ${item?.baseRole==='viewer'?'selected':''}>${label('Viewer','مشاهد')}</option></select></label>
      <div class="rbac-dialog-actions"><button class="rbac-secondary" type="button" data-close>${label('Cancel','إلغاء')}</button><button class="rbac-primary" type="submit">${creating?label('Create role','إنشاء الدور'):label('Save details','حفظ التفاصيل')}</button></div></form>`);
    $('#rbac-form').onsubmit=async event => { event.preventDefault(); const button=dialog.querySelector('[type="submit"]'); button.disabled=true;
      const data=Object.fromEntries(new FormData(event.currentTarget)); if (creating) data.perms=[];
      try { const result=await api(creating?'/roles':'/roles/'+encodeURIComponent(item.slug),{method:creating?'POST':'PATCH',body:JSON.stringify(data)}); closeDialog(); if (creating) ui.selected=result.slug; await refresh(); status(creating?label('Role created. Choose its permissions and assign users.','تم إنشاء الدور. اختر صلاحياته وعيّن المستخدمين.'):label('Role details saved.','تم حفظ تفاصيل الدور.')); }
      catch(error) { button.disabled=false; dialog.querySelector('p').textContent=error.message; }
    };
  }
  function currentRoleLabel(user) {
    const slug=window.SouliaRBAC.slugOf(user); const found=slug&&ui.roles.find(item=>item.slug===slug);
    return found ? roleName(found) : label('no role','بدون دور');
  }
  /** Dry run first: every account, the role it lands on, and what changes (nothing is lost). */
  async function migrate() {
    showDialog(`<h3>${label('Move accounts onto roles','نقل الحسابات إلى أدوار')}</h3><p>${label('Checking…','جارٍ الفحص…')}</p>`);
    try {
      const plan=await api('/roles/migrate-legacy',{method:'POST',body:JSON.stringify({dryRun:true})});
      const roleCell=row=>{
        if (row.action==='skip') return `<span class="rbac-quiet-note">${row.reason==='inactive'?label('Disabled — left as it is; give it a role when you enable it','معطّل — سيبقى كما هو؛ عيّن له دورًا عند تفعيله'):label('No permissions — stays without a role','بلا صلاحيات — سيبقى بلا دور')}</span>`;
        const known=ui.roles.find(item=>item.slug===row.role.slug);
        return row.action==='create' ? `${label('New role: ','دور جديد: ')}<strong>${esc(row.role.name)}</strong>` : `<strong>${esc(roleName(known||row.role))}</strong>`;
      };
      const permCell=row=>row.action==='skip'?'—':`${count(row.after.length)}${row.added?.length?` <small class="rbac-added" title="${esc(row.added.map(name).join('، '))}">+${count(row.added.length)} ${label('equivalent','مكافئة')}</small>`:''}${row.dropped?.length?` <small class="rbac-dropped" title="${esc(row.dropped.join(', '))}">${count(row.dropped.length)} ${label('not grantable','غير قابلة للمنح')}</small>`:''}`;
      const rows=plan.users.map(row=>`<tr><td><strong>${esc(row.name||row.username)}</strong><small>@${esc(row.username)}</small></td><td>${roleCell(row)}</td><td>${permCell(row)}</td></tr>`).join('');
      dialog.innerHTML=`<div class="rbac-dialog-inner rbac-migrate"><h3>${label('Move accounts onto roles','نقل الحسابات إلى أدوار')}</h3>
        <p>${label('Each account joins the role that has exactly its permissions; where none exists a role is created for it. Nobody gains or loses access: product and supplier edit keys are added only where the account already used those screens.','يُنقل كل حساب إلى الدور الذي تطابق صلاحياته صلاحيات الحساب تمامًا، وإن لم يوجد يُنشأ له دور. لن يكسب أحد صلاحية أو يفقدها: تُضاف مفاتيح تعديل الأصناف والموردين فقط للحسابات التي كانت تستخدم هذه الشاشات.')}</p>
        <div style="overflow-x:auto"><table class="rbac-users-table"><thead><tr><th>${label('Employee','الموظف')}</th><th>${label('Role','الدور')}</th><th>${label('Permissions','الصلاحيات')}</th></tr></thead><tbody>${rows}</tbody></table></div>
        ${plan.createdRoles.length?`<p class="rbac-quiet-note">${count(plan.createdRoles.length)} ${label('new roles will be created — rename or merge them afterwards.','دورًا جديدًا سيُنشأ — يمكنك تغيير أسمائها أو دمجها لاحقًا.')}</p>`:''}
        <div class="rbac-dialog-actions"><button class="rbac-secondary" data-close>${label('Cancel','إلغاء')}</button><button class="rbac-primary" id="rbac-migrate-go" ${plan.users.some(row=>row.action!=='skip')?'':'disabled'}>${label('Move accounts','نقل الحسابات')}</button></div></div>`;
      $('#rbac-migrate-go').onclick=async()=>{ const button=$('#rbac-migrate-go'); button.disabled=true;
        try { const done=await api('/roles/migrate-legacy',{method:'POST',body:JSON.stringify({dryRun:false})}); closeDialog(); await refresh(); syncAccounts(); status(`${count(done.moved)} ${label('accounts moved onto roles.','حسابًا نُقل إلى أدوار.')}`); }
        catch(error) { button.disabled=false; dialog.querySelector('p').textContent=error.message; } };
    } catch(error) { const p=dialog.querySelector('p'); if (p) p.textContent=error.message; }
  }
  async function assign(slug) {
    try {
      if (!ui.users) ui.users=await api('/users');
      const assigned=new Set(role()?.users?.map(user => user.id)||[]);
      const me=String((typeof currentUser!=='undefined'&&(currentUser?._id||currentUser?.id))||'');
      const candidates=ui.users.filter(user => user.username!=='admin'&&!assigned.has(String(user._id))&&String(user._id)!==me);
      showDialog(`<h3>${label('Assign user','تعيين مستخدم')}</h3><p>${label('The selected role replaces the user’s current permission grants.','سيحل هذا الدور محل صلاحيات المستخدم الحالية.')}</p>${candidates.length?`<form id="rbac-assign-form"><label>${label('Employee','الموظف')}<select name="userId">${candidates.map(user => `<option value="${esc(user._id)}">${esc(user.name)} (@${esc(user.username)}) — ${esc(currentRoleLabel(user))}</option>`).join('')}</select></label><div class="rbac-dialog-actions"><button class="rbac-secondary" type="button" data-close>${label('Cancel','إلغاء')}</button><button class="rbac-primary" type="submit">${label('Assign','تعيين')}</button></div></form>`:`<div class="rbac-empty">${label('No available users.','لا يوجد مستخدمون متاحون.')}</div><div class="rbac-dialog-actions"><button class="rbac-secondary" data-close>${label('Close','إغلاق')}</button></div>`}`);
      const formEl=$('#rbac-assign-form'); if (formEl) formEl.onsubmit=async event => { event.preventDefault(); const button=formEl.querySelector('[type="submit"]'); button.disabled=true; try { await api('/roles/'+encodeURIComponent(slug)+'/assign',{method:'POST',body:JSON.stringify({userId:new FormData(formEl).get('userId')})}); ui.users=null; closeDialog(); await refresh(); syncAccounts(); status(label('User assigned.','تم تعيين المستخدم.')); } catch(error) { button.disabled=false; dialog.querySelector('p').textContent=error.message; } };
    } catch(error) { status(error.message,true); }
  }
  $('#rbac-root').addEventListener('input', event => { if (event.target.id==='rbac-search') { const start=event.target.selectionStart; ui.search=event.target.value; renderDetail(); const input=$('#rbac-search'); input.focus(); input.setSelectionRange(start,start); } });
  $('#rbac-root').addEventListener('change', event => {
    const target=event.target;
    if (target.dataset.perm) { target.checked?ui.draft.add(target.dataset.perm):ui.draft.delete(target.dataset.perm); reconcile(target.dataset.perm,target.checked); syncGrantUI(); }
    else if (target.dataset.moduleAll) { const group=groups.find(item=>item[0]===target.dataset.moduleAll); group?.[3].filter(editablePermission).forEach(key=>target.checked?ui.draft.add(key):ui.draft.delete(key)); reconcile(); syncGrantUI(); }
    else if (target.id==='rbac-all') { groups.flatMap(group=>group[3]).filter(editablePermission).forEach(key=>target.checked?ui.draft.add(key):ui.draft.delete(key)); reconcile(); syncGrantUI(); }
  });
  /* ⓘ popover: one element on <body>; Escape / outside click / scroll close it. The button sits inside
     the row's <label>, so its click must never reach the checkbox. */
  const tip = document.createElement('div'); tip.className='rbac-tip'; tip.setAttribute('role','tooltip'); tip.id='rbac-tip'; tip.hidden=true; document.body.append(tip);
  let tipFor = null, tipAt = {top:0,left:0};
  function closeTip(focusBack) { if (tip.hidden) return; tip.hidden=true; if (tipFor) { tipFor.setAttribute('aria-expanded','false'); tipFor.removeAttribute('aria-describedby'); if (focusBack) tipFor.focus(); } tipFor=null; }
  function openTip(btn) {
    const key=btn.dataset.info; if (tipFor===btn) { closeTip(); return; } closeTip();
    tip.dir = en() ? 'ltr' : 'rtl';
    tip.innerHTML = `<div class="rbac-tip-head"><strong>${esc(name(key))}</strong><span class="rbac-action-tag">${esc(action(key))}</span></div><p>${esc(info(key))}</p>${sensitive.has(key)?`<p class="rbac-tip-warn">${esc(label('Sensitive: saving asks for confirmation.','صلاحية حساسة: يُطلب تأكيد عند الحفظ.'))}</p>`:''}<code>${esc(key)}</code>`;
    tip.hidden=false; tipFor=btn; btn.setAttribute('aria-expanded','true'); btn.setAttribute('aria-describedby','rbac-tip');
    const r=btn.getBoundingClientRect(), w=Math.min(320, innerWidth-16);
    tip.style.width=w+'px';
    let left = en() ? r.left - 8 : r.right - w + 8;
    left=Math.max(8, Math.min(left, innerWidth - w - 8));
    let top=r.bottom+6; const h=tip.offsetHeight;
    if (top+h > innerHeight-8 && r.top-h-6 > 8) top=r.top-h-6;
    tip.style.left=left+'px'; tip.style.top=top+'px';
    tipAt={top:r.top,left:r.left};
  }
  document.addEventListener('mousedown', event => { if (!tip.hidden && !tip.contains(event.target) && !event.target.closest('.rbac-info')) closeTip(); }, true);
  document.addEventListener('keydown', event => { if (event.key==='Escape' && !tip.hidden) { event.stopPropagation(); closeTip(true); } }, true);
  // Close on scroll only when the anchor really moved: a click that scrolls its row into view
  // delivers that scroll event after the popover opened.
  addEventListener('scroll', () => { if (!tipFor) return; const r=tipFor.getBoundingClientRect(); if (Math.abs(r.top-tipAt.top)>2||Math.abs(r.left-tipAt.left)>2) closeTip(); }, true);
  addEventListener('resize', () => closeTip());
  $('#rbac-root').addEventListener('click', event => {
    const target=event.target.closest('button'); if (!target) return;
    if (target.dataset.info) { event.preventDefault(); event.stopPropagation(); openTip(target); return; }
    if (target.dataset.role) select(target.dataset.role);
    else if (target.dataset.expand) { const key=target.dataset.expand; ui.expanded.has(key)?ui.expanded.delete(key):ui.expanded.add(key); const module=target.closest('.rbac-module'); module.classList.toggle('is-open',ui.expanded.has(key)); target.setAttribute('aria-expanded',String(ui.expanded.has(key))); }
    else if (target.id==='rbac-expand-all') { ui.expanded=ui.expanded.size===groups.length?new Set():new Set(groups.map(group=>group[0])); document.querySelectorAll('#rbac-detail .rbac-module').forEach(module=>{const open=ui.expanded.has(module.dataset.module);module.classList.toggle('is-open',open);module.querySelector('[data-expand]').setAttribute('aria-expanded',String(open));});target.textContent=ui.expanded.size===groups.length?label('Collapse all','طي الكل'):label('Expand all','توسيع الكل'); }
    else if (target.id==='rbac-create') form(null);
    else if (target.id==='rbac-migrate') migrate();
    else if (target.id==='rbac-refresh') { if (!dirty() || confirm(label('Discard unsaved changes and refresh?','تجاهل التغييرات غير المحفوظة وتحديث الصفحة؟'))) refresh().catch(()=>{}); }
    else if (target.id==='rbac-retry') refresh().catch(()=>{});
    else if (target.dataset.edit) form(ui.roles.find(item=>item.slug===target.dataset.edit));
    else if (target.dataset.delete) { const item=ui.roles.find(role=>role.slug===target.dataset.delete); confirmDialog(label('Delete role','حذف الدور'),label('This role can only be deleted when no users are assigned.','يمكن حذف الدور فقط بعد إزالة جميع المستخدمين المعيّنين له.'),async()=>{ await api('/roles/'+encodeURIComponent(item.slug),{method:'DELETE'}); await refresh(); status(label('Role deleted.','تم حذف الدور.')); },true); }
    else if (target.dataset.assign) assign(target.dataset.assign);
    else if (target.dataset.unassign) { const item=role(); confirmDialog(label('Remove user from role','إزالة مستخدم من الدور'),label('The account will have no role and no access until it is assigned another role.','سيبقى الحساب بلا دور ولا صلاحيات حتى تعيّنه لدور آخر.'),async()=>{ await api('/roles/'+encodeURIComponent(item.slug)+'/unassign',{method:'POST',body:JSON.stringify({userId:target.dataset.unassign})}); ui.users=null; await refresh(); syncAccounts(); status(label('User removed from role.','تمت إزالة المستخدم من الدور.')); }); }
    else if (target.id==='rbac-discard') { ui.draft=new Set(ui.original); syncGrantUI(); }
    else if (target.id==='rbac-save') save();
  });
  dialog.addEventListener('click', event => { if (event.target.closest('[data-close]')) closeDialog(); });
  if (typeof currentPage !== 'undefined' && currentPage==='roles') queueMicrotask(()=>window.rbacOpen());
})();
