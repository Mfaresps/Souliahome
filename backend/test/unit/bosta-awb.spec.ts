import { EventEmitter } from 'events';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const https = require('https');
import { BadRequestException } from '@nestjs/common';
import { BostaService } from '../../src/bosta/bosta.service';

export {};

type Reply = { status: number; body: string };

function stubBosta(replies: Reply[], seen: any[]) {
  return jest.spyOn(https, 'request').mockImplementation(((_opts: any, cb: any) => {
    const req: any = new EventEmitter();
    let payload = '';
    req.write = (p: string) => { payload += p; };
    req.destroy = () => {};
    req.end = () => {
      seen.push(JSON.parse(payload));
      const r = replies.shift()!;
      const res: any = new EventEmitter();
      res.statusCode = r.status;
      res.setEncoding = () => {};
      cb(res);
      res.emit('data', r.body);
      res.emit('end');
    };
    return req;
  }) as any);
}

function makeService(tx: any) {
  const updates: any[] = [];
  const txModel: any = {
    findById: () => ({ select: () => ({ lean: async () => tx }) }),
    findByIdAndUpdate: async (_id: string, u: any) => { updates.push(u); },
  };
  const svc: any = Object.create(BostaService.prototype);
  svc.txModel = txModel;
  svc.logger = { error: () => {}, warn: () => {}, log: () => {} };
  svc.resolveApiKey = async () => 'KEY';
  return { svc: svc as BostaService, updates };
}

const PDF = 'JVBERi0xLjQK' + 'A'.repeat(200);
const baseTx = { _id: 't1', bostaTrackingNumber: '77873113', bostaStatus: 'CREATED' };

describe('BostaService.getAwb', () => {
  afterEach(() => jest.restoreAllMocks());

  it('requests A6 per Bosta docs and caches it', async () => {
    const seen: any[] = [];
    stubBosta([{ status: 200, body: JSON.stringify({ success: true, data: PDF }) }], seen);
    const { svc, updates } = makeService({ ...baseTx });
    const r = await svc.getAwb('t1');
    expect(seen[0]).toEqual({ trackingNumbers: '77873113', requestedAwbType: 'A6', lang: 'ar' });
    expect(r.awbType).toBe('A6');
    expect(updates[0]).toEqual({ bostaAwbBase64: PDF, bostaAwbType: 'A6' });
  });

  it('a Bosta error is a 400 carrying Bosta\'s message, never a 500', async () => {
    const seen: any[] = [];
    const err = { status: 400, body: JSON.stringify({ success: false, message: 'Delivery is not printable' }) };
    stubBosta([err, err, err], seen);
    const { svc } = makeService({ ...baseTx });
    await expect(svc.getAwb('t1')).rejects.toBeInstanceOf(BadRequestException);
    await expect(makeService({ ...baseTx }).svc.getAwb('t1')).rejects.toThrow(/Delivery is not printable|بوسطة رفضت/);
  });

  it('falls back to A4 when A6 is refused, and says so', async () => {
    const seen: any[] = [];
    const bad = { status: 400, body: JSON.stringify({ message: 'invalid awb type' }) };
    stubBosta([bad, bad, { status: 200, body: JSON.stringify({ data: PDF }) }], seen);
    const { svc, updates } = makeService({ ...baseTx });
    const r = await svc.getAwb('t1');
    expect(seen.map(s => `${s.requestedAwbType}/${s.lang}`)).toEqual(['A6/ar', 'A6/en', 'A4/ar']);
    expect(r.awbType).toBe('A4');
    expect(updates[0].bostaAwbType).toBe('A4');
  });

  it('an old A4 copy is re-requested as A6', async () => {
    const seen: any[] = [];
    stubBosta([{ status: 200, body: PDF }], seen);
    const { svc } = makeService({ ...baseTx, bostaAwbBase64: 'OLD', bostaAwbType: 'A4' });
    const r = await svc.getAwb('t1');
    expect(seen).toHaveLength(1);
    expect(r.pdfBase64).toBe(PDF);
  });

  it('a non-JSON HTML error page is a 400, not a 500', async () => {
    const seen: any[] = [];
    const html = { status: 502, body: '<html>Bad gateway</html>' };
    stubBosta([html, html, html], seen);
    const { svc } = makeService({ ...baseTx });
    await expect(svc.getAwb('t1')).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('BostaService.recordAwbPrint', () => {
  it('appends {at, by} and returns the whole log', async () => {
    let pushed: any = null;
    const svc: any = Object.create(BostaService.prototype);
    svc.txModel = {
      findById: () => ({ select: () => ({ lean: async () => ({ bostaTrackingNumber: 'T1' }) }) }),
      findByIdAndUpdate: (_id: string, upd: any) => {
        pushed = upd.$push.bostaAwbPrints;
        return { lean: async () => ({ bostaAwbPrints: [{ at: 'x', by: 'A' }, pushed] }) };
      },
    };
    svc.emit = jest.fn();
    const r = await svc.recordAwbPrint('t1', 'Reem', 'u1');
    expect(pushed.by).toBe('Reem');
    expect(pushed.byId).toBe('u1');
    expect(new Date(pushed.at).toString()).not.toBe('Invalid Date');
    expect(r.prints).toHaveLength(2);
    expect(svc.emit).toHaveBeenCalledWith('tx:updated', { _id: 't1' });
  });
});
