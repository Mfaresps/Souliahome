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
  it('handles language download failure without an uncaught worker error and allows a later retry',async()=>{
    jest.spyOn((service as any).logger,'warn').mockImplementation(()=>undefined);
    (createWorker as jest.Mock).mockImplementationOnce((_languages,_engine,options)=>{
      expect(typeof options.errorHandler).toBe('function');
      expect(()=>options.errorHandler(new Error('fetch failed'))).not.toThrow();
      return Promise.reject(new Error('fetch failed'));
    });
    await expect(service.read(image)).resolves.toMatchObject({ran:false,amount:null,confident:false});
    const w=worker();w.recognize.mockResolvedValue({data:{text:''}});
    (createWorker as jest.Mock).mockResolvedValue(w);
    await expect(service.read(image)).resolves.toMatchObject({ran:true});
    expect(createWorker).toHaveBeenCalledTimes(2);
  });
  it('checks isolated icon digits in English before accepting an amount', async () => {
    const w = worker(); (createWorker as jest.Mock).mockResolvedValue(w);
    w.recognize.mockResolvedValueOnce({ data: { text: 'Transaction Successful\n9\nsender@instapay\nreceiver@instapay' } })
      .mockResolvedValueOnce({ data: { text: 'Transaction Successful\n9\nsender@instapay\nreceiver@instapay' } })
      .mockResolvedValueOnce({ data: { text: 'Transaction Successful\n9\nsender@instapay\nreceiver@instapay' } })
      .mockResolvedValueOnce({ data: { text: '500 €cP\nTo\nreceiver@instapay' } });
    expect(await service.read(image)).toMatchObject({ amount: 500, method: 'Instapay', confident: true, ran: true });
    expect(w.reinitialize.mock.calls).toEqual([['eng'], ['ara+eng'], ['eng'], ['ara+eng']]);
  });
  it('skips the English fallback when both anchored amount and destination are clear', async () => {
    const w = worker(); (createWorker as jest.Mock).mockResolvedValue(w);
    w.recognize.mockResolvedValue({ data: { text: '120 EGP\nsender@instapay\nMobile Wallet' } });
    expect(await service.read(image)).toMatchObject({ amount: 120, method: 'فودافون كاش', confident: true });
    expect(w.recognize).toHaveBeenCalledTimes(5);
    expect(w.reinitialize.mock.calls).toEqual([['eng'], ['ara+eng']]);
  });
  it('leaves an unreadable destination blank instead of guessing from the sender', async () => {
    const w = worker(); (createWorker as jest.Mock).mockResolvedValue(w);
    w.recognize.mockResolvedValue({ data: { text: '120 EGP\nsender@instapay' } });
    expect(await service.read(image)).toMatchObject({ amount: 120, method: '', confident: false, ran: true });
    expect(w.recognize).toHaveBeenCalledTimes(7);
    expect(w.reinitialize).toHaveBeenLastCalledWith('ara+eng');
  });
  it('reads the status-bar clock independently from the receipt amount and transfer time', async () => {
    const w=worker();(createWorker as jest.Mock).mockResolvedValue(w);
    for(let i=0;i<3;i++)w.recognize.mockResolvedValueOnce({data:{text:'120 EGP\nsender@instapay\nMobile Wallet\n13:55:09'}});
    w.recognize.mockResolvedValueOnce({data:{text:'9:06'}}).mockResolvedValueOnce({data:{text:'45%'}});
    expect(await service.read(image)).toMatchObject({amount:120,screenshotTime:'09:06',screenshotTimeSource:'screen-status-bar'});
  });
});
