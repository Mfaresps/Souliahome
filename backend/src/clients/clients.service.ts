import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { buildClientProfiles, clientCode, clientPhone, shopifyContact } from './client-profile.util';

const COMMON = '_id client phone customerEmail shopifyCustomerId ref total deposit remaining date transactionDate createdAt shopifyCreatedAt '
  + 'cancelled payStatus cancelReason cancelReasonCode shippingAddress shippingCity shippingGov';
@Injectable()
export class ClientsService {
  constructor(@InjectModel('Transaction') private readonly transactions: Model<any>,
    @InjectModel('ShopifyOrder') private readonly orders: Model<any>,
    @InjectModel('ReturnRequest') private readonly returns: Model<any>,
    @InjectModel('FollowUp') private readonly followups: Model<any>,
    @InjectModel('ClientContact') private readonly contacts: Model<any>,
    @InjectModel('Complaint') private readonly complaints: Model<any>) {}

  private profileRead: Promise<any[]> | null = null;

  async profiles() {
    // Share concurrent list/profile/ticket reads; retain no stale server-side snapshot.
    if (this.profileRead) return this.profileRead;
    const task = this.readProfiles();
    this.profileRead = task;
    try { return await task; } finally { if (this.profileRead === task) this.profileRead = null; }
  }
  private async readProfiles() {
    const [transactions, orders, returns, followups, contacts] = await Promise.all([
      this.transactions.find({ type: 'مبيعات' }).select(COMMON + ' type shopifyOrderId pickupStatus deliveredAt bostaStatus bostaShippingStatus failedDelivery shipIssueState').lean().exec(),
      this.orders.find().select(COMMON + ' shopifyId status rawData.customer.id rawData.customer.email rawData.contact_email rawData.email').lean().exec(),
      this.returns.find({ status: 'معتمد' }).select('originalTransactionId originalRef returnTxId returnTxRef approvedAt createdAt total reason reasonDetails requestKind reversedAt').lean().exec(),
      this.followups.find({ reason: 'عملية تأكيد الطلب', status: 'العميل ألغى الطلب', cancelled: { $ne: true }, autoSource: { $ne: 'shipping-issue' } })
        .select('transactionId shopifyOrderId status reason resolution orderOutcome cancelled autoSource').lean().exec(),
      this.contacts.find().select('key email updatedAt').sort({ updatedAt: -1 }).lean().exec(),
    ]);
    const normalized = orders.map((r: any) => ({ ...r, customerEmail: r.customerEmail || shopifyContact(r.rawData).customerEmail,
      shopifyCustomerId: r.shopifyCustomerId || shopifyContact(r.rawData).shopifyCustomerId }));
    const profiles = buildClientProfiles(transactions, normalized, returns, followups);
    const overrides = new Map(contacts.map((r: any) => [r.key, r.email]));
    const aliasOwners = new Map<string, Set<string>>();
    for (const p of profiles) for (const alias of [...p.phones.map(phone => 'p:' + clientPhone(phone)), ...p.emails.map(email => 'e:' + email)]) {
      if (!aliasOwners.has(alias)) aliasOwners.set(alias, new Set());
      aliasOwners.get(alias)!.add(p.key);
    }
    const legacyOverrides = new Map<string, string>();
    for (const c of contacts as any[]) {
      const keys = aliasOwners.get(c.key);
      if (keys?.size === 1) {
        const key = [...keys][0];
        if (!legacyOverrides.has(key)) legacyOverrides.set(key, c.email);
      }
    }
    return profiles.map(p => {
      // Keep a manually entered contact when a legacy phone identity later gains a Shopify ID.
      // A shared number never transfers an override between different customers.
      const hasOverride = overrides.has(p.key) || legacyOverrides.has(p.key);
      return { ...p, email: overrides.has(p.key) ? overrides.get(p.key) : legacyOverrides.get(p.key) ?? p.email,
        emailSource: hasOverride ? 'manual' : p.email ? 'shopify' : '' };
    });
  }
  async list() {
    return (await this.profiles()).map(({ history, addresses, returns, emails, ...profile }) => profile);
  }
  async profile(key: string) {
    return this.resolveProfile(await this.profiles(), key);
  }
  private resolveProfile(profiles: any[], key: string) {
    const code = key.match(/(?:^|~)(CL-[a-f\d]{20})$/i)?.[1]?.toUpperCase();
    let profile = profiles.find(p => p.key === key || code && p.code === code);
    if (!profile && key) {
      const matches = profiles.filter(p => {
        const aliases = [...p.phones.map((phone: string) => 'p:' + clientPhone(phone)), ...p.emails.map((email: string) => 'e:' + email)];
        return aliases.some(alias => alias === key || code && clientCode(alias) === code);
      });
      if (matches.length === 1) profile = matches[0];
    }
    if (!profile) throw new NotFoundException('العميل غير موجود');
    return profile;
  }
  async orderProfile(id: string, source = 'shopify') {
    if (!id) throw new NotFoundException('سجل العميل غير متاح');
    const profiles = await this.profiles();
    let profile = profiles.find(p => p.history.some((r: any) => source === 'transaction'
      ? r.source === 'transaction' && r.id === id : r.orderId === id || r.source === 'shopify' && r.id === id)
      || source === 'transaction' && p.returns.some((r: any) => r.id === id));
    if (!profile && source === 'transaction') {
      const returned: any = await this.returns.findOne({ returnTxId: id }).select('originalTransactionId').lean().exec();
      if (returned) profile = profiles.find(p => p.history.some((r: any) => r.source === 'transaction' && r.id === String(returned.originalTransactionId)));
    }
    if (!profile) throw new NotFoundException('سجل العميل غير متاح');
    return profile;
  }
  async tickets(key: string) {
    const all = await this.profiles();
    const p = this.resolveProfile(all, key);
    const txIds = p.history.filter((r: any) => r.source === 'transaction').map((r: any) => r.id);
    const orderIds = [...new Set(p.history.flatMap((r: any) => [r.orderId, r.shopifyId, r.source === 'shopify' ? r.id : '']).filter(Boolean))];
    const refs = p.history.map((r: any) => String(r.ref || '').replace(/^#+/, '')).filter((ref: string) => ref && !all.some(other => other.key !== p.key
      && other.history.some((r: any) => String(r.ref || '').replace(/^#+/, '') === ref)));
    const phones = p.phones.map(clientPhone).filter((phone: string) => !all.some(other => other.key !== p.key && other.phones.some((v: string) => clientPhone(v) === phone)))
      .flatMap((phone: string) => [phone, '+' + phone, '00' + phone, ...p.phones.filter((v: string) => clientPhone(v) === phone),
        ...(phone.startsWith('20') ? ['0' + phone.slice(2), phone.slice(2)] : [])]);
    const noTx = { transactionId: { $in: ['', null] } }, noOrder = { shopifyOrderId: { $in: ['', null] } };
    const [followups, complaints] = await Promise.all([
      this.followups.find({ $or: [{ transactionId: { $in: txIds } }, { shopifyOrderId: { $in: orderIds } },
        { $and: [noTx, noOrder, { orderRef: { $in: refs.flatMap((ref: string) => [ref, '#' + ref]) } }] },
        { $and: [noTx, noOrder, { clientPhone: { $in: phones } }] }] })
        .select('ticketNo orderRef status reason reasonOther responsibleName createdAt').sort({ createdAt: -1 }).limit(101).lean().exec(),
      this.complaints.find({ $or: [{ transactionId: { $in: txIds } },
        { $and: [noTx, { transactionRef: { $in: refs.flatMap((ref: string) => [ref, '#' + ref]) } }] },
        { $and: [noTx, { phone: { $in: phones } }] }] })
        .select('complaintNo transactionRef status progressStage description createdAt').sort({ createdAt: -1 }).limit(101).lean().exec(),
    ]);
    const rows = [...followups.map((r: any) => ({ id: String(r._id), kind: 'followup', number: r.ticketNo || String(r._id), ref: r.orderRef || '',
      status: r.status || '', subject: r.reasonOther || r.reason || '', assignedTo: r.responsibleName || '', date: r.createdAt })),
    ...complaints.map((r: any) => ({ id: String(r._id), kind: 'complaint', number: r.complaintNo || String(r._id), ref: r.transactionRef || '',
      status: r.progressStage || r.status || '', subject: r.description || '', assignedTo: '', date: r.createdAt }))]
      .sort((a, b) => String(b.date instanceof Date ? b.date.toISOString() : b.date || '').localeCompare(String(a.date instanceof Date ? a.date.toISOString() : a.date || '')));
    return { rows: rows.slice(0, 100), hasMore: rows.length > 100 };
  }
  async updateEmail(key: string, email: string, updatedBy: string) {
    const profile = await this.profile(key);
    await this.contacts.updateOne({ key: profile.key }, { $set: { email, updatedBy } }, { upsert: true }).exec();
    return { email };
  }
}
