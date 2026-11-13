import 'reflect-metadata';
import { ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext, Script } from 'vm';
import { ShopifyController } from '../../src/shopify/shopify.controller';
import { PermsGuard } from '../../src/core/guards/perms.guard';
import { PERMS_KEY } from '../../src/core/decorators/perms.decorator';

import { normalizeRolePermissions } from '../../src/users/access-role-permissions';
import { DEFAULT_ACCESS_ROLES } from '../../src/users/access-roles.service';

const html = readFileSync(resolve(__dirname, '../../../frontend/public/index.html'), 'utf8');
const rbacSource = readFileSync(resolve(__dirname, '../../../frontend/public/roles-permissions.js'), 'utf8');
/** The Roles page editor's dependency rule (the only place grants are edited, Nov 13, 2026). */
function rbacReconcile(start: string[], changed?: string, checked?: boolean): Set<string> {
  const fn = rbacSource.match(/function reconcile\(changedKey, checked\) \{[\s\S]*?\n  \}/)?.[0];
  if (!fn) throw new Error('reconcile() not found in roles-permissions.js');
  const env: any = { ui: { draft: new Set(start) } };
  runInNewContext(fn + '\nreconcile(' + JSON.stringify(changed ?? null) + ',' + JSON.stringify(checked ?? null) + ');', env);
  return env.ui.draft;
}


function extract(fn: string) {
  const match = html.match(new RegExp('(?:async )?function ' + fn + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
  if (!match) throw new Error('Missing function: ' + fn);
  return match[0];
}

describe('Prepare and ship permission', () => {
  const guard = new PermsGuard(new Reflector());
  const canApprove = (user: any) => guard.canActivate({
    getHandler: () => ShopifyController.prototype.approve,
    getClass: () => ShopifyController,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext);

  it('protects the approval endpoint with the permission guard', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, ShopifyController.prototype.approve)).toContain(PermsGuard);
    expect(Reflect.getMetadata(PERMS_KEY, ShopifyController.prototype.approve)).toEqual(['shopify-prepare-ship']);
  });

  it('allows admins automatically and employees only with an explicit grant', () => {
    expect(canApprove({ role: 'admin', perms: [] })).toBe(true);
    expect(canApprove({ role: 'staff', perms: ['shopify-prepare-ship'] })).toBe(true);
    expect(canApprove({ role: 'viewer', perms: ['shopify-prepare-ship'] })).toBe(true);
    expect(canApprove({ role: 'viewer', perms: ['shopify-orders'] })).toBe(false);
    expect(canApprove({ role: 'staff', perms: ['shopify-orders', 'settings', 'inventory-units-allocate'] })).toBe(false);
    expect(canApprove({ role: 'staff' })).toBe(false);
    expect(canApprove(undefined)).toBe(false);
  });

  it('grants preparation and order access through the fulfillment role', () => {
    const perms = DEFAULT_ACCESS_ROLES.find(role => role.slug === 'fulfillment')!.perms;
    expect(perms).toEqual(expect.arrayContaining(['shopify-orders', 'shopify-prepare-ship']));
    expect(canApprove({ role: 'staff', perms })).toBe(true);
  });

  it('includes order access when granting Prep & Ship and revokes the action when order access is removed', () => {
    expect([...rbacReconcile(['shopify-prepare-ship'], 'shopify-prepare-ship', true)].sort()).toEqual(['shopify-orders', 'shopify-prepare-ship']);
    const revoked = rbacReconcile(['shopify-prepare-ship'], 'shopify-orders', false);
    expect(revoked.has('shopify-prepare-ship')).toBe(false);
    expect(normalizeRolePermissions(['shopify-prepare-ship'])).toContain('shopify-orders');
  });

  it('keeps every inline frontend script syntactically valid', () => {
    for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      if (/\bsrc\s*=|application\/ld\+json|application\/json/.test(match[1])) continue;
      expect(() => new Script(match[2])).not.toThrow();
    }
  });

  it.each(['approveShopifyOrder', '_confirmApproveShopify', 'bulkSendShopifyOrders',
    '_confirmBulkSendShopify', '_dpBulkSendReadyOrders', '_spPeekConfirmBoth'])(
    'blocks %s before opening a dialog or sending requests when permission is absent', async name => {
      const env: any = { hasPerm: jest.fn(() => false), toast: jest.fn(), t: (key: string) => key };
      runInNewContext(extract('_spRequirePrepareShip') + '\n' + extract(name), env);
      await env[name]('order-id');
      expect(env.hasPerm).toHaveBeenCalledWith('shopify-prepare-ship');
      expect(env.toast).toHaveBeenCalledWith('spPrepareShipDenied', true);
    },
  );
});
