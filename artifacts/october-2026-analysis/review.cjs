const {collections:d}=require('./snapshot.json');
const orders=d.shopifyorders.filter(o=>o.shopifyCreatedAt.startsWith('2026-10'));
const sales=d.transactions.filter(t=>t.type==='مبيعات');
for(const o of orders){
 const tx=sales.find(t=>t.shopifyOrderId===o.shopifyId||t.ref===o.ref);
 const followups=d.followups.filter(f=>f.orderRef===o.ref);
 const texts=[o.cancelReason,o.cancelReasonNote,o.rejectReason,o.notes,...(o.comments||[]).map(c=>c.text),tx?.cancelReason,...(tx?.comments||[]).map(c=>c.text),...followups.flatMap(f=>[f.comment,f.resolution,...(f.comments||[]).map(c=>c.text)])].filter(Boolean);
 const relevant=texts.filter(s=>/ديب|عربون|مقدم|تحول|حوّل|حولت|رفض|تدفع|الغ|لغ[يت]|كنسل|مش عاي|مش عيز|مش راضي|معاين/i.test(s));
 if(process.argv[2]==='cancel'&&(o.cancelled||tx?.cancelled)) console.log(JSON.stringify({ref:o.ref,code:tx?.cancelReasonCode||o.cancelReasonCode,reason:tx?.cancelReason||o.cancelReason,relevant:[...new Set(relevant)]}));
 if(process.argv[2]==='objections'&&!o.cancelled&&!tx?.cancelled&&relevant.some(s=>/مش عاي|مش عيز|مش راضي|مش هتعرف|رافض|رفض|معندهاش|معاين/i.test(s))) console.log(JSON.stringify({ref:o.ref,status:o.status,paid:o.depositAmount>0||tx?.deposit>0,relevant:[...new Set(relevant)]}));
 if(process.argv[2]==='deposits'){
 const op=o.depositAmount>0, tp=tx?.deposit>0;
 if(op!==Boolean(tp)||(o.depositReceipts||[]).some(r=>r.status==='مُسترد'))console.log(JSON.stringify({ref:o.ref,status:o.status,cancel:o.cancelled||tx?.cancelled,orderDeposit:o.depositAmount,txDeposit:tx?.deposit,initial:tx?.initialDeposit,receipts:(o.depositReceipts||[]).map(r=>({status:r.status,amount:r.amount,refundedAt:r.refundedAt})),deposits:tx?.deposits,notes:o.notes}));
 }
}
