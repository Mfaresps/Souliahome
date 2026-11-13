import { AccessRolesService } from '../../src/users/access-roles.service';
import { AccessRolesController } from '../../src/users/access-roles.controller';
import { ACCESS_ROLE_PERMISSIONS, normalizeRolePermissions, validateRolePermissionTier } from '../../src/users/access-role-permissions';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { managedRoleRequiredPermissions, MANAGED_READERS } from '../../src/core/guards/managed-role-access';
import { JwtAuthGuard } from '../../src/core/guards/jwt-auth.guard';
import { UserSchema } from '../../src/users/schemas/user.schema';

const query = (value: unknown) => ({ lean: () => ({ exec: async () => value }), exec: async () => value });

describe('Access roles', () => {
  test('managed role fields have concrete Mongoose schema types at runtime', () => {
    expect(UserSchema.path('roleId').instance).toBe('String');
    expect(UserSchema.path('roleAssignedAt').instance).toBe('Date');
  });
  test('the app skips exactly the startup lists the server refuses a role', () => {
    const html = fs.readFileSync(path.resolve(__dirname,'../../../frontend/public/index.html'),'utf8');
    const block = html.match(/const _BOOT_READERS = (\{[\s\S]*?\});/)?.[1] || '{}';
    // eslint-disable-next-line no-new-func
    const frontend = new Function('return ' + block)();
    expect(frontend).toEqual(MANAGED_READERS);
  });
  test('the server catalog matches the existing user permission editor', () => {
    const html = fs.readFileSync(path.resolve(__dirname,'../../../frontend/public/index.html'),'utf8');
    const source = html.match(/const PERMS = \[([\s\S]*?)\];/)?.[1] || '';
    const frontendKeys = [...source.matchAll(/'([^']+)'/g)].map(match => match[1]);
    expect(frontendKeys.every(key => ACCESS_ROLE_PERMISSIONS.has(key))).toBe(true);
    expect([...ACCESS_ROLE_PERMISSIONS].filter(key => !frontendKeys.includes(key)).sort()).toEqual([
      'products-create','products-delete','products-edit','suppliers-create','suppliers-delete','suppliers-edit',
    ]);
  });
  test('permission catalog rejects unknown grants and enforces dependencies and tiers', () => {
    expect(() => normalizeRolePermissions(['made-up-power'])).toThrow();
    expect(normalizeRolePermissions(['pickup-orders-edit'])).toEqual(['pickup-orders-edit','pickup-orders']);
    expect(() => validateRolePermissionTier('staff', ['users'])).toThrow();
    expect(() => validateRolePermissionTier('viewer', ['shopify-cancel'])).toThrow();
    expect(() => validateRolePermissionTier('viewer', ['dashboard','reports-kpis'])).not.toThrow();
    expect(normalizeRolePermissions(['products-create','suppliers-edit'])).toEqual([
      'products-create','suppliers-edit','products','products-sku-manage','suppliers',
    ]);
  });

  test('managed roles have server module boundaries while shared endpoints stay available', () => {
    expect(managedRoleRequiredPermissions('/api/transactions/summary-page','GET')).toEqual(['movements']);
    expect(managedRoleRequiredPermissions('/api/transactions','POST',{type:'مشتريات'})).toEqual(['purchase-create']);
    expect(managedRoleRequiredPermissions('/api/transactions','POST',{type:'مبيعات'})).toEqual(['transaction']);
    expect(managedRoleRequiredPermissions('/api/shopify/orders','GET')).toEqual(['shopify-orders']);
    expect(managedRoleRequiredPermissions('/api/vault','GET')).toEqual(['vault']);
    expect(managedRoleRequiredPermissions('/api/products/123','PUT')).toEqual(['products-edit']);
    expect(managedRoleRequiredPermissions('/api/suppliers','POST')).toEqual(['suppliers-create']);
    expect(managedRoleRequiredPermissions('/api/notifications','GET')).toBeNull();
    // Startup reference data every screen reads stays open to an account on a role.
    expect(managedRoleRequiredPermissions('/api/products','GET')).toBeNull();
    expect(managedRoleRequiredPermissions('/api/transactions/inventory','GET')).toBeNull();
    expect(managedRoleRequiredPermissions('/api/transactions/startup-overview','GET')).toBeNull();
    // Lists some screens read name every reader; writes keep their own key.
    expect(managedRoleRequiredPermissions('/api/suppliers','GET')).toEqual(expect.arrayContaining(['suppliers','products']));
    expect(managedRoleRequiredPermissions('/api/supplier-returns','GET')).toContain('approvals');
    expect(managedRoleRequiredPermissions('/api/supplier-returns','POST')).toEqual(['suppliers-returns']);
    expect(managedRoleRequiredPermissions('/api/expenses','POST')).toEqual(['expenses']);
    expect(managedRoleRequiredPermissions('/api/vault','GET')).toEqual(['vault']);
  });

  test('JWT guard denies ungranted modules and viewer writes for managed accounts', async () => {
    const base = Object.getPrototypeOf(JwtAuthGuard.prototype);
    const spy = jest.spyOn(base,'canActivate').mockResolvedValue(true);
    try {
      const guard = new JwtAuthGuard();
      const request: any = { path:'/api/products/507f1f77bcf86cd799439011', method:'PUT', user:{role:'staff',roleId:'sales',perms:['products']} };
      const context = { switchToHttp:()=>({getRequest:()=>request}) } as any;
      await expect(guard.canActivate(context)).rejects.toThrow();
      request.user.perms.push('products-edit');
      await expect(guard.canActivate(context)).resolves.toBe(true);
      request.user.role='viewer';
      await expect(guard.canActivate(context)).rejects.toThrow();
      request.user.roleId=null;
      await expect(guard.canActivate(context)).resolves.toBe(true);
    } finally { spy.mockRestore(); }
  });

  test('role changes propagate to assigned accounts and protected roles cannot change', async () => {
    const roles = {
      bulkWrite: jest.fn(async()=>undefined),
      findOne: jest.fn(() => query({ slug:'manager',name:'Manager',description:'Operations',baseRole:'staff',perms:['dashboard'] })),
      findOneAndUpdate: jest.fn(() => query({ slug:'manager',perms:['dashboard','vault'] })),
    };
    const users = { updateMany: jest.fn(() => ({exec:async()=>({modifiedCount:2})})) };
    const service = new AccessRolesService(roles as any,users as any);
    await expect(service.update('super-admin',{perms:[]})).rejects.toThrow();
    await service.update('manager',{perms:['dashboard','vault']});
    expect(users.updateMany).toHaveBeenCalledWith({roleId:'manager'},{$set:{role:'staff',perms:['dashboard','vault']}});
  });

  test('every admin manages roles; nobody can change their own role', async () => {
    const service = { create:jest.fn(), assign:jest.fn(), list:jest.fn(async()=>[]), unassigned:jest.fn(async()=>[]) };
    const controller = new AccessRolesController(service as any);
    controller.create({name:'New'});
    expect(service.create).toHaveBeenCalledWith({name:'New'});
    controller.assign({user:{userId:'u1',username:'another-admin'}},'manager',{userId:'u2'});
    expect(service.assign).toHaveBeenCalledWith('manager','u2','u1');
    await expect(controller.list()).resolves.toEqual({roles:[],unassigned:[],canManage:true});
    const target = { username:'me', role:'admin', save:jest.fn() };
    const real = new AccessRolesService({ bulkWrite:jest.fn(async()=>undefined) } as any, { findById:jest.fn(()=>query(target)) } as any);
    await expect(real.assign('viewer','507f1f77bcf86cd799439011','507f1f77bcf86cd799439011')).rejects.toThrow('own role');
    expect(target.save).not.toHaveBeenCalled();
  });

  test('migration moves legacy accounts onto roles without gaining or losing access', async () => {
    const roleDocs = [
      { slug:'sales', name:'Sales', baseRole:'staff', perms:['dashboard','movements'] },
      { slug:'viewer', name:'Viewer', baseRole:'viewer', perms:['dashboard'] },
    ];
    const legacy = [
      { _id:'507f1f77bcf86cd799439011', username:'a@x', name:'A', role:'staff', perms:['movements','dashboard'] },
      { _id:'507f1f77bcf86cd799439012', username:'b@x', name:'B', role:'staff', perms:['products','categories'] },
      { _id:'507f1f77bcf86cd799439013', username:'c@x', name:'C', role:'staff', perms:['categories','products'] },
      { _id:'507f1f77bcf86cd799439014', username:'d@x', name:'D', role:'viewer', perms:[] },
      { _id:'507f1f77bcf86cd799439015', username:'e@x', name:'E', role:'staff', perms:['dashboard','users'] },
      { _id:'507f1f77bcf86cd799439016', username:'f@x', name:'F', role:'staff', perms:['vault'], isActive:false },
    ];
    const roles = { bulkWrite:jest.fn(async()=>undefined), find:jest.fn(()=>query(roleDocs)), updateOne:jest.fn(()=>({exec:async()=>({})})) };
    const users = { find:jest.fn(()=>query(legacy)), updateOne:jest.fn(()=>({exec:async()=>({modifiedCount:1})})) };
    const service = new AccessRolesService(roles as any, users as any);
    const dry = await service.migrateLegacy(true);
    expect(users.updateOne).not.toHaveBeenCalled();
    expect(roles.updateOne).not.toHaveBeenCalled();
    const row = (u: string) => dry.users.find(item => item.username === u)!;
    expect(row('a@x')).toMatchObject({ action:'match', role:{slug:'sales'} });
    // 'categories' is the legacy alias of categories-view; products → the product edit key.
    expect(row('b@x')).toMatchObject({ action:'create', added:['products-edit'] });
    expect([...row('b@x').after!].sort()).toEqual(['categories-view','products','products-edit']);
    // Identical sets share one created role.
    expect(row('c@x').role).toEqual(row('b@x').role);
    expect(row('d@x').action).toBe('skip');
    expect(row('f@x')).toMatchObject({ action:'skip', reason:'inactive' });
    // users/settings are admin-only by policy and can never be granted through a role.
    expect(row('e@x')).toMatchObject({ action:'create', dropped:['users'], after:['dashboard'] });
    expect(dry.createdRoles.length).toBe(2);
    const done = await service.migrateLegacy(false);
    expect(roles.updateOne).toHaveBeenCalledTimes(2);
    expect(users.updateOne).toHaveBeenCalledTimes(4);
    // The write is conditional on the account being unchanged since the read.
    expect((users.updateOne.mock.calls[0] as any[])[0]).toMatchObject({ _id:'507f1f77bcf86cd799439011', perms:['movements','dashboard'] });
    expect(done.moved).toBe(4);
  });

  test('assignment persists the role tier and grants; owner account cannot be reassigned', async () => {
    const target = { username:'staff-1', role:'viewer', perms:[], roleId:null, roleAssignedAt:null, save:jest.fn(async()=>undefined) };
    const roles = { bulkWrite:jest.fn(async()=>undefined), findOne:jest.fn(() => query({slug:'manager',baseRole:'staff',perms:['dashboard','movements']})) };
    const users = { findById:jest.fn(()=>query(target)) };
    const service = new AccessRolesService(roles as any,users as any);
    await service.assign('manager','507f1f77bcf86cd799439011');
    expect(target.role).toBe('staff');
    expect(target.perms).toEqual(['dashboard','movements']);
    expect(target.roleId).toBe('manager');
    expect(target.save).toHaveBeenCalledTimes(1);
    target.username='admin';
    await expect(service.assign('manager','507f1f77bcf86cd799439011')).rejects.toThrow();
  });

  test('custom role cannot be deleted while assigned', async () => {
    const roles = { bulkWrite:jest.fn(async()=>undefined), findOne:jest.fn(() => query({slug:'custom',system:false})), deleteOne:jest.fn() };
    const users = { exists:jest.fn(async()=>({_id:'507f1f77bcf86cd799439011'})) };
    const service = new AccessRolesService(roles as any,users as any);
    await expect(service.delete('custom')).rejects.toThrow();
    expect(roles.deleteOne).not.toHaveBeenCalled();
  });
});
