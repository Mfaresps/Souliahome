import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Expense, ExpenseDocument } from '../expenses/schemas/expense.schema';
import { AuditResult, AuditRow, OrderAuditService } from './order-audit.service';

export const ADVERTISING_CATEGORY = /^\s*(?:اعلانات|إعلانات|الإعلانات|advertising)\s*$/i;
const FIELDS = '_id expenseNo date desc category amount status account notes attachment';
const validDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0,10) === v;
type Window = {fromDate:string;toDate:string};
const iso = (date:Date) => date.toISOString().slice(0,10);
/** Calendar months compare to previous calendar months, with partial months matched by day. */
export function previousMarketingWindows(period: {fromDate:string;toDate:string;months?:number[];year?:number}): Window[] {
  const start=new Date(period.fromDate), end=new Date(period.toDate);
  const shift=(date:Date, months:number, matchMonthEnd=false) => {
    const last=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,0)).getUTCDate();
    const targetLast=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()-months+1,0));
    return new Date(Date.UTC(targetLast.getUTCFullYear(),targetLast.getUTCMonth(),matchMonthEnd && date.getUTCDate()===last ? targetLast.getUTCDate() : Math.min(date.getUTCDate(),targetLast.getUTCDate())));
  };
  if (period.months?.length) {
    const months=[...new Set(period.months)].sort((a,b)=>a-b), span=months[months.length-1]-months[0]+1;
    return months.map(month=>{
      const from=new Date(Math.max(start.getTime(),Date.UTC(period.year!,month-1,1)));
      const to=new Date(Math.min(end.getTime(),Date.UTC(period.year!,month,0)));
      return from<=to ? {fromDate:iso(shift(from,span)),toDate:iso(shift(to,span,true))} : null;
    }).filter((window):window is Window=>!!window);
  }
  if (start.getUTCFullYear()===end.getUTCFullYear() && start.getUTCMonth()===end.getUTCMonth()) return [{fromDate:iso(shift(start,1)),toDate:iso(shift(end,1,true))}];
  const days=Math.round((end.getTime()-start.getTime())/86400000)+1;
  return [{fromDate:iso(new Date(start.getTime()-days*86400000)),toDate:iso(new Date(start.getTime()-86400000))}];
}
export function calculateAuditFinancials(rows:AuditRow[]) {
  const sum=(list:AuditRow[],key:keyof AuditRow)=>list.reduce((total,row)=>total+(Number(row[key])||0),0);
  const registered=rows.filter(row=>row.registered),sales=sum(rows,'orderTotal'),profit=sum(registered,'netProfit'),profitSales=sum(registered,'orderTotal');
  return {orders:rows.length,sales,productCost:sum(rows,'productCost'),shippingCost:rows.some(row=>row.actualShippingKnown)?rows.reduce((total,row)=>total+(row.actualShippingKnown?row.actualShipCost:0),0):null,profit:registered.length?profit:null,margin:profitSales>0?profit/profitSales*100:null,average:rows.length?sales/rows.length:null,registeredOrders:registered.length,pendingOrders:rows.filter(row=>row.syncStatus==='pending'&&!row.registered&&!row.cancelled).length};
}
export function marketingRowScope(row: AuditRow) {
  if (row.cancelled || row.syncStatus === 'cancelled') return 'cancelled';
  if (row.registered) return 'synced';
  if (row.syncStatus === 'pending') return row.depositApproved > 0 || row.depositPending > 0 ? 'pending-deposit' : row.shipWithoutDeposit ? 'pending-without-deposit' : 'pending-no-choice';
  return 'unsynced';
}
export function calculateAuditMarketing(rows: AuditRow[], invoices: any[]) {
  const active = rows.filter(row => !row.cancelled && row.syncStatus !== 'cancelled' && (row.registered || row.syncStatus === 'pending'));
  const registered = active.filter(row => row.registered), pending = active.filter(row => !row.registered);
  const sum = (list: any[], key: string) => list.reduce((total, row) => total + (Number(row[key]) || 0), 0);
  const spend = sum(invoices, 'amount'), revenue = sum(active, 'orderTotal'), registeredRevenue = sum(registered, 'orderTotal');
  const profit = sum(registered, 'netProfit');
  const estimatedProfit = profit + pending.reduce((total, row) => total + row.orderTotal - row.productCost - row.shippingCost, 0);
  const divide = (a: number, b: number) => b > 0 ? Math.round(a / b * 10000) / 10000 : null;
  const round = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
  return { spend: round(spend), expenseCount: invoices.length, orders: active.length, registeredOrders: registered.length, pendingOrders: pending.length,
    excludedOrders: rows.length - active.length, revenue: round(revenue), registeredRevenue: round(registeredRevenue),
    salesAfterAdvertising: round(revenue - spend), profitBeforeAdvertising: registered.length ? round(profit) : null,
    profitAfterAdvertising: registered.length ? round(profit - spend) : null,
    estimatedProfitAfterAdvertising: active.length ? round(estimatedProfit - spend) : null,
    roas: divide(revenue, spend), costPerOrder: divide(spend, active.length),
    advertisingPercent: revenue > 0 ? divide(spend * 100, revenue) : null,
    netMargin: registeredRevenue > 0 ? divide((profit - spend) * 100, registeredRevenue) : null,
    breakEvenRoas: registered.length && !pending.length && profit > 0 ? divide(registeredRevenue, profit) : null,
    profitPerRegisteredOrder: registered.length ? divide(profit - spend, registered.length) : null,
    missingCostOrders: registered.filter(row => !row.hasProfit).length,
    unconfirmedShippingOrders: registered.filter(row => row.actualShippingKnown===false||(row.actualShippingKnown===undefined&&row.shippingCost>0&&!(row.actualShipCost>0))).length,
    attribution: 'selected-orders', costBasis: 'current-catalogue',
  };
}

