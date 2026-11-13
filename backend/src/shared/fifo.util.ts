/**
 * FIFO cost layers — pure rules, no database (phase 1 of the FIFO plan, Nov 13, 2026).
 *
 * A purchase line creates a layer: a quantity and its cost (after the invoice discount).
 * An outflow (sale, negative adjustment, supplier return) takes from the oldest open layer first.
 *
 * ⚠ Not wired to any live path yet. Nothing in the app calls this: the live cost still comes
 *   from `lineUnitCost` / `avgCost`. The historical preview (`inventory-costing/fifo-preview.ts`)
 *   is the only caller.
 *
 * Rules the tests lock in:
 * - **An outflow never fails for lack of stock.** The uncovered part is costed at a provisional
 *   cost (the last known layer cost) and kept as an open deficit. The next layer that arrives
 *   settles it first; the gap between the provisional and the real cost is a `variance` dated
 *   at the layer's arrival. **The outflow's own cost never changes afterwards.**
 * - Every outflow is recorded under an `eventKey`; a repeated key returns the first result
 *   and consumes nothing (idempotency).
 * - Release (cancel / sound customer return / order edit down) puts qty back on the SAME
 *   layers, newest allocation first. A deficit not yet settled is cancelled before any layer.
 * - A purchase edit that lowers a layer below what was already consumed is refused here
 *   (`needsReplay`), never silently fixed.
 */

export type FifoLayerKind = 'purchase' | 'opening' | 'adjustment' | 'customer-return';
/** actual = from an invoice · card / implied = an estimate a person must review. */
export type FifoConfidence = 'actual' | 'card' | 'implied' | 'line-cost';

export interface FifoLayer {
  id: string;
  kind: FifoLayerKind;
  at: number;                 // entry time (ms) — the order layers are consumed in
  originalQty: number;
  remainingQty: number;
  unitCost: number;
  confidence: FifoConfidence;
  sourceTxId?: string;
  sourceRef?: string;
  supplierId?: string;
  supplierName?: string;
  businessDate?: string;
}

export interface FifoAllocation {
  layerId: string | null;     // null = the uncovered part, still a deficit
  qty: number;
  unitCost: number;           // the cost booked for this part
  deficitId?: string;
}

export interface FifoDeficit {
  id: string;
  eventKey: string;
  at: number;
  qty: number;                // still uncovered
  originalQty: number;
  provisionalCost: number;
  provisionalSource: string;
  settlements: Array<{ layerId: string; qty: number; actualCost: number; at: number; variance: number }>;
  cancelledQty: number;
}

export interface FifoVariance {
  at: number;
  kind: 'deficit-settled' | 'supplier-return' | 'purchase-revalued' | 'return-restore';
  eventKey: string;
  layerId?: string;
  qty: number;
  amount: number;             // + = more cost than booked, − = less
}

export interface ConsumeResult {
  eventKey: string;
  qty: number;
  allocations: FifoAllocation[];
  shortQty: number;
  totalCost: number;
  unitCost: number;
  repeated: boolean;
}

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const round6 = (n: number) => Math.round((Number(n) || 0) * 1e6) / 1e6;

/** One product's FIFO state. Deterministic: the same calls in the same order give the same result. */
export class FifoBook {
  layers: FifoLayer[] = [];
  deficits: FifoDeficit[] = [];
  variances: FifoVariance[] = [];
  private outflows = new Map<string, ConsumeResult>();
  private deficitSeq = 0;

  constructor(readonly code: string, private readonly fallbackCost: () => { cost: number; source: string } = () => ({ cost: 0, source: 'none' })) {}

  /** The cost used for an uncovered outflow: the newest layer's cost, else the fallback. */
  provisionalCost(): { cost: number; source: string } {
    for (let i = this.layers.length - 1; i >= 0; i--) {
      const l = this.layers[i];
      if (l.kind !== 'customer-return') return { cost: l.unitCost, source: `layer:${l.sourceRef || l.id}` };
    }
    return this.fallbackCost();
  }

