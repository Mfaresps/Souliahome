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

const html = readFileSync(resolve(__dirname, '../../../frontend/public/index.html'), 'utf8');

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

  it('grants preparation and order access through the fulfillment job preset', () => {
    const templates = html.match(/const JOB_TEMPLATES = \{[\s\S]*?\n\};/);
    expect(templates).not.toBeNull();
    const perms = runInNewContext(templates![0] + '\nJOB_TEMPLATES.fulfillment.perms');
    expect(perms).toEqual(expect.arrayContaining(['shopify-orders', 'shopify-prepare-ship']));
    expect(canApprove({ role: 'staff', perms })).toBe(true);
  });

  it('includes order access when granting Prep & Ship and revokes the action when order access is removed', () => {
    const orders = { value: 'shopify-orders', checked: false };
    const prepareShip = { value: 'shopify-prepare-ship', checked: true };
    const env: any = {
      qs: (selector: string) => selector === '.perm-cb[value="shopify-orders"]' ? orders
        : selector === '.perm-cb[value="shopify-prepare-ship"]' ? prepareShip : null,
      qsa: () => [],
    };
    runInNewContext(extract('onPermCbChange') + '\n' + extract('refreshPermModules'), env);
    env.onPermCbChange(prepareShip);
    expect(orders.checked).toBe(true);
    expect(prepareShip.checked).toBe(true);
    orders.checked = false;
    env.onPermCbChange(orders);
    expect(orders.checked).toBe(false);
    expect(prepareShip.checked).toBe(false);
    orders.checked = true;
    env.onPermCbChange(orders);
    expect(prepareShip.checked).toBe(false);
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
