import { randomUUID } from 'crypto';
import { Connection, Types } from 'mongoose';

/**
 * An order edited while it is being prepared.
 *
 * Example: an order of 4 products, the picker scanned product A, then someone
 * removes product A from the order. Before this, the scanned piece stayed
 * `picking` and assigned to a line that no longer exists: it dropped out of the
 * picking summary (nobody could see it) and out of available stock for good.
 *
 * Rules (one pass, after the edit is saved):
 * - A piece whose line was removed, or whose line now holds another product, goes
 *   back to stock (`available`, no assignment, event `picking-undone`).
 * - A line whose quantity went down keeps at most its new quantity: «without
 *   scan» skips are dropped first, then the newest scanned pieces.
 * - Skips on a removed line are switched off.
 * - Every piece that went back is named on the order (`prepEditNotice.released`)
 *   so the picker knows exactly which piece to put back on the shelf.
 * - «تم التحضير» is cleared only when the order is no longer fully covered.
 * Nothing here touches stock balances, money or the movement log: an assignment
 * is a custody claim, not a stock movement.
 */

const HELD = ['reserved', 'picking', 'prepared'];

export interface PickLine { lineId?: string; code?: string; name?: string; qty?: number }
export interface HeldUnit { _id: any; productId: string; status: string; assignment: { transactionId: string; lineId: string }; updatedAt?: any; barcode?: string }
export interface EditDiff {
  removed: Array<{ code: string; name: string; qty: number }>;
  added: Array<{ code: string; name: string; qty: number }>;
  changed: Array<{ code: string; name: string; from: number; to: number }>;
}

const code = (v: unknown) => String(v ?? '').trim();
const qtyOf = (line: PickLine) => (Number.isSafeInteger(Number(line.qty)) ? Number(line.qty) : 0);

/** What changed in the items, by line id (else code). Pure. */
export function diffOrderLines(before: PickLine[], after: PickLine[]): EditDiff {
  const key = (line: PickLine) => line.lineId ? 'id:' + line.lineId : 'code:' + code(line.code);
  const prior = new Map(before.map(line => [key(line), line]));
  const next = new Map(after.map(line => [key(line), line]));
  const diff: EditDiff = { removed: [], added: [], changed: [] };
  for (const [k, line] of prior) {
    const now = next.get(k);
    if (!now || code(now.code) !== code(line.code)) diff.removed.push({ code: code(line.code), name: line.name || '', qty: qtyOf(line) });
    else if (qtyOf(now) !== qtyOf(line)) diff.changed.push({ code: code(line.code), name: line.name || now.name || '', from: qtyOf(line), to: qtyOf(now) });
  }
  for (const [k, line] of next) {
    const was = prior.get(k);
    if (!was || code(was.code) !== code(line.code)) diff.added.push({ code: code(line.code), name: line.name || '', qty: qtyOf(line) });
  }
  return diff;
}

/** Which pieces go back and which skips are switched off. Pure. */
export function planPickingAfterEdit(sale: { items?: PickLine[]; pickingExceptions?: any[] }, units: HeldUnit[], codeOfProduct: Map<string, string>) {
  const lines = new Map((sale.items || []).filter(line => line.lineId).map(line => [String(line.lineId), line]));
  const release: HeldUnit[] = [];
  const undoSkipIds: string[] = [];
  const activeSkips = (sale.pickingExceptions || []).filter((e: any) => e.active === true && e.kind === 'damaged-label');
  // Skips whose line is gone (or now another product) stop counting.
  for (const skip of activeSkips) {
    const line = lines.get(String(skip.lineId));
    if (!line || code(line.code) !== code(skip.sku)) undoSkipIds.push(skip.id);
  }
  const byLine = new Map<string, HeldUnit[]>();
  for (const unit of units) {
    const line = lines.get(String(unit.assignment?.lineId));
    if (!line || codeOfProduct.get(String(unit.productId)) !== code(line.code)) { release.push(unit); continue; }
    byLine.set(String(line.lineId), [...(byLine.get(String(line.lineId)) || []), unit]);
  }
  let complete = true;
  for (const [lineId, line] of lines) {
    const qty = qtyOf(line);
    const skips = activeSkips.filter((e: any) => String(e.lineId) === lineId && code(e.sku) === code(line.code) && !undoSkipIds.includes(e.id))
      .sort((a: any, b: any) => String(b.at || '').localeCompare(String(a.at || '')));
    const held = (byLine.get(lineId) || []).sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime());
    let excess = skips.length + held.length - qty;
    // A lower quantity drops «without scan» skips first: a scanned piece is real evidence.
    for (const skip of skips) { if (excess <= 0) break; undoSkipIds.push(skip.id); excess--; }
    for (const unit of held) { if (excess <= 0) break; release.push(unit); excess--; }
    const keptHeld = held.filter(unit => !release.includes(unit));
    const keptSkips = skips.filter((skip: any) => !undoSkipIds.includes(skip.id)).length;
    if (keptHeld.filter(unit => unit.status === 'prepared').length + keptSkips !== qty) complete = false;
  }
  return { release, undoSkipIds, complete };
}

/**
 * Applies the plan to a sale that was just edited. Runs only for a sale in
 * preparation (Preparing / Ready, nothing handed to the courier). Returns the
 * notice it stored, or null when the edit did not touch preparation.
 */
