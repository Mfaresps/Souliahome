import { AccessRolesService } from '../../src/users/access-roles.service';
import { AccessRolesController } from '../../src/users/access-roles.controller';
import { ACCESS_ROLE_PERMISSIONS, normalizeRolePermissions, validateRolePermissionTier } from '../../src/users/access-role-permissions';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { managedRoleRequiredPermissions } from '../../src/core/guards/managed-role-access';
import { JwtAuthGuard } from '../../src/core/guards/jwt-auth.guard';
import { UserSchema } from '../../src/users/schemas/user.schema';

const query = (value: unknown) => ({ lean: () => ({ exec: async () => value }), exec: async () => value });

describe('Access roles', () => {
  test('managed role fields have concrete Mongoose schema types at runtime', () => {
    expect(UserSchema.path('roleId').instance).toBe('String');
    expect(UserSchema.path('roleAssignedAt').instance).toBe('Date');
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

  test('only the owner can write role definitions or assignments', async () => {
    const service = { create:jest.fn(), assign:jest.fn(), list:jest.fn(async()=>[]) };
    const controller = new AccessRolesController(service as any);
    expect(() => controller.create({user:{username:'another-admin'}},{name:'New'})).toThrow();
    expect(() => controller.assign({user:{username:'another-admin'}},'manager',{userId:'1'})).toThrow();
    expect(service.create).not.toHaveBeenCalled();
    await expect(controller.list({user:{username:'another-admin'}})).resolves.toEqual({roles:[],canManage:false});
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
