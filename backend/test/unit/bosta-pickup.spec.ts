import { BostaService } from '../../src/bosta/bosta.service';
import { CreatePickupDto } from '../../src/bosta/dto/create-pickup.dto';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';

const id1 = '507f1f77bcf86cd799439011', id2 = '507f1f77bcf86cd799439012';
const dto = { scheduledDate: '2099-10-13', businessLocationId: 'warehouse', orderIds: [id1, id2], contactName: 'Warehouse contact', contactPhone: '01114701237' };
function setup() {
  const svc: any = Object.create(BostaService.prototype);
  const record = { _id: 'request' };
  svc.resolveApiKey = jest.fn().mockResolvedValue('private-key');
  svc.settingsService = { getBostaPickupPolicy: jest.fn().mockResolvedValue({ cutoffTime: '16:00', holidayDates: [] }) };
  svc.request = jest.fn().mockResolvedValue({ success: true, data: { _id: 'pickup-123' } });
  svc.pickupLocations = jest.fn().mockResolvedValue([{ id: 'warehouse' }]);
  svc.txModel = { find: jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([
    { _id: id1, ref: '1', pickupRef: 'run-1' }, { _id: id2, ref: '2', pickupRef: 'run-2' },
  ]) }) }) };
  svc.pickupModel = {
    init: jest.fn().mockResolvedValue(undefined),
    find: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }),
    findOneAndUpdate: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue(record), updateOne: jest.fn().mockResolvedValue({}),
  };
  return svc;
}
describe('Bosta warehouse pickup', () => {
  it('loads the connected account warehouses through the official location endpoint', async () => {
    const svc = setup(); delete svc.pickupLocations;
    svc.request.mockResolvedValue({ success: true, data: [{ _id: 'warehouse', locationName: 'Main warehouse', contactPerson: { name: 'Contact', phone: '01114701237' } }] });
    expect(await svc.pickupLocations()).toEqual([{ id: 'warehouse', name: 'Main warehouse', contactName: 'Contact', contactPhone: '01114701237' }]);
    expect(svc.request).toHaveBeenCalledWith('GET', '/pickup-locations', undefined, 'private-key', 'https://app.bosta.co/api/v2');
  });
  it('reports failed warehouse loading without creating any request', async () => {
    const svc = setup(); delete svc.pickupLocations;
    svc.request.mockResolvedValue({ success: false, message: 'Key not authorized' });
    await expect(svc.pickupLocations()).rejects.toThrow('Key not authorized');
    expect(svc.pickupModel.create).not.toHaveBeenCalled();
  });
  it('counts orders from all runs on the server and sends the documented v2 payload', async () => {
    const svc = setup();
    const result = await svc.createPickup({ ...dto, numberOfParcels: 999 }, 'operator');
    expect(result).toEqual({ success: true, numberOfParcels: 2, scheduledDate: dto.scheduledDate, bostaPickupId: 'pickup-123' });
    expect(svc.request).toHaveBeenCalledWith('POST', '/pickups', {
      scheduledDate: dto.scheduledDate, businessLocationId: 'warehouse', numberOfParcels: 2, packageType: 'Normal',
      contactPerson: { name: dto.contactName, phone: dto.contactPhone }, notes: 'SOULIA: run-1, run-2',
    }, 'private-key', 'https://app.bosta.co/api/v2');
    expect(svc.txModel.find).toHaveBeenCalledWith(expect.objectContaining({ type: 'مبيعات', cancelled: { $ne: true }, archived: { $ne: true }, pickupStatus: { $in: ['Ready', 'Picked-Up'] }, bostaStatus: 'CREATED' }));
    expect(svc.pickupModel.updateOne).toHaveBeenCalledWith({ _id: 'request' }, { $set: { status: 'created', bostaPickupId: 'pickup-123' } });
  });
  it('excludes orders already reserved by a successful or uncertain request', async () => {
    const svc = setup();
    svc.pickupModel.find.mockReturnValue({ lean: async () => [{ orderIds: [id1], status: 'created', scheduledDate: '2099-10-12', numberOfParcels: 1 }] });
    const preview = await svc.pickupPreview();
    expect(preview.orders.map((o: any) => o.id)).toEqual([id2]);
    expect(preview.numberOfParcels).toBe(1);
    await expect(svc.createPickup(dto, 'operator')).rejects.toThrow('تغيرت');
    expect(svc.request).not.toHaveBeenCalled();
  });
  it('rejects a stale preview when an order was added or removed', async () => {
    const svc = setup();
    await expect(svc.createPickup({ ...dto, orderIds: [id1] }, 'operator')).rejects.toThrow('تغيرت');
    expect(svc.pickupModel.create).not.toHaveBeenCalled();
  });
  it('prevents concurrent requests before sending to Bosta', async () => {
    const svc = setup();
    svc.pickupModel.create.mockRejectedValue({ code: 11000 });
    await expect(svc.createPickup(dto, 'operator')).rejects.toThrow('يوجد طلب');
    expect(svc.request).not.toHaveBeenCalled();
  });
  it('allows retry after an explicit rejection without duplicating the reservation', async () => {
    const svc = setup();
    svc.pickupModel.findOneAndUpdate.mockResolvedValue({ _id: 'retry' });
    await svc.createPickup(dto, 'operator');
    expect(svc.pickupModel.create).not.toHaveBeenCalled();
    expect(svc.pickupModel.findOneAndUpdate).toHaveBeenCalledWith(expect.objectContaining({ status: 'rejected' }), expect.objectContaining({ $set: expect.objectContaining({ status: 'pending', active: true }) }), { new: true });
  });
  it.each([{ success: false, message: 'Date unavailable' }, { success: 'false', message: 'Date unavailable' }])('releases reservations after an explicit carrier rejection', async reply => {
    const svc = setup(); svc.request.mockResolvedValue(reply);
    await expect(svc.createPickup(dto, 'operator')).rejects.toThrow('Date unavailable');
    expect(svc.pickupModel.updateOne).toHaveBeenCalledWith({ _id: 'request' }, { $set: { status: 'rejected', active: false, error: 'Date unavailable', bostaErrorCode: 0 } });
  });
  it('keeps the reservation when a network failure could hide a successful request', async () => {
    const svc = setup(); svc.request.mockRejectedValue(new Error('timeout'));
    await expect(svc.createPickup(dto, 'operator')).rejects.toThrow('راجع طلبات');
    expect(svc.pickupModel.updateOne).toHaveBeenCalledWith({ _id: 'request' }, { $set: { status: 'pending', active: true, error: 'timeout', bostaErrorCode: 0 } });
  });
  it.each(['2099-02-31', '2020-01-01', '2099-10-16'])('rejects invalid, past or Friday dates: %s', async scheduledDate => {
    const svc = setup();
    await expect(svc.createPickup({ ...dto, scheduledDate }, 'operator')).rejects.toThrow();
    expect(svc.request).not.toHaveBeenCalled();
  });
  it('rejects a warehouse outside the connected account', async () => {
    const svc = setup();
    await expect(svc.createPickup({ ...dto, businessLocationId: 'other' }, 'operator')).rejects.toThrow('اختر مخزن');
  });
  it('validates contact details and unique order IDs at the API boundary', async () => {
    expect(await validate(plainToInstance(CreatePickupDto, dto))).toHaveLength(0);
    expect((await validate(plainToInstance(CreatePickupDto, { ...dto, orderIds: [id1, id1], contactPhone: '123' }))).length).toBeGreaterThan(0);
    expect((await validate(plainToInstance(CreatePickupDto, { ...dto, contactName: '  ' }))).length).toBeGreaterThan(0);
  });
});

