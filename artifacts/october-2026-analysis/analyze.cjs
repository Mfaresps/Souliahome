const fs=require('fs');
const path=require('path');
const assert=require('assert/strict');
const snapshot=require('./snapshot.json');
const d=snapshot.collections;
const dateFormat=new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Cairo',year:'numeric',month:'2-digit',day:'2-digit'});
const day=x=>x&&Number.isFinite(+new Date(x))?dateFormat.format(new Date(x)):'';
const orders=d.shopifyorders.filter(o=>day(o.shopifyCreatedAt).startsWith('2026-10'));
const sales=d.transactions.filter(t=>t.type==='مبيعات');
const cleanRef=x=>String(x||'').replace(/^#/,'').trim();
const phone=x=>{let p=String(x||'').replace(/[٠-٩]/g,c=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(c))).replace(/\D/g,'');if(p.startsWith('00'))p=p.slice(2);if(p.startsWith('20')&&p.length===12)p='0'+p.slice(2);if(p.length===10&&p.startsWith('1'))p='0'+p;return p;};
const sum=(a,f)=>Math.round(a.reduce((s,x)=>s+(+f(x)||0),0)*100)/100;
const pct=(a,b)=>b?+(100*a/b).toFixed(2):null;
const hist=(a,f)=>Object.entries(a.reduce((r,x)=>{const k=String(f(x)??'');r[k]=(r[k]||0)+1;return r},{})).sort((a,b)=>b[1]-a[1]);
const directRefusal=new Set(['2815','2896','2960']);
const transferBarrier=new Set(['2912']);
const ambiguousPriorRefusal=new Set(['2833','2932']);
const pendingGroups={
 'paid-awaiting-confirmation':['2884','2917','2940','2961','2972','2998','3001','3006','3009','3010','3011'],
 'cancellation-awaiting-approval':['2948','2949','2966'],
 'postponed':['2911','2920','2929','2991','2995'],
 'contact-or-payment-in-progress':['2768','2800','2814','2887','2989','2999','3000'],
};
const labels=Object.fromEntries([...fs.readFileSync(path.join(__dirname,'../../backend/src/shared/cancellation.constants.ts'),'utf8').matchAll(/code: '([^']+)', ar: '([^']+)'/g)].map(m=>[m[1],m[2]]));
const rows=orders.map(o=>{
 const matches=sales.filter(t=>String(t.shopifyOrderId)===o.shopifyId||cleanRef(t.ref)===cleanRef(o.ref));
 assert(matches.length<=1,`Ambiguous transaction ${o.ref}`);
 const t=matches[0];
 const followups=d.followups.filter(f=>cleanRef(f.orderRef)===cleanRef(o.ref)||f.shopifyOrderId===o._id||f.shopifyOrderId===o.shopifyId||(t&&f.transactionId===t._id));
 const approvedReceipts=(o.depositReceipts||[]).filter(r=>r.status==='معتمد'&&r.amount>0);
 const refundedReceipts=(o.depositReceipts||[]).filter(r=>r.status==='مُسترد'&&r.amount>0);
 const upfrontHistory=(t?.deposits||[]).filter(r=>r.amount>0);
 const paid=approvedReceipts.length>0||refundedReceipts.length>0||o.depositAmount>0||t?.initialDeposit>0||upfrontHistory.length>0;
 // deposit is intentionally excluded: legacy collection can replace it with the full invoice total.
 const cancelled=Boolean(o.cancelled||t?.cancelled||o.status==='rejected');
 const confirmed=Boolean(t)||o.status==='approved';
 const delivered=Boolean(t&&(t.bostaStatus==='DELIVERED'||t.pickupStatus==='Delivered'));
 const shipped=Boolean(t&&(delivered||['PICKED_UP','IN_TRANSIT','OUT_FOR_DELIVERY','DELIVERED','RETURNED','FAILED_ATTEMPT','CUSTOMER_POSTPONED'].includes(t.bostaStatus)||t.pickupStatus==='Shipped'));
 const open=!confirmed&&!cancelled;
 const meaningfulFollowups=followups.filter(f=>(f.comments||[]).length||f.comment||f.resolution||f.deferredUntil);
 const actionEvidence=Boolean(confirmed||cancelled||paid||o.cancelRequest||o.pendingStatus||o.reviewedAt||(o.comments||[]).length||(o.editHistory||[]).length||meaningfulFollowups.length);
 const code=cancelled?(t?.cancelled?(t.cancelReasonCode||'legacy'):o.cancelReasonCode||'legacy'):'';
 const reason=cancelled?(t?.cancelled?t.cancelReason:o.cancelReason||o.rejectReason)||'غير محدد':'';
 const pendingGroup=open?Object.entries(pendingGroups).find(([,refs])=>refs.includes(o.ref))?.[0]||'unclassified':'';
 const cphone=phone(o.phone||t?.phone);
 const customerKey=cphone?'phone:'+cphone:o.rawData?.customer?.id?'shopify:'+o.rawData.customer.id:'unknown:'+o.ref;
 return {ref:o.ref,day:day(o.shopifyCreatedAt),created:o.shopifyCreatedAt,customerKey,hasPhone:!!cphone,hasCustomerId:!!o.rawData?.customer?.id,paid,upfrontAmount:+o.depositAmount||+t?.initialDeposit||sum(upfrontHistory.filter(x=>!x.reversed),r=>r.amount),approvedReceiptAmount:sum(approvedReceipts,r=>r.amount),receiptBacked:approvedReceipts.length>0||refundedReceipts.length>0,confirmed,activeConfirmed:confirmed&&!cancelled,cancelled,open,delivered,shipped,noAction:open&&!actionEvidence,pendingGroup,cancelCode:code,cancelLabel:labels[code]||(code==='legacy'?'سبب قديم غير مصنف':''),cancelReason:reason,cancelDate:day(t?.cancelled?t.cancelledAt:o.cancelledAt),cancelRequest:o.cancelRequest?.status==='معلق',requestReason:o.cancelRequest?.status==='معلق'?o.cancelRequest.reason:'',directRefusal:directRefusal.has(o.ref),transferBarrier:transferBarrier.has(o.ref),priorRefusal:ambiguousPriorRefusal.has(o.ref),orderValue:+(t?.total??o.total)||0,carrierStatus:t?.bostaStatus||'',pickupStatus:t?.pickupStatus||'',deliveredAt:t?.deliveredAt||'',confirmedAt:t?.confirmedAt||o.reviewedAt||'',carrierLastSync:t?.bostaLastSync||'',followupCount:followups.length,followupStatuses:followups.map(f=>f.status).join(' | '),linkedTransaction:t?._id||'',ageDays:Math.floor((+new Date(snapshot.extractedAt)-+new Date(o.shopifyCreatedAt))/86400000),afterSales:!!t?.afterSales||Boolean(t?.afterSalesEvents?.length)};
});
const choose=f=>rows.filter(f), count=f=>choose(f).length, customers=a=>new Set(a.map(r=>r.customerKey)).size;
const metrics={received:rows.length,uniqueCustomers:customers(rows),withoutPhone:count(r=>!r.hasPhone),unknownCustomer:count(r=>r.customerKey.startsWith('unknown:')),paid:count(r=>r.paid),paidCustomers:customers(choose(r=>r.paid)),paidReceiptBacked:count(r=>r.paid&&r.receiptBacked),paidLegacy:count(r=>r.paid&&!r.receiptBacked),confirmed:count(r=>r.confirmed),activeConfirmed:count(r=>r.activeConfirmed),paidConfirmedEver:count(r=>r.paid&&r.confirmed),paidConfirmedActive:count(r=>r.paid&&r.activeConfirmed),paidCancelled:count(r=>r.paid&&r.cancelled),confirmedWithoutUpfront:count(r=>r.confirmed&&!r.paid),activeConfirmedWithoutUpfront:count(r=>r.activeConfirmed&&!r.paid),cancelled:count(r=>r.cancelled),cancelledCustomers:customers(choose(r=>r.cancelled)),preConfirmationCancelled:count(r=>r.cancelled&&!r.confirmed),postConfirmationCancelled:count(r=>r.cancelled&&r.confirmed),open:count(r=>r.open),openCustomers:customers(choose(r=>r.open)),noAction:count(r=>r.noAction),pendingCancellation:count(r=>r.open&&r.cancelRequest),delivered:count(r=>r.delivered),deliveredCustomers:customers(choose(r=>r.delivered)),shipped:count(r=>r.shipped),returned:count(r=>r.carrierStatus==='RETURNED'),inTransit:count(r=>r.shipped&&!r.delivered&&r.carrierStatus!=='RETURNED'&&!r.cancelled),directRefusal:count(r=>r.directRefusal),transferBarrier:count(r=>r.transferBarrier),priorRefusal:count(r=>r.priorRefusal),openPaid:count(r=>r.open&&r.paid),openPaidDeposit:sum(choose(r=>r.open&&r.paid),r=>r.upfrontAmount),openPaidValue:sum(choose(r=>r.open&&r.paid),r=>r.orderValue),allUpfrontRecorded:sum(rows,r=>r.upfrontAmount),receivedValue:sum(rows,r=>r.orderValue),deliveredValue:sum(choose(r=>r.delivered),r=>r.orderValue),cancelledValue:sum(choose(r=>r.cancelled),r=>r.orderValue),openValue:sum(choose(r=>r.open),r=>r.orderValue),carrierDeliveredButInternalShipped:count(r=>r.carrierStatus==='DELIVERED'&&r.pickupStatus==='Shipped'),openMarkedConfirmedFollowup:count(r=>r.open&&r.followupStatuses.includes('تمت عملية التأكيد'))};
metrics.rates={upfrontPayment:pct(metrics.paid,metrics.received),paidConfirmation:pct(metrics.paidConfirmedActive,metrics.received),anyConfirmation:pct(metrics.confirmed,metrics.received),paidToActiveConfirmation:pct(metrics.paidConfirmedActive,metrics.paid),deliveryAmongShipped:pct(metrics.delivered,metrics.shipped),deliveryAmongReceived:pct(metrics.delivered,metrics.received),deliveryAmongClosedShipments:pct(metrics.delivered,metrics.delivered+metrics.returned),cancellation:pct(metrics.cancelled,metrics.received),depositRefusalAmongReceived:pct(metrics.directRefusal,metrics.received),depositFrictionAmongReceived:pct(metrics.directRefusal+metrics.transferBarrier,metrics.received)};
const groups={cancelReasons:hist(choose(r=>r.cancelled),r=>r.cancelCode).map(([code,n])=>({code,label:labels[code]||'سبب قديم: فشل توصيل / رفض الاستلام',count:n,percent:pct(n,metrics.cancelled)})),pending:hist(choose(r=>r.open),r=>r.pendingGroup),weekly:[],paidDelivery:[]};
for(const [start,end]of [[1,7],[8,14],[15,21],[22,28],[29,31]]){const a=rows.filter(r=>+r.day.slice(-2)>=start&&+r.day.slice(-2)<=end);groups.weekly.push({period:`${start}-${end}`,orders:a.length,paid:a.filter(r=>r.paid).length,confirmed:a.filter(r=>r.confirmed).length,cancelled:a.filter(r=>r.cancelled).length,open:a.filter(r=>r.open).length,delivered:a.filter(r=>r.delivered).length});}
for(const paid of [true,false]){const a=choose(r=>r.confirmed&&r.paid===paid);groups.paidDelivery.push({paid,confirmed:a.length,shipped:a.filter(r=>r.shipped).length,delivered:a.filter(r=>r.delivered).length,returned:a.filter(r=>r.carrierStatus==='RETURNED').length,cancelled:a.filter(r=>r.cancelled).length,openShipping:a.filter(r=>r.shipped&&!r.delivered&&!r.cancelled).length});}
const linked=new Set(rows.map(r=>r.linkedTransaction));
const otherSales=sales.filter(t=>!linked.has(t._id)&&day(t.shopifyCreatedAt||t.date).startsWith('2026-10')).map(t=>({ref:t.ref,date:t.date,notes:t.notes,afterSalesKind:t.afterSales?.kind||'',originalRef:t.afterSales?.originalRef||'',value:t.total}));
const repeated=hist(rows,r=>r.customerKey).filter(([,n])=>n>1).map(([key,n])=>({count:n,refs:rows.filter(r=>r.customerKey===key).map(r=>r.ref)}));
assert.equal(metrics.received,metrics.cancelled+metrics.open+metrics.activeConfirmed);
assert.equal(metrics.paid,metrics.paidConfirmedActive+metrics.paidCancelled+metrics.openPaid);
assert.equal(metrics.shipped,metrics.delivered+metrics.returned+metrics.inTransit);
assert(rows.every(r=>r.pendingGroup!=='unclassified'));
assert.equal(new Set(rows.map(r=>r.ref)).size,rows.length);
assert.equal(new Set(orders.map(o=>o.shopifyId)).size,rows.length);
const refs=rows.map(r=>+r.ref).sort((a,b)=>a-b),missingRefs=[];for(let n=refs[0];n<=refs.at(-1);n++)if(!refs.includes(n))missingRefs.push(n);
const result={snapshotAt:snapshot.extractedAt,timezone:snapshot.timezone,month:snapshot.cohortMonth,metrics,groups,otherSales,repeated,range:{first:refs[0],last:refs.at(-1),missingRefs},rows};
fs.writeFileSync(path.join(__dirname,'analysis.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({...result,rows:undefined,repeated:{customersWithMultipleOrders:repeated.length,distribution:hist(repeated,x=>x.count)}},null,2));
