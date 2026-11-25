import 'reflect-metadata';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext, Script } from 'vm';
import { PermsGuard } from '../../src/core/guards/perms.guard';
import { PERMS_KEY } from '../../src/core/decorators/perms.decorator';
import { assertPickupEditable } from '../../src/core/pickup-access';
import { TransactionsController } from '../../src/transactions/transactions.controller';
import { BostaController } from '../../src/bosta/bosta.controller';
import { InventoryUnitsController } from '../../src/inventory-units/inventory-units.controller';
import { InventoryPacksController } from '../../src/inventory-units/inventory-packs.controller';

import { normalizeRolePermissions } from '../../src/users/access-role-permissions';

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

const grab = (name: string) => {
  const match = html.match(new RegExp('(?:async )?function ' + name + '\\([^]*?\\n\\}'));
  if (!match) throw new Error('Missing function: ' + name);
  return match[0];
};
const guard = new PermsGuard(new Reflector());
const allow = (controller: any, method: string, user: any) => guard.canActivate({
  getHandler: () => controller.prototype[method], getClass: () => controller,
  switchToHttp: () => ({ getRequest: () => ({ user }) }),
} as unknown as ExecutionContext);
const legacyEditor = { role: 'staff', perms: ['pickup-orders', 'pickup-orders-edit', 'inventory-units-view', 'inventory-units-allocate'] };
const viewer = { role: 'staff', perms: ['pickup-orders', 'movements', 'inventory-units-view', 'inventory-units-allocate'] };
const ACTIONS = ['pickup-orders-prepare','pickup-orders-move','pickup-orders-cancel','pickup-orders-bosta','pickup-orders-bosta-cancel'];
const holder = (perm: string) => ({ role: 'staff', perms: ['pickup-orders', perm, 'inventory-units-view', 'inventory-units-allocate'] });
// Each write and the one action that unlocks it (Nov 24, 2026 split of pickup-orders-edit).
const writes: [any, string, string][] = [
  [TransactionsController, 'setPickupPreparing', 'pickup-orders-move'],
  [TransactionsController, 'confirmPickup', 'pickup-orders-move'],
  [TransactionsController, 'undoPickup', 'pickup-orders-cancel'],
  [TransactionsController, 'returnPickupToPreparing', 'pickup-orders-move'],
  [TransactionsController, 'addToPickupRun', 'pickup-orders-move'],
  [TransactionsController, 'setPrepChecked', 'pickup-orders-prepare'],
  [TransactionsController, 'updatePickupOrder', 'pickup-orders-move'],
  [BostaController, 'createPickup', 'pickup-orders-bosta'],
  [BostaController, 'extendPickup', 'pickup-orders-bosta'],
  [BostaController, 'verifyPickupUpdate', 'pickup-orders-bosta'],
  [BostaController, 'createOrder', 'pickup-orders-bosta'],
  [BostaController, 'awbPrinted', 'pickup-orders-bosta'],
  [BostaController, 'cancelOrder', 'pickup-orders-bosta-cancel'],
  [BostaController, 'confirmCollection', 'pickup-orders-bosta'],
  ...['identify','pickException','pickScan','preparePicking'].map(method => [InventoryUnitsController, method, 'pickup-orders-prepare'] as [any,string,string]),
  ...['scan','undo'].map(method => [InventoryPacksController, method, 'pickup-orders-prepare'] as [any,string,string]),
];

