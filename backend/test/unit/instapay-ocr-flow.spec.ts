import sharp from 'sharp';
import { createWorker } from 'tesseract.js';
import { DepositReceiptOcrService } from '../../src/shopify/deposit-receipt-ocr.service';
import * as instapay from '../../src/shopify/receipt-instapay.util';

jest.mock('tesseract.js', () => ({ createWorker: jest.fn() }));
jest.mock('../../src/shopify/receipt-instapay.util', () => ({
  prepareInstapayLayout: jest.fn(), parseInstapayLayout: jest.fn(), instapayAmountImage: jest.fn(),
  instapayReferenceBox: jest.fn(), instapayReferenceImage: jest.fn(), instapayDestinationImage: jest.fn(),
  verifiedInstapayReference: jest.requireActual('../../src/shopify/receipt-instapay.util').verifiedInstapayReference,
}));

describe('InstaPay fast OCR safety and worker lifecycle', () => {
  let service: DepositReceiptOcrService;
  let image: Buffer;
  let worker: any;
  beforeEach(async () => {
    jest.resetAllMocks();
    service = new DepositReceiptOcrService();
    image = await sharp({ create: { width: 400, height: 800, channels: 3, background: 'white' } }).png().toBuffer();
    worker = { setParameters: jest.fn().mockResolvedValue(undefined), reinitialize: jest.fn().mockResolvedValue(undefined),
      recognize: jest.fn(), terminate: jest.fn().mockResolvedValue(undefined) };
    (createWorker as jest.Mock).mockResolvedValue(worker);
    (instapay.prepareInstapayLayout as jest.Mock).mockResolvedValue({ image, original: image });
    (instapay.parseInstapayLayout as jest.Mock).mockImplementation(() => ({ amount: 500, method: 'Instapay', pattern: 'instapay',
      senderHandle: 'sender@instapay', reference: '123456789012', dateText: '09 Nov 2026 01:13 PM',
      amountConfidence: .9, amountSource: 'currency', confident: true, screenshotTime: '05:23' }));
    (instapay.instapayAmountImage as jest.Mock).mockResolvedValue(image);
    (instapay.instapayReferenceImage as jest.Mock).mockResolvedValue(image);
    (instapay.instapayReferenceBox as jest.Mock).mockReturnValue({ x0: 0, y0: 0, x1: 10, y1: 10 });
    worker.recognize.mockResolvedValueOnce({ data: { text: 'full page' } })
      .mockResolvedValueOnce({ data: { text: '500', confidence: 96 } });
  });
  afterEach(async () => { await service.onModuleDestroy(); });

  it('requires agreement on the source reference and restores Arabic/English for the next receipt', async () => {
    worker.recognize.mockResolvedValue({ data: { text: '123456789012', confidence: 95 } });
    expect(await service.read(image)).toMatchObject({ amount: 500, reference: '123456789012', senderHandle: 'sender@instapay',
      screenshotTime: '05:23', screenshotTimeSource: 'screen-status-bar', confident: true, ran: true });
    expect(worker.reinitialize.mock.calls).toEqual([['eng'], ['ara+eng']]);
    expect(worker.setParameters).toHaveBeenLastCalledWith({ tessedit_pageseg_mode: '11', tessedit_char_whitelist: '' });
    expect(worker.recognize).toHaveBeenCalledTimes(4);
  });

  it('leaves conflicting references blank even when the full-page pass supplied an id', async () => {
    worker.recognize.mockResolvedValueOnce({ data: { text: '123456789012', confidence: 95 } })
      .mockResolvedValueOnce({ data: { text: '123456789512', confidence: 95 } })
      .mockResolvedValueOnce({ data: { text: '123456789612', confidence: 95 } });
    expect(await service.read(image)).toMatchObject({ amount: 500, reference: '', ran: true });
  });

  it('refuses a low-confidence reference without removing the verified amount', async () => {
    worker.recognize.mockResolvedValue({ data: { text: '123456789012', confidence: 42 } });
    expect(await service.read(image)).toMatchObject({ amount: 500, reference: '', ran: true });
  });

  it('refuses disagreeing amount readings instead of choosing either figure', async () => {
    worker.recognize.mockReset().mockResolvedValueOnce({ data: { text: 'full page' } })
      .mockResolvedValueOnce({ data: { text: '5000', confidence: 96 } })
      .mockResolvedValue({ data: { text: '123456789012', confidence: 95 } });
    expect(await service.read(image)).toMatchObject({ amount: null, confident: false, ran: true });
  });

  it('restores worker parameters after a fast-pass error before using the general reader', async () => {
    worker.recognize.mockReset().mockRejectedValueOnce(new Error('fast pass failed'))
      .mockResolvedValue({ data: { text: '500 EGP\nsender@instapay\nMobile Wallet' } });
    expect(await service.read(image)).toMatchObject({ amount: 500, method: 'فودافون كاش', ran: true });
    expect(worker.reinitialize.mock.calls).toEqual([['eng'], ['ara+eng']]);
    expect(worker.setParameters).toHaveBeenLastCalledWith({ tessedit_pageseg_mode: '11', tessedit_char_whitelist: '' });
  });
});
