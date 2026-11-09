import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { isValidObjectId } from 'mongoose';
import { AccessRole, AccessRoleDocument } from './schemas/access-role.schema';
import { User, UserDocument } from './schemas/user.schema';
import { ACCESS_ROLE_PERMISSIONS, normalizeRolePermissions, validateRolePermissionTier } from './access-role-permissions';

const DEFAULTS: Array<{slug:string;name:string;description:string;baseRole:'staff'|'viewer';perms:string[]}> = [
  { slug:'manager', name:'Manager', description:'Operations, orders, stock and approvals.', baseRole:'staff', perms:['dashboard','transaction','movements','pickup-orders','pickup-orders-edit','approvals','inventory','products','clients','suppliers','suppliers-create','suppliers-edit','complaints','expenses','categories-view','categories-create','categories-edit','categories-assign-products','purchase-create','purchase-view','delivery-manual-confirm','delivery-view-audit','reports','reports-kpis','reports-charts','suppliers-tab-invoices','suppliers-tab-pos'] },
  { slug:'accountant', name:'Accountant', description:'Financial records, suppliers and reports.', baseRole:'staff', perms:['dashboard','movements','pickup-orders','expenses','vault','clients','suppliers','reports','reports-kpis','reports-charts','reports-discounts','reports-orderaudit','reports-cancellations','reports-shipping','reports-export','purchase-view','suppliers-tab-invoices','suppliers-tab-payments','suppliers-tab-ledger','suppliers-tab-pos','carrier-settle-view'] },
  { slug:'sales', name:'Sales', description:'Orders, customers and product information.', baseRole:'staff', perms:['dashboard','transaction','movements','pickup-orders','clients','products','inventory','complaints','categories-view','shopify-orders','shopify-deposit-upload'] },
  { slug:'warehouse', name:'Warehouse', description:'Inventory, units and order preparation.', baseRole:'staff', perms:['dashboard','inventory','products','movements','pickup-orders','pickup-orders-edit','categories-view','categories-assign-products','inventory-units-view','inventory-units-register','inventory-units-allocate'] },
  { slug:'customer-service', name:'Customer Service', description:'Customer cases, orders and follow-ups.', baseRole:'staff', perms:['dashboard','clients','complaints','movements','pickup-orders','products','inventory','categories-view','shopify-orders','shopify-deposit-upload','csp-view','csp-create','csp-edit'] },
  { slug:'viewer', name:'Viewer', description:'Read-only overview and reports.', baseRole:'viewer', perms:['dashboard','inventory','reports','reports-kpis','reports-charts','reports-discounts','reports-orderaudit','reports-cancellations','reports-shipping','categories-view'] },
];
const RESERVED_SLUGS = new Set(['super-admin','admin',...DEFAULTS.map(role => role.slug)]);

export interface RoleInput { name?: string; description?: string; baseRole?: 'staff'|'viewer'; perms?: string[] }

@Injectable()
export class AccessRolesService {
  private defaultsReady: Promise<void> | null = null;
  constructor(
    @InjectModel(AccessRole.name) private readonly roles: Model<AccessRoleDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
  ) {}

  async ensureDefaults() {
    if (!this.defaultsReady) this.defaultsReady = this.roles.bulkWrite(DEFAULTS.map(role => ({ updateOne: {
      filter: { slug: role.slug }, update: { $setOnInsert: { ...role, system: true } }, upsert: true,
    } })), { ordered: false }).then(() => undefined).catch(error => { this.defaultsReady = null; throw error; });
    await this.defaultsReady;
  }

  private async findRole(id: string) {
    const role = await this.roles.findOne({ slug: id }).lean().exec();
    if (!role) throw new NotFoundException('Role not found');
    return role;
  }

  async list() {
    await this.ensureDefaults();
    const [roles, users] = await Promise.all([
      this.roles.find().sort({ system: -1, name: 1 }).lean().exec(),
      this.users.find().select('_id username name email avatar role roleId roleAssignedAt isActive createdAt').lean().exec(),
    ]);
    const safeUsers = users.map(user => ({ id: String(user._id), username: user.username, name: user.name, email:user.email || '',
      avatar: user.avatar || '', isActive: user.isActive !== false, createdAt: (user as any).createdAt || null,
      assignedAt: user.roleAssignedAt || null }));
    const by = (predicate: (user: typeof users[number]) => boolean) => users.filter(predicate).map(user => safeUsers.find(item => item.id === String(user._id)));
    return [
      { slug:'super-admin', name:'Super Admin', description:'Protected owner account with full system access.', system:true, locked:true, baseRole:'admin', perms:[...ACCESS_ROLE_PERMISSIONS], users:by(u => u.username === 'admin') },
      { slug:'admin', name:'Admin', description:'Full administrative access.', system:true, locked:true, baseRole:'admin', perms:[...ACCESS_ROLE_PERMISSIONS], users:by(u => u.role === 'admin' && u.username !== 'admin') },
      ...roles.map(role => ({ slug:role.slug, name:role.name, description:role.description,
        system:role.system, locked:false, baseRole:role.baseRole, perms:role.perms,
        createdAt:(role as any).createdAt, updatedAt:(role as any).updatedAt,
        users:by(u => u.roleId === role.slug || (!u.roleId && role.slug === 'viewer' && u.role === 'viewer')) })),
    ];
  }

