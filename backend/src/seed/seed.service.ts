import { Injectable, Logger } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { ProductsService } from '../products/products.service';
import { SettingsService } from '../settings/settings.service';

const ALL_PERMS = [
  'dashboard', 'transaction', 'inventory', 'movements',
  'clients', 'products', 'suppliers', 'expenses',
  'complaints', 'reports', 'vault', 'users', 'settings',
];

const SALES_PERMS = [
  'dashboard', 'transaction', 'inventory', 'movements',
  'clients', 'products', 'complaints', 'expenses',
];

const ACCOUNTING_PERMS = [
  'dashboard', 'transaction', 'inventory', 'movements',
  'reports', 'vault', 'expenses', 'suppliers',
];

const DEFAULT_USERS = [
  // المديرين (Admins)
  {
    username: 'admin',
    password: 'Fares@2024',
    name: 'Fares',
    role: 'admin',
    phone: '+966501234567',
    perms: ALL_PERMS,
  },
  {
    username: 'admin2',
    password: 'Admin2@2024',
    name: 'محمد الإدارة',
    role: 'admin',
    phone: '+966501234568',
    perms: ALL_PERMS,
  },
  
  // موظفو المبيعات (Sales Reps)
  {
    username: 'sales_1',
    password: 'Sales1@2024',
    name: 'أحمد المبيعات',
    role: 'staff',
    phone: '+966501234569',
    perms: SALES_PERMS,
  },
  {
    username: 'sales_2',
    password: 'Sales2@2024',
    name: 'علي الممثل',
    role: 'staff',
    phone: '+966501234570',
    perms: SALES_PERMS,
  },
  {
    username: 'sales_3',
    password: 'Sales3@2024',
    name: 'سارة المبيعات',
    role: 'staff',
    phone: '+966501234571',
    perms: SALES_PERMS,
  },
  {
    username: 'sales_4',
    password: 'Sales4@2024',
    name: 'فاطمة العروض',
    role: 'staff',
    phone: '+966501234572',
    perms: SALES_PERMS,
  },
  {
    username: 'sales_5',
    password: 'Sales5@2024',
    name: 'عمر التسويق',
    role: 'staff',
    phone: '+966501234573',
    perms: SALES_PERMS,
  },
  
  // المحاسبين (Accountants)
  {
    username: 'accountant_1',
    password: 'Account1@2024',
    name: 'خالد المحاسب',
    role: 'staff',
    phone: '+966501234574',
    perms: ACCOUNTING_PERMS,
  },
  {
    username: 'accountant_2',
    password: 'Account2@2024',
    name: 'نور المالية',
    role: 'staff',
    phone: '+966501234575',
    perms: ACCOUNTING_PERMS,
  },
  {
    username: 'accountant_3',
    password: 'Account3@2024',
    name: 'ليلى الحسابات',
    role: 'staff',
    phone: '+966501234576',
    perms: ACCOUNTING_PERMS,
  },
  {
    username: 'accountant_4',
    password: 'Account4@2024',
    name: 'يوسف الحسابي',
    role: 'staff',
    phone: '+966501234577',
    perms: ACCOUNTING_PERMS,
  },
  {
    username: 'accountant_5',
    password: 'Account5@2024',
    name: 'هند الإحصائي',
    role: 'staff',
    phone: '+966501234578',
    perms: ACCOUNTING_PERMS,
  },
];