  openQty(): number {
    return this.layers.reduce((s, l) => s + l.remainingQty, 0);
  }

  openDeficitQty(): number {
    return this.deficits.reduce((s, d) => s + d.qty, 0);
  }

  /** Signed on-hand quantity: open layers minus uncovered outflows. */
  balance(): number {
    return this.openQty() - this.openDeficitQty();
  }

  value(): number {
    return round2(this.layers.reduce((s, l) => s + l.remainingQty * l.unitCost, 0));
  }

  getLayer(id: string): FifoLayer | undefined {
    return this.layers.find((l) => l.id === id);
  }

  outflow(eventKey: string): ConsumeResult | undefined {
    return this.outflows.get(eventKey);
  }

  /** Adds a layer. Open deficits are settled from it first (oldest deficit first). */
  addLayer(input: Omit<FifoLayer, 'remainingQty'> & { remainingQty?: number }): FifoLayer {
    const qty = Math.max(0, Number(input.originalQty) || 0);
    if (this.layers.some((l) => l.id === input.id)) throw new Error(`duplicate layer ${input.id}`);
    const layer: FifoLayer = { ...input, originalQty: qty, remainingQty: qty, unitCost: round6(input.unitCost) };
    this.layers.push(layer);
    this.layers.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    this.settleDeficitsFrom(layer);
    return layer;
  }

  private settleDeficitsFrom(layer: FifoLayer) {
    for (const d of this.deficits) {
      if (layer.remainingQty <= 0) break;
      if (d.qty <= 0) continue;
      const take = Math.min(d.qty, layer.remainingQty);
      layer.remainingQty -= take;
      d.qty -= take;
      const variance = round2((layer.unitCost - d.provisionalCost) * take);
      d.settlements.push({ layerId: layer.id, qty: take, actualCost: layer.unitCost, at: layer.at, variance });
      if (variance !== 0) this.variances.push({ at: layer.at, kind: 'deficit-settled', eventKey: d.eventKey, layerId: layer.id, qty: take, amount: variance });
    }
  }

  /**
   * Takes `qty` FIFO. `prefer` lists layers to take from first (a supplier return names the
   * invoice it goes back to); anything they cannot cover is taken FIFO from the rest.
   */
  consume(eventKey: string, qty: number, at: number, opts: { prefer?: Array<{ layerId: string; qty?: number }> } = {}): ConsumeResult {
    const done = this.outflows.get(eventKey);
    if (done) return { ...done, repeated: true };
    const want = Math.max(0, Number(qty) || 0);
    let need = want;
    const allocations: FifoAllocation[] = [];
    const take = (layer: FifoLayer, max: number) => {
      const n = Math.min(max, layer.remainingQty, need);
      if (n <= 0) return;
      layer.remainingQty -= n;
      need -= n;
      const last = allocations[allocations.length - 1];
      if (last && last.layerId === layer.id) last.qty += n;
      else allocations.push({ layerId: layer.id, qty: n, unitCost: layer.unitCost });
    };
    for (const p of opts.prefer || []) {
      const layer = this.getLayer(p.layerId);
      if (layer) take(layer, p.qty ?? Infinity);
    }
    for (const layer of this.layers) {
      if (need <= 0) break;
      take(layer, Infinity);
    }
    let shortQty = 0;
    if (need > 0) {
      shortQty = need;
      const prov = this.provisionalCost();
      const id = `deficit:${++this.deficitSeq}:${eventKey}`;
      this.deficits.push({ id, eventKey, at, qty: need, originalQty: need, provisionalCost: round6(prov.cost), provisionalSource: prov.source, settlements: [], cancelledQty: 0 });
      allocations.push({ layerId: null, qty: need, unitCost: round6(prov.cost), deficitId: id });
      need = 0;
    }
    const totalCost = round2(allocations.reduce((s, a) => s + a.qty * a.unitCost, 0));
    const result: ConsumeResult = { eventKey, qty: want, allocations, shortQty, totalCost, unitCost: want ? round6(totalCost / want) : 0, repeated: false };
    this.outflows.set(eventKey, result);
    return result;
  }

