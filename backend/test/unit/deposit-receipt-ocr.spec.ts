import { createWorker } from 'tesseract.js';
import sharp from 'sharp';
import { DepositReceiptOcrService, englishHeadlineFigure } from '../../src/shopify/deposit-receipt-ocr.service';

jest.mock('tesseract.js', () => ({ createWorker: jest.fn() }));
const worker = () => ({ setParameters: jest.fn().mockResolvedValue(undefined),
  reinitialize: jest.fn().mockResolvedValue(undefined), terminate: jest.fn().mockResolvedValue(undefined), recognize: jest.fn() });

describe('receipt OCR on original uploads', () => {
  let service: DepositReceiptOcrService;
  let image: Buffer;
  beforeEach(() => {
    jest.clearAllMocks(); service = new DepositReceiptOcrService();
    image = Buffer.from('original upload bytes');
  });
  afterEach(async () => { await service.onModuleDestroy(); });

  it('bounds a worker startup that never resolves and expires queued reads', async () => {
    jest.useFakeTimers();
    jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
    let finishStartup!: (value: any) => void;
    (createWorker as jest.Mock).mockImplementationOnce(() => new Promise(resolve => { finishStartup = resolve; }));
    try {
      const first = service.read(image), queued = service.read(image);
      await jest.advanceTimersByTimeAsync(21_000);
      await expect(first).resolves.toMatchObject({ ran: false, amount: null });
      await expect(queued).resolves.toMatchObject({ ran: false, amount: null });
      expect(createWorker).toHaveBeenCalledTimes(1);
    } finally { jest.useRealTimers(); }
    await expect(service.read(image)).resolves.toMatchObject({ ran: false });
    expect(createWorker).toHaveBeenCalledTimes(1);
    const expired = worker(); finishStartup(expired);
    await new Promise(resolve => setImmediate(resolve));
    expect(expired.terminate).toHaveBeenCalled();
    const next = worker(); next.recognize.mockResolvedValue({ data: { text: '' } });
    (createWorker as jest.Mock).mockResolvedValue(next);
    await expect(service.read(image)).resolves.toMatchObject({ ran: true });
  });

  it('returns manual entry when recognition and worker termination both hang', async () => {
    jest.useFakeTimers();
    const stalled = worker();
    stalled.recognize.mockImplementation(() => new Promise(() => {}));
    stalled.terminate.mockImplementation(() => new Promise(() => {}));
    (createWorker as jest.Mock).mockResolvedValue(stalled);
    jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
    try {
      const result = service.read(image);
      await jest.advanceTimersByTimeAsync(21_000);
      await expect(result).resolves.toMatchObject({ ran: false, amount: null });
      expect(stalled.terminate).toHaveBeenCalled();
    } finally { jest.useRealTimers(); }
  });

  it('handles language download failure and allows a later retry', async () => {
    jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
    (createWorker as jest.Mock).mockImplementationOnce((_languages, _engine, options) => {
      expect(typeof options.errorHandler).toBe('function');
      expect(() => options.errorHandler(new Error('fetch failed'))).not.toThrow();
      return Promise.reject(new Error('fetch failed'));
    });
    await expect(service.read(image)).resolves.toMatchObject({ ran: false, amount: null, confident: false });
    const w = worker(); w.recognize.mockResolvedValue({ data: { text: '' } });
    (createWorker as jest.Mock).mockResolvedValue(w);
    await expect(service.read(image)).resolves.toMatchObject({ ran: true });
    expect(createWorker).toHaveBeenCalledTimes(2);
  });

  it('passes the identical buffer to Tesseract and requests layout metadata', async () => {
    const w = worker(); (createWorker as jest.Mock).mockResolvedValue(w);
    w.recognize.mockResolvedValue({ data: { text: '120 EGP\nsender@instapay\nMobile Wallet' } });
    expect(await service.read(image)).toMatchObject({ amount: 120, method: 'فودافون كاش', confident: true, ran: true });
    expect(createWorker).toHaveBeenCalledWith(['ara', 'eng'], 1, expect.any(Object));
    expect(w.setParameters).toHaveBeenCalledWith({ tessedit_pageseg_mode: '11' });
    expect(w.recognize).toHaveBeenCalledTimes(1);
    expect(w.recognize.mock.calls[0][0]).toBe(image);
    expect(w.recognize.mock.calls[0][2]).toEqual({ blocks: true });
  });

  it('crops and enlarges a small receipt inside a dark chat screenshot before recognition', async () => {
    const card = await sharp({ create: { width: 220, height: 420, channels: 3, background: '#fafafa' } }).png().toBuffer();
    const screenshot = await sharp({ create: { width: 400, height: 800, channels: 3, background: '#101010' } })
      .composite([{ input: card, left: 90, top: 250 }]).png().toBuffer();
    const w = worker(); (createWorker as jest.Mock).mockResolvedValue(w);
    w.recognize.mockResolvedValue({ data: { text: 'Approved Transaction\n1,000 EGP\nTransfer Amount\nFrom\nsender@instapay\nTo: vkswr3420@instapay\nFees 1 EGP\nTotal Amount 1,001 EGP' } });
    expect(await service.read(screenshot)).toMatchObject({ amount: 1000, method: 'Instapay', confident: true, ran: true });
    const recognized = w.recognize.mock.calls[0][0] as Buffer;
    expect(recognized).not.toBe(screenshot);
    const dimensions = await sharp(recognized).metadata();
    expect(dimensions.width).toBeGreaterThanOrEqual(900);
    expect(dimensions.height).toBeGreaterThan(dimensions.width!);
  });

  it('fills the Vodafone Cash headline the Arabic pass read as «0 جنيه» from the English pass', async () => {
    const w = worker(); (createWorker as jest.Mock).mockResolvedValue(w);
    w.recognize.mockResolvedValueOnce({ data: { text: '0 جنيه\n01211449112\nMohamed F |\n01008835575\nتحويل اموال' } })
      .mockResolvedValueOnce({ data: { text: '«400\n01211449112\nMohamed F |\n01008835575' } });
    expect(await service.read(image)).toMatchObject({ amount: 400, method: 'فودافون كاش', confident: false, ran: true });
  });

  it('englishHeadlineFigure takes only one clean figure on the first numeric line', () => {
    expect(englishHeadlineFigure('«> 400.00\nOlga 1.50')).toBe(400);
    expect(englishHeadlineFigure('a> 300.00')).toBe(300);
    expect(englishHeadlineFigure('«400')).toBe(400);
    expect(englishHeadlineFigure('Jo\n01001110017')).toBeNull();
    expect(englishHeadlineFigure('400 500')).toBeNull();
    expect(englishHeadlineFigure('«5')).toBeNull();
    expect(englishHeadlineFigure('rR #%%%[0 %%%[0 PPM) A000')).toBeNull();
  });

  it('uses the same bytes for the English fallback and rejects conflicting amounts', async () => {
    const w = worker(); (createWorker as jest.Mock).mockResolvedValue(w);
    w.recognize.mockResolvedValueOnce({ data: { text: 'Transaction Successful\n500\nsender@instapay\nreceiver@instapay' } })
      .mockResolvedValueOnce({ data: { text: '600 EGP\nsender@instapay\nreceiver@instapay' } });
    expect(await service.read(image)).toMatchObject({ amount: null, confident: false, ran: true });
    expect(w.recognize.mock.calls.map(call => call[0])).toEqual([image, image]);
    expect(w.reinitialize.mock.calls).toEqual([['eng'], ['ara+eng']]);
  });

  it('recovers missing receipt details from English recognition of the original image', async () => {
    const w = worker(); (createWorker as jest.Mock).mockResolvedValue(w);
    w.recognize.mockResolvedValueOnce({ data: { text: '500 EGP\nFrom\nABCD\nrabi8ul@instapay\nTo Mobile Wallet\nReference\nDate' } })
      .mockResolvedValueOnce({ data: { text: '500 EGP\nFrom\nABCD rabi8ul@instapay\nTo Mobile Wallet\nReference 957372239566\nDate 25 Sep 2026 03:44 PM' } });
    expect(await service.read(image)).toMatchObject({ amount: 500, senderName: undefined, senderBank: 'ABCD',
      reference: '957372239566', dateText: '25 Sep 2026 03:44 PM', ran: true });
    expect(w.recognize.mock.calls.map(call => call[0])).toEqual([image, image]);
  });

  it('keeps the Arabic sender phone when the English pass improves the amount reading', async () => {
    const w = worker(); (createWorker as jest.Mock).mockResolvedValue(w);
    w.recognize.mockResolvedValueOnce({ data: { text: 'ناجحة\n300\nمن\n01275030836\nإلى\n01008835575\nرقم العملية 25000143088423' } })
      .mockResolvedValueOnce({ data: { text: '300.00 EGP\nTransaction ID 25000143088423' } });
    expect(await service.read(image)).toMatchObject({ amount: 300, senderPhone: '01275030836',
      reference: '25000143088423', ran: true });
  });

  it('recovers a cropped InstaPay figure when the first pass reads 500 EGP as 5 EGP', async () => {
    const w = worker(); (createWorker as jest.Mock).mockResolvedValue(w);
    w.recognize.mockResolvedValueOnce({ data: { text: 'تمت العملية بنجاح\n5 EGP\nمن\nnewsreen@instapay\nإلى المحفظة الإلكترونية\n01008835575\nالمرجع 758508528571' } })
      .mockResolvedValueOnce({ data: { text: '500 EGP\nFrom\nnewsreen@instapay\nTo Mobile Wallet\n01008835575\nReference 758508528571' } });
    expect(await service.read(image)).toMatchObject({ amount: 500, method: 'فودافون كاش', confident: true, ran: true });
    expect(w.recognize).toHaveBeenCalledTimes(2);
  });

  it.each(['5 EGP', '600 EGP'])('does not auto-fill a one-digit InstaPay amount when the second pass says %s', async alternate => {
    const w = worker(); (createWorker as jest.Mock).mockResolvedValue(w);
    w.recognize.mockResolvedValueOnce({ data: { text: 'تمت العملية بنجاح\n5 EGP\nnewsreen@instapay\nإلى المحفظة الإلكترونية' } })
      .mockResolvedValueOnce({ data: { text: `${alternate}\nnewsreen@instapay\nTo Mobile Wallet` } });
    expect(await service.read(image)).toMatchObject({ amount: null, method: 'فودافون كاش', confident: false, ran: true });
  });

  it('runs English recognition for a clear transfer whose sender address was missed', async () => {
    const w = worker(); (createWorker as jest.Mock).mockResolvedValue(w);
    w.recognize.mockResolvedValueOnce({ data: { text: 'Approved Transaction\n500 EGP\nFrom\nCIB\nTo\nMobile Wallet' } })
      .mockResolvedValueOnce({ data: { text: 'Approved Transaction\n500 EGP\nFrom\nCIB\nsender@instapay\nTo\nMobile Wallet' } });
    expect(await service.read(image)).toMatchObject({ amount: 500, senderHandle: 'sender@instapay', senderBank: 'البنك التجاري الدولي (CIB)' });
    expect(w.recognize).toHaveBeenCalledTimes(2);
  });

  it('leaves conflicting OCR reference numbers for employee review', async () => {
    const w = worker(); (createWorker as jest.Mock).mockResolvedValue(w);
    w.recognize.mockResolvedValueOnce({ data: { text: '500 EGP\nFrom\nABCD\nrabi8ul@instapay\nTo Mobile Wallet\nReference 111111111111\nDate' } })
      .mockResolvedValueOnce({ data: { text: '500 EGP\nFrom\nABCD\nrabi8ul@instapay\nTo Mobile Wallet\nReference 957372239566\nDate 25 Sep 2026 03:44 PM' } });
    expect(await service.read(image)).toMatchObject({ reference: '', dateText: '25 Sep 2026 03:44 PM' });
  });

  it('keeps an unreadable destination blank', async () => {
    const w = worker(); (createWorker as jest.Mock).mockResolvedValue(w);
    w.recognize.mockResolvedValue({ data: { text: '120 EGP\nsender@instapay' } });
    expect(await service.read(image)).toMatchObject({ amount: 120, method: '', confident: false, ran: true });
    expect(w.recognize.mock.calls.every(call => call[0] === image)).toBe(true);
  });
});
