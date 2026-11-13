import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { isValidObjectId } from 'mongoose';
import { AccessRole, AccessRoleDocument } from './schemas/access-role.schema';
import { User, UserDocument } from './schemas/user.schema';
import { ACCESS_ROLE_PERMISSIONS, NON_DELEGABLE_PERMISSIONS, VIEWER_PERMISSIONS, normalizeRolePermissions, validateRolePermissionTier } from './access-role-permissions';

export const DEFAULT_ACCESS_ROLES: Array<{slug:string;name:string;description:string;baseRole:'staff'|'viewer';perms:string[]}> = [
  { slug:'manager', name:'Manager', description:'Operations, orders, stock and approvals.', baseRole:'staff', perms:['dashboard','transaction','movements','pickup-orders','pickup-orders-edit','approvals','inventory','products','clients','suppliers','suppliers-create','suppliers-edit','complaints','expenses','categories-view','categories-create','categories-edit','categories-assign-products','purchase-create','purchase-view','delivery-manual-confirm','delivery-view-audit','reports','reports-kpis','reports-charts','suppliers-tab-invoices','suppliers-tab-pos'] },
  { slug:'accountant', name:'Accountant', description:'Financial records, suppliers and reports.', baseRole:'staff', perms:['dashboard','movements','pickup-orders','expenses','vault','clients','suppliers','reports','reports-kpis','reports-charts','reports-discounts','reports-orderaudit','reports-cancellations','reports-shipping','reports-export','purchase-view','suppliers-tab-invoices','suppliers-tab-payments','suppliers-tab-ledger','suppliers-tab-pos','carrier-settle-view'] },
  { slug:'sales', name:'Sales', description:'Orders, customers and product information.', baseRole:'staff', perms:['dashboard','transaction','movements','pickup-orders','clients','products','inventory','complaints','categories-view','shopify-orders','shopify-deposit-upload'] },
  { slug:'warehouse', name:'Warehouse', description:'Inventory, units and order preparation.', baseRole:'staff', perms:['dashboard','inventory','products','movements','pickup-orders','pickup-orders-edit','categories-view','categories-assign-products','inventory-units-view','inventory-units-register','inventory-units-allocate'] },
  { slug:'customer-service', name:'Customer Service', description:'Customer cases, orders and follow-ups.', baseRole:'staff', perms:['dashboard','clients','complaints','movements','pickup-orders','products','inventory','categories-view','shopify-orders','shopify-deposit-upload','csp-view','csp-create','csp-edit'] },
  { slug:'viewer', name:'Viewer', description:'Read-only overview and reports.', baseRole:'viewer', perms:['dashboard','inventory','reports','reports-kpis','reports-charts','reports-discounts','reports-orderaudit','reports-cancellations','reports-shipping','categories-view'] },
  // The four job presets the user window used to carry (JOB_TEMPLATES) — now real roles, so a
  // job is granted in ONE place. Inserted with $setOnInsert: an existing database gains them
  // without any role it already has being touched.
  { slug:'fulfillment', name:'Fulfillment', description:'Order preparation, shipping and delivery.', baseRole:'staff', perms:['dashboard','movements','pickup-orders','pickup-orders-edit','inventory','products','clients','delivery-manual-confirm','delivery-view-audit','shopify-orders','shopify-prepare-ship','shopify-deposit-upload'] },
  { slug:'cashier', name:'Cashier', description:'Cash register and expenses.', baseRole:'staff', perms:['dashboard','vault','expenses','movements','pickup-orders','clients'] },
  { slug:'purchasing', name:'Purchasing', description:'Suppliers, purchase invoices and supplier returns.', baseRole:'staff', perms:['dashboard','suppliers','products','inventory','movements','pickup-orders','purchase-create','purchase-view','purchase-edit-price','categories-view','categories-link-suppliers','suppliers-tab-invoices','suppliers-tab-pos','suppliers-tab-sreturns','suppliers-tab-activity','suppliers-returns'] },
  { slug:'marketing', name:'Marketing', description:'Products, collections and sales reports.', baseRole:'staff', perms:['dashboard','products','inventory','categories-view','categories-create','categories-edit','categories-assign-products','reports','reports-kpis','reports-charts','reports-discounts','shopify-orders'] },
];
/** Old per-user grants that are not catalog keys but mean exactly one catalog key. */
const LEGACY_PERM_ALIASES: Record<string, string> = { categories: 'categories-view' };
const UNASSIGNED = { role: { $ne: 'admin' }, username: { $ne: 'admin' }, $or: [{ roleId: null }, { roleId: '' }, { roleId: { $exists: false } }] };
const RESERVED_SLUGS = new Set(['super-admin','admin',...DEFAULT_ACCESS_ROLES.map(role => role.slug)]);