@Injectable()
export class OrderAuditMarketingService {
  constructor(@InjectModel(Expense.name) private readonly expenses: Model<ExpenseDocument>, private readonly audit: OrderAuditService) {}
  async list(query: Record<string,string>) {
    const page = Number(query.page || 1);
    if (!Number.isInteger(page) || page < 1 || page > 10000) throw new BadRequestException('رقم الصفحة غير صحيح');
    const filter: any = { category: ADVERTISING_CATEGORY };
    if (query.windows) {
      let windows:Window[];
      try { windows=JSON.parse(query.windows); } catch {throw new BadRequestException('فترة المقارنة غير صحيحة');}
      if (!Array.isArray(windows)||!windows.length||windows.length>12||windows.some(window=>!window||!validDate(window.fromDate)||!validDate(window.toDate)||window.fromDate>window.toDate)) throw new BadRequestException('فترة المقارنة غير صحيحة');
      filter.$and=[{$or:windows.map(window=>{const next=new Date(window.toDate);next.setUTCDate(next.getUTCDate()+1);return {date:{$gte:window.fromDate,$lt:iso(next)}};})}];
    }
    if (query.search) { const search = query.search.trim().slice(0,100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); filter.$or = [{desc:new RegExp(search,'i')},{expenseNo:new RegExp(search,'i')}]; }
    if (query.fromDate || query.toDate) {
      if (!validDate(query.fromDate) || !validDate(query.toDate) || query.fromDate > query.toDate) throw new BadRequestException('اختر فترة مصروفات صحيحة');
      const next = new Date(query.toDate); next.setUTCDate(next.getUTCDate()+1);
      filter.date = { $gte:query.fromDate, $lt:next.toISOString().slice(0,10) };
    }
    if (query.months) {
      const months = [...new Set(query.months.split(',').map(Number))], year = Number(query.year);
      if (months.some(month => !Number.isInteger(month) || month < 1 || month > 12) || !Number.isInteger(year) || year < 1970 || year > 2100) throw new BadRequestException('الشهور غير صحيحة');
      filter.$and = [...(filter.$and||[]),{date:new RegExp(`^(?:${months.map(month=>`${year}-${String(month).padStart(2,'0')}`).join('|')})-`)}];
    }
    const items = await this.expenses.find(filter).sort({date:-1,_id:-1}).skip((page-1)*30).limit(31).select(FIELDS).lean();
    return {items:items.slice(0,30), hasMore:items.length>30, page};
  }
  async analyze(body: any) {
    if (!Array.isArray(body?.expenseIds) || body.expenseIds.length > 200 || body.expenseIds.some((id:unknown)=>typeof id!=='string'||!/^[a-f\d]{24}$/i.test(id))) throw new BadRequestException('اختر حتى 200 مصروف إعلانات');
    const ids = [...new Set<string>(body.expenseIds)];
    const invoices: any[] = ids.length ? await this.expenses.find({_id:{$in:ids.map(id=>new Types.ObjectId(id))},category:ADVERTISING_CATEGORY,status:'معتمد',amount:{$gt:0}}).select(FIELDS).lean() : [];
    if (invoices.length !== ids.length) throw new BadRequestException('أحد المصروفات لم يعد متاحاً. اختر مصروفات إعلانات معتمدة فقط ثم أعد المحاولة.');
    const scopeIds = ['synced','pending-deposit','pending-without-deposit','pending-no-choice','cancelled','unsynced'];
    if (!Array.isArray(body.scopes) || body.scopes.length > 6 || body.scopes.some((scope:unknown)=>typeof scope!=='string'||!scopeIds.includes(scope))) throw new BadRequestException('حالات الطلبات غير صحيحة');
    if (body.compare!==undefined && typeof body.compare!=='boolean') throw new BadRequestException('خيار المقارنة غير صحيح');
    if (body.previousExpenseIds!==undefined && (!Array.isArray(body.previousExpenseIds)||body.previousExpenseIds.length>200||body.previousExpenseIds.some((id:unknown)=>typeof id!=='string'||!/^[a-f\d]{24}$/i.test(id)))) throw new BadRequestException('مصروفات المقارنة غير صحيحة');
    let data: AuditResult;
    if (body.period) {
      if (typeof body.period.fromDate!=='string'||typeof body.period.toDate!=='string'||(body.period.months!==undefined&&(!Array.isArray(body.period.months)||body.period.months.some((n:unknown)=>!Number.isInteger(n))))) throw new BadRequestException('الفترة غير صحيحة');
      data = await this.audit.runAuditPeriod({fromDate:body.period.fromDate,toDate:body.period.toDate,months:body.period.months?.join(','),year:body.period.year===undefined?undefined:String(body.period.year)},{persist:false});
    } else {
      if (!Number.isSafeInteger(body.from)||!Number.isSafeInteger(body.to)) throw new BadRequestException('نطاق الطلبات غير صحيح');
      data = await this.audit.runAudit(body.from,body.to,{persist:false});
    }
    const rows = data.rows.filter(row=>body.scopes.includes(marketingRowScope(row)));
    let comparison:any=null;
    if (body.compare && data.period) {
      const windows=previousMarketingWindows(data.period);
      try {
        const previousRows:AuditRow[]=[];
        for (const window of windows) {
          const previous=await this.audit.runAuditPeriod(window,{persist:false});
          previousRows.push(...previous.rows.filter(row=>body.scopes.includes(marketingRowScope(row))));
        }
        const previousIds=body.previousExpenseIds===undefined?null:[...new Set<string>(body.previousExpenseIds)];
        const filter:any={category:ADVERTISING_CATEGORY,status:'معتمد',amount:{$gt:0}};
        if (previousIds) filter._id={$in:previousIds.map(id=>new Types.ObjectId(id))};
        else filter.$or=windows.map(window=>{const next=new Date(window.toDate);next.setUTCDate(next.getUTCDate()+1);return {date:{$gte:window.fromDate,$lt:iso(next)}};});
        const previousInvoices:any[]=windows.length ? await this.expenses.find(filter).select(FIELDS).lean() : [];
        if (previousIds && previousInvoices.length!==previousIds.length) throw new BadRequestException('أحد مصروفات المقارنة غير متاح أو غير معتمد');
        const outsideExpenseCount=previousInvoices.filter(invoice=>!windows.some(window=>String(invoice.date).slice(0,10)>=window.fromDate&&String(invoice.date).slice(0,10)<=window.toDate)).length;
        const basis=data.period.months?.length?'selected-months':data.period.fromDate.slice(0,7)===data.period.toDate.slice(0,7)?'calendar-month':'previous-days';
        comparison={windows,basis,financials:calculateAuditFinancials(previousRows),metrics:calculateAuditMarketing(previousRows,previousInvoices),invoices:previousInvoices,expenseMode:previousIds?'selected':'all-approved',outsideExpenseCount};
      } catch(error) {
        if (error instanceof BadRequestException) throw error;
        comparison={windows,error:'تعذر تحميل الفترة السابقة. أعد المحاولة.'};
      }
    }
    return {metrics:calculateAuditMarketing(rows,invoices),financials:calculateAuditFinancials(rows),comparison,invoices,generatedAt:new Date().toISOString()};
  }
}
