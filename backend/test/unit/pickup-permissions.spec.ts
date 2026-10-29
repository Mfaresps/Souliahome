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

const html = readFileSync(resolve(__dirname, '../../../frontend/public/index.html'), 'utf8');
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
const editor = { role: 'staff', perms: ['pickup-orders', 'pickup-orders-edit', 'inventory-units-view', 'inventory-units-allocate'] };
const viewer = { role: 'staff', perms: ['pickup-orders', 'movements', 'inventory-units-view', 'inventory-units-allocate'] };
const writes: [any, string][] = [
  ...['setPickupPreparing','confirmPickup','undoPickup','returnPickupToPreparing','addToPickupRun','setPrepChecked','updatePickupOrder','addPickupComments'].map(method => [TransactionsController, method] as [any,string]),
  ...['createPickup','extendPickup','verifyPickupUpdate','createOrder','awbPrinted','cancelOrder','confirmCollection'].map(method => [BostaController, method] as [any,string]),
  ...['identify','pickException','pickScan'].map(method => [InventoryUnitsController, method] as [any,string]),
  ...['scan','undo'].map(method => [InventoryPacksController, method] as [any,string]),
];

describe('Pick-Up Orders access', () => {
  it('allows page data only with explicit view access or admin authority', () => {
    expect(allow(TransactionsController, 'getPickupOrders', viewer)).toBe(true);
    expect(allow(TransactionsController, 'getPickupOrders', { role: 'staff', perms: ['movements'] })).toBe(false);
    expect(allow(TransactionsController, 'getPickupOrders', { role: 'admin' })).toBe(true);
    expect(allow(TransactionsController, 'getPickupOrders', undefined)).toBe(false);
  });

  it.each(writes)('protects every pickup mutation on %p.%s', (controller, method) => {
    expect(Reflect.getMetadata(PERMS_KEY, controller.prototype[method])).toEqual(expect.arrayContaining(['pickup-orders','pickup-orders-edit']));
    expect(allow(controller, method, viewer)).toBe(false);
    expect(allow(controller, method, { ...editor, perms: ['pickup-orders-edit','inventory-units-allocate'] })).toBe(false);
    expect(allow(controller, method, editor)).toBe(true);
    expect(allow(controller, method, { role: 'admin' })).toBe(true);
    const guards = Reflect.getMetadata(GUARDS_METADATA, controller.prototype[method]) || Reflect.getMetadata(GUARDS_METADATA, controller);
    expect(guards).toContain(PermsGuard);
  });

  it('protects individual preparation actions without blocking unrelated inventory actions', () => {
    expect(() => assertPickupEditable(viewer)).toThrow(ForbiddenException);
    expect(() => assertPickupEditable(editor)).not.toThrow();
    const service = { action: jest.fn() };
    const controller = new InventoryUnitsController(service as any, undefined as any, undefined as any);
    for (const action of ['picking','prepare','undo-picking']) {
      expect(() => controller.action('unit', { action } as any, { user: viewer } as any)).toThrow(ForbiddenException);
    }
    controller.action('unit', { action: 'inspect' } as any, { user: viewer } as any);
    expect(service.action).toHaveBeenCalledTimes(1);
  });

  it('keeps every inline script syntactically valid', () => {
    for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      if (/\bsrc\s*=|application\/ld\+json|application\/json/.test(match[1])) continue;
      expect(() => new Script(match[2])).not.toThrow();
    }
  });

  it.each(["openPrepGroupModal","submitPrepGroup","deletePrepGroup","prepGroupMoveToReady","puConfirmMoveToReady","_puAddPendingToPrepGroup","puPtRowCheck","puPtToggleAll","puPtMoveSelected","_puPersistPrepCheck","puCardPrepTick","_pwEnsurePickLines","_pwEnsurePickLinesImpl","pwRetryOrderScan","pwScanAnyOrderUnit","pwSkipDamagedLabel","pwScanOrderUnit","pwToggleManualScan","pwSubmitManualScan","_pwRetryLastScan","_pwSubmitScan","_pwDrainScans","pwUndoLastPick","pwAddComment","_pwAutoPrepareScannedOrder","pucoTickOrder","_pucoTickOrderImpl","pucoAddOrder","pucoRemoveFromPrep","pucoRestoreFromReady","pucoReturnReadyToPrep","pucoMoveOrderToReady","pucoMoveGroupToReady","pucoMovePendingToPrep","puCardItemChange","puCardAddItem","puCardDelItem","puCardSave","puGroupSaveAll","puCreatePrepGroup","puMovePendingGroupToPrep","puGroupMoveToReady","puGroupUndoReady","puGroupUndoReadyToPrep","puJoinPrepGroup","openPuBulkModal","submitPuBulk","_puGroupDragStart","puBoardDrop","undoPickupRun","deletePickupRun","openPuEditModal","savePuEditDate","puEditRemoveOrder","puEditMoveSelectedToRun","openCreatePickupModal","submitCreatePickup","openPickupBulkModal","runBulkPickup","openPuDateModal","savePuDateEdit"])('blocks %s before any local or server change', async name => {
    const env: any = { _puRequireEdit: () => false };
    runInNewContext(grab(name), env);
    await env[name]();
  });

  it('blocks writes from invoice dialogs opened on the read-only page while allowing viewing and label preview', () => {
    const env: any = { currentPage: 'pickup-orders', _puCanEdit: () => false };
    runInNewContext(grab('_puRequestBlocked'), env);
    for (const path of ['/transactions/order/comments','/transactions/pickup-orders/confirm','/shipping/create-order/id','/inventory-units/unit/actions','/after-sales/case/approve']) {
      expect(env._puRequestBlocked(path, 'POST')).toBe(true);
    }
    expect(env._puRequestBlocked('/transactions/pickup-orders', 'GET')).toBe(false);
    expect(env._puRequestBlocked('/shipping/awb/id', 'POST')).toBe(false);
    expect(env._puRequestBlocked('/shipping/awb/id/printed', 'POST')).toBe(true);
    env.currentPage = 'movements';
    expect(env._puRequestBlocked('/transactions/order/comments', 'POST')).toBe(false);
  });

  it('automatically includes view when granting edit and removes edit when revoking view', () => {
    const view = { value: 'pickup-orders', checked: false }, edit = { value: 'pickup-orders-edit', checked: true };
    const env: any = { qsa: () => [], qs: (selector: string) => selector === '.perm-cb[value="pickup-orders"]' ? view
      : selector === '.perm-cb[value="pickup-orders-edit"]' ? edit : null };
    runInNewContext(grab('onPermCbChange') + '\n' + grab('refreshPermModules'), env);
    env.onPermCbChange(edit);
    expect(view.checked).toBe(true);
    view.checked = false; env.onPermCbChange(view);
    expect(edit.checked).toBe(false);
  });
});