  async create(input: RoleInput) {
    await this.ensureDefaults();
    const name = String(input.name || '').trim();
    if (name.length < 2 || name.length > 60) throw new BadRequestException('Role name must be 2–60 characters');
    const baseRole = input.baseRole === 'viewer' ? 'viewer' : 'staff';
    const description = String(input.description || '').trim().slice(0, 240);
    let perms: string[];
    try { perms = normalizeRolePermissions(input.perms || []); } catch { throw new BadRequestException('Unknown permission'); }
    try { validateRolePermissionTier(baseRole, perms); } catch { throw new BadRequestException('Permission is restricted for this access tier'); }
    const slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `role-${Date.now()}`;
    if (RESERVED_SLUGS.has(slug)) throw new ConflictException('This role name is reserved');
    try { return await this.roles.create({ slug, name, description, baseRole, perms, system:false }); }
    catch (error: any) { if (error?.code === 11000) throw new ConflictException('A role with this name already exists'); throw error; }
  }

  async update(id: string, input: RoleInput) {
    if (id === 'admin' || id === 'super-admin') throw new ForbiddenException('Protected role');
    await this.ensureDefaults();
    const current = await this.findRole(id);
    const name = input.name === undefined ? current.name : String(input.name).trim();
    if (name.length < 2 || name.length > 60) throw new BadRequestException('Role name must be 2–60 characters');
    const baseRole = input.baseRole === 'viewer' ? 'viewer' : input.baseRole === 'staff' ? 'staff' : current.baseRole;
    let perms: string[];
    try { perms = input.perms === undefined ? current.perms : normalizeRolePermissions(input.perms); } catch { throw new BadRequestException('Unknown permission'); }
    try { validateRolePermissionTier(baseRole, perms); } catch { throw new BadRequestException('Permission is restricted for this access tier'); }
    const description = input.description === undefined ? current.description : String(input.description).trim().slice(0, 240);
    const role = await this.roles.findOneAndUpdate({ slug:id }, { $set:{ name, description, baseRole, perms } }, { new:true }).lean().exec();
    await this.users.updateMany({ roleId:id }, { $set:{ role:baseRole, perms } }).exec();
    return role;
  }

  async delete(id: string) {
    if (id === 'admin' || id === 'super-admin') throw new ForbiddenException('Protected role');
    await this.ensureDefaults();
    const role = await this.findRole(id);
    if (role.system) throw new ForbiddenException('System role cannot be deleted');
    if (await this.users.exists({ roleId:id })) throw new ConflictException('Remove assigned users before deleting this role');
    await this.roles.deleteOne({ slug:id }).exec();
    return { deleted:true };
  }

  async assign(id: string, userId: string) {
    if (id === 'super-admin') throw new ForbiddenException('Super Admin cannot be assigned');
    if (!isValidObjectId(userId)) throw new BadRequestException('Invalid user ID');
    if (id !== 'admin') await this.ensureDefaults();
    const target = await this.users.findById(userId).exec();
    if (!target) throw new NotFoundException('User not found');
    if (target.username === 'admin') throw new ForbiddenException('Super Admin account is protected');
    if (id === 'admin') {
      target.role = 'admin'; target.perms = []; target.roleId = null;
    } else {
      const role = await this.findRole(id);
      target.role = role.baseRole; target.perms = role.perms; target.roleId = id;
    }
    target.roleAssignedAt = new Date();
    await target.save();
    return { assigned:true };
  }

  async unassign(id: string, userId: string) {
    if (id === 'super-admin') throw new ForbiddenException('Super Admin account is protected');
    if (!isValidObjectId(userId)) throw new BadRequestException('Invalid user ID');
    const target = await this.users.findById(userId).exec();
    if (!target) throw new NotFoundException('User not found');
    if (target.username === 'admin') throw new ForbiddenException('Super Admin account is protected');
    if (id === 'admin' ? target.role !== 'admin' : target.roleId !== id) throw new BadRequestException('User is not assigned to this role');
    target.role = 'viewer'; target.perms = []; target.roleId = null; target.roleAssignedAt = null;
    await target.save();
    return { removed:true };
  }
}