  /**
   * Puts `qty` of an earlier outflow back (cancel, sound customer return, edit down).
   * Newest allocation first. A deficit part: if still open it is cancelled; if already settled,
   * the qty goes back to the layer that settled it. Returns the cost released (at booked cost).
   */
  release(eventKey: string, qty: number, at: number, releaseKey?: string): { releasedQty: number; releasedCost: number; restored: Array<{ layerId: string | null; qty: number }> } {
    const out = this.outflows.get(eventKey);
    if (!out) return { releasedQty: 0, releasedCost: 0, restored: [] };
    let left = Math.max(0, Math.min(Number(qty) || 0, out.allocations.reduce((s, a) => s + a.qty, 0)));
    let releasedCost = 0;
    const restored: Array<{ layerId: string | null; qty: number }> = [];
    for (let i = out.allocations.length - 1; i >= 0 && left > 0; i--) {
      const a = out.allocations[i];
      const n = Math.min(a.qty, left);
      if (n <= 0) continue;
      if (a.layerId) {
        const layer = this.getLayer(a.layerId);
        if (layer) layer.remainingQty += n;
        restored.push({ layerId: a.layerId, qty: n });
      } else {
        const d = this.deficits.find((x) => x.id === a.deficitId);
        let fromOpen = 0;
        if (d) {
          fromOpen = Math.min(d.qty, n);
          d.qty -= fromOpen;
          d.cancelledQty += fromOpen;
          // already settled → back to the settling layers, newest settlement first
          let rest = n - fromOpen;
          for (let j = d.settlements.length - 1; j >= 0 && rest > 0; j--) {
            const s = d.settlements[j];
            const m = Math.min(s.qty, rest);
            const layer = this.getLayer(s.layerId);
            if (layer) layer.remainingQty += m;
            s.qty -= m;
            rest -= m;
            restored.push({ layerId: s.layerId, qty: m });
            // the settled variance for these pieces is undone with them
            const undo = round2((s.actualCost - a.unitCost) * m);
            if (undo !== 0) this.variances.push({ at, kind: 'return-restore', eventKey: releaseKey || eventKey, layerId: s.layerId, qty: m, amount: -undo });
          }
        }
        if (fromOpen) restored.push({ layerId: null, qty: fromOpen });
      }
      a.qty -= n;
      left -= n;
      releasedCost += n * a.unitCost;
    }
    out.allocations = out.allocations.filter((a) => a.qty > 0);
    const releasedQty = (Number(qty) || 0) - left;
    return { releasedQty, releasedCost: round2(releasedCost), restored };
  }

  /** Changes an invoice layer's cost. Remaining pieces take the new cost; consumed ones post a variance. */
  revalueLayer(layerId: string, newCost: number, at: number, eventKey: string): number {
    const layer = this.getLayer(layerId);
    if (!layer) return 0;
    const consumed = layer.originalQty - layer.remainingQty;
    const variance = round2((newCost - layer.unitCost) * consumed);
    layer.unitCost = round6(newCost);
    if (variance !== 0) this.variances.push({ at, kind: 'purchase-revalued', eventKey, layerId, qty: consumed, amount: variance });
    return variance;
  }

  /** Changes an invoice layer's quantity. Below what was already consumed → refused. */
  resizeLayer(layerId: string, newQty: number): { ok: true } | { ok: false; needsReplay: true; consumed: number } {
    const layer = this.getLayer(layerId);
    if (!layer) return { ok: true };
    const consumed = layer.originalQty - layer.remainingQty;
    if (newQty < consumed) return { ok: false, needsReplay: true, consumed };
    layer.originalQty = newQty;
    layer.remainingQty = newQty - consumed;
    this.settleDeficitsFrom(layer);
    return { ok: true };
  }
}

/** Cost of a supplier-return part taken from a layer vs the refund value → variance (refund − cost). */
export function supplierReturnVariance(result: ConsumeResult, refundUnitCost: number): number {
  return round2(result.allocations.reduce((s, a) => s + a.qty * (refundUnitCost - a.unitCost), 0));
}
