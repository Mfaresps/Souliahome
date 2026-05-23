/**
 * Shared city normalisation utility.
 * Maps any Arabic/English city variant → the Bosta-accepted English city name.
 * Used by both bosta.service.ts (before sending) and shopify.service.ts (on ingest).
 *
 * Shopify Governorate dropdown values (exact strings):
 *   6th of October | Al Sharqia | Alexandria | Aswan | Asyut | Beheira | Beni Suef
 *   Cairo | Dakahlia | Damietta | Faiyum | Gharbia | Giza | Helwan | Ismailia
 *   Kafr el-Sheikh | Luxor | Matrouh | Minya | Monufia | New Valley | North Sinai
 *   Port Said | Qalyubia | Qena | Red Sea | Sohag | South Sinai | Suez
 */

export const CITY_MAP: Record<string, string> = {

  // ═══════════════════════════════════════════════════════════
  // Shopify Governorate exact values → Bosta city name
  // (these are the strings Shopify sends in shipping_address.province)
  // ═══════════════════════════════════════════════════════════
  '6th of october':  'Giza',          // شوبيفاي يرسلها كـ province = Giza عند بوسطة
  'al sharqia':      'Sharqia',
  'alexandria':      'Alexandria',
  'aswan':           'Aswan',
  'asyut':           'Assuit',
  'beheira':         'Behira',
  'beni suef':       'Bani Suif',
  'cairo':           'Cairo',
  'dakahlia':        'Dakahlia',
  'damietta':        'Damietta',
  'faiyum':          'Fayoum',
  'gharbia':         'Gharbia',
  'giza':            'Giza',
  'helwan':          'Cairo',         // حلوان = Cairo عند بوسطة
  'ismailia':        'Ismailia',
  'kafr el-sheikh':  'Kafr Alsheikh',
  'kafr el sheikh':  'Kafr Alsheikh',
  'luxor':           'Luxor',
  'matrouh':         'Matrouh',
  'minya':           'Menya',
  'monufia':         'Monufia',
  'new valley':      'New Valley',
  'north sinai':     'North Sinai',
  'port said':       'Port Said',
  'qalyubia':        'El Kalioubia',
  'qena':            'Qena',
  'red sea':         'Red Sea',
  'sohag':           'Sohag',
  'south sinai':     'South Sinai',
  'suez':            'Suez',

  // ═══════════════════════════════════════════════════════════
  // Shopify city field variants (addr.city) — common spellings
  // ═══════════════════════════════════════════════════════════
  // Cairo neighbourhoods
  'new cairo':          'Cairo',
  'new cairo city':     'Cairo',
  'nasr city':          'Cairo',
  'maadi':              'Cairo',
  'el maadi':           'Cairo',
  'shubra':             'Cairo',
  'heliopolis':         'Cairo',
  'zamalek':            'Cairo',
  'masr el gedida':     'Cairo',
  'masr el-gedida':     'Cairo',
  'el marg':            'Cairo',
  'el mataria':         'Cairo',
  'ain shams':          'Cairo',
  'el zeitoun':         'Cairo',
  'el mokatam':         'Cairo',
  'el rehab':           'Cairo',
  'madinaty':           'Cairo',
  'el shorouk':         'Cairo',
  'shorouk city':       'Cairo',
  'badr city':          'Cairo',
  'el obour':           'Cairo',
  'obour city':         'Cairo',
  // Giza neighbourhoods
  'giza city':          'Giza',
  'al giza':            'Giza',
  'al-giza':            'Giza',
  'dokki':              'Giza',
  'mohandeseen':        'Giza',
  'mohandessin':        'Giza',
  'agouza':             'Giza',
  'imbaba':             'Giza',
  'el haram':           'Giza',
  'haram':              'Giza',
  '6th october':        'Giza',
  'sixth of october':   'Giza',
  'october':            'Giza',
  'sheikh zayed':       'Giza',
  'sheikh zayed city':  'Giza',
  'october city':       'Giza',
  'hadayek october':    'Giza',
  'faisal':             'Giza',
  'boulak dakrour':     'Giza',
  // Alexandria
  'alex':               'Alexandria',
  'el montaza':         'Alexandria',
  'el agamy':           'Alexandria',
  'sidi bishr':         'Alexandria',
  'smoha':              'Alexandria',
  'mahram bek':         'Alexandria',
  'el raml':            'Alexandria',
  'sidi gaber':         'Alexandria',
  'mandara':            'Alexandria',
  'abu qir':            'Alexandria',
  'stanley':            'Alexandria',
  'cleopatra':          'Alexandria',
  'mamoura':            'Alexandria',
  'el dekhela':         'Alexandria',
  'el laban':           'Alexandria',
  'el amiriya':         'Alexandria',
  'borg el arab':       'Alexandria',
  // Dakahlia
  'el mansoura':        'Dakahlia',
  'mansoura':           'Dakahlia',
  'talkha':             'Dakahlia',
  'mit ghamr':          'Dakahlia',
  // Gharbia
  'tanta':              'Gharbia',
  'el mahalla':         'Gharbia',
  'mahalla':            'Gharbia',
  'el mahalla el kubra':'Gharbia',
  // Sharqia
  'el zagazig':         'Sharqia',
  'zagazig':            'Sharqia',
  'belbeis':            'Sharqia',
  'sharqia':            'Sharqia',
  'al-sharqia':         'Sharqia',
  // El Kalioubia
  'qaliubiya':          'El Kalioubia',
  'qalubiya':           'El Kalioubia',
  'banha':              'El Kalioubia',
  'benha':              'El Kalioubia',
  'qalyub':             'El Kalioubia',
  'shubra el kheima':   'El Kalioubia',
  'shubra el-kheima':   'El Kalioubia',
  'khanka':             'El Kalioubia',
  // Beheira
  'el beheira':         'Behira',
  'damanhur':           'Behira',
  'kafr el dawar':      'Behira',
  'rashid':             'Behira',
  // Monufia
  'menoufia':           'Monufia',
  'shebin el kom':      'Monufia',
  'shebin el-kom':      'Monufia',
  // Damietta
  'el damietta':        'Damietta',
  'new damietta':       'Damietta',
  // Ismailia
  'el ismailia':        'Ismailia',
  // Bani Suif
  'beni-suef':          'Bani Suif',
  'bani suef':          'Bani Suif',
  // Menya
  'el minya':           'Menya',
  'menia':              'Menya',
  // Assuit
  'assiut':             'Assuit',
  'assiout':            'Assuit',
  // Sohag
  'el sohag':           'Sohag',
  // Qena
  'el qena':            'Qena',
  'nag hammadi':        'Qena',
  // Luxor
  'el luxor':           'Luxor',
  // Aswan
  'el aswan':           'Aswan',
  // Red Sea
  'hurghada':           'Red Sea',
  'el gouna':           'Red Sea',
  'safaga':             'Red Sea',
  'marsa alam':         'Red Sea',
  'el quseir':          'Red Sea',
  // South Sinai
  'sharm el sheikh':    'South Sinai',
  'sharm el-sheikh':    'South Sinai',
  'dahab':              'South Sinai',
  'nuweiba':            'South Sinai',
  'taba':               'South Sinai',
  'el tor':             'South Sinai',
  'saint catherine':    'South Sinai',
  // North Sinai
  'arish':              'North Sinai',
  'el arish':           'North Sinai',
  'rafah':              'North Sinai',
  // Matrouh
  'marsa matrouh':      'Matrouh',
  'el alamein':         'Matrouh',
  'north coast':        'North Coast',
  // New Valley
  'kharga':             'New Valley',
  'dakhla':             'New Valley',

  // ═══════════════════════════════════════════════
  // Arabic names (manual entry & legacy data)
  // ═══════════════════════════════════════════════
  'القاهرة': 'Cairo', 'قاهرة': 'Cairo',
  'وسط البلد': 'Cairo', 'العتبة': 'Cairo', 'الأزهر': 'Cairo',
  'باب الشعرية': 'Cairo', 'الموسكي': 'Cairo', 'الخليفة': 'Cairo',
  'السيدة زينب': 'Cairo', 'مصر القديمة': 'Cairo', 'الفسطاط': 'Cairo',
  'شبرا': 'Cairo', 'روض الفرج': 'Cairo', 'الشرابية': 'Cairo',
  'السواح': 'Cairo', 'المرج': 'Cairo', 'عزبة النخل': 'Cairo',
  'المطرية القاهرة': 'Cairo', 'عين شمس': 'Cairo', 'الزيتون': 'Cairo',
  'الوايلي': 'Cairo', 'ألماظة': 'Cairo', 'مصر الجديدة': 'Cairo',
  'هليوبوليس': 'Cairo', 'مدينة نصر': 'Cairo', 'النزهة القاهرة': 'Cairo',
  'البساتين': 'Cairo', 'دار السلام القاهرة': 'Cairo', 'منشأة ناصر': 'Cairo',
  'التجمع الأول': 'Cairo', 'التجمع الخامس': 'Cairo', 'التجمع': 'Cairo',
  'المقطم': 'Cairo', 'المعادي': 'Cairo', 'حلوان': 'Cairo',
  'طرة': 'Cairo', 'المعصرة': 'Cairo', 'القطامية': 'Cairo',
  'القاهرة الجديدة': 'Cairo', 'الرحاب': 'Cairo', 'مدينتي': 'Cairo',
  'الشروق': 'Cairo', 'مدينة الشروق': 'Cairo', 'مدينة بدر': 'Cairo',
  'بدر': 'Cairo', 'بدر سيتي': 'Cairo', 'العبور': 'Cairo', 'مدينة العبور': 'Cairo',
  'بساتين': 'Cairo', 'عمارات': 'Cairo', 'مدينة السلام': 'Cairo',
  'زهراء مدينة نصر': 'Cairo', 'ميدان التحرير': 'Cairo', 'قصر النيل': 'Cairo',
  'بولاق': 'Cairo', 'الدراسة': 'Cairo', 'الأميرية': 'Cairo', 'منيل الروضة': 'Cairo',
  'الخصوص القاهرة': 'Cairo',
  'العاشر من رمضان': 'Sharqia', '١٠ رمضان': 'Sharqia', '10 رمضان': 'Sharqia',
  '10th of ramadan': 'Sharqia', '10th ramadan': 'Sharqia',

  'الجيزة': 'Giza', 'جيزة': 'Giza',
  'الدقي': 'Giza', 'المهندسين': 'Giza', 'العجوزة': 'Giza',
  'إمبابة': 'Giza', 'فيصل الجيزة': 'Giza', 'الهرم': 'Giza',
  'أكتوبر': 'Giza', '٦ أكتوبر': 'Giza', '6 أكتوبر': 'Giza',
  'سادس أكتوبر': 'Giza', 'مدينة 6 أكتوبر': 'Giza',
  'الشيخ زايد': 'Giza', 'حدائق أكتوبر': 'Giza',
  'الحوامدية': 'Giza', 'البدرشين': 'Giza', 'الصف': 'Giza',
  'أطفيح': 'Giza', 'كرداسة': 'Giza', 'أبو النمرس': 'Giza',
  'العياط': 'Giza', 'البراجيل': 'Giza', 'الوراق': 'Giza',
  'أوسيم': 'Giza', 'كفر الجبل': 'Giza', 'المريوطية': 'Giza',
  'بولاق الدكرور': 'Giza', 'الدكرور': 'Giza', 'منشأة القناطر': 'Giza',
  'أبو رواش': 'Giza', 'الجيزة الجديدة': 'Giza', 'الرماية': 'Giza',
  'شبرامنت': 'Giza', 'المنيب': 'Giza',

  'الإسكندرية': 'Alexandria', 'اسكندرية': 'Alexandria', 'إسكندرية': 'Alexandria',
  'المنتزه': 'Alexandria', 'العجمي': 'Alexandria', 'سيدي بشر': 'Alexandria',
  'سموحة': 'Alexandria', 'محرم بك': 'Alexandria', 'الرمل': 'Alexandria',
  'سيدي جابر': 'Alexandria', 'الإبراهيمية الإسكندرية': 'Alexandria',
  'المندرة': 'Alexandria', 'أبو قير': 'Alexandria', 'ستانلي': 'Alexandria',
  'كليوباترا': 'Alexandria', 'المعمورة': 'Alexandria', 'الدخيلة': 'Alexandria',
  'اللبان': 'Alexandria', 'العامرية': 'Alexandria', 'برج العرب': 'Alexandria',
  'مدينة برج العرب': 'Alexandria', 'بيجام': 'Alexandria',
  'النزهة الإسكندرية': 'Alexandria', 'الجمرك': 'Alexandria',
  'المازة': 'Alexandria', 'المفروزة': 'Alexandria', 'كرموز': 'Alexandria',
  'باب شرق': 'Alexandria', 'وابور المياه': 'Alexandria', 'الأزاريطة': 'Alexandria',

  'الدقهلية': 'Dakahlia', 'دقهلية': 'Dakahlia',
  'المنصورة': 'Dakahlia', 'منصورة': 'Dakahlia', 'طلخا': 'Dakahlia',
  'ميت غمر': 'Dakahlia', 'دكرنس': 'Dakahlia', 'أجا': 'Dakahlia',
  'منية النصر': 'Dakahlia', 'السنبلاوين': 'Dakahlia',
  'الجمالية الدقهلية': 'Dakahlia', 'تمي الأمديد': 'Dakahlia',
  'بني عبيد': 'Dakahlia', 'المطرية الدقهلية': 'Dakahlia',
  'شربين': 'Dakahlia', 'بلقاس': 'Dakahlia',

  'الغربية': 'Gharbia', 'غربية': 'Gharbia',
  'طنطا': 'Gharbia', 'المحلة الكبرى': 'Gharbia', 'المحلة': 'Gharbia',
  'كفر الزيات': 'Gharbia', 'زفتى': 'Gharbia', 'السنطة': 'Gharbia',
  'قطور': 'Gharbia', 'بسيون': 'Gharbia', 'سمنود': 'Gharbia',

  'الشرقية': 'Sharqia', 'شرقية': 'Sharqia',
  'الزقازيق': 'Sharqia', 'زقازيق': 'Sharqia', 'بلبيس': 'Sharqia',
  'منيا القمح': 'Sharqia', 'ههيا': 'Sharqia', 'أبو كبير': 'Sharqia',
  'فاقوس': 'Sharqia', 'الصالحية الجديدة': 'Sharqia',
  'القنايات': 'Sharqia', 'أبو حماد': 'Sharqia', 'كفر صقر': 'Sharqia',
  'الإبراهيمية الشرقية': 'Sharqia', 'ديرب نجم': 'Sharqia',

  'القليوبية': 'El Kalioubia', 'قليوبية': 'El Kalioubia',
  'شبرا الخيمة': 'El Kalioubia', 'بنها': 'El Kalioubia',
  'القناطر الخيرية': 'El Kalioubia', 'القناطر': 'El Kalioubia',
  'كفر شكر': 'El Kalioubia', 'طوخ': 'El Kalioubia', 'قليوب': 'El Kalioubia',
  'شبين القناطر': 'El Kalioubia', 'الخانكة': 'El Kalioubia',
  'الخصوص': 'El Kalioubia', 'تلا القليوبية': 'El Kalioubia', 'أبو زعبل': 'El Kalioubia',

  'البحيرة': 'Behira', 'بحيرة': 'Behira',
  'دمنهور': 'Behira', 'كفر الدوار': 'Behira', 'رشيد': 'Behira',
  'إيتاي البارود': 'Behira', 'أبو حمص': 'Behira', 'الدلنجات': 'Behira',
  'شبراخيت': 'Behira', 'المحمودية': 'Behira', 'حوش عيسى': 'Behira',
  'الرحمانية': 'Behira', 'وادي النطرون': 'Behira', 'أبو المطامير': 'Behira',
  'النوبارية': 'Behira', 'العطف': 'Behira',

  'المنوفية': 'Monufia', 'منوفية': 'Monufia',
  'شبين الكوم': 'Monufia', 'منوف': 'Monufia', 'أشمون': 'Monufia',
  'الباجور': 'Monufia', 'قويسنا': 'Monufia', 'بركة السبع': 'Monufia',
  'تلا المنوفية': 'Monufia', 'الشهداء': 'Monufia', 'سرس الليان': 'Monufia',

  'كفر الشيخ': 'Kafr Alsheikh', 'كفرالشيخ': 'Kafr Alsheikh',
  'دسوق': 'Kafr Alsheikh', 'فوه': 'Kafr Alsheikh', 'مطوبس': 'Kafr Alsheikh',
  'قلين': 'Kafr Alsheikh', 'بلطيم': 'Kafr Alsheikh', 'بيلا': 'Kafr Alsheikh',
  'سيدي سالم': 'Kafr Alsheikh', 'الحامول': 'Kafr Alsheikh', 'برج البرلس': 'Kafr Alsheikh',

  'دمياط': 'Damietta', 'فارسكور': 'Damietta', 'الزرقا': 'Damietta',
  'كفر سعد': 'Damietta', 'رأس البر': 'Damietta', 'عزبة البرج': 'Damietta',
  'دمياط الجديدة': 'Damietta',

  'الإسماعيلية': 'Ismailia', 'الاسماعيلية': 'Ismailia',
  'إسماعيلية': 'Ismailia', 'اسماعيلية': 'Ismailia',
  'القنطرة': 'Ismailia', 'القنطرة شرق': 'Ismailia', 'القنطرة غرب': 'Ismailia',
  'التل الكبير': 'Ismailia', 'أبو صوير': 'Ismailia',

  'بورسعيد': 'Port Said', 'بور سعيد': 'Port Said', 'بور فؤاد': 'Port Said',

  'السويس': 'Suez', 'سويس': 'Suez',
  'عتاقة': 'Suez', 'الجناين': 'Suez', 'فيصل السويس': 'Suez',

  'الفيوم': 'Fayoum', 'فيوم': 'Fayoum',
  'سنورس': 'Fayoum', 'إطسا': 'Fayoum', 'طامية': 'Fayoum',
  'يوسف الصديق': 'Fayoum', 'الحادقة': 'Fayoum', 'أبشواي': 'Fayoum',

  'بني سويف': 'Bani Suif', 'بنى سويف': 'Bani Suif', 'بنيسويف': 'Bani Suif',
  'الواسطى': 'Bani Suif', 'إهناسيا': 'Bani Suif', 'ببا': 'Bani Suif',
  'الفشن': 'Bani Suif', 'سمسطا': 'Bani Suif', 'أبو الريش': 'Bani Suif',

  'المنيا': 'Menya', 'منيا': 'Menya',
  'أبو قرقاص': 'Menya', 'ملوي': 'Menya', 'المنيا الجديدة': 'Menya',
  'مغاغة': 'Menya', 'بني مزار': 'Menya', 'مطاي': 'Menya',
  'سمالوط': 'Menya', 'دير مواس': 'Menya',

  'أسيوط': 'Assuit', 'اسيوط': 'Assuit',
  'ديروط': 'Assuit', 'القوصية': 'Assuit', 'منفلوط': 'Assuit',
  'أبنوب': 'Assuit', 'أبو تيج': 'Assuit', 'ساحل سليم': 'Assuit',
  'البداري': 'Assuit', 'صدفا': 'Assuit',

  'سوهاج': 'Sohag',
  'أخميم': 'Sohag', 'طهطا': 'Sohag', 'جرجا': 'Sohag',
  'دار السلام سوهاج': 'Sohag', 'جهينة': 'Sohag', 'المراغة': 'Sohag',
  'المنشأة': 'Sohag', 'البلينا': 'Sohag', 'ساقلته': 'Sohag',

  'قنا': 'Qena',
  'نجع حمادي': 'Qena', 'دشنا': 'Qena', 'قوص': 'Qena',
  'أبو تشت': 'Qena', 'نقادة': 'Qena', 'فرشوط': 'Qena',
  'الوقف': 'Qena', 'قفط': 'Qena',

  'الأقصر': 'Luxor', 'أقصر': 'Luxor',
  'إسنا': 'Luxor', 'الأرمنت': 'Luxor',

  'أسوان': 'Aswan', 'اسوان': 'Aswan',
  'كوم أمبو': 'Aswan', 'إدفو': 'Aswan', 'نصر النوبة': 'Aswan',
  'دراو': 'Aswan', 'أبو سمبل': 'Aswan',

  'البحر الأحمر': 'Red Sea', 'بحر أحمر': 'Red Sea',
  'الغردقة': 'Red Sea', 'غردقة': 'Red Sea',
  'سفاجا': 'Red Sea', 'القصير': 'Red Sea',
  'مرسى علم': 'Red Sea', 'رأس غارب': 'Red Sea', 'الزعفرانة': 'Red Sea',

  'شرم الشيخ': 'South Sinai', 'شرم': 'South Sinai',
  'جنوب سيناء': 'South Sinai', 'سيناء': 'South Sinai',
  'دهب': 'South Sinai', 'نويبع': 'South Sinai', 'طابا': 'South Sinai',
  'أبو رديس': 'South Sinai', 'الطور': 'South Sinai', 'سانت كاترين': 'South Sinai',

  'شمال سيناء': 'North Sinai',
  'العريش': 'North Sinai', 'رفح': 'North Sinai',
  'الشيخ زويد': 'North Sinai', 'بئر العبد': 'North Sinai',
  'الحسنة': 'North Sinai', 'نخل': 'North Sinai',

  'مطروح': 'Matrouh', 'مرسى مطروح': 'Matrouh', 'مرسي مطروح': 'Matrouh',
  'الضبعة': 'Matrouh', 'السلوم': 'Matrouh', 'سيوة': 'Matrouh',
  'الحمام': 'Matrouh', 'العلمين': 'Matrouh',
  'الساحل الشمالي': 'North Coast', 'ساحل شمالي': 'North Coast',
  'الساحل': 'North Coast', 'مارينا': 'North Coast', 'هاسيندا باي': 'North Coast',

  'الوادي الجديد': 'New Valley', 'وادي جديد': 'New Valley',
  'الخارجة': 'New Valley', 'الداخلة': 'New Valley',
  'الفرافرة': 'New Valley',
};