const DEFAULT_PRODUCTS = [
  { code: 'Code 01', name: 'Baby Rest Basket', sellPrice: 1898, buyPrice: 730, minStock: 10, openingBalance: 0 },
  { code: 'Code 02', name: 'Geo Basket', sellPrice: 1872, buyPrice: 720, minStock: 10, openingBalance: 0 },
  { code: 'Code 03', name: 'Coco Black Basket', sellPrice: 715, buyPrice: 290, minStock: 10, openingBalance: 0 },
  { code: 'Code 04', name: 'Black Tassel Basket', sellPrice: 715, buyPrice: 290, minStock: 10, openingBalance: 0 },
  { code: 'Code 05', name: 'Terra Red Basket XL', sellPrice: 1350, buyPrice: 500, minStock: 10, openingBalance: 0 },
  { code: 'Code 06', name: 'Terra Red Basket L', sellPrice: 1050, buyPrice: 350, minStock: 10, openingBalance: 0 },
  { code: 'Code 07', name: 'Terra Red Basket S', sellPrice: 690, buyPrice: 250, minStock: 10, openingBalance: 0 },
  { code: 'Code 08', name: 'Ocean Gray Basket', sellPrice: 1420, buyPrice: 500, minStock: 10, openingBalance: 0 },
  { code: 'Code 09', name: 'Bohème Basket', sellPrice: 1420, buyPrice: 500, minStock: 10, openingBalance: 0 },
  { code: 'Code 10', name: 'Boho Charm Basket', sellPrice: 1420, buyPrice: 500, minStock: 10, openingBalance: 0 },
  { code: 'Code 11', name: 'Sand Bloom Basket L', sellPrice: 1200, buyPrice: 350, minStock: 10, openingBalance: 0 },
  { code: 'Code 12', name: 'Sand Bloom Basket M', sellPrice: 750, buyPrice: 250, minStock: 10, openingBalance: 0 },
  { code: 'Code 13', name: 'Sand Bloom Basket S', sellPrice: 550, buyPrice: 150, minStock: 10, openingBalance: 0 },
  { code: 'Code 14', name: 'Greyva Basket L', sellPrice: 1200, buyPrice: 350, minStock: 10, openingBalance: 0 },
  { code: 'Code 15', name: 'Greyva Basket M', sellPrice: 750, buyPrice: 250, minStock: 10, openingBalance: 0 },
  { code: 'Code 16', name: 'Greyva Basket S', sellPrice: 550, buyPrice: 150, minStock: 10, openingBalance: 0 },
  { code: 'Code 17', name: 'Luma Organize', sellPrice: 850, buyPrice: 350, minStock: 10, openingBalance: 0 },
  { code: 'Code 18', name: 'Sandora-Deep Gray-organize M', sellPrice: 790, buyPrice: 300, minStock: 10, openingBalance: 0 },
  { code: 'Code 19', name: 'Sandora-Deep Gray-organize L', sellPrice: 980, buyPrice: 400, minStock: 10, openingBalance: 0 },
  { code: 'Code 20', name: 'Sandora-Sand Beige-organize M', sellPrice: 790, buyPrice: 300, minStock: 10, openingBalance: 0 },
  { code: 'Code 21', name: 'Sandora-Sand Beige-organize L', sellPrice: 980, buyPrice: 400, minStock: 10, openingBalance: 0 },
  { code: 'Code 22', name: 'Sandora-Off White-organize M', sellPrice: 790, buyPrice: 300, minStock: 10, openingBalance: 0 },
  { code: 'Code 23', name: 'Sandora-Off White-organize L', sellPrice: 950, buyPrice: 400, minStock: 10, openingBalance: 0 },
  { code: 'Code 24', name: 'Twist Basket', sellPrice: 1550, buyPrice: 720, minStock: 10, openingBalance: 0 },
  { code: 'Code 25', name: 'Lovely Basket', sellPrice: 1450, buyPrice: 500, minStock: 10, openingBalance: 0 },
  { code: 'Code 26', name: 'Ólfa Basket', sellPrice: 690, buyPrice: 250, minStock: 10, openingBalance: 0 },
  { code: 'Code 27', name: 'Contra Basket', sellPrice: 650, buyPrice: 250, minStock: 10, openingBalance: 0 },
  { code: 'Code 28', name: 'Art Tissue', sellPrice: 390, buyPrice: 120, minStock: 10, openingBalance: 0 },
  { code: 'Code 29', name: 'Clean Tissue', sellPrice: 425, buyPrice: 150, minStock: 10, openingBalance: 0 },
  { code: 'Code 30', name: 'Cotton Tissue', sellPrice: 425, buyPrice: 150, minStock: 10, openingBalance: 0 },
  { code: 'Code 31', name: 'Loop Basket', sellPrice: 390, buyPrice: 140, minStock: 10, openingBalance: 0 },
  { code: 'Code 32', name: 'Ribbon Storage', sellPrice: 680, buyPrice: 250, minStock: 10, openingBalance: 0 },
  { code: 'Code 33', name: 'Orvia Runner', sellPrice: 0, buyPrice: 0, minStock: 10, openingBalance: 0 },
  { code: 'Code 34', name: 'Joy Set Organizers', sellPrice: 790, buyPrice: 300, minStock: 10, openingBalance: 0 },
  { code: 'Code 35', name: 'Khyout Rug M', sellPrice: 1350, buyPrice: 450, minStock: 10, openingBalance: 0 },
  { code: 'Code 36', name: 'Khyout Rug L', sellPrice: 1650, buyPrice: 600, minStock: 10, openingBalance: 0 },
  { code: 'Code 37', name: 'Loop Runner white', sellPrice: 624, buyPrice: 240, minStock: 10, openingBalance: 0 },
  { code: 'Code 38', name: 'Circle Runner', sellPrice: 468, buyPrice: 180, minStock: 10, openingBalance: 0 },
  { code: 'Code 39', name: 'Loop Runner beige', sellPrice: 728, buyPrice: 280, minStock: 10, openingBalance: 0 },
  { code: 'Code 40', name: 'infinite Runner white', sellPrice: 858, buyPrice: 330, minStock: 10, openingBalance: 0 },
  { code: 'Code 41', name: 'Arova-Doormat', sellPrice: 910, buyPrice: 350, minStock: 10, openingBalance: 0 },
  { code: 'Code 42', name: 'Place mat 6pcs', sellPrice: 185, buyPrice: 70, minStock: 10, openingBalance: 0 },
  { code: 'Code 43', name: 'Coastra cups 6pcs', sellPrice: 65, buyPrice: 25, minStock: 10, openingBalance: 0 },
  { code: 'Code 44', name: 'Ghazl Rug M', sellPrice: 1350, buyPrice: 450, minStock: 10, openingBalance: 0 },
  { code: 'Code 45', name: 'Ghazl Rug L', sellPrice: 1650, buyPrice: 600, minStock: 10, openingBalance: 0 },
  { code: 'Code 46', name: 'Ribbon Storage', sellPrice: 650, buyPrice: 250, minStock: 10, openingBalance: 0 },
  { code: 'Code 47', name: 'Maroon Organize 4 Set', sellPrice: 620, buyPrice: 200, minStock: 10, openingBalance: 0 },
  { code: 'Code 48', name: 'brown Organize 4 Set', sellPrice: 620, buyPrice: 200, minStock: 10, openingBalance: 0 },
];

@Injectable()
export class SeedService {
  private readonly logger = new Logger(SeedService.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly productsService: ProductsService,
    private readonly settingsService: SettingsService,
  ) {}

  async seed(): Promise<void> {
    await this.seedUsers();
    await this.seedProducts();
    await this.seedSettings();
  }

  private async seedUsers(): Promise<void> {
    const count = await this.usersService.countUsers();
    if (count > 0) {
      this.logger.log('Users already seeded, skipping.');
      return;
    }
    for (const userData of DEFAULT_USERS) {
      await this.usersService.createUser(userData);
      this.logger.log(`Seeded user: ${userData.username}`);
    }
  }

  private async seedProducts(): Promise<void> {
    const count = await this.productsService.countProducts();
    if (count > 0) {
      this.logger.log('Products already seeded, skipping.');
      return;
    }
    for (const product of DEFAULT_PRODUCTS) {
      await this.productsService.create(product);
    }
    this.logger.log(`Seeded ${DEFAULT_PRODUCTS.length} products.`);
  }

  private async seedSettings(): Promise<void> {
    await this.settingsService.getSettings();
    this.logger.log('Settings initialized.');
  }
}
