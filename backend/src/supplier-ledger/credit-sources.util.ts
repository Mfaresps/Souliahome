/**
 * Where did the supplier credit used on a purchase invoice come from?
 *
 * A 'credit-used' row only says "7,000 of standing credit was consumed". The reader of the
 * invoice needs the earlier event behind it — usually an advance payment that left a named
 * vault on a known date. The ledger records that on the entry that CREATED the credit
 * ('advance-deposit' carries vaultSeg / vaultTxNo), so this walks the supplier's ledger in
 * order and allocates credit FIFO:
 *
 *   amount < 0 (reduces what we owe): first clears any debt; whatever drops the balance below
 *              zero becomes a credit lot remembering its source entry.
 *   'credit-used': consumes lots oldest-first; the rest is new debt.
 *   any other amount > 0: new debt. ⚠ A purchase posts its debt NET of the credit it applies,
 *              and before the 'credit-used' row — letting that debt draw on the lots would hand
 *              the credit's source to the wrong row.
 *
 * The slices consumed by the target row are its sources. Pure — no DB access.
 */
export interface LedgerRowLike {
  _id?: unknown;
  entryType: string;
  amount: number;
  date?: string;
  vaultSeg?: string;
  vaultTxNo?: string;
  refNo?: string;
  sourceRef?: string;
  desc?: string;
}

export interface CreditSource {
  amount: number;
  entryType: string;
  date: string;
  vaultSeg: string;
  vaultTxNo: string;
  refNo: string;
  sourceRef: string;
  desc: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function allocateCreditSources(rows: LedgerRowLike[], targetIndex: number): CreditSource[] {
  let debt = 0;
  const lots: Array<{ left: number; row: LedgerRowLike }> = [];
  for (let i = 0; i <= targetIndex && i < rows.length; i++) {
    const row = rows[i];
    const amt = Number(row.amount) || 0;
    if (amt < 0) {
      let reduce = -amt;
      const pay = Math.min(debt, reduce);
      debt = r2(debt - pay);
      reduce = r2(reduce - pay);
      if (reduce > 0) lots.push({ left: reduce, row });
      continue;
    }
    if (amt <= 0) continue;
    if (row.entryType !== 'credit-used') { debt = r2(debt + amt); continue; }
    let need = amt;
    const taken: CreditSource[] = [];
    while (need > 0.004 && lots.length) {
      const lot = lots[0];
      const use = Math.min(lot.left, need);
      lot.left = r2(lot.left - use);
      need = r2(need - use);
      if (i === targetIndex) {
        const s = lot.row;
        taken.push({
          amount: r2(use), entryType: s.entryType, date: String(s.date || ''),
          vaultSeg: String(s.vaultSeg || ''), vaultTxNo: String(s.vaultTxNo || ''),
          refNo: String(s.refNo || ''), sourceRef: String(s.sourceRef || ''), desc: String(s.desc || ''),
        });
      }
      if (lot.left <= 0.004) lots.shift();
    }
    debt = r2(debt + need);
    if (i === targetIndex) return taken;
  }
  return [];
}