export function stripTashkeel(s: string): string {
  return s.replace(/[ؐ-ًؚ-ٰٟۖ-ۜ۟-۪ۤۧۨ-ۭـ]/g, '');
}

export function normalizeCity(raw: string): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  // 1. Exact match
  if (CITY_MAP[trimmed]) return CITY_MAP[trimmed];
  // 2. Case-insensitive match (covers Shopify province values: "Al Sharqia", "Kafr el-Sheikh"...)
  const lower = trimmed.toLowerCase();
  if (CITY_MAP[lower]) return CITY_MAP[lower];
  // 3. Strip tashkeel then match
  const stripped = stripTashkeel(trimmed);
  if (CITY_MAP[stripped]) return CITY_MAP[stripped];
  // 4. First word — handles "الدقهلية — المنصورة" and "Cairo Nasr City" style inputs
  const firstWord = trimmed.split(/[\s\-—–،,\/]+/)[0];
  if (firstWord && firstWord !== trimmed) {
    if (CITY_MAP[firstWord]) return CITY_MAP[firstWord];
    if (CITY_MAP[firstWord.toLowerCase()]) return CITY_MAP[firstWord.toLowerCase()];
    if (CITY_MAP[stripTashkeel(firstWord)]) return CITY_MAP[stripTashkeel(firstWord)];
  }
  // 5. startsWith — "الإسكندرية سيدي جابر" → Alexandria
  // Only run on short inputs (≤40 chars) to avoid false-positives on full address strings
  if (trimmed.length <= 40) {
    const strippedLower = stripTashkeel(trimmed).toLowerCase();
    for (const [key, val] of Object.entries(CITY_MAP)) {
      const k = key.toLowerCase();
      if (lower.startsWith(k) || strippedLower.startsWith(stripTashkeel(key).toLowerCase())) return val;
    }
    // 6. Substring fallback — also length-gated to prevent address strings from matching city names
    for (const [key, val] of Object.entries(CITY_MAP)) {
      if (lower.includes(key.toLowerCase()) || strippedLower.includes(stripTashkeel(key).toLowerCase())) return val;
    }
  }
  return '';
}

/** Bosta shipZone: 'cairo' for Cairo/Giza, 'gov' for all other governorates */
export function cityToShipZone(bostaCity: string): 'cairo' | 'gov' {
  const lower = (bostaCity || '').toLowerCase();
  return (lower === 'cairo' || lower === 'giza') ? 'cairo' : 'gov';
}
