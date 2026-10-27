import 'reflect-metadata';
import { ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from 'vm';
import { ShopifyController } from '../../src/shopify/shopify.controller';
import { PermsGuard } from '../../src/core/guards/perms.guard';
import { RolesGuard } from '../../src/core/guards/roles.guard';
import { JwtAuthGuard } from '../../src/core/guards/jwt-auth.guard';
import { PERMS_KEY } from '../../src/core/decorators/perms.decorator';

const html = readFileSync(resolve(__dirname, '../../../frontend/public/index.html'), 'utf8');
function extract(name: string) {
  const match = html.match(new RegExp('(?:async )?function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
  if (!match) throw new Error('Missing function: ' + name);
  return match[0];
}

describe('Shopify assignment permission', () => {
  const guard = new PermsGuard(new Reflector());
  const allowed = (user: any) => guard.canActivate({
    getHandler: () => ShopifyController.prototype.reassign,
    getClass: () => ShopifyController,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext);

  it('requires authentication and the dedicated permission instead of admin role', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, ShopifyController.prototype.reassign);
    expect(guards).toEqual([JwtAuthGuard, PermsGuard]);
    expect(guards).not.toContain(RolesGuard);
    expect(Reflect.getMetadata(PERMS_KEY, ShopifyController.prototype.reassign)).toEqual(['shopify-reassign']);
    expect(allowed({ role: 'admin', perms: [] })).toBe(true);
    expect(allowed({ role: 'staff', perms: ['shopify-orders', 'shopify-reassign'] })).toBe(true);
    expect(allowed({ role: 'staff', perms: ['shopify-orders', 'shopify-edit-direct', 'shopify-prepare-ship'] })).toBe(false);
    expect(allowed({ role: 'staff', perms: [] })).toBe(false);
    expect(allowed(undefined)).toBe(false);
  });

  it('records the employee performing the change rather than calling them admin', async () => {
    const service = { reassignOrder: jest.fn().mockResolvedValue({ success: true }) };
    const controller = new ShopifyController(service as any, {} as any, {} as any);
    await controller.reassign('order', 'other-employee', 'Handover', { user: { userId: 'employee', name: 'Sara', role: 'staff' } });
    expect(service.reassignOrder).toHaveBeenCalledWith('order', 'other-employee', 'Handover', 'Sara', 'employee');
  });

  it('lists the grant under Shopify and keeps it opt-in for staff and viewers', () => {
    const start = html.indexOf('const PERMS = '), end = html.indexOf('\n};', html.indexOf('const ROLE_TEMPLATES = ', start)) + 3;
    const env: any = {};
    runInNewContext(html.slice(start, end) + '\nthis.catalog = { PERMS, PERMS_AR, PERM_MODULES, ROLE_TEMPLATES };', env);
    const { PERMS, PERMS_AR, PERM_MODULES, ROLE_TEMPLATES } = env.catalog;
    expect(PERMS).toContain('shopify-reassign');
    expect(PERM_MODULES.find((group: any) => group.key === 'shopify').perms).toContain('shopify-reassign');
    expect(PERMS_AR['shopify-reassign']).toContain('Assignee');
    expect(ROLE_TEMPLATES.staff).not.toContain('shopify-reassign');
    expect(ROLE_TEMPLATES.viewer).not.toContain('shopify-reassign');
  });

  it.each(['openReassignOrderModal', 'saveReassignOrder', 'openSpAssignModal', 'saveSpAssign'])(
    'blocks %s before opening UI or making a request without the grant', async name => {
      const env: any = { hasPerm: jest.fn(() => false), toast: jest.fn(), t: (key: string) => key };
      runInNewContext(extract('_spRequireReassign') + '\n' + extract(name), env);
      await env[name](['order']);
      expect(env.hasPerm).toHaveBeenCalledWith('shopify-reassign');
      expect(env.toast).toHaveBeenCalledWith('spReassignDenied', true);
    },
  );

  it('renders the assignee as an action only for users holding the permission', () => {
    const env: any = { currentLang: 'en', hasPerm: () => false, esc: String, escHtml: String };
    runInNewContext(extract('_spStaffCellHtml'), env);
    const order = { _id: 'order', assignedToName: 'Malak', status: 'pending' };
    expect(env._spStaffCellHtml(order)).not.toContain('<button');
    env.hasPerm = (key: string) => key === 'shopify-reassign';
    expect(env._spStaffCellHtml(order)).toContain('openSpAssignModal');
    expect(env._spStaffCellHtml({ ...order, assignedToName: '' })).toContain('openSpAssignModal');
  });

  it('offers active staff from both the admin and employee user directories', () => {
    const env: any = { users: [{ _id: 'a', role: 'staff', isActive: true }, { _id: 'b', role: 'staff', active: true },
      { _id: 'c', role: 'staff', isActive: false }, { _id: 'd', role: 'staff', active: false }, { _id: 'admin', role: 'admin' }] };
    runInNewContext(extract('_spStaffList'), env);
    expect(env._spStaffList().map((user: any) => user._id)).toEqual(['a', 'b']);
  });

  it('allows an authorized employee to submit a reassignment through the existing API', async () => {
    const order = { _id: 'order', assignedTo: 'old-employee', ref: '123' };
    const env: any = { hasPerm: (key: string) => key === 'shopify-reassign', currentLang: 'en',
      qs: (selector: string) => selector === 'input[name="sp-asg-user"]:checked' ? { value: 'new-employee' } : null,
      _spOrderById: () => order, api: jest.fn().mockResolvedValue({ success: true }),
      closeModal: jest.fn(), loadShopifyOrders: jest.fn(), toast: jest.fn(), t: String,
    };
    runInNewContext(extract('_spRequireReassign') + '\n' + extract('saveSpAssign'), env);
    await env.saveSpAssign(['order']);
    expect(env.api).toHaveBeenCalledWith('/shopify/orders/order/reassign', { method: 'PATCH', body: JSON.stringify({ newEmployeeId: 'new-employee' }) });
    expect(env.loadShopifyOrders).toHaveBeenCalled();
  });
});
