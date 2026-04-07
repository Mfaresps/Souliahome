/**
 * 📊 نظرة عامة على المستخدمين والصلاحيات
 * Soulia Home - نظام إدارة المخزون والمبيعات
 */

export const USERS_STRUCTURE = {
  admins: [
    {
      name: "Fares",
      username: "admin",
      password: "Fares@2024",
      role: "admin",
      permissions: ["ALL"],
      description: "المدير الرئيسي - صلاحيات كاملة"
    },
    {
      name: "محمد الإدارة",
      username: "admin2",
      password: "Admin2@2024",
      role: "admin",
      permissions: ["ALL"],
      description: "مدير إدارة ثاني"
    }
  ],
  
  sales: [
    {
      name: "أحمد المبيعات",
      username: "sales_1",
      password: "Sales1@2024",
      role: "staff",
      permissions: [
        "dashboard",      // 📊 لوحة المعلومات
        "transaction",    // 💰 الحركات (المبيعات والمشتريات)
        "inventory",      // 📦 المخزون
        "movements",      // 🔄 حركات العملاء
        "clients",        // 👥 العملاء
        "products",       // 🛍️ المنتجات
        "complaints",     // 📞 الشكاوى
        "expenses"        // 💸 المصاريف
      ]
    },
    {
      name: "علي الممثل",
      username: "sales_2",
      password: "Sales2@2024",
      role: "staff",
      permissions: ["dashboard", "transaction", "inventory", "movements", "clients", "products", "complaints", "expenses"]
    },
    {
      name: "سارة المبيعات",
      username: "sales_3",
      password: "Sales3@2024",
      role: "staff",
      permissions: ["dashboard", "transaction", "inventory", "movements", "clients", "products", "complaints", "expenses"]
    },
    {
      name: "فاطمة العروض",
      username: "sales_4",
      password: "Sales4@2024",
      role: "staff",
      permissions: ["dashboard", "transaction", "inventory", "movements", "clients", "products", "complaints", "expenses"]
    },
    {
      name: "عمر التسويق",
      username: "sales_5",
      password: "Sales5@2024",
      role: "staff",
      permissions: ["dashboard", "transaction", "inventory", "movements", "clients", "products", "complaints", "expenses"]
    }
  ],
  
  accountants: [
    {
      name: "خالد المحاسب",
      username: "accountant_1",
      password: "Account1@2024",
      role: "staff",
      permissions: [
        "dashboard",      // 📊 لوحة المعلومات
        "transaction",    // 💰 الحركات
        "inventory",      // 📦 المخزون
        "movements",      // 🔄 الحركات
        "reports",        // 📈 التقارير المالية
        "vault",          // 🔐 الخزنة
        "expenses",       // 💸 المصاريف
        "suppliers"       // 🏭 الموردين
      ]
    },
    {
      name: "نور المالية",
      username: "accountant_2",
      password: "Account2@2024",
      role: "staff",
      permissions: ["dashboard", "transaction", "inventory", "movements", "reports", "vault", "expenses", "suppliers"]
    },
    {
      name: "ليلى الحسابات",
      username: "accountant_3",
      password: "Account3@2024",
      role: "staff",
      permissions: ["dashboard", "transaction", "inventory", "movements", "reports", "vault", "expenses", "suppliers"]
    },
    {
      name: "يوسف الحسابي",
      username: "accountant_4",
      password: "Account4@2024",
      role: "staff",
      permissions: ["dashboard", "transaction", "inventory", "movements", "reports", "vault", "expenses", "suppliers"]
    },
    {
      name: "هند الإحصائي",
      username: "accountant_5",
      password: "Account5@2024",
      role: "staff",
      permissions: ["dashboard", "transaction", "inventory", "movements", "reports", "vault", "expenses", "suppliers"]
    }
  ]
};

// إحصائيات
export const STATS = {
  totalUsers: 12,
  admins: 2,
  salesReps: 5,
  accountants: 5,
};

// شرح الصلاحيات
export const PERMISSIONS_MAP = {
  dashboard: "عرض لوحة المعلومات والإحصائيات",
  transaction: "إنشاء وتعديل الحركات (مبيعات، مشتريات)",
  inventory: "عرض وتحديث المخزون",
  movements: "عرض حركات العملاء والموردين",
  clients: "إدارة بيانات العملاء",
  products: "إدارة المنتجات والأسعار",
  suppliers: "إدارة بيانات الموردين",
  expenses: "تسجيل وتتبع المصاريف",
  complaints: "تسجيل والرد على شكاوى العملاء",
  reports: "عرض التقارير المالية والإحصائية",
  vault: "الوصول إلى الخزنة والتسويات",
  users: "إدارة المستخدمين والصلاحيات (مدير فقط)",
  settings: "تغيير إعدادات النظام (مدير فقط)"
};
