import * as ExcelJS from 'exceljs';
import { CarrierStatementService } from '../../src/transactions/carrier-statement.service';
import {
  normalizeRef,
  normalizeTracking,
  parseMoney,
  normalizePhone,
  namesLookAlike,
  varianceLevel,
  NET_VALUE_TOLERANCE,
} from '../../src/shared/carrier-statement.constants';

/**
 * Carrier settlement-file parsing and classification.
 *
 * The fixtures mirror a REAL Bosta «Cash Cycles» export (28-08-2026) — including the two shapes of
 * `Order Reference` it actually contains ("2432" bare and "#2377" prefixed) and the fee columns
 * whose sum is `Total Fees`. Where a value below looks oddly specific, it was copied from that
 * file rather than invented.
 */

const HEADERS = [
  'Order Id', 'Order Status', 'Order Reference', 'Customer Name', 'Customer Phone',
  'COD', 'Shipping Fees', 'Insurance Fees', 'VAT', 'Total Fees', 'Net Value', 'Dropoff City',
];

async function sheet(rows: any[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Cash Cycles');
  ws.addRow(HEADERS);
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** [orderId, status, ref, name, phone, cod, ship, ins, vat, totalFees, netValue, city] */
const row = (
  id: string, status: string, ref: string, name: string, phone: string,
  cod: any, ship: number, ins: number, vat: number, fees: any, net: any, city = 'Cairo',
) => [id, status, ref, name, phone, cod, ship, ins, vat, fees, net, city];

const TX = [
  { _id: 'a', ref: '2432', type: 'مبيعات', remaining: 1380, shipCost: 145, payStatus: 'معلق', cancelled: false, client: 'انجي ابراهيم', phone: '01119897047', bostaTrackingNumber: '7776543002' },
  { _id: 'b', ref: '2434', type: 'مبيعات', remaining: 1730, shipCost: 145, payStatus: 'معلق', cancelled: false, client: 'ندي جمال حمزة', phone: '01020282104', bostaTrackingNumber: '8438863252' },
  { _id: 'c', ref: '500', type: 'مبيعات', remaining: 0, shipCost: 120, payStatus: 'مكتمل', cancelled: false, client: 'محصل', phone: '01000000001', bostaTrackingNumber: '900500' },
  { _id: 'd', ref: '501', type: 'مبيعات', remaining: 300, shipCost: 120, payStatus: 'معلق', cancelled: true, client: 'ملغية', phone: '01000000002', bostaTrackingNumber: '900501' },
  { _id: 'e', ref: '502', type: 'مشتريات', remaining: 400, shipCost: 0, payStatus: 'معلق', cancelled: false, client: 'مورد', phone: '', bostaTrackingNumber: '900502' },
  { _id: 'f', ref: '503', type: 'مبيعات', remaining: 600, shipCost: 120, payStatus: 'معلق', cancelled: false, client: 'هدى سمير', phone: '01077778888', bostaTrackingNumber: '900503' },
  // conflict pair: the file's ref points here, its tracking points at 'h'
  { _id: 'g', ref: '504', type: 'مبيعات', remaining: 700, shipCost: 120, payStatus: 'معلق', cancelled: false, client: 'ن', phone: '01099990000', bostaTrackingNumber: '111111' },
  { _id: 'h', ref: '505', type: 'مبيعات', remaining: 800, shipCost: 120, payStatus: 'معلق', cancelled: false, client: 'م', phone: '01088887777', bostaTrackingNumber: '900505' },
];

function mockModel() {
  return {
    find: (q: any) => ({
      lean: () => ({
        exec: async () => {
          const refs = (q.$or || []).find((o: any) => o.ref)?.ref?.$in || [];
          const trks = (q.$or || []).find((o: any) => o.bostaTrackingNumber)?.bostaTrackingNumber?.$in || [];
          return TX.filter((t) => refs.includes(t.ref) || trks.includes(t.bostaTrackingNumber));
        },
      }),
    }),
  } as any;
}

const svc = () => new CarrierStatementService(mockModel());

describe('carrier statement — normalisation helpers', () => {
  it('strips the # the real file carries on some references', () => {
    // Measured: the sample file holds both "2432" and "#2377", while ZERO of the 521 stored
    // transactions carry a '#'. Without this the prefixed rows report as «غير موجود» while the
    // order is sitting right there.
    expect(normalizeRef('2432')).toBe('2432');
    expect(normalizeRef('#2377')).toBe('2377');
    expect(normalizeRef('  #2377 ')).toBe('2377');
  });

  it('converts Arabic-Indic digits', () => {
    expect(normalizeRef('٢٤٣٢')).toBe('2432');
    expect(parseMoney('١٢٩٫٩٦'.replace('٫', '.'))).toBeCloseTo(129.96, 2);
  });

  it('returns null — never 0 — for an unreadable amount', () => {
    // The load-bearing rule: coercing "N/A" to 0 would claim the carrier deducted nothing and
    // silently overstate what entered the vault.
    expect(parseMoney('N/A')).toBeNull();
    expect(parseMoney('')).toBeNull();
    expect(parseMoney('—')).toBeNull();
    expect(parseMoney(0)).toBe(0);
    expect(parseMoney('1,380')).toBe(1380);
    expect(parseMoney('(114)')).toBe(-114);
  });

  it('normalises phones to a comparable local form', () => {
    expect(normalizePhone('+201119897047')).toBe('1119897047');
    expect(normalizePhone('01119897047')).toBe('1119897047');
  });

  it('tolerates the name noise the real file contains', () => {
    expect(namesLookAlike('هاجر علوي -', 'هاجر علوي')).toBe(true);
    expect(namesLookAlike('أحمد على', 'احمد علي')).toBe(true);
    expect(namesLookAlike('محمد سمير', 'سارة خالد')).toBe(false);
  });

  it('escalates variance on EITHER cash or percentage', () => {
    // Two thresholds, because a flat one calls 20 on 300 an incident and a percentage one calls
    // 20 on 99 noise.
    expect(varianceLevel(145, 129.96).code).toBe('ok');   // under tariff is not a finding
    expect(varianceLevel(145, 166.44).code).toBe('notable');
    expect(varianceLevel(120, 175).code).toBe('high');    // +55 by cash
    expect(varianceLevel(99, 124).code).toBe('high');     // +25 = 25% by ratio
    expect(varianceLevel(0, 50).code).toBe('high');       // free shipping billed 0
  });
});

describe('carrier statement — file recognition', () => {
  it('rejects a file that is not this carrier’s settlement report', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Sheet1').addRow(['a', 'b', 'c']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    await expect(svc().analyze(buf, 'wrong.xlsx', 'bosta')).rejects.toThrow(/أعمدة مفقودة/);
  });

  it('reports which column was read as which field', async () => {
    const buf = await sheet([row('7776543002', 'Delivered', '2432', 'انجي ابراهيم', '+201119897047', 1380, 104, 10, 15.96, 129.96, 1250.04)]);
    const r = await svc().analyze(buf, 'f.xlsx', 'bosta');
    const map = Object.fromEntries(r.columns.filter((c) => c.column).map((c) => [c.field, c.header]));
    expect(map.ref).toBe('Order Reference');
    expect(map.cod).toBe('COD');
    expect(map.totalFees).toBe('Total Fees');
    // ⚠ The file's «Order Id» holds what we store as bostaTrackingNumber — verified against live
    //   data. The column name is misleading; do not "correct" this to bostaOrderId.
    expect(map.tracking).toBe('Order Id');
  });

  it('hashes the bytes so a re-upload is detectable', async () => {
    const buf = await sheet([row('7776543002', 'Delivered', '2432', 'x', '', 1380, 104, 10, 15.96, 129.96, 1250.04)]);
    const a = await svc().analyze(buf, 'f.xlsx', 'bosta');
    const b = await svc().analyze(buf, 'f.xlsx', 'bosta');
    expect(a.fileHash).toBe(b.fileHash);
    expect(a.fileHash).toHaveLength(64);
  });
});

describe('carrier statement — row classification', () => {
  it('matches on reference and suggests only a clean row', async () => {
    const buf = await sheet([row('7776543002', 'Delivered', '2432', 'انجي ابراهيم', '+201119897047', 1380, 104, 10, 15.96, 129.96, 1250.04)]);
    const r = await svc().analyze(buf, 'f.xlsx', 'bosta');
    expect(r.rows[0].status).toBe('matched');
    expect(r.rows[0].matchedBy).toBe('ref');
    expect(r.rows[0].suggested).toBe(true);
    expect(r.rows[0].identityMismatch).toBe(false);
  });

  it('falls back to the tracking number when the reference is absent', async () => {
    const buf = await sheet([row('8438863252', 'Delivered', '', 'ندي جمال حمزة', '+201020282104', 1730, 136, 10, 20.44, 166.44, 1563.56)]);
    const r = await svc().analyze(buf, 'f.xlsx', 'bosta');
    expect(r.rows[0].status).toBe('matched');
    expect(r.rows[0].matchedBy).toBe('tracking');
  });

  it('records the shipping overcharge on a matched row', async () => {
    const buf = await sheet([row('8438863252', 'Delivered', '2434', 'ندي جمال حمزة', '+201020282104', 1730, 136, 10, 20.44, 166.44, 1563.56)]);
    const r = await svc().analyze(buf, 'f.xlsx', 'bosta');
    // billed 145, carrier took 166.44
    expect(r.rows[0].shipVariance).toBeCloseTo(21.44, 2);
    expect(r.rows[0].varianceLevel).toBe('notable');
  });

  it('flags an identity clash but still allows the row to be settled deliberately', async () => {
    const buf = await sheet([row('900503', 'Delivered', '503', 'شخص مختلف تماما', '+201000000009', 600, 100, 10, 10, 120, 480)]);
    const r = await svc().analyze(buf, 'f.xlsx', 'bosta');
    expect(r.rows[0].status).toBe('matched');
    expect(r.rows[0].identityMismatch).toBe(true);
    expect(r.rows[0].selectable).toBe(true);
    // ⚠ Matched but NOT suggested: the check exists to catch a mistyped reference before cash moves.
    expect(r.rows[0].suggested).toBe(false);
  });

  it('skips an order that is already collected', async () => {
    const buf = await sheet([row('900500', 'Delivered', '500', 'محصل', '+201000000001', 500, 100, 10, 10, 120, 380)]);
    const r = await svc().analyze(buf, 'f.xlsx', 'bosta');
    expect(r.rows[0].status).toBe('already_settled');
    expect(r.rows[0].suggested).toBe(false);
  });

  it('refuses a cancelled transaction and a non-sale', async () => {
    const buf = await sheet([
      row('900501', 'Delivered', '501', 'ملغية', '+201000000002', 300, 100, 10, 10, 120, 180),
      row('900502', 'Delivered', '502', 'مورد', '', 400, 100, 10, 10, 120, 280),
    ]);
    const r = await svc().analyze(buf, 'f.xlsx', 'bosta');
    expect(r.rows.map((x) => x.status)).toEqual(['invalid', 'invalid']);
  });

  it('never guesses when reference and tracking disagree', async () => {
    const buf = await sheet([row('111111', 'Delivered', '505', 'م', '+201088887777', 800, 100, 10, 10, 120, 680)]);
    const r = await svc().analyze(buf, 'f.xlsx', 'bosta');
    // ref → 505, tracking → 504. Picking either would settle a real invoice on a coin flip.
    expect(r.rows[0].status).toBe('conflict');
    expect(r.rows[0].suggested).toBe(false);
  });

  it('surfaces a fee-only deduction even when the shipment is unknown to us', async () => {
    // The real «#2377» row: COD 0, fees 114, Net −114 — money that already left us on a returned
    // shipment. Classified BEFORE matching, so it can never hide under «غير موجود».
    const buf = await sheet([row('9610351696', 'Delivered', '#2377', 'هاجر علوي -', '+201142511455', 0, 90, 10, 14, 114, -114, 'Giza')]);
    const r = await svc().analyze(buf, 'f.xlsx', 'bosta');
    expect(r.rows[0].status).toBe('fee_only');
    expect(r.rows[0].ref).toBe('2377');
    expect(r.summary.feeOnlyCount).toBe(1);
    expect(r.summary.feeOnlyAmount).toBe(114);
  });

  it('tells a PREPAID order apart from a RETURNED one', async () => {
    // ⚠ COD = 0 has two causes and they are not the same event. Verified on live data: 307 sales
    //   are prepaid (deposit === total, remaining 0) and 101 of them carried no actualShipCost at
    //   all — 12,540 EGP of real shipping cost that no report could see. Calling those "returned"
    //   mislabels a normal cost of business as an incident.
    const prepaidTx = [
      { _id: 'p', ref: '9001', type: 'مبيعات', total: 2180, deposit: 2180, remaining: 0, shipCost: 120, payStatus: 'مكتمل', cancelled: false, client: 'غاده', phone: '01011112222', bostaTrackingNumber: '900387' },
      { _id: 'r', ref: '9002', type: 'مبيعات', total: 1000, deposit: 0, remaining: 1000, shipCost: 120, payStatus: 'معلق', cancelled: false, client: 'مرتجع', phone: '01033334444', bostaTrackingNumber: '900500' },
    ];
    const m: any = { find: (q: any) => ({ lean: () => ({ exec: async () => {
      const refs = (q.$or || []).find((o: any) => o.ref)?.ref?.$in || [];
      const trks = (q.$or || []).find((o: any) => o.bostaTrackingNumber)?.bostaTrackingNumber?.$in || [];
      return prepaidTx.filter((t) => refs.includes(t.ref) || trks.includes(t.bostaTrackingNumber));
    } }) }) };
    const buf = await sheet([
      row('900387', 'Delivered', '9001', 'غاده', '+201011112222', 0, 90, 10, 14, 114, -114),
      row('900500', 'Delivered', '9002', 'مرتجع', '+201033334444', 0, 90, 10, 14, 114, -114),
    ]);
    const r = await new CarrierStatementService(m).analyze(buf, 'f.xlsx', 'bosta');
    expect(r.rows[0].status).toBe('fee_only');
    expect(r.rows[0].note).toMatch(/مدفوع مسبقاً/);
    expect(r.rows[1].note).toMatch(/مرتجعة/);
    expect(r.summary.feeOnlyCount).toBe(2);
  });

  it('records the shipping variance on a fee-only row too', async () => {
    // The audit was blind to this: an order that collects nothing still costs us shipping, and the
    // carrier can still overcharge for it.
    const tx = [{ _id: 'p', ref: '9001', type: 'مبيعات', total: 2180, deposit: 2180, remaining: 0, shipCost: 120, payStatus: 'مكتمل', cancelled: false, client: 'غاده', phone: '01011112222', bostaTrackingNumber: '900387' }];
    const m: any = { find: (q: any) => ({ lean: () => ({ exec: async () => {
      const refs = (q.$or || []).find((o: any) => o.ref)?.ref?.$in || [];
      const trks = (q.$or || []).find((o: any) => o.bostaTrackingNumber)?.bostaTrackingNumber?.$in || [];
      return tx.filter((t) => refs.includes(t.ref) || trks.includes(t.bostaTrackingNumber));
    } }) }) };
    const buf = await sheet([row('900387', 'Delivered', '9001', 'غاده', '+201011112222', 0, 140, 10, 20, 170, -170)]);
    const r = await new CarrierStatementService(m).analyze(buf, 'f.xlsx', 'bosta');
    expect(r.rows[0].shipVariance).toBe(50);        // carrier 170 vs our tariff 120
    expect(r.rows[0].varianceLevel).toBe('high');
    expect(r.summary.varianceTotal).toBe(50);
  });

  it('refuses a row whose own arithmetic does not reconcile', async () => {
    // ⚠ The file's proof line is what tells us we mapped its columns correctly at all. If it
    //   fails, the honest conclusion is that WE misread the file.
    const buf = await sheet([row('7776543002', 'Delivered', '2432', 'انجي ابراهيم', '+201119897047', 1380, 104, 10, 15.96, 129.96, 999)]);
    const r = await svc().analyze(buf, 'f.xlsx', 'bosta');
    expect(r.rows[0].status).toBe('invalid');
    expect(r.proofFailures).toBe(1);
  });

  it('refuses an unreadable amount instead of treating it as zero', async () => {
    const buf = await sheet([row('7776543002', 'Delivered', '2432', 'x', '', 'N/A', 104, 10, 15.96, 129.96, 1250.04)]);
    const r = await svc().analyze(buf, 'f.xlsx', 'bosta');
    expect(r.rows[0].status).toBe('invalid');
  });

  it('rejects an amount larger than what the invoice still owes', async () => {
    const buf = await sheet([row('7776543002', 'Delivered', '2432', 'انجي ابراهيم', '+201119897047', 5000, 104, 10, 15.96, 129.96, 4870.04)]);
    const r = await svc().analyze(buf, 'f.xlsx', 'bosta');
    expect(r.rows[0].status).toBe('amount_mismatch');
    expect(r.rows[0].suggested).toBe(false);
  });

  it('holds back a partial collection for a human decision', async () => {
    const buf = await sheet([row('7776543002', 'Delivered', '2432', 'انجي ابراهيم', '+201119897047', 1000, 104, 10, 15.96, 129.96, 870.04)]);
    const r = await svc().analyze(buf, 'f.xlsx', 'bosta');
    expect(r.rows[0].status).toBe('amount_mismatch');
  });

  it('does not settle a shipment the carrier has not delivered', async () => {
    const buf = await sheet([row('7776543002', 'Returned', '2432', 'انجي ابراهيم', '+201119897047', 1380, 104, 10, 15.96, 129.96, 1250.04)]);
    const r = await svc().analyze(buf, 'f.xlsx', 'bosta');
    expect(r.rows[0].status).toBe('not_deliverable');
  });

  it('catches a shipment listed twice in the same file', async () => {
    // Two rows naming one shipment would settle it twice in a single run.
    const buf = await sheet([
      row('7776543002', 'Delivered', '2432', 'انجي ابراهيم', '+201119897047', 1380, 104, 10, 15.96, 129.96, 1250.04),
      row('7776543002', 'Delivered', '2432', 'انجي ابراهيم', '+201119897047', 1380, 104, 10, 15.96, 129.96, 1250.04),
    ]);
    const r = await svc().analyze(buf, 'f.xlsx', 'bosta');
    expect(r.rows.every((x) => x.status === 'invalid')).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/مكرر/);
  });

  it('reports a row carrying no identifier at all', async () => {
    const buf = await sheet([row('', 'Delivered', '', 'بدون معرّف', '+201000000123', 100, 90, 10, 10, 110, -10)]);
    const r = await svc().analyze(buf, 'f.xlsx', 'bosta');
    expect(r.rows[0].status).toBe('invalid');
    expect(r.rows[0].note).toMatch(/لا يوجد رقم مرجع/);
  });

  it('sums only what it would actually settle', async () => {
    const buf = await sheet([
      row('7776543002', 'Delivered', '2432', 'انجي ابراهيم', '+201119897047', 1380, 104, 10, 15.96, 129.96, 1250.04),
      row('8438863252', 'Delivered', '2434', 'ندي جمال حمزة', '+201020282104', 1730, 136, 10, 20.44, 166.44, 1563.56),
      row('9610351696', 'Delivered', '#2377', 'هاجر علوي -', '+201142511455', 0, 90, 10, 14, 114, -114),
      row('900500', 'Delivered', '500', 'محصل', '+201000000001', 500, 100, 10, 10, 120, 380),
    ]);
    const r = await svc().analyze(buf, 'f.xlsx', 'bosta');
    expect(r.summary.suggestedCount).toBe(2);
    expect(r.summary.suggestedCod).toBe(3110);
    expect(r.summary.suggestedFees).toBeCloseTo(296.4, 2);
    expect(r.summary.suggestedNet).toBeCloseTo(2813.6, 2);
    // The fee-only row and the already-settled one contribute nothing to the collection total.
    expect(r.summary.feeOnlyCount).toBe(1);
  });

  it('agrees with the carrier’s own net figure on every settleable row', async () => {
    const buf = await sheet([
      row('7776543002', 'Delivered', '2432', 'انجي ابراهيم', '+201119897047', 1380, 104, 10, 15.96, 129.96, 1250.04),
      row('8438863252', 'Delivered', '2434', 'ندي جمال حمزة', '+201020282104', 1730, 136, 10, 20.44, 166.44, 1563.56),
    ]);
    const r = await svc().analyze(buf, 'f.xlsx', 'bosta');
    for (const p of r.rows) {
      expect(Math.abs((p.cod! - p.totalFees!) - p.netValue!)).toBeLessThanOrEqual(NET_VALUE_TOLERANCE);
    }
    expect(r.proofFailures).toBe(0);
  });
});