describe('Pick-Up Orders access', () => {
  it('allows page data only with explicit view access or admin authority', () => {
    expect(allow(TransactionsController, 'getPickupOrders', viewer)).toBe(true);
    expect(allow(TransactionsController, 'getPickupOrders', { role: 'staff', perms: ['movements'] })).toBe(false);
    expect(allow(TransactionsController, 'getPickupOrders', { role: 'admin' })).toBe(true);
    expect(allow(TransactionsController, 'getPickupOrders', undefined)).toBe(false);
  });

  it.each(writes)('protects %p.%s with %s only', (controller, method, perm) => {
    expect(Reflect.getMetadata(PERMS_KEY, controller.prototype[method])).toEqual(expect.arrayContaining(['pickup-orders', perm]));
    expect(allow(controller, method, viewer)).toBe(false);
    expect(allow(controller, method, holder(perm))).toBe(true);
    for (const other of ACTIONS.filter(key => key !== perm)) expect(allow(controller, method, holder(other))).toBe(false);
    expect(allow(controller, method, { role: 'staff', perms: [perm, 'inventory-units-allocate', 'inventory-units-view'] })).toBe(false);
    expect(allow(controller, method, legacyEditor)).toBe(true); // the pre-split key still works
    expect(allow(controller, method, { role: 'admin' })).toBe(true);
    const guards = Reflect.getMetadata(GUARDS_METADATA, controller.prototype[method]) || Reflect.getMetadata(GUARDS_METADATA, controller);
    expect(guards).toContain(PermsGuard);
  });

  it('lets anyone who can view the board comment on an order', () => {
    expect(Reflect.getMetadata(PERMS_KEY, TransactionsController.prototype.addPickupComments)).toEqual(['pickup-orders']);
    expect(allow(TransactionsController, 'addPickupComments', viewer)).toBe(true);
    expect(allow(TransactionsController, 'addPickupComments', { role: 'staff', perms: ['movements'] })).toBe(false);
  });

  it('protects individual preparation actions without blocking unrelated inventory actions', () => {
    expect(() => assertPickupEditable(viewer)).toThrow(ForbiddenException);
    expect(() => assertPickupEditable(legacyEditor)).not.toThrow();
    expect(() => assertPickupEditable(holder('pickup-orders-prepare'), 'prepare')).not.toThrow();
    expect(() => assertPickupEditable(holder('pickup-orders-move'), 'prepare')).toThrow(ForbiddenException);
    const service = { action: jest.fn() };
    const controller = new InventoryUnitsController(service as any, undefined as any, undefined as any);
    for (const action of ['picking','prepare','undo-picking']) {
      expect(() => controller.action('unit', { action } as any, { user: viewer } as any)).toThrow(ForbiddenException);
      expect(() => controller.action('unit', { action } as any, { user: holder('pickup-orders-move') } as any)).toThrow(ForbiddenException);
    }
    controller.action('unit', { action: 'picking' } as any, { user: holder('pickup-orders-prepare') } as any);
    controller.action('unit', { action: 'inspect' } as any, { user: viewer } as any);
    expect(service.action).toHaveBeenCalledTimes(2);
  });

  it('keeps every inline script syntactically valid', () => {
    for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      if (/\bsrc\s*=|application\/ld\+json|application\/json/.test(match[1])) continue;
      expect(() => new Script(match[2])).not.toThrow();
    }
  });

  // Each Pick-Up function checks ITS action before any local or server change.
  it.each([['_puPersistPrepCheck','prepare'],['puCardPrepTick','prepare'],['_pwEnsurePickLines','prepare'],['_pwEnsurePickLinesImpl','prepare'],['pwRetryOrderScan','prepare'],['pwScanAnyOrderUnit','prepare'],['pwSkipDamagedLabel','prepare'],['pwScanOrderUnit','prepare'],['pwToggleManualScan','prepare'],['pwSubmitManualScan','prepare'],['_pwRetryLastScan','prepare'],['_pwSubmitScan','prepare'],['_pwDrainScans','prepare'],['pwUndoLastPick','prepare'],['_pwAutoPrepareScannedOrder','prepare'],['pucoTickOrder','prepare'],['_pucoTickOrderImpl','prepare'],['pwAckPrepEdit','prepare'],['openPrepGroupModal','move'],['submitPrepGroup','move'],['prepGroupMoveToReady','move'],['puConfirmMoveToReady','move'],['_puAddPendingToPrepGroup','move'],['puPtRowCheck','move'],['puPtToggleAll','move'],['puPtMoveSelected','move'],['pucoAddOrder','move'],['pucoReturnReadyToPrep','move'],['pucoMoveOrderToReady','move'],['pucoMoveGroupToReady','move'],['pucoMovePendingToPrep','move'],['puCardItemChange','move'],['puCardAddItem','move'],['puCardDelItem','move'],['puCardSave','move'],['puGroupSaveAll','move'],['puCreatePrepGroup','move'],['puMovePendingGroupToPrep','move'],['puGroupMoveToReady','move'],['puGroupUndoReadyToPrep','move'],['puJoinPrepGroup','move'],['openPuBulkModal','move'],['submitPuBulk','move'],['_puGroupDragStart','move'],['openPuEditModal','move'],['savePuEditDate','move'],['puEditMoveSelectedToRun','move'],['openCreatePickupModal','move'],['submitCreatePickup','move'],['openPickupBulkModal','move'],['runBulkPickup','move'],['openPuDateModal','move'],['savePuDateEdit','move'],['deletePrepGroup','cancel'],['pucoRemoveFromPrep','cancel'],['pucoRestoreFromReady','cancel'],['puGroupUndoReady','cancel'],['undoPickupRun','cancel'],['deletePickupRun','cancel'],['puEditRemoveOrder','cancel'],['pwSendToBosta','bosta'],['bulkSendToBosta','bosta']] as [string,string][])('%s checks the «%s» permission first', async (name, action) => {
    const src = grab(name);
    expect(src).toContain(`_puRequire('${action}')`);
    const asked: string[] = [];
    const env: any = { _puRequire: (a: string) => { asked.push(a); return false; }, currentLang: 'ar' };
    runInNewContext(src, env);
    await env[name]();
    expect(asked[0]).toBe(action);
  });

  it('a drop on Pending needs «cancel», elsewhere «move»', async () => {
    for (const [col, action] of [['pending','cancel'],['prep','move'],['ready','move']]) {
      const asked: string[] = [];
      const env: any = { _puRequire: (a: string) => { asked.push(a); return false; } };
      runInNewContext(grab('puBoardDrop'), env);
      await env.puBoardDrop({ preventDefault() {} }, col);
      expect(asked).toEqual([action]);
    }
  });

  it('blocks writes from invoice dialogs opened on the read-only page while allowing viewing and label preview', () => {
    const env: any = { currentPage: 'pickup-orders', _puCanEdit: () => false };
    runInNewContext(grab('_puRequestBlocked'), env);
    for (const path of ['/transactions/pickup-orders/confirm','/shipping/create-order/id','/inventory-units/unit/actions','/after-sales/case/approve']) {
      expect(env._puRequestBlocked(path, 'POST')).toBe(true);
    }
    expect(env._puRequestBlocked('/transactions/pickup-orders', 'GET')).toBe(false);
    expect(env._puRequestBlocked('/transactions/order/comments', 'POST')).toBe(false); // comments open to viewers
    expect(env._puRequestBlocked('/shipping/awb/id', 'POST')).toBe(false);
    expect(env._puRequestBlocked('/shipping/awb/id/printed', 'POST')).toBe(true);
    env.currentPage = 'movements';
    expect(env._puRequestBlocked('/transactions/order/comments', 'POST')).toBe(false);
  });

  it('every Pick-Up action includes view, and revoking view removes them all', () => {
    for (const key of ACTIONS) {
      expect(rbacReconcile([key], key, true).has('pickup-orders')).toBe(true);
      expect(normalizeRolePermissions([key])).toContain('pickup-orders');
    }
    const after = rbacReconcile(['pickup-orders', ...ACTIONS], 'pickup-orders', false);
    expect(ACTIONS.some(key => after.has(key))).toBe(false);
  });
});