export interface RoleInput { name?: string; description?: string; baseRole?: 'staff'|'viewer'; perms?: string[] }

@Injectable()
export class AccessRolesService {
  private defaultsReady: Promise<void> | null = null;
  constructor(
    @InjectModel(AccessRole.name) private readonly roles: Model<AccessRoleDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
  ) {}

  async ensureDefaults() {
    if (!this.defaultsReady) this.defaultsReady = this.roles.bulkWrite(DEFAULT_ACCESS_ROLES.map(role => ({ updateOne: {
      filter: { slug: role.slug }, update: { $setOnInsert: { ...role, system: true } }, upsert: true,
    } })), { ordered: false }).then(() => undefined).catch(error => { this.defaultsReady = null; throw error; });
    await this.defaultsReady;
  }

  /** Existence check for callers outside this service (account creation). */
  async findRolePublic(id: string) { await this.ensureDefaults(); return this.findRole(id); }

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
        users:by(u => u.roleId === role.slug) })),
    ];
  }

  /** Accounts that hold permissions of their own instead of a role (granted before roles
   *  existed). Listed so the Roles page can say so and offer to move them onto roles. */
  async unassigned() {
    const users = await this.users.find(UNASSIGNED).select('_id username name role perms isActive').lean().exec();
    return users.map(u => ({ id: String(u._id), username: u.username, name: u.name, tier: u.role, permCount: (u.perms || []).length, isActive: u.isActive !== false }));
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

  async assign(id: string, userId: string, actorId?: string) {
    if (id === 'super-admin') throw new ForbiddenException('Super Admin cannot be assigned');
    if (!isValidObjectId(userId)) throw new BadRequestException('Invalid user ID');
    if (actorId && String(actorId) === String(userId)) throw new ForbiddenException('You cannot change your own role');
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

  async unassign(id: string, userId: string, actorId?: string) {
    if (id === 'super-admin') throw new ForbiddenException('Super Admin account is protected');
    if (!isValidObjectId(userId)) throw new BadRequestException('Invalid user ID');
    if (actorId && String(actorId) === String(userId)) throw new ForbiddenException('You cannot change your own role');
    const target = await this.users.findById(userId).exec();
    if (!target) throw new NotFoundException('User not found');
    if (target.username === 'admin') throw new ForbiddenException('Super Admin account is protected');
    if (id === 'admin' ? target.role !== 'admin' : target.roleId !== id) throw new BadRequestException('User is not assigned to this role');
    target.role = 'viewer'; target.perms = []; target.roleId = null; target.roleAssignedAt = null;
    await target.save();
    return { removed:true };
  }

  /**
   * Moves every account that still holds its own permission list onto a role, so a role is
   * the only place access is granted. Nobody gains or loses a capability:
   *  - an exact match (same tier, same permission set) joins that role;
   *  - otherwise a role is created for that exact set (accounts with identical sets share it).
   * Legacy accounts never passed the managed-role module check, under which product edits and
   * supplier writes need explicit keys the old per-user editor could not grant. Those keys are
   * added where the account already held the module, so the move keeps what they could do.
   * dryRun (the default) writes nothing and returns the plan.
   */
  async migrateLegacy(dryRun = true) {
    await this.ensureDefaults();
    const [roles, legacy] = await Promise.all([
      this.roles.find().lean().exec(),
      this.users.find(UNASSIGNED).lean().exec(),
    ]);
    type Target = { slug: string; name: string; isNew: boolean; baseRole: 'staff' | 'viewer'; perms: string[] };
    const keyOf = (tier: string, perms: string[]) => tier + '|' + [...perms].sort().join(',');
    const byKey = new Map<string, Target>();
    roles.forEach(role => { const key = keyOf(role.baseRole, role.perms); if (!byKey.has(key)) byKey.set(key, { slug: role.slug, name: role.name, isNew: false, baseRole: role.baseRole, perms: role.perms }); });
    const taken = new Set(roles.map(role => role.slug));
    const plan: Array<{ id: string; username: string; name: string; action: 'match' | 'create' | 'skip'; reason?: string; role?: { slug: string; name: string }; before: string[]; after?: string[]; added?: string[]; dropped?: string[] }> = [];
    const targets = new Map<string, Target>();
    for (const user of legacy) {
      const tier: 'staff' | 'viewer' = user.role === 'viewer' ? 'viewer' : 'staff';
      const before = [...(user.perms || [])];
      if (!before.length) { plan.push({ id: String(user._id), username: user.username, name: user.name, action: 'skip', reason: 'no-permissions', before }); continue; }
      // A disabled account keeps what it has: a role made for someone who cannot log in is
      // clutter. It shows «no role» and gets one when it is enabled again.
      if (user.isActive === false) { plan.push({ id: String(user._id), username: user.username, name: user.name, action: 'skip', reason: 'inactive', before }); continue; }
      const dropped: string[] = [];
      let perms = [...new Set(before.map(key => LEGACY_PERM_ALIASES[key] || key))].filter(key => {
        const ok = ACCESS_ROLE_PERMISSIONS.has(key) && !NON_DELEGABLE_PERMISSIONS.has(key) && (tier === 'staff' || VIEWER_PERMISSIONS.has(key));
        if (!ok) dropped.push(key);
        return ok;
      });
      const added: string[] = [];
      const grant = (key: string) => { if (!perms.includes(key)) { perms.push(key); added.push(key); } };
      if (tier === 'staff') {
        if (perms.includes('products')) grant('products-edit');
        if (perms.includes('products-sku-manage')) { grant('products-create'); grant('products-delete'); }
        if (perms.includes('suppliers')) { grant('suppliers-create'); grant('suppliers-edit'); grant('suppliers-delete'); }
      }
      perms = normalizeRolePermissions(perms);
      const key = keyOf(tier, perms);
      let target = byKey.get(key);
      if (!target) {
        const base = 'custom-' + (String(user.username || '').toLowerCase().replace(/@.*$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || String(user._id).slice(-6));
        let slug = base; let n = 2;
        while (taken.has(slug)) slug = `${base}-${n++}`;
        taken.add(slug);
        target = { slug, name: `${user.name || user.username} (custom)`, isNew: true, baseRole: tier, perms };
        byKey.set(key, target);
      }
      targets.set(target.slug, target);
      plan.push({ id: String(user._id), username: user.username, name: user.name, action: target.isNew ? 'create' : 'match',
        role: { slug: target.slug, name: target.name }, before, after: perms, added, dropped });
    }
    const created = [...byKey.values()].filter(role => role.isNew);
    let moved = 0;
    if (!dryRun) {
      for (const role of created) {
        await this.roles.updateOne({ slug: role.slug }, { $setOnInsert: { slug: role.slug, name: role.name,
          description: "Created from this account's previous permissions.", baseRole: role.baseRole, perms: role.perms, system: false } }, { upsert: true }).exec();
      }
      for (const row of plan) {
        if (row.action === 'skip' || !row.role) continue;
        const target = targets.get(row.role.slug)!;
        // Conditional on the account still being unassigned with the permissions read above,
        // so an edit made between the read and this write is never overwritten.
        const result = await this.users.updateOne({ _id: row.id, ...UNASSIGNED, perms: row.before },
          { $set: { role: target.baseRole, perms: target.perms, roleId: target.slug, roleAssignedAt: new Date() } }).exec();
        moved += (result as { modifiedCount?: number })?.modifiedCount || 0;
      }
    }
    return { dryRun, moved, users: plan, createdRoles: created.map(role => ({ slug: role.slug, name: role.name, baseRole: role.baseRole, perms: role.perms })) };
  }
}
