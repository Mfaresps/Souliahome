import sharp from 'sharp';
import { createWorker } from 'tesseract.js';
import { DepositReceiptOcrService } from '../../src/shopify/deposit-receipt-ocr.service';

jest.mock('tesseract.js', () => ({ createWorker: jest.fn() }));
const worker = () => ({ setParameters: jest.fn().mockResolvedValue(undefined),
  reinitialize: jest.fn().mockResolvedValue(undefined), terminate: jest.fn().mockResolvedValue(undefined), recognize: jest.fn() });

describe('receipt OCR fallbacks', () => {
  let service: DepositReceiptOcrService;
  let image: Buffer;
  beforeEach(async () => {
    jest.clearAllMocks(); service = new DepositReceiptOcrService();
    image = await sharp({ create: { width: 80, height: 120, channels: 3, background: '#fff' } }).png().toBuffer();
  });
  afterEach(async () => { await service.onModuleDestroy(); });
  it('checks isolated icon digits in English before accepting an amount', async () => {
    const w = worker(); (createWorker as jest.Mock).mockResolvedValue(w);
    w.recognize.mockResolvedValueOnce({ data: { text: 'Transaction Successful\n9\nsender@instapay\nreceiver@instapay' } })
      .mockResolvedValueOnce({ data: { text: 'Transaction Successful\n9\nsender@instapay\nreceiver@instapay' } })
      .mockResolvedValueOnce({ data: { text: 'Transaction Successful\n9\nsender@instapay\nreceiver@instapay' } })
      .mockResolvedValueOnce({ data: { text: '500 €cP\nTo\nreceiver@instapay' } });
    expect(await service.read(image)).toMatchObject({ amount: 500, method: 'Instapay', confident: true, ran: true });
    expect(w.reinitialize.mock.calls).toEqual([['eng'], ['ara+eng']]);
  });
  it('skips the English fallback when both anchored amount and destination are clear', async () => {
    const w = worker(); (createWorker as jest.Mock).mockResolvedValue(w);
    w.recognize.mockResolvedValue({ data: { text: '120 EGP\nsender@instapay\nMobile Wallet' } });
    expect(await service.read(image)).toMatchObject({ amount: 120, method: 'فودافون كاش', confident: true });
    expect(w.recognize).toHaveBeenCalledTimes(3);
    expect(w.reinitialize).not.toHaveBeenCalled();
  });
  it('leaves an unreadable destination blank instead of guessing from the sender', async () => {
    const w = worker(); (createWorker as jest.Mock).mockResolvedValue(w);
    w.recognize.mockResolvedValue({ data: { text: '120 EGP\nsender@instapay' } });
    expect(await service.read(image)).toMatchObject({ amount: 120, method: '', confident: false, ran: true });
    expect(w.recognize).toHaveBeenCalledTimes(5);
    expect(w.reinitialize).toHaveBeenLastCalledWith('ara+eng');
  });
});
