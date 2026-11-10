import sharp from 'sharp';
import { createWorker } from 'tesseract.js';
import { DepositReceiptOcrService } from '../../src/shopify/deposit-receipt-ocr.service';
import * as images from '../../src/shopify/receipt-image.util';
import * as digits from '../../src/shopify/receipt-digit.util';
import * as wallet from '../../src/shopify/receipt-wallet.util';

jest.mock('tesseract.js', () => ({ createWorker: jest.fn() }));
jest.mock('../../src/shopify/receipt-instapay.util', () => ({ prepareInstapayLayout: jest.fn().mockResolvedValue(null) }));
jest.mock('../../src/shopify/receipt-image.util', () => ({ receiptOcrRegion: jest.fn(), receiptTealAmount: jest.fn() }));
jest.mock('../../src/shopify/receipt-digit.util', () => ({ readArabicTealAmount: jest.fn() }));
jest.mock('../../src/shopify/receipt-wallet.util', () => ({ walletMessageAmount: jest.fn(), walletUssdContext: jest.fn() }));

describe('verified wallet headline OCR', () => {
  let service: DepositReceiptOcrService, image: Buffer, worker: any;
  const primary = 'تم التحويل بنجاح\n5 جنيه\nمبلغ التحويل\nمن\n01011112222\nإلى\n01012345678\nرقم العملية 123456789012';
  beforeEach(async () => {
    jest.clearAllMocks();
    service = new DepositReceiptOcrService();
    image = await sharp({ create: { width: 400, height: 800, channels: 3, background: 'white' } }).png().toBuffer();
    worker = { reinitialize: jest.fn().mockResolvedValue(undefined), setParameters: jest.fn().mockResolvedValue(undefined),
      recognize: jest.fn(), terminate: jest.fn().mockResolvedValue(undefined) };
    (createWorker as jest.Mock).mockResolvedValue(worker);
    (images.receiptOcrRegion as jest.Mock).mockResolvedValue(image);
    (images.receiptTealAmount as jest.Mock).mockResolvedValue(image);
    (digits.readArabicTealAmount as jest.Mock).mockResolvedValue(null);
    (wallet.walletMessageAmount as jest.Mock).mockResolvedValue(null);
    (wallet.walletUssdContext as jest.Mock).mockResolvedValue(null);
  });
  afterEach(async () => { await service.onModuleDestroy(); });

  it('replaces a truncated full-page 5 with 1635 only after the isolated ink agrees twice', async () => {
    worker.recognize.mockResolvedValueOnce({ data: { text: primary } })
      .mockResolvedValue({ data: { text: '1635', confidence: 96 } });
    expect(await service.read(image)).toMatchObject({ amount: 1635, method: 'فودافون كاش', confident: true });
    expect(worker.recognize).toHaveBeenCalledTimes(3);
    expect(worker.reinitialize.mock.calls).toEqual([['eng'], ['ara+eng']]);
    expect(worker.setParameters).toHaveBeenLastCalledWith({ tessedit_pageseg_mode: '11', tessedit_char_whitelist: '' });
  });

  it('leaves disagreeing headline readings blank instead of keeping the truncated primary amount', async () => {
    worker.recognize.mockResolvedValueOnce({ data: { text: primary } })
      .mockResolvedValueOnce({ data: { text: '1635', confidence: 96 } })
      .mockResolvedValueOnce({ data: { text: '1636', confidence: 96 } });
    expect(await service.read(image)).toMatchObject({ amount: null, confident: false });
  });

  it('does not infer a vault from the teal colour alone', async () => {
    worker.recognize.mockResolvedValueOnce({ data: { text: 'تم بنجاح\n120 EGP' } })
      .mockResolvedValue({ data: { text: '120', confidence: 96 } });
    expect(await service.read(image)).toMatchObject({ amount: 120, method: '', confident: false });
  });

  it('reads the Arabic display font without accepting the fee-inclusive total', async () => {
    worker.recognize.mockResolvedValue({ data: { text: 'لقد تم الدفع بنجام!\nاجمالي المبلع\nمن\n01011112222\nإلى\n01012345678\nالرسوم 1 جنيه\nالإجمالي 201 جنيه' } });
    (digits.readArabicTealAmount as jest.Mock).mockResolvedValue(200);
    expect(await service.read(image)).toMatchObject({ amount: 200, method: 'فودافون كاش', confident: true });
    expect(worker.recognize).toHaveBeenCalledTimes(1);
  });

  it('uses the anchored Arabic message glyphs before the general reader can substitute 600', async () => {
    worker.recognize.mockResolvedValue({ data: { text: 'تم تحويل 000 جنيه الى 01012345678' } });
    (wallet.walletMessageAmount as jest.Mock).mockResolvedValue(500);
    expect(await service.read(image)).toMatchObject({ amount: 500, method: 'فودافون كاش' });
    expect(worker.recognize).toHaveBeenCalledTimes(1);
  });

  it('restores the worker language and whitelist after a digit recognition failure', async () => {
    worker.recognize.mockResolvedValueOnce({ data: { text: primary } }).mockRejectedValueOnce(new Error('crop failed'));
    expect(await service.read(image)).toMatchObject({ amount: 5, ran: true });
    expect(worker.reinitialize.mock.calls).toEqual([['eng'], ['ara+eng']]);
    expect(worker.setParameters).toHaveBeenLastCalledWith({ tessedit_pageseg_mode: '11', tessedit_char_whitelist: '' });
  });
});