describe('Bosta pickup scheduling at confirmation', () => {
  afterEach(() => jest.useRealTimers());
  it('rejects same-day confirmation after the Cairo cutoff even with a previously open form', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-13T13:00:00Z'));
    const svc = setup();
    await expect(svc.createPickup({ ...dto, scheduledDate: '2026-10-13' }, 'operator')).rejects.toThrow('انتهى وقت');
    expect(svc.request).not.toHaveBeenCalled();
    expect(svc.pickupModel.create).not.toHaveBeenCalled();
  });
  it('rechecks the cutoff after warehouse loading and before reserving orders', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-13T12:59:59Z'));
    const svc = setup();
    svc.pickupLocations.mockImplementation(async () => { jest.setSystemTime(new Date('2026-10-13T13:00:00Z')); return [{ id: 'warehouse' }]; });
    await expect(svc.createPickup({ ...dto, scheduledDate: '2026-10-13' }, 'operator')).rejects.toThrow('انتهى وقت');
    expect(svc.request).not.toHaveBeenCalled(); expect(svc.pickupModel.create).not.toHaveBeenCalled();
  });
  it('rejects configured holidays before contacting the carrier', async () => {
    const svc = setup();
    svc.settingsService.getBostaPickupPolicy.mockResolvedValue({ cutoffTime: '16:00', holidayDates: [dto.scheduledDate] });
    await expect(svc.createPickup(dto, 'operator')).rejects.toThrow('إجازة'); expect(svc.request).not.toHaveBeenCalled();
  });
  it.each([1080, 1081, 2022, 1078, 2024, 2025, 2026, 2027])('records carrier schedule rejection %s and blocks that date for this warehouse', async code => {
    const svc = setup();
    svc.request.mockResolvedValue({ success: false, errorCode: code, message: 'Carrier date refusal' });
    await expect(svc.createPickup(dto, 'operator')).rejects.toThrow();
    expect(svc.pickupModel.updateOne).toHaveBeenCalledWith({ _id: 'request' }, { $set: expect.objectContaining({ status: 'rejected', active: false, bostaErrorCode: code }) });
    svc.pickupModel.find.mockReturnValue({ lean: async () => [{ scheduledDate: dto.scheduledDate, status: 'rejected', bostaErrorCode: code }] });
    svc.request.mockClear();
    await expect(svc.createPickup(dto, 'operator')).rejects.toThrow();
    expect(svc.request).not.toHaveBeenCalled();
  });
});