export async function reconcilePickingAfterEdit(connection: Connection, saleId: string, beforeItems: PickLine[], by: string, actorId?: string) {
  const transactions = connection.collection('transactions');
  const sale: any = await transactions.findOne({ _id: new Types.ObjectId(saleId) });
  if (!sale || sale.type !== 'مبيعات' || sale.cancelled || sale.archived) return null;
  if (!['Preparing', 'Ready'].includes(String(sale.pickupStatus || '')) || sale.shippedAt || sale.deliveredAt) return null;
  if (sale.bostaStatus && !['CREATED', 'VALIDATION_ERROR'].includes(String(sale.bostaStatus))) return null;
  const diff = diffOrderLines(beforeItems || [], sale.items || []);
  if (!diff.removed.length && !diff.added.length && !diff.changed.length) return null;

  const units: any[] = await connection.collection('inventoryunits').find({ 'assignment.transactionId': saleId, status: { $in: HELD } }).toArray();
  const productIds = [...new Set(units.map(u => String(u.productId)))].filter(id => Types.ObjectId.isValid(id));
  const products = productIds.length ? await connection.collection('products').find({ _id: { $in: productIds.map(id => new Types.ObjectId(id)) } }, { projection: { code: 1, name: 1 } }).toArray() : [];
  const codeOfProduct = new Map(products.map((p: any) => [String(p._id), code(p.code)]));
  const nameOfProduct = new Map(products.map((p: any) => [String(p._id), String(p.name || '')]));
  const plan = planPickingAfterEdit(sale, units, codeOfProduct);

  let actor: any = null;
  if (plan.release.length) {
    if (actorId && /^[a-f\d]{24}$/i.test(actorId)) actor = await connection.collection('users').findOne({ _id: new Types.ObjectId(actorId) });
    if (!actor && by) actor = await connection.collection('users').findOne({ $or: [{ name: by }, { username: by }] });
  }
  const codes = plan.release.length ? await connection.collection('inventoryunitcodes')
    .find({ _id: { $in: plan.release.map(u => new Types.ObjectId(String(u._id))) } }).toArray() : [];
  const manual = new Map(codes.map((row: any) => [String(row._id), `U-${String(row.code).slice(0, 4)}-${String(row.code).slice(4, 8)}-${String(row.code).slice(8)}`]));

  const now = new Date().toISOString();
  const notice = {
    id: randomUUID(), at: now, by,
    ...diff,
    released: plan.release.map(u => ({ unitId: String(u._id), barcode: u.barcode || '', manualCode: manual.get(String(u._id)) || '',
      code: codeOfProduct.get(String(u.productId)) || '', name: nameOfProduct.get(String(u.productId)) || '' })),
    skipsUndone: plan.undoSkipIds.length,
    prepReset: sale.prepChecked === true && !plan.complete,
  };

  const session = await connection.startSession();
  try {
    await session.withTransaction(async () => {
      const exceptions = (sale.pickingExceptions || []).map((entry: any) => plan.undoSkipIds.includes(entry.id)
        ? { ...entry, active: false, undoneBy: by, undoneAt: now, undoReason: 'Order edited during preparation' } : entry);
      // Locks the sale: a scan in flight against the old lines must retry against the new ones.
      await transactions.updateOne({ _id: sale._id }, {
        $set: { pickingExceptions: exceptions, prepEditNotice: notice, ...(notice.prepReset ? { prepChecked: false } : {}) },
        $inc: { unitTrackingRevision: 1 },
        $push: { pickupHistory: { action: 'edit-during-prep', date: now, by, released: notice.released.length,
          removed: diff.removed.length, added: diff.added.length, changed: diff.changed.length } } as any,
      }, { session });
      if (!plan.release.length) return;
      if (!actor) throw new Error('Actor required to release pieces');
      const Unit = connection.model('InventoryUnit'), Event = connection.model('InventoryUnitEvent');
      const operationKey = `prep-edit:${notice.id}`;
      for (const productId of [...new Set(plan.release.map(u => String(u.productId)))]) {
        await connection.collection('products').updateOne({ _id: new Types.ObjectId(productId) }, { $inc: { unitTrackingRevision: 1 } }, { session });
      }
      for (const held of plan.release) {
        const unit: any = await Unit.findOne({ _id: held._id, 'assignment.transactionId': saleId, status: { $in: HELD } }).session(session);
        if (!unit) continue;
        const fromStatus = unit.status, assignment = unit.assignment;
        const last: any = await Event.findOne({ unitId: String(unit._id) }).sort({ sequence: -1 }).session(session).lean();
        unit.status = 'available'; unit.assignment = null;
        await unit.save({ session });
        await new Event({ unitId: String(unit._id), sequence: (last?.sequence || 0) + 1, operationKey,
          action: 'picking-undone', fromStatus, toStatus: 'available', transactionId: assignment.transactionId, lineId: assignment.lineId,
          byUserId: String(actor._id), by: actor.name || actor.username || by, reason: 'Order edited during preparation; piece no longer needed',
          details: { prepEdit: true, previousAssignment: assignment, packId: unit.packId || null, stockChanged: false },
        }).save({ session });
      }
    });
  } finally { await session.endSession(); }
  return notice;
}
